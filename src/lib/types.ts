export interface Channel {
  id: string
  userId: string
  title: string
  thumbnail: string
}

/**
 * `long`/`live` come from the split per-channel playlists. `short` is only ever
 * assigned by duration on the combined `UU` fallback path, which is the one way
 * a Short can enter the feed at all — see `PLAYLIST_KINDS` in `youtube.ts`.
 */
export type VideoKind = 'long' | 'short' | 'live'

export interface Video {
  id: string
  userId: string
  channelId: string
  channelTitle: string
  title: string
  thumbnail: string
  publishedAt: string // ISO 8601
  durationSec: number
  viewCount: number
  isLive: boolean
  kind: VideoKind
  /** Absent on rows cached before refreshing existed, which refreshes them first. */
  fetchedAt?: number
}

/** Runtime list, because `loadRules` has to validate persisted values against it. */
export const SORT_KEYS = [
  'newest',
  'oldest',
  'views',
  'viewsPerHour',
  'longest',
  'shortest',
  'shuffle',
] as const

export type SortKey = (typeof SORT_KEYS)[number]

export const CHANNEL_SORT_KEYS = ['recent', 'name'] as const

export type ChannelSortKey = (typeof CHANNEL_SORT_KEYS)[number]

export const VIDEOS_PER_CHANNEL_ROW = 5

export interface FeedRules {
  sort: SortKey
  /** `YYYY-MM-DD`; '' means unbounded on that end. */
  fromDate: string
  toDate: string
  query: string
  mutedChannels: string[]
  channelSort: ChannelSortKey
  channelQuery: string
  /**
   * Seeds the `shuffle` order. The order must be a pure function of the seed
   * rather than of call time: the feed is re-sorted on every keystroke and every
   * streamed batch, so a comparator reading `Math.random()` would re-deal the
   * grid under the viewer mid-scroll.
   */
  shuffleSeed: number
}

export const DEFAULT_RULES: FeedRules = {
  sort: 'newest',
  fromDate: '',
  toDate: '',
  query: '',
  mutedChannels: [],
  channelSort: 'recent',
  channelQuery: '',
  shuffleSeed: 0,
}

/** Videos read per playlist per channel on a refresh (50 per API call). */
export const PAGES_PER_PLAYLIST = 2

/** How old a cached video's details may be before a refresh re-reads them. */
export const METADATA_TTL_MS = 6 * 3600_000

/**
 * Videos published longer ago than this are never re-read: their view counts
 * have flattened, and re-reading a back catalogue would swallow the pacing
 * budget that new uploads need.
 */
export const METADATA_REFRESH_MAX_AGE_MS = 7 * 24 * 3600_000

/**
 * Indexing budget. Channels and videos each get half while channels remain to
 * be scanned; once scanning finishes, videos take the whole allowance.
 */
export const TOTAL_ITEMS_PER_MIN = 3000
export const CHANNEL_ITEMS_PER_SEC = TOTAL_ITEMS_PER_MIN / 2 / 60
export const VIDEO_ITEMS_PER_SEC = TOTAL_ITEMS_PER_MIN / 2 / 60
export const VIDEO_ITEMS_PER_SEC_SOLO = TOTAL_ITEMS_PER_MIN / 60
