export interface Channel {
  id: string
  userId: string
  title: string
  thumbnail: string
  /**
   * `contentDetails.totalItemCount` from the subscription: the channel's
   * approximate upload count. A refresh scans a channel's playlists only when
   * this differs from the stored value, so a channel that posted nothing costs
   * no `playlistItems` calls. Absent on rows cached before this field existed,
   * which is treated as "changed" and forces a scan.
   */
  totalItemCount?: number
  /**
   * Whether the channel's entire back catalogue has been indexed by the
   * background backfill pass (which reads every playlist page, not just the
   * head). False/absent until that pass completes for the channel; the main
   * refresh only ever reads the newest page, so history is filled in gradually
   * across refreshes within a per-run quota budget.
   */
  isFullyUpdated?: boolean
}

/**
 * A user-defined label attached to channels. Tags live in their own IDB store
 * (the worker rewrites channel rows wholesale on every refresh, so anything
 * stored on the channel row would be lost), and carry their channel assignments
 * with them: filtering by tags then reduces to Set lookups on `channelId`.
 * Videos have no tag data of their own — they inherit their channel's tags.
 */
export interface Tag {
  id: string
  userId: string
  name: string
  /** One of `TAG_COLORS`. Absent on rows saved before colors existed. */
  color?: string
  channelIds: string[]
}

/**
 * The 32 colors a tag can wear: 15 hues in a light and a dark shade, plus two
 * grays. Chip text flips between near-black and white by the shade's measured
 * luminance (see `tagTextColor`), which is why both shades are usable.
 */
export const TAG_COLORS = [
  '#dd5f5f', '#dd925f', '#ddc45f', '#c4dd5f', '#92dd5f', '#5fdd5f', '#5fdd92', '#5fddc4',
  '#5fc4dd', '#5f92dd', '#5f5fdd', '#925fdd', '#c45fdd', '#dd5fc4', '#dd5f92', '#9a9aa7',
  '#ab2b2b', '#ab5e2b', '#ab922b', '#92ab2b', '#5eab2b', '#2bab2b', '#2bab5e', '#2bab92',
  '#2b92ab', '#2b5eab', '#2b2bab', '#5e2bab', '#922bab', '#ab2b92', '#ab2b5e', '#4a4a55',
] as const

/** What a tag saved before colors existed falls back to. */
export const DEFAULT_TAG_COLOR: string = TAG_COLORS[15]

/** The most tags one channel can carry. */
export const MAX_TAGS_PER_CHANNEL = 10

/** How multiple selected tags combine when filtering the feed. */
export const TAG_MODES = ['or', 'and'] as const

export type TagMode = (typeof TAG_MODES)[number]

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
  /**
   * views/hour as of `fetchedAt`, computed when the row is written so the
   * trending sort is a plain numeric sort. Slightly stale by design: videos
   * young enough for their rate to still move are re-fetched by the metadata
   * TTL anyway, and an old video's rate barely changes. Absent on rows cached
   * before this field existed — the sort fills those in lazily.
   */
  viewsPerHour?: number
  /**
   * Lazy per-row caches (see rules.ts), filled on first use with `??=`. UI-only:
   * the worker builds its own rows for the DB, so these never get persisted.
   * Lowercasing 200k titles or parsing 200k dates on every keystroke/sort was
   * the dominant cost of the search filter and the trending sort.
   */
  titleLc?: string
  channelTitleLc?: string
  publishedMs?: number
}

/**
 * Runtime list, because `loadRules` has to validate persisted values against it.
 * `longest`/`shortest`/`shuffle` used to be sorts; a persisted value naming one
 * of them now falls back to the default. Shuffling lives on as a button that
 * re-deals only the feed page on screen.
 */
export const SORT_KEYS = ['newest', 'oldest', 'views', 'viewsPerHour'] as const

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
  /** Tag ids the feed is filtered to; empty means no tag filter. */
  selectedTags: string[]
  /** How multiple selected tags combine: any of them (`or`) or all (`and`). */
  tagMode: TagMode
  channelSort: ChannelSortKey
  channelQuery: string
}

export const DEFAULT_RULES: FeedRules = {
  sort: 'newest',
  fromDate: '',
  toDate: '',
  query: '',
  mutedChannels: [],
  selectedTags: [],
  tagMode: 'or',
  channelSort: 'recent',
  channelQuery: '',
}

/**
 * The feed is split into pages of this many videos: a 200k-video grid is far
 * past what anyone scrolls through, and pages bound both the render slice and
 * what the page-scoped shuffle has to re-deal.
 */
export const FEED_PAGE_SIZE = 10_000

/** Videos read per playlist per channel on a refresh (50 per API call). */
export const PAGES_PER_PLAYLIST = 2

/** How old a cached video's details may be before a refresh re-reads them. */
export const METADATA_TTL_MS = 6 * 3600_000

/**
 * Videos published longer ago than this are never re-read: their view counts
 * have flattened, and re-reading a back catalogue would crowd out the new
 * uploads a refresh exists to surface.
 */
export const METADATA_REFRESH_MAX_AGE_MS = 7 * 24 * 3600_000
