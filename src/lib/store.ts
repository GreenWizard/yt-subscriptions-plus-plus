import {
  clearUser,
  deleteRow,
  getMeta,
  getQuota,
  getRowIdsByUser,
  getRowsByUser,
  getVideosPublishedSince,
  pruneUserRows,
  putMeta,
  putQuota,
  putRows,
} from './idb'
import {
  CHANNEL_SORT_KEYS,
  DEFAULT_RULES,
  SORT_KEYS,
  TAG_MODES,
  type Channel,
  type ChannelSortKey,
  type FeedRules,
  type SortKey,
  type Tag,
  type TagMode,
  type Video,
} from './types'

// Keys are versioned; earlier shapes are left behind rather than migrated.
const RULES_KEY = 'ytd.rules.v2'
const LAST_USER_KEY = 'ytd.lastUserId'

/** The account whose cache should be shown before sign-in completes. */
export function getLastUserId(): string | null {
  return localStorage.getItem(LAST_USER_KEY)
}

export function setLastUserId(userId: string): void {
  localStorage.setItem(LAST_USER_KEY, userId)
}

export interface LoadedFeed {
  channels: Channel[]
  videos: Video[]
  feedFetchedAt: number
}

function sortKey(value: unknown): SortKey {
  return (SORT_KEYS as readonly unknown[]).includes(value) ? (value as SortKey) : DEFAULT_RULES.sort
}

function tagMode(value: unknown): TagMode {
  return (TAG_MODES as readonly unknown[]).includes(value) ? (value as TagMode) : DEFAULT_RULES.tagMode
}

function channelSortKey(value: unknown): ChannelSortKey {
  return (CHANNEL_SORT_KEYS as readonly unknown[]).includes(value)
    ? (value as ChannelSortKey)
    : DEFAULT_RULES.channelSort
}

/**
 * `YYYY-MM-DD`, or '' for an unbounded end. A malformed string is dropped
 * rather than kept: it parses to `NaN`, every comparison against `NaN` is false,
 * and that silently disables the whole date window instead of narrowing it.
 */
function dateString(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return ''
  return Number.isNaN(new Date(`${value}T00:00:00`).getTime()) ? '' : value
}

/**
 * Every field is untrusted: it may have been written by an older build or edited
 * by hand. An unrecognized `sort` reached `sortVideos`, which returned
 * `undefined` and blanked the app on every load until storage was cleared.
 * Listing the fields rather than looping over keys also means adding a rule
 * fails to compile here until it is given a check of its own.
 */
export function loadRules(): FeedRules {
  try {
    const raw = localStorage.getItem(RULES_KEY)
    if (!raw) return DEFAULT_RULES
    const saved = JSON.parse(raw) as unknown
    if (typeof saved !== 'object' || saved === null) return DEFAULT_RULES
    const s = saved as Record<string, unknown>
    return {
      sort: sortKey(s.sort),
      fromDate: dateString(s.fromDate),
      toDate: dateString(s.toDate),
      query: typeof s.query === 'string' ? s.query : DEFAULT_RULES.query,
      mutedChannels: Array.isArray(s.mutedChannels)
        ? s.mutedChannels.filter((c): c is string => typeof c === 'string')
        : DEFAULT_RULES.mutedChannels,
      // Ids of tags since deleted are harmless — the filter drops unknown ids —
      // but they are pruned on the next tag deletion anyway (see App).
      selectedTags: Array.isArray(s.selectedTags)
        ? s.selectedTags.filter((t): t is string => typeof t === 'string')
        : DEFAULT_RULES.selectedTags,
      tagMode: tagMode(s.tagMode),
      channelSort: channelSortKey(s.channelSort),
      channelQuery: typeof s.channelQuery === 'string' ? s.channelQuery : DEFAULT_RULES.channelQuery,
    }
  } catch {
    return DEFAULT_RULES
  }
}

export function saveRules(rules: FeedRules): void {
  localStorage.setItem(RULES_KEY, JSON.stringify(rules))
}

// --- The feed cache, read from and written to IndexedDB directly ------------
//
// The store is the single source of truth: `loadFeed` is the only way the UI
// gets its data, and the write helpers are used only by the feed Worker.

/** One account's cached feed. Rows are already scoped by the `by_user` index. */
export async function loadFeed(userId: string): Promise<LoadedFeed> {
  const [channels, videos, meta] = await Promise.all([
    getRowsByUser<Channel>('channels', userId),
    getRowsByUser<Video>('videos', userId),
    getMeta(userId),
  ])
  return { channels, videos, feedFetchedAt: meta?.feedFetchedAt ?? 0 }
}

/** Cached video ids only — cheap even on a large store; no rows materialized. */
export function loadVideoIds(userId: string): Promise<string[]> {
  return getRowIdsByUser('videos', userId)
}

/** Cached videos published at or after `sinceIso`, the only staleness candidates. */
export function loadVideosSince(userId: string, sinceIso: string): Promise<Video[]> {
  return getVideosPublishedSince<Video>(userId, sinceIso)
}

/** Cached channel rows, read before a refresh to compare upload counts. */
export function loadChannels(userId: string): Promise<Channel[]> {
  return getRowsByUser<Channel>('channels', userId)
}

export function saveVideos(videos: Video[]): Promise<void> {
  return putRows('videos', videos)
}

export function saveChannels(channels: Channel[]): Promise<void> {
  return putRows('channels', channels)
}

export function markFetched(userId: string): Promise<void> {
  return putMeta({ userId, feedFetchedAt: Date.now() })
}

/**
 * Drop rows for channels the account no longer subscribes to. Run only once a
 * refresh has succeeded: an interrupted run's picture of the account is
 * incomplete, so it must not delete anything.
 */
export function pruneToSubscribed(userId: string, subscribed: Set<string>): Promise<void> {
  return Promise.all([
    pruneUserRows<Video>('videos', userId, (v) => subscribed.has(v.channelId)),
    pruneUserRows<Channel>('channels', userId, (c) => subscribed.has(c.id)),
  ]).then(() => undefined)
}

/** Clears one account's cache only; other accounts on this browser are kept. */
export function clearFeed(userId: string): Promise<void> {
  return clearUser(userId)
}

// --- Tags -------------------------------------------------------------------
//
// Tags are user curation, not cache: the refresh worker never touches them and
// clearing the feed cache leaves them in place (channel assignments point at
// channel ids, which come back with the next refresh).

export function loadTags(userId: string): Promise<Tag[]> {
  return getRowsByUser<Tag>('tags', userId)
}

/** Insert or update one tag row (create, rename and assignment all land here). */
export function saveTag(tag: Tag): Promise<void> {
  return putRows('tags', [tag])
}

/** Batch upsert, used by the file import so many rows land in one transaction. */
export function saveTags(tags: Tag[]): Promise<void> {
  return putRows('tags', tags)
}

export function removeTag(userId: string, tagId: string): Promise<void> {
  return deleteRow('tags', userId, tagId)
}

// --- API quota counter ------------------------------------------------------
//
// The YouTube daily quota resets at midnight Pacific time, so usage is counted
// against the Pacific calendar day. The counter is global (shared across every
// account on this browser) because the quota belongs to the OAuth project.

/** The current Pacific calendar day as `YYYY-MM-DD`, DST-correct via `Intl`. */
export function pacificDay(ts: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(ts)
}

/**
 * API calls used so far in the current quota day. A stored count from an earlier
 * day reads as 0: that day's quota has already reset.
 */
export async function loadQuotaUsed(): Promise<number> {
  const row = await getQuota()
  return row && row.date === pacificDay() ? row.used : 0
}

export function saveQuota(date: string, used: number): Promise<void> {
  return putQuota(date, used)
}
