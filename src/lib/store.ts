import { idbGet, idbSet, idbDel } from './idb'
import { DEFAULT_RULES, type Channel, type FeedRules, type Video } from './types'

// Keys are versioned; earlier shapes predate per-video `kind` and per-row
// `userId`, so old entries are simply left behind rather than migrated.
const RULES_KEY = 'ytd.rules.v2'
// One cache record per signed-in YouTube account. A single shared key meant a
// second account's refresh overwrote the first account's feed.
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

export function loadRules(): FeedRules {
  try {
    const raw = localStorage.getItem(RULES_KEY)
    if (!raw) return DEFAULT_RULES
    const saved = JSON.parse(raw) as Partial<FeedRules>
    // Take only keys that still exist, so removed rules cannot linger.
    const merged = { ...DEFAULT_RULES }
    for (const key of Object.keys(DEFAULT_RULES) as (keyof FeedRules)[]) {
      if (saved[key] !== undefined) (merged[key] as unknown) = saved[key]
    }
    return merged
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
 * The rows of a cache record that belong to `userId`. Records are keyed per
 * account, so in normal use this filters nothing; it is a guard against a
 * record left by an account-blind build showing one account's feed to another.
 */
export function rowsForUser<T extends { userId: string }>(rows: T[], userId: string): T[] {
  return rows.filter((r) => r.userId === userId)
}

/**
 * Merge freshly fetched videos over the cached set: rows the API returned again
 * are updated in place, rows it did not mention are kept untouched. A refresh
 * only ever adds to the cache, so history already indexed is never re-fetched
 * and never lost — earlier versions capped the cache and silently dropped the
 * oldest rows on every refresh.
 */
export function mergeVideos(cached: Video[], fresh: Video[]): Video[] {
  const byId = new Map(cached.map((v) => [v.id, v]))
  for (const v of fresh) byId.set(v.id, v)
  return [...byId.values()]
}

/**
 * Same last-write-wins merge for channels. Unsubscribing must not delete the
 * channel row, or every cached video from it loses its avatar.
 */
export function mergeChannels(cached: Channel[], fresh: Channel[]): Channel[] {
  const byId = new Map(cached.map((c) => [c.id, c]))
  for (const c of fresh) byId.set(c.id, c)
  return [...byId.values()]
}
