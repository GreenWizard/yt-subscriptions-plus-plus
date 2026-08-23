export interface Channel {
  id: string
  /** Channel ID of the signed-in YouTube account this row belongs to. */
  userId: string
  title: string
  thumbnail: string
}

/**
 * Which auto-generated channel playlist a video came from. YouTube splits a
 * channel's uploads into long-form (UULF), Shorts (UUSH), and live (UULV);
 * `unknown` means it came from the combined UU fallback and was classified by
 * duration instead.
 */
export type VideoKind = 'long' | 'short' | 'live'

export interface Video {
  id: string
  /** Channel ID of the signed-in YouTube account this row belongs to. */
  userId: string
  channelId: string
  channelTitle: string
  title: string
  description: string
  thumbnail: string
  publishedAt: string // ISO 8601
  durationSec: number
  viewCount: number
  likeCount: number
  commentCount: number
  isLive: boolean
  kind: VideoKind
  /**
   * When this row's details were last read from the API. Absent on rows cached
   * before metadata refreshing existed, which makes them refresh first.
   */
  fetchedAt?: number
}

export type SortKey =
  | 'newest'
  | 'oldest'
  | 'views'
  | 'viewsPerHour'
  | 'longest'
  | 'shortest'

export interface FeedRules {
  sort: SortKey
  hideShorts: boolean
  minMinutes: number
  maxMinutes: number // 0 = no upper bound
  /** Release-date window as `YYYY-MM-DD`; '' means unbounded on that end. */
  fromDate: string
  toDate: string
  query: string
  mutedChannels: string[]
}

export const DEFAULT_RULES: FeedRules = {
  sort: 'newest',
  hideShorts: true,
  minMinutes: 0,
  maxMinutes: 0,
  fromDate: '',
  toDate: '',
  query: '',
  mutedChannels: [],
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
