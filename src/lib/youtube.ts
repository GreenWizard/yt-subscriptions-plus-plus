import { getAccessToken, invalidateToken } from './auth'
import { PAGES_PER_PLAYLIST, type Channel, type Video, type VideoKind } from './types'

const API = 'https://www.googleapis.com/youtube/v3'
const DETAIL_CHUNK = 50

/** Shorts may run up to 3 minutes (raised from 60s in October 2024). */
const SHORTS_MAX_SEC = 180

export class YouTubeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message)
  }
}

async function apiGet<T>(path: string, params: Record<string, string>, retry = true): Promise<T> {
  const token = await getAccessToken(false).catch(() => getAccessToken(true))
  const url = `${API}/${path}?${new URLSearchParams(params).toString()}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })

  if (res.ok) return (await res.json()) as T

  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; errors?: { reason?: string }[] }
  }
  const reason = body.error?.errors?.[0]?.reason
  const message = body.error?.message || res.statusText

  if (res.status === 401 && retry) {
    invalidateToken()
    return apiGet<T>(path, params, false)
  }
  if (res.status === 403 && (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded')) {
    throw new YouTubeError(
      'Daily YouTube API quota exhausted. It resets at midnight Pacific time.',
      res.status,
      reason,
    )
  }
  throw new YouTubeError(message, res.status, reason)
}

/** Run tasks with a bounded number in flight, preserving result order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

interface ListResponse<T> {
  items?: T[]
  nextPageToken?: string
}

interface SubscriptionItem {
  snippet: {
    title: string
    resourceId: { channelId: string }
    thumbnails?: Record<string, { url: string } | undefined>
  }
}

export async function fetchSubscriptions(onProgress?: (count: number) => void): Promise<Channel[]> {
  const channels: Channel[] = []
  let pageToken: string | undefined

  do {
    const page: ListResponse<SubscriptionItem> = await apiGet('subscriptions', {
      part: 'snippet',
      mine: 'true',
      maxResults: '50',
      order: 'alphabetical',
      ...(pageToken ? { pageToken } : {}),
    })
    for (const item of page.items ?? []) {
      const t = item.snippet.thumbnails
      channels.push({
        id: item.snippet.resourceId.channelId,
        title: item.snippet.title,
        thumbnail: t?.medium?.url ?? t?.default?.url ?? '',
      })
    }
    onProgress?.(channels.length)
    pageToken = page.nextPageToken
  } while (pageToken)

  return channels
}

/**
 * YouTube auto-generates per-channel playlists whose IDs are the channel ID
 * with `UC` swapped for a type prefix. `UU` is everything; it decomposes into
 * long-form, Shorts, and live. Reading the parts separately keeps Shorts from
 * consuming the page budget and starving older long-form uploads, which is
 * what limited history to roughly a week when reading `UU` alone.
 */
const PLAYLIST_PREFIX: Record<VideoKind, string> = {
  long: 'UULF',
  live: 'UULV',
  short: 'UUSH',
}

function playlistId(channelId: string, prefix: string): string {
  return prefix + channelId.slice(2)
}

interface PlaylistItem {
  contentDetails: { videoId: string; videoPublishedAt?: string }
}

export interface VideoRef {
  id: string
  /** null when read from the combined UU fallback; resolved from duration. */
  kind: VideoKind | null
}

/** Read up to `maxPages` pages of video IDs from one playlist, newest first. */
async function fetchPlaylistIds(id: string, maxPages: number): Promise<string[]> {
  const ids: string[] = []
  let pageToken: string | undefined

  for (let page = 0; page < maxPages; page++) {
    const res: ListResponse<PlaylistItem> = await apiGet('playlistItems', {
      part: 'contentDetails',
      playlistId: id,
      maxResults: '50',
      ...(pageToken ? { pageToken } : {}),
    })
    for (const item of res.items ?? []) ids.push(item.contentDetails.videoId)
    if (!res.nextPageToken) break
    pageToken = res.nextPageToken
  }

  return ids
}

/**
 * Video refs for one channel. The split playlists are undocumented, so a 404
 * on the long-form list falls back to the combined `UU` uploads playlist.
 */
async function fetchChannelRefs(channelId: string, includeShorts: boolean): Promise<VideoRef[]> {
  if (!channelId.startsWith('UC')) {
    const ids = await fetchPlaylistIds(channelId, PAGES_PER_PLAYLIST)
    return ids.map((id) => ({ id, kind: null }))
  }

  const kinds: VideoKind[] = includeShorts ? ['long', 'live', 'short'] : ['long', 'live']

  const perKind = await Promise.all(
    kinds.map(async (kind) => {
      try {
        const ids = await fetchPlaylistIds(
          playlistId(channelId, PLAYLIST_PREFIX[kind]),
          PAGES_PER_PLAYLIST,
        )
        return ids.map((id): VideoRef => ({ id, kind }))
      } catch (err) {
        // A channel with no videos of this kind simply has no such playlist.
        if (err instanceof YouTubeError && err.status === 404) return null
        throw err
      }
    }),
  )

  // Every split playlist missing means the prefixes did not apply here.
  if (perKind.every((r) => r === null)) {
    const ids = await fetchPlaylistIds(playlistId(channelId, 'UU'), PAGES_PER_PLAYLIST).catch(
      (err) => {
        if (err instanceof YouTubeError && err.status === 404) return [] as string[]
        throw err
      },
    )
    return ids.map((id) => ({ id, kind: null }))
  }

  return perKind.filter((r): r is VideoRef[] => r !== null).flat()
}

interface VideoItem {
  id: string
  snippet: {
    title: string
    description: string
    channelId: string
    channelTitle: string
    publishedAt: string
    liveBroadcastContent?: string
    thumbnails?: Record<string, { url: string } | undefined>
  }
  contentDetails: { duration: string }
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string }
}

/** Parse an ISO 8601 duration (PT1H2M3S) into seconds. */
export function parseDuration(iso: string): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso)
  if (!m) return 0
  const [, d, h, min, s] = m
  return (+(d ?? 0) * 86400) + (+(h ?? 0) * 3600) + (+(min ?? 0) * 60) + +(s ?? 0)
}

export async function fetchVideoDetails(refs: VideoRef[]): Promise<Video[]> {
  const kindById = new Map(refs.map((r) => [r.id, r.kind]))
  const ids = refs.map((r) => r.id)

  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += DETAIL_CHUNK) chunks.push(ids.slice(i, i + DETAIL_CHUNK))

  const pages = await pool(chunks, 4, (chunk) =>
    apiGet<ListResponse<VideoItem>>('videos', {
      part: 'snippet,contentDetails,statistics',
      id: chunk.join(','),
      maxResults: String(DETAIL_CHUNK),
    }),
  )

  return pages.flatMap((page) =>
    (page.items ?? []).map((item): Video => {
      const t = item.snippet.thumbnails
      const durationSec = parseDuration(item.contentDetails.duration)
      const known = kindById.get(item.id) ?? null
      return {
        id: item.id,
        channelId: item.snippet.channelId,
        channelTitle: item.snippet.channelTitle,
        title: item.snippet.title,
        description: item.snippet.description ?? '',
        thumbnail: t?.medium?.url ?? t?.high?.url ?? t?.default?.url ?? '',
        publishedAt: item.snippet.publishedAt,
        durationSec,
        viewCount: Number(item.statistics?.viewCount ?? 0),
        likeCount: Number(item.statistics?.likeCount ?? 0),
        commentCount: Number(item.statistics?.commentCount ?? 0),
        isLive: item.snippet.liveBroadcastContent === 'live',
        // Fallback path only: approximate by length against the Shorts ceiling.
        kind: known ?? (durationSec > 0 && durationSec <= SHORTS_MAX_SEC ? 'short' : 'long'),
      }
    }),
  )
}

export interface RefreshProgress {
  scanned: number
  channels: number
  videos: number
}

export interface FeedResult {
  /** Channels whose scan failed; their videos are missing from this refresh. */
  failed: { title: string; message: string }[]
}

/**
 * Scan every channel and stream video details back through `onVideos` as each
 * batch resolves, so the feed fills in progressively instead of appearing only
 * once the whole refresh completes.
 */
export async function fetchFeed(
  channels: Channel[],
  knownIds: Set<string>,
  includeShorts: boolean,
  onProgress: (p: RefreshProgress) => void,
  onVideos: (videos: Video[]) => void,
): Promise<FeedResult> {
  const failed: { title: string; message: string }[] = []
  const seen = new Set(knownIds)
  const pending: VideoRef[] = []
  const inflight: Promise<void>[] = []
  let scanned = 0
  let delivered = 0

  const flush = (force: boolean) => {
    while (pending.length >= DETAIL_CHUNK || (force && pending.length > 0)) {
      const batch = pending.splice(0, DETAIL_CHUNK)
      inflight.push(
        fetchVideoDetails(batch).then((videos) => {
          delivered += videos.length
          onVideos(videos)
          onProgress({ scanned, channels: channels.length, videos: delivered })
        }),
      )
    }
  }

  await pool(channels, 6, async (channel) => {
    try {
      for (const ref of await fetchChannelRefs(channel.id, includeShorts)) {
        if (seen.has(ref.id)) continue
        seen.add(ref.id)
        pending.push(ref)
      }
    } catch (err) {
      failed.push({ title: channel.title, message: err instanceof Error ? err.message : String(err) })
    }
    scanned++
    onProgress({ scanned, channels: channels.length, videos: delivered })
    flush(false)
  })

  flush(true)
  await Promise.all(inflight)

  return { failed }
}
