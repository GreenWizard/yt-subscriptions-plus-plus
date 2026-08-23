import { idbGet, idbSet, idbDel } from './idb'
import {
  CHANNEL_SORT_KEYS,
  DEFAULT_RULES,
  SORT_KEYS,
  type Channel,
  type ChannelSortKey,
  type FeedRules,
  type SortKey,
  type Video,
} from './types'

// Keys are versioned; earlier shapes are left behind rather than migrated.
const RULES_KEY = 'ytd.rules.v2'
// One cache record per signed-in YouTube account, so a second account's refresh
// cannot overwrite the first account's feed.
const CACHE_PREFIX = 'cache.v3.'
const LAST_USER_KEY = 'ytd.lastUserId'

const cacheKey = (userId: string) => `${CACHE_PREFIX}${userId}`

/** The account whose cache should be shown before sign-in completes. */
export function getLastUserId(): string | null {
  return localStorage.getItem(LAST_USER_KEY)
}

export function setLastUserId(userId: string): void {
  localStorage.setItem(LAST_USER_KEY, userId)
}

export interface FeedCache {
  userId: string
  channels: Channel[]
  videos: Video[]
  feedFetchedAt: number
}

function sortKey(value: unknown): SortKey {
  return (SORT_KEYS as readonly unknown[]).includes(value) ? (value as SortKey) : DEFAULT_RULES.sort
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

/** Only an unsigned 32-bit int is meaningful to `shuffleRank`'s mixing. */
function shuffleSeed(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >>> 0 === value
    ? value
    : DEFAULT_RULES.shuffleSeed
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
      channelSort: channelSortKey(s.channelSort),
      channelQuery: typeof s.channelQuery === 'string' ? s.channelQuery : DEFAULT_RULES.channelQuery,
      shuffleSeed: shuffleSeed(s.shuffleSeed),
    }
  } catch {
    return DEFAULT_RULES
  }
}

export function saveRules(rules: FeedRules): void {
  localStorage.setItem(RULES_KEY, JSON.stringify(rules))
}

export async function loadCache(userId: string): Promise<FeedCache | undefined> {
  return idbGet<FeedCache>(cacheKey(userId))
}

export async function saveCache(cache: FeedCache): Promise<void> {
  await idbSet(cacheKey(cache.userId), cache)
}

/** Clears one account's cache only; other accounts on this browser are kept. */
export async function clearCache(userId: string): Promise<void> {
  await idbDel(cacheKey(userId))
}

/**
 * Records are keyed per account, so in normal use this filters nothing; it
 * guards against a record left by an account-blind build showing one account's
 * feed to another.
 */
export function rowsForUser<T extends { userId: string }>(rows: T[], userId: string): T[] {
  return rows.filter((r) => r.userId === userId)
}

/**
 * Last-write-wins by id: rows the API returned again are updated in place, rows
 * it did not mention are kept. A refresh only ever adds to the cache, so history
 * already indexed is never re-fetched and never lost.
 */
export function mergeVideos(cached: Video[], fresh: Video[]): Video[] {
  const byId = new Map(cached.map((v) => [v.id, v]))
  for (const v of fresh) byId.set(v.id, v)
  return [...byId.values()]
}

/**
 * Same merge for channels. Unsubscribing must not delete the channel row, or
 * every cached video from it loses its avatar.
 */
export function mergeChannels(cached: Channel[], fresh: Channel[]): Channel[] {
  const byId = new Map(cached.map((c) => [c.id, c]))
  for (const c of fresh) byId.set(c.id, c)
  return [...byId.values()]
}
