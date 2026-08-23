import { idbGet, idbSet, idbDel } from './idb'
import { DEFAULT_RULES, type Channel, type FeedRules, type Video } from './types'

// Both keys are versioned: the v1 shapes predate per-video `kind` and the
// removal of the lookback window, so old entries are simply left behind.
const RULES_KEY = 'ytd.rules.v2'
const CACHE_KEY = 'cache.v2'

/** Cap on cached videos, newest kept, to bound IndexedDB growth. */
const MAX_CACHED_VIDEOS = 4000

export interface FeedCache {
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

export async function loadCache(): Promise<FeedCache | undefined> {
  return idbGet<FeedCache>(CACHE_KEY)
}

export async function saveCache(cache: FeedCache): Promise<void> {
  await idbSet(CACHE_KEY, cache)
}

export async function clearCache(): Promise<void> {
  await idbDel(CACHE_KEY)
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
