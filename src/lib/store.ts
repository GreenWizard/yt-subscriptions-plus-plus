import { idbGet, idbSet, idbDel } from './idb'
import { DEFAULT_RULES, type Channel, type FeedRules, type Video } from './types'

const RULES_KEY = 'ytd.rules'
const CACHE_KEY = 'cache.v1'

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
    // Merge so rules saved by an older version still pick up new defaults.
    return { ...DEFAULT_RULES, ...(JSON.parse(raw) as Partial<FeedRules>) }
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

/** Drop cached videos outside the retention window so the store stays small. */
export function pruneVideos(videos: Video[], retentionDays: number): Video[] {
  const cutoff = Date.now() - Math.max(retentionDays, 1) * 86400_000
  return videos.filter((v) => new Date(v.publishedAt).getTime() >= cutoff)
}

/** Last-write-wins merge of freshly fetched videos over the cached set. */
export function mergeVideos(cached: Video[], fresh: Video[]): Video[] {
  const byId = new Map(cached.map((v) => [v.id, v]))
  for (const v of fresh) byId.set(v.id, v)
  return [...byId.values()]
}
