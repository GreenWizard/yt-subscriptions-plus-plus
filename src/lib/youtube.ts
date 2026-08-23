import { getAccessToken, invalidateToken } from './auth'
import type { Channel, Video } from './types'

const API = 'https://www.googleapis.com/youtube/v3'

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
 * A channel's uploads playlist ID is its channel ID with the `UC` prefix
 * swapped for `UU`, so we can skip a channels.list round trip entirely.
 */
function uploadsPlaylistId(channelId: string): string {
  return channelId.startsWith('UC') ? `UU${channelId.slice(2)}` : channelId
}

interface PlaylistItem {
  contentDetails: { videoId: string; videoPublishedAt?: string }
}

/** Recent upload IDs for one channel, newest first, stopping once we pass `since`. */
async function fetchRecentUploadIds(channelId: string, since: Date, maxPages = 2): Promise<string[]> {
  const ids: string[] = []
  let pageToken: string | undefined

  for (let page = 0; page < maxPages; page++) {
    let res: ListResponse<PlaylistItem>
    try {
      res = await apiGet('playlistItems', {
        part: 'contentDetails',
        playlistId: uploadsPlaylistId(channelId),
        maxResults: '50',
        ...(pageToken ? { pageToken } : {}),
      })
    } catch (err) {
      // A channel with no public uploads 404s; that is not a failure of the run.
      if (err instanceof YouTubeError && err.status === 404) return ids
      throw err
    }

    let reachedOlder = false
    for (const item of res.items ?? []) {
      const published = item.contentDetails.videoPublishedAt
      if (published && new Date(published) < since) {
        reachedOlder = true
        continue
      }
      ids.push(item.contentDetails.videoId)
    }

    if (reachedOlder || !res.nextPageToken) break
    pageToken = res.nextPageToken
  }

  return ids
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

export async function fetchVideoDetails(ids: string[]): Promise<Video[]> {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50))

  const pages = await pool(chunks, 4, (chunk) =>
    apiGet<ListResponse<VideoItem>>('videos', {
      part: 'snippet,contentDetails,statistics',
      id: chunk.join(','),
      maxResults: '50',
    }),
  )

  return pages.flatMap((page) =>
    (page.items ?? []).map((item): Video => {
      const t = item.snippet.thumbnails
      return {
        id: item.id,
        channelId: item.snippet.channelId,
        channelTitle: item.snippet.channelTitle,
        title: item.snippet.title,
        description: item.snippet.description ?? '',
        thumbnail: t?.medium?.url ?? t?.high?.url ?? t?.default?.url ?? '',
        publishedAt: item.snippet.publishedAt,
        durationSec: parseDuration(item.contentDetails.duration),
        viewCount: Number(item.statistics?.viewCount ?? 0),
        likeCount: Number(item.statistics?.likeCount ?? 0),
        commentCount: Number(item.statistics?.commentCount ?? 0),
        isLive: item.snippet.liveBroadcastContent === 'live',
      }
    }),
  )
}

export interface RefreshProgress {
  stage: 'subs' | 'uploads' | 'details' | 'done'
  done: number
  total: number
}

/**
 * Collect every upload from `channels` published within the lookback window.
 * `knownIds` are videos already cached, so we only pay for details we lack.
 */
export async function fetchFeed(
  channels: Channel[],
  lookbackDays: number,
  knownIds: Set<string>,
  onProgress: (p: RefreshProgress) => void,
): Promise<{ videos: Video[]; allIds: string[] }> {
  const since = new Date(Date.now() - lookbackDays * 86400_000)

  let done = 0
  const perChannel = await pool(channels, 6, async (channel) => {
    const ids = await fetchRecentUploadIds(channel.id, since).catch(() => [] as string[])
    onProgress({ stage: 'uploads', done: ++done, total: channels.length })
    return ids
  })

  const allIds = [...new Set(perChannel.flat())]
  const missing = allIds.filter((id) => !knownIds.has(id))

  onProgress({ stage: 'details', done: 0, total: missing.length })
  const videos = missing.length ? await fetchVideoDetails(missing) : []
  onProgress({ stage: 'done', done: missing.length, total: missing.length })

  return { videos, allIds }
}
