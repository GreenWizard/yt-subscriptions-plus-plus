import type { FeedRules, SortKey, Video } from './types'

export const SORT_LABELS: Record<SortKey, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  views: 'Most views',
  viewsPerHour: 'Trending (views/hour)',
  longest: 'Longest first',
  shortest: 'Shortest first',
}

function ageHours(video: Video): number {
  return Math.max(1, (Date.now() - new Date(video.publishedAt).getTime()) / 3_600_000)
}

export function viewsPerHour(video: Video): number {
  return video.viewCount / ageHours(video)
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

  return sortVideos(filtered, rules.sort)
}

export function sortVideos(videos: Video[], sort: SortKey): Video[] {
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
    // 'newest', and anything that is not a SortKey at all. The type says that
    // cannot happen, but the value can come from persisted state, and falling
    // out of the switch returns `undefined` — which blanks the entire app.
    // `loadRules` screens it too; this is the half that cannot be bypassed.
    case 'newest':
    default:
      return sorted.sort(byDate)
  }
}
