import { PAGES_PER_PLAYLIST, type Channel, type Video, type VideoKind } from './types'

const API = 'https://www.googleapis.com/youtube/v3'
const DETAIL_CHUNK = 50

/** Shorts may run up to 3 minutes (raised from 60s in October 2024). */
const SHORTS_MAX_SEC = 180

/**
 * Supplies access tokens without this module depending on the browser-only auth
 * code: the whole feed runs in a Worker, where `window` and Google Identity
 * Services do not exist, so the token has to come from the main thread.
 */
export interface AuthBridge {
  getToken(interactive: boolean): Promise<string>
  invalidate(): void
}

let authBridge: AuthBridge | null = null

export function setAuthBridge(bridge: AuthBridge): void {
  authBridge = bridge
}

function auth(): AuthBridge {
  if (!authBridge) throw new Error('Auth bridge not configured.')
  return authBridge
}

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
  const token = await auth().getToken(false).catch(() => auth().getToken(true))
  const url = `${API}/${path}?${new URLSearchParams(params).toString()}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })

  if (res.ok) return (await res.json()) as T

  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; errors?: { reason?: string }[] }
  }
  const reason = body.error?.errors?.[0]?.reason
  const message = body.error?.message || res.statusText

  if (res.status === 401 && retry) {
    auth().invalidate()
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

export interface CurrentUser {
  id: string
  title: string
}

/** The account's own channel ID, which scopes every cached row. */
export async function fetchCurrentUser(): Promise<CurrentUser> {
  const res = await apiGet<ListResponse<{ id: string; snippet?: { title?: string } }>>('channels', {
    part: 'snippet',
    mine: 'true',
    maxResults: '1',
  })
  const me = res.items?.[0]
  if (!me) throw new Error('This Google account has no YouTube channel.')
  return { id: me.id, title: me.snippet?.title ?? 'You' }
}

interface SubscriptionItem {
  snippet: {
    title: string
    resourceId: { channelId: string }
    thumbnails?: Record<string, { url: string } | undefined>
  }
  contentDetails?: { totalItemCount?: number }
}

export async function fetchSubscriptions(
  userId: string,
  onProgress?: (count: number) => void,
): Promise<Channel[]> {
  const channels: Channel[] = []
  let pageToken: string | undefined

  do {
    const page: ListResponse<SubscriptionItem> = await apiGet('subscriptions', {
      // `contentDetails` rides the same call at no extra quota cost and carries
      // the upload count used to skip unchanged channels' playlist scans.
      part: 'snippet,contentDetails',
      mine: 'true',
      maxResults: '50',
      order: 'alphabetical',
      ...(pageToken ? { pageToken } : {}),
    })
    for (const item of page.items ?? []) {
      const t = item.snippet.thumbnails
      channels.push({
        id: item.snippet.resourceId.channelId,
        userId,
        title: item.snippet.title,
        thumbnail: t?.medium?.url ?? t?.default?.url ?? '',
        totalItemCount: item.contentDetails?.totalItemCount,
      })
    }
    onProgress?.(channels.length)
    pageToken = page.nextPageToken
  } while (pageToken)

  return channels
}

/**
 * YouTube auto-generates per-channel playlists whose IDs are the channel ID with
 * `UC` swapped for a type prefix: `UU` is everything, and it decomposes into
 * long-form, Shorts and live. Reading only long-form and live keeps Shorts out
 * of the feed and stops them consuming the page budget, which is what limited
 * history to about a week back when `UU` was read whole.
 */
const PLAYLIST_KINDS = ['long', 'live'] as const

const PLAYLIST_PREFIX: Record<(typeof PLAYLIST_KINDS)[number], string> = {
  long: 'UULF',
  live: 'UULV',
}

function playlistId(channelId: string, prefix: string): string {
  return prefix + channelId.slice(2)
}

interface PlaylistItem {
  contentDetails: { videoId: string }
}

export interface VideoRef {
  id: string
  /** null when read from the combined UU fallback; resolved from duration. */
  kind: VideoKind | null
}

/** Video IDs from one playlist, newest first. */
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
 * The split playlists are undocumented, so a 404 on all of them falls back to
 * the combined `UU` uploads playlist.
 */
async function fetchChannelRefs(channelId: string): Promise<VideoRef[]> {
  if (!channelId.startsWith('UC')) {
    const ids = await fetchPlaylistIds(channelId, PAGES_PER_PLAYLIST)
    return ids.map((id) => ({ id, kind: null }))
  }

  const perKind = await Promise.all(
    PLAYLIST_KINDS.map(async (kind) => {
      try {
        const ids = await fetchPlaylistIds(
          playlistId(channelId, PLAYLIST_PREFIX[kind]),
          PAGES_PER_PLAYLIST,
        )
        return ids.map((id): VideoRef => ({ id, kind }))
      } catch (err) {
        // A channel with no videos of this kind has no such playlist.
        if (err instanceof YouTubeError && err.status === 404) return null
        throw err
      }
    }),
  )

  // All of them missing means the prefixes did not apply to this channel.
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
    channelId: string
    channelTitle: string
    publishedAt: string
    liveBroadcastContent?: string
    thumbnails?: Record<string, { url: string } | undefined>
  }
  contentDetails: { duration: string }
  statistics?: { viewCount?: string }
}

/** Parse an ISO 8601 duration (PT1H2M3S) into seconds. */
export function parseDuration(iso: string): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso)
  if (!m) return 0
  const [, d, h, min, s] = m
  return (+(d ?? 0) * 86400) + (+(h ?? 0) * 3600) + (+(min ?? 0) * 60) + +(s ?? 0)
}

export async function fetchVideoDetails(refs: VideoRef[], userId: string): Promise<Video[]> {
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
        userId,
        channelId: item.snippet.channelId,
        channelTitle: item.snippet.channelTitle,
        title: item.snippet.title,
        thumbnail: t?.medium?.url ?? t?.high?.url ?? t?.default?.url ?? '',
        publishedAt: item.snippet.publishedAt,
        durationSec,
        viewCount: Number(item.statistics?.viewCount ?? 0),
        isLive: item.snippet.liveBroadcastContent === 'live',
        // `UU` fallback only: nothing but duration distinguishes a Short there.
        kind: known ?? (durationSec > 0 && durationSec <= SHORTS_MAX_SEC ? 'short' : 'long'),
        fetchedAt: Date.now(),
      }
    }),
  )
}

export interface RefreshProgress {
  scanned: number
  /** Channels whose scan was skipped because their upload count was unchanged. */
  skipped: number
  channels: number
  /** Newly indexed videos delivered so far. */
  videos: number
  /** Cached videos whose details were re-read and updated in place. */
  updated: number
  /** Newly discovered videos still queued behind the pacing budget. */
  queued: number
  /** Cached videos still queued for a details refresh. */
  queuedStale: number
}

export interface FeedResult {
  /** Channels whose scan failed; their videos are missing from this refresh. */
  failed: { title: string; message: string }[]
}

// Bounded so a large subscription list cannot open unlimited sockets at once,
// but otherwise the feed runs flat out: it lives in a Worker now, so its CPU
// cost no longer competes with rendering and needs no artificial throttle.
const CHANNEL_SCAN_CONCURRENCY = 8
const DETAIL_WORKERS = 32

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Index the subscription feed, streaming results out as they arrive. Channel
 * scanning and detail fetching are a producer/consumer pair that run
 * concurrently: consumers start draining discovered videos while scanning is
 * still in progress.
 *
 * Discovered videos are routed into two queues: anything outside `knownIds` is
 * new and fetched first, anything in `staleIds` is cached but aged out and
 * re-read afterwards. Cached videos that are neither cost no request.
 */
export async function fetchFeed(
  channels: Channel[],
  userId: string,
  knownIds: Set<string>,
  staleIds: Set<string>,
  /** Channel id -> the upload count from the previous refresh, if any. */
  prevCounts: Map<string, number | undefined>,
  onProgress: (p: RefreshProgress) => void,
  onVideos: (videos: Video[]) => void | Promise<void>,
): Promise<FeedResult> {
  const failed: { title: string; message: string }[] = []
  // Within-run dedupe only: the same video can appear in two channel scans.
  const seen = new Set<string>()
  const pending: VideoRef[] = []
  const stale: VideoRef[] = []

  let scanned = 0
  let skipped = 0
  let delivered = 0
  let updated = 0
  let scanningDone = false
  // Refs pulled off a queue and currently being fetched: counted as neither
  // queued nor delivered, so the reported total dips while a batch is in flight.
  let inFlightNew = 0
  let inFlightStale = 0

  const report = () =>
    onProgress({
      scanned,
      skipped,
      channels: channels.length,
      videos: delivered,
      updated,
      queued: pending.length + inFlightNew,
      queuedStale: stale.length + inFlightStale,
    })

  const produce = pool(channels, CHANNEL_SCAN_CONCURRENCY, async (channel) => {
    // Skip the playlist scan when the channel's upload count is unchanged since
    // the last refresh: no new uploads means nothing to discover, and the scan
    // is the dominant per-refresh quota cost. A missing previous count — a first
    // refresh, or a row cached before this field existed — counts as changed, so
    // the channel is always scanned. The count is approximate and also moves for
    // Shorts and deletions, so it can over-scan (harmless) but a delete-plus-post
    // that nets zero can be missed until the next count change.
    const prev = prevCounts.get(channel.id)
    const unchanged =
      prev !== undefined && channel.totalItemCount !== undefined && prev === channel.totalItemCount
    if (unchanged) {
      skipped++
      scanned++
      report()
      return
    }
    try {
      for (const ref of await fetchChannelRefs(channel.id)) {
        if (seen.has(ref.id)) continue
        seen.add(ref.id)
        if (!knownIds.has(ref.id)) pending.push(ref)
        else if (staleIds.has(ref.id)) stale.push(ref)
      }
    } catch (err) {
      failed.push({ title: channel.title, message: err instanceof Error ? err.message : String(err) })
    }
    scanned++
    report()
  })

  const consume = async () => {
    for (;;) {
      // New videos always win: re-reads wait until discovery is done and nothing
      // new is left, so a refresh never delays fresh uploads.
      const isNew = pending.length > 0
      if (!isNew && (!scanningDone || stale.length === 0)) {
        if (scanningDone && stale.length === 0) return
        await sleep(100)
        continue
      }
      const batch = (isNew ? pending : stale).splice(0, DETAIL_CHUNK)
      if (isNew) inFlightNew += batch.length
      else inFlightStale += batch.length
      report()
      try {
        const videos = await fetchVideoDetails(batch, userId)
        if (isNew) delivered += videos.length
        else updated += videos.length
        await onVideos(videos)
      } catch (err) {
        failed.push({
          title: `${batch.length} videos`,
          message: err instanceof Error ? err.message : String(err),
        })
      } finally {
        if (isNew) inFlightNew -= batch.length
        else inFlightStale -= batch.length
      }
      report()
    }
  }

  // Several drainers run in parallel, so one slow request cannot stall the
  // whole video side while others could be in flight.
  const consumers = Promise.all(Array.from({ length: DETAIL_WORKERS }, consume))

  await produce
  scanningDone = true
  await consumers

  return { failed }
}
