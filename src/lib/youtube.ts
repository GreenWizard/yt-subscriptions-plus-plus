import { type Channel, type Video, type VideoKind } from './types'

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

// Every list endpoint this module calls costs one quota unit, so a simple count
// of API requests is the quota spent. Lives here because `apiGet` is the single
// choke point every request passes through; the Worker reads it to persist and
// report usage, and seeds it from the day's stored total on startup.
let apiCalls = 0

export function getApiCalls(): number {
  return apiCalls
}

export function setApiCalls(n: number): void {
  apiCalls = n
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
  // Count every request that reaches the API — a failed call still spends quota.
  // The 401 path retries via a recursive call, which counts that attempt too.
  apiCalls++

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
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
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
  pageInfo?: { totalResults?: number }
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

/**
 * List-endpoint page tokens are base64 of a tiny protobuf `{1: offset, 2: 0}`
 * (e.g. offset 50 → `CDIQAA`), so the token for any page is computable from its
 * offset. That is what lets a refresh guess every subscriptions page up front
 * and fetch them in parallel. The format is undocumented, so every guessed
 * page is verified against the previous page's real `nextPageToken` and the
 * chain falls back to sequential fetching from the first mismatch.
 */
export function encodePageToken(offset: number): string {
  const bytes = [0x08]
  let v = offset >>> 0
  for (;;) {
    const b = v & 0x7f
    v >>>= 7
    if (v) bytes.push(b | 0x80)
    else {
      bytes.push(b)
      break
    }
  }
  bytes.push(0x10, 0x00)
  return btoa(String.fromCharCode(...bytes)).replace(/=+$/, '')
}

/** Inverse of `encodePageToken`; NaN when the token is not offset-shaped. */
export function decodePageToken(token: string): number {
  try {
    const bin = atob(token)
    if (bin.charCodeAt(0) !== 0x08) return NaN
    let v = 0
    let shift = 0
    for (let i = 1; i < bin.length; i++) {
      const b = bin.charCodeAt(i)
      v |= (b & 0x7f) << shift
      shift += 7
      if (!(b & 0x80)) break
    }
    return v
  } catch {
    return NaN
  }
}

const SUBS_PAGE = 50
const PLAYLIST_PAGE = 50

/**
 * Read a whole token-chained list, fetching pages in parallel wherever the
 * offset-token prediction lets it.
 *
 * With `expectedCount` (a count remembered from a previous run), every page
 * token is guessed up front and all pages go out at once. Without it, the first
 * page is fetched alone and its `pageInfo.totalResults` — the list's own size —
 * sizes the prediction for the rest; that wave is only fired when the server's
 * real `nextPageToken` equals the predicted one, which both proves the token
 * scheme applies and makes the cold path waste-free.
 *
 * Either way the guessed chain is verified page by page: each page must name
 * the next fetched page as its real `nextPageToken`. From the first mismatch
 * (grown/shrunk list, wrong guess) or a failed page, fetching resumes
 * sequentially from the last server-confirmed token, so the result is always
 * exactly what pure token-chaining would have returned.
 */
async function fetchListPaged<I>(
  fetchPage: (pageToken?: string) => Promise<ListResponse<I>>,
  pageSize: number,
  expectedCount?: number,
  onPage?: (itemsSoFar: number) => void,
): Promise<I[]> {
  const items: I[] = []
  const absorb = (page: ListResponse<I>): void => {
    for (const item of page.items ?? []) items.push(item)
    onPage?.(items.length)
  }

  // Fetch guessed tokens in parallel and absorb the verified prefix. Returns
  // where to resume: a token (or undefined for the first page) to continue
  // from sequentially, or null when the chain ended cleanly. A rejected page
  // resumes at its own token — every token past index 0 was just confirmed by
  // the previous page, so retrying it is retrying a real token, not a guess.
  const runPredicted = async (tokens: (string | undefined)[]): Promise<string | undefined | null> => {
    const results = await Promise.allSettled(tokens.map((t) => fetchPage(t)))
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status === 'rejected') return tokens[i]
      absorb(r.value)
      const next = r.value.nextPageToken ?? null
      // The list ended here (it may have shrunk): later guessed pages are
      // unverifiable, so they are discarded even though they were fetched.
      if (next === null) return null
      // A guess held only if the real next token is the page already fetched;
      // otherwise resume sequentially from the real token.
      if (next !== (i + 1 < tokens.length ? tokens[i + 1] : null)) return next
    }
    return null
  }

  // `undefined` means the first page; `null` means the chain is finished.
  let pageToken: string | undefined | null = undefined

  const expectedPages = expectedCount ? Math.ceil(expectedCount / pageSize) : 0
  if (expectedPages >= 2) {
    pageToken = await runPredicted(
      Array.from({ length: expectedPages }, (_, i) => (i === 0 ? undefined : encodePageToken(i * pageSize))),
    )
  } else if (expectedCount === undefined) {
    const first = await fetchPage(undefined)
    absorb(first)
    pageToken = first.nextPageToken ?? null
    const total = first.pageInfo?.totalResults
    if (pageToken !== null && total && pageToken === encodePageToken(pageSize)) {
      const remaining = Math.ceil(Math.max(0, total - pageSize) / pageSize)
      if (remaining >= 2) {
        pageToken = await runPredicted(
          Array.from({ length: remaining }, (_, i) => encodePageToken((i + 1) * pageSize)),
        )
      }
    }
  }

  while (pageToken !== null) {
    const page = await fetchPage(pageToken)
    absorb(page)
    pageToken = page.nextPageToken ?? null
  }

  return items
}

interface SubscriptionItem {
  snippet: {
    title: string
    resourceId: { channelId: string }
    thumbnails?: Record<string, { url: string } | undefined>
  }
  contentDetails?: { totalItemCount?: number }
}

/**
 * @param expectedCount Channel count from the previous refresh's cache; sizes
 * the parallel page prediction up front. A cold load (no cache) still runs in
 * parallel off the first page's `pageInfo.totalResults` — see `fetchListPaged`.
 */
export async function fetchSubscriptions(
  userId: string,
  onProgress?: (count: number) => void,
  expectedCount?: number,
): Promise<Channel[]> {
  const items = await fetchListPaged<SubscriptionItem>(
    (pageToken) =>
      apiGet('subscriptions', {
        // `contentDetails` rides the same call at no extra quota cost and carries
        // the upload count used to skip unchanged channels' playlist scans.
        part: 'snippet,contentDetails',
        mine: 'true',
        maxResults: String(SUBS_PAGE),
        order: 'alphabetical',
        ...(pageToken ? { pageToken } : {}),
      }),
    SUBS_PAGE,
    // 0 means "nothing cached", which is no prediction at all — pass unknown so
    // the first page's own total sizes the parallel fetch instead.
    expectedCount || undefined,
    onProgress,
  )

  return items.map((item) => {
    const t = item.snippet.thumbnails
    return {
      id: item.snippet.resourceId.channelId,
      userId,
      title: item.snippet.title,
      thumbnail: t?.medium?.url ?? t?.default?.url ?? '',
      totalItemCount: item.contentDetails?.totalItemCount,
    }
  })
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
  const fetchPage = (pageToken?: string): Promise<ListResponse<PlaylistItem>> =>
    apiGet('playlistItems', {
      part: 'contentDetails',
      playlistId: id,
      maxResults: String(PLAYLIST_PAGE),
      ...(pageToken ? { pageToken } : {}),
    })

  // The unbounded read (backfilling a whole back catalogue) fetches in
  // parallel: the first page's `pageInfo.totalResults` is this playlist's own
  // exact size, so the remaining pages are predicted with no wasted calls.
  if (maxPages === Number.POSITIVE_INFINITY) {
    const items = await fetchListPaged(fetchPage, PLAYLIST_PAGE)
    return items.map((item) => item.contentDetails.videoId)
  }

  const ids: string[] = []
  let pageToken: string | undefined

  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(pageToken)
    for (const item of res.items ?? []) ids.push(item.contentDetails.videoId)
    if (!res.nextPageToken) break
    pageToken = res.nextPageToken
  }

  return ids
}

/**
 * The split playlists are undocumented, so a 404 on all of them falls back to
 * the combined `UU` uploads playlist.
 *
 * Only the first page (newest `maxPages`×50) is read: the auto-playlists are
 * newest-first, so new uploads are always at the head, and a refresh only needs
 * to discover what changed since the last one.
 */
async function fetchChannelRefs(channelId: string, maxPages = 1): Promise<VideoRef[]> {
  if (!channelId.startsWith('UC')) {
    const ids = await fetchPlaylistIds(channelId, maxPages)
    return ids.map((id) => ({ id, kind: null }))
  }

  const perKind = await Promise.all(
    PLAYLIST_KINDS.map(async (kind) => {
      try {
        const ids = await fetchPlaylistIds(playlistId(channelId, PLAYLIST_PREFIX[kind]), maxPages)
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
    const ids = await fetchPlaylistIds(playlistId(channelId, 'UU'), maxPages).catch((err) => {
      if (err instanceof YouTubeError && err.status === 404) return [] as string[]
      throw err
    })
    return ids.map((id) => ({ id, kind: null }))
  }

  return perKind.filter((r): r is VideoRef[] => r !== null).flat()
}

/**
 * Every video ref from a channel — all playlist pages, not just the head. Used
 * by the background backfill pass to index a channel's whole back catalogue.
 */
export function fetchAllVideoRefs(channelId: string): Promise<VideoRef[]> {
  return fetchChannelRefs(channelId, Number.POSITIVE_INFINITY)
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
  /** Channels whose playlists have been read so far (of those needing a scan). */
  scanned: number
  /** Channels skipped because their upload count was unchanged since last time. */
  skipped: number
  /** Total subscribed channels this refresh covers. */
  channels: number
  /** Newly indexed videos written so far. */
  videos: number
  /** Cached videos whose details were re-read and updated in place. */
  updated: number
  /** Video ids discovered and still awaiting a details fetch. */
  queued: number
}

export interface FeedResult {
  /** Channels whose scan failed; their videos are missing from this refresh. */
  failed: { title: string; message: string }[]
  /**
   * Channels whose scanned head page held only ids we had never seen. That means
   * uploads have likely spilled past the single page the scan reads, so the
   * channel should be re-indexed in full — its `isFullyUpdated` is dropped.
   */
  needsBackfill: Set<string>
}

/** Everything the scan stage needs, resolved by the Worker before the run. */
export interface FeedScan {
  /** Channels to actually read — new or with a changed upload count. */
  channelsToScan: Channel[]
  /** All subscribed channels, for progress reporting. */
  totalChannels: number
  /** Channels omitted from `channelsToScan` because they were unchanged. */
  skipped: number
  /** Ids already cached; a scanned id in here is a re-read candidate, not new. */
  knownIds: Set<string>
  /** Cached ids whose details have aged out and should be re-fetched. */
  staleIds: Set<string>
}

// Bounded so a large subscription list cannot open unlimited sockets at once,
// but otherwise the feed runs flat out: it lives in a Worker now, so its CPU
// cost no longer competes with rendering and needs no artificial throttle.
const CHANNEL_SCAN_CONCURRENCY = 8
const DETAIL_WORKERS = 32

/**
 * Index the subscription feed in explicit stages:
 *
 *   1. Scan — read the first page of each to-scan channel's playlists and
 *      collect the video ids found (deduped across channels).
 *   2. Filter — drop ids already cached whose details are still fresh; keep the
 *      genuinely new ones and the cached-but-stale ones.
 *   3. Details — fetch `videos.list` for the survivors in 50-id chunks and
 *      stream each batch out via `onVideos`.
 *
 * Which channels to scan (new or changed upload count) and staleness are decided
 * by the caller and arrive in `scan`; this function does not re-derive them.
 */
export async function fetchFeed(
  scan: FeedScan,
  userId: string,
  onProgress: (p: RefreshProgress) => void,
  onVideos: (videos: Video[]) => void | Promise<void>,
): Promise<FeedResult> {
  const { channelsToScan, totalChannels, skipped, knownIds, staleIds } = scan
  const failed: { title: string; message: string }[] = []
  const needsBackfill = new Set<string>()

  let scanned = 0
  let delivered = 0
  let updated = 0
  let queued = 0

  const report = () =>
    onProgress({ scanned, skipped, channels: totalChannels, videos: delivered, updated, queued })

  report()

  // A playlist page holding only ids we have never cached means uploads have
  // likely run past this single page, so the channel needs a full re-index.
  const entirelyNew = (kindRefs: VideoRef[]) =>
    kindRefs.length > 0 && kindRefs.every((r) => !knownIds.has(r.id))

  // Stage 1: scan. Concurrent across channels; results merged, deduped by id.
  const seen = new Set<string>()
  const refs: VideoRef[] = []
  await pool(channelsToScan, CHANNEL_SCAN_CONCURRENCY, async (channel) => {
    try {
      const channelRefs = await fetchChannelRefs(channel.id)
      // Check each playlist page (long / live, or the combined fallback)
      // separately: either being all-new is enough to trigger a re-index.
      if (
        entirelyNew(channelRefs.filter((r) => r.kind === 'long')) ||
        entirelyNew(channelRefs.filter((r) => r.kind === 'live')) ||
        entirelyNew(channelRefs.filter((r) => r.kind === null))
      ) {
        needsBackfill.add(channel.id)
      }
      for (const ref of channelRefs) {
        if (seen.has(ref.id)) continue
        seen.add(ref.id)
        refs.push(ref)
      }
    } catch (err) {
      failed.push({ title: channel.title, message: err instanceof Error ? err.message : String(err) })
    }
    scanned++
    report()
  })

  // Stage 2: filter. A cached id is only refetched when its details have gone
  // stale; anything not cached is new. Everything else costs no request.
  const toFetch = refs.filter((r) => !knownIds.has(r.id) || staleIds.has(r.id))
  queued = toFetch.length
  report()

  // Stage 3: details. Fetch in 50-id chunks, several chunks in flight at once.
  const chunks: VideoRef[][] = []
  for (let i = 0; i < toFetch.length; i += DETAIL_CHUNK) chunks.push(toFetch.slice(i, i + DETAIL_CHUNK))

  await pool(chunks, DETAIL_WORKERS, async (chunk) => {
    try {
      const videos = await fetchVideoDetails(chunk, userId)
      for (const v of videos) {
        if (knownIds.has(v.id)) updated++
        else delivered++
      }
      await onVideos(videos)
    } catch (err) {
      failed.push({
        title: `${chunk.length} videos`,
        message: err instanceof Error ? err.message : String(err),
      })
    }
    queued -= chunk.length
    report()
  })

  return { failed, needsBackfill }
}
