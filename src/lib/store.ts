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

/** Cap on cached videos, newest kept, to bound IndexedDB growth. */
const MAX_CACHED_VIDEOS = 4000

export interface FeedCache {
  userId: string
  channels: Channel[]
  videos: Video[]
  subsFetchedAt: number
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

/** Keep the newest videos only, so the cache cannot grow without bound. */
export function pruneVideos(videos: Video[]): Video[] {
  if (videos.length <= MAX_CACHED_VIDEOS) return videos
  return [...videos]
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, MAX_CACHED_VIDEOS)
}

/** Last-write-wins merge of freshly fetched videos over the cached set. */
export function mergeVideos(cached: Video[], fresh: Video[]): Video[] {
  const byId = new Map(cached.map((v) => [v.id, v]))
  for (const v of fresh) byId.set(v.id, v)
  return [...byId.values()]
}
