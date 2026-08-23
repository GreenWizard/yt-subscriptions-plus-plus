export interface Channel {
  id: string
  /** Channel ID of the signed-in YouTube account this row belongs to. */
  userId: string
  title: string
  thumbnail: string
}

/**
 * Which auto-generated channel playlist a video came from. YouTube splits a
 * channel's uploads into long-form (UULF), Shorts (UUSH), and live (UULV), and
 * only the first two are ever read.
 *
 * `short` therefore never comes from a playlist: it is only ever assigned by
 * duration on the combined `UU` fallback path, which returns everything and so
 * is the one way a Short can enter the feed at all.
 */
export type VideoKind = 'long' | 'short' | 'live'

export interface Video {
  id: string
  /** Channel ID of the signed-in YouTube account this row belongs to. */
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
  /**
   * When this row's details were last read from the API. Absent on rows cached
   * before metadata refreshing existed, which makes them refresh first.
   */
  fetchedAt?: number
}

/**
 * Every valid sort, as a runtime list. Persisted rules are untrusted, so the
 * loader has to check a stored value against something at runtime; deriving
 * `SortKey` from the list is what keeps the two from drifting apart.
 */
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

export interface FeedRules {
  sort: SortKey
  /** Release-date window as `YYYY-MM-DD`; '' means unbounded on that end. */
  fromDate: string
  toDate: string
  query: string
  mutedChannels: string[]
  /**
   * Seeds the `shuffle` order. The order has to be a pure function of the seed
   * rather than of call time, because the feed is re-sorted on every keystroke
   * and every streamed batch: a comparator that read `Math.random()` would deal
   * the grid a new order under the viewer mid-scroll. Persisting it means a
   * reload comes back to the same shuffle, and re-dealing is an explicit act.
   */
  shuffleSeed: number
}

export const DEFAULT_RULES: FeedRules = {
  sort: 'newest',
  fromDate: '',
  toDate: '',
  query: '',
  mutedChannels: [],
  // Unused until `shuffle` is picked, which deals a real seed as it is chosen.
  shuffleSeed: 0,
}

/** Videos read per playlist per channel on a refresh (50 per API call). */
export const PAGES_PER_PLAYLIST = 2

/**
 * How old a cached video's details may be before a refresh re-reads them.
 * Titles rarely change but view counts drive the trending sort, so a daily
 * refresh should pick up new numbers without re-reading the same rows twice
 * in one sitting.
 */
export const METADATA_TTL_MS = 6 * 3600_000

/**
 * Videos published longer ago than this are never re-read. Their view counts
 * have long since flattened, and re-reading a whole back catalogue on every
 * refresh would swallow the pacing budget that new uploads need.
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
