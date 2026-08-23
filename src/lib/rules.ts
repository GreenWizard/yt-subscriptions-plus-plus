import type { FeedRules, SortKey, Video } from './types'

export const SORT_LABELS: Record<SortKey, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  views: 'Most views',
  viewsPerHour: 'Trending (views/hour)',
  longest: 'Longest first',
  shortest: 'Shortest first',
  shuffle: 'Shuffle',
}

function ageHours(video: Video): number {
  return Math.max(1, (Date.now() - new Date(video.publishedAt).getTime()) / 3_600_000)
}

export function viewsPerHour(video: Video): number {
  return video.viewCount / ageHours(video)
}

/** A fresh `shuffleSeed`: an unsigned 32-bit int, which is what mixing takes. */
export function randomShuffleSeed(): number {
  return (Math.random() * 0x1_0000_0000) >>> 0
}

/**
 * Where one video lands in the shuffle: the seed mixed with the video id
 * (FNV-1a, then an avalanche step so neighbouring seeds do not produce
 * neighbouring orders). Hashing rather than dealing a Fisher-Yates permutation
 * keeps the order a property of the video itself, so it survives filtering — a
 * video's place relative to the others does not move when a search narrows the
 * feed around it, and a refresh drops new videos into the existing order rather
 * than re-dealing it.
 */
function shuffleRank(id: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^ (h >>> 16)) >>> 0
}

/**
 * Ranks are computed once per video instead of inside the comparator, which
 * would re-hash the same id on each of its ~log n comparisons.
 */
function shuffled(videos: Video[], seed: number): Video[] {
  return videos
    .map((video) => ({ video, rank: shuffleRank(video.id, seed) }))
    // Two ids can hash to the same 32-bit rank, and `sort` is only stable with
    // respect to the input order — which for the feed is IndexedDB insertion
    // order. Breaking ties on the id keeps one seed meaning one exact order.
    .sort((a, b) => a.rank - b.rank || (a.video.id < b.video.id ? -1 : 1))
    .map((entry) => entry.video)
}

export function applyRules(videos: Video[], rules: FeedRules): Video[] {
  const muted = new Set(rules.mutedChannels)
  const needle = rules.query.trim().toLowerCase()
  // Both ends are inclusive whole days in the viewer's own timezone, which is
  // the calendar the date picker showed them.
  const from = rules.fromDate ? new Date(`${rules.fromDate}T00:00:00`).getTime() : -Infinity
  const to = rules.toDate ? new Date(`${rules.toDate}T23:59:59.999`).getTime() : Infinity
  // Parsing a date per video is not free, and this list is re-filtered on
  // every keystroke, so skip it entirely when no window is set.
  const windowed = from > -Infinity || to < Infinity

  const filtered = videos.filter((v) => {
    if (muted.has(v.channelId)) return false
    // Shorts are not part of this feed. The Shorts playlist is never read, so
    // in practice this only catches the `UU` fallback path, which returns a
    // channel's uploads undivided and has nothing but duration to go on.
    if (v.kind === 'short') return false
    if (windowed) {
      const published = new Date(v.publishedAt).getTime()
      if (published < from || published > to) return false
    }
    if (needle && !v.title.toLowerCase().includes(needle) && !v.channelTitle.toLowerCase().includes(needle)) {
      return false
    }
    return true
  })

  return sortVideos(filtered, rules.sort, rules.shuffleSeed)
}

export function sortVideos(videos: Video[], sort: SortKey, shuffleSeed: number): Video[] {
  const byDate = (a: Video, b: Video) =>
    new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()

  const sorted = [...videos]
  switch (sort) {
    case 'oldest':
      return sorted.sort((a, b) => -byDate(a, b))
    case 'views':
      return sorted.sort((a, b) => b.viewCount - a.viewCount || byDate(a, b))
    case 'viewsPerHour':
      return sorted.sort((a, b) => viewsPerHour(b) - viewsPerHour(a) || byDate(a, b))
    case 'longest':
      return sorted.sort((a, b) => b.durationSec - a.durationSec || byDate(a, b))
    case 'shortest':
      return sorted.sort((a, b) => a.durationSec - b.durationSec || byDate(a, b))
    case 'shuffle':
      return shuffled(sorted, shuffleSeed)
    // 'newest', and anything that is not a SortKey at all. The type says that
    // cannot happen, but the value can come from persisted state, and falling
    // out of the switch returns `undefined` — which blanks the entire app.
    // `loadRules` screens it too; this is the half that cannot be bypassed.
    case 'newest':
    default:
      return sorted.sort(byDate)
  }
}
