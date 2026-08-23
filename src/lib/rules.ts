import type { FeedRules, SortKey, Video } from './types'

export const SORT_LABELS: Record<SortKey, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  views: 'Most views',
  viewsPerHour: 'Trending (views/hour)',
  longest: 'Longest first',
  shortest: 'Shortest first',
}

const SHORTS_MAX_SEC = 60

export function ageHours(video: Video): number {
  return Math.max(1, (Date.now() - new Date(video.publishedAt).getTime()) / 3_600_000)
}

export function viewsPerHour(video: Video): number {
  return video.viewCount / ageHours(video)
}

export function applyRules(videos: Video[], rules: FeedRules): Video[] {
  const cutoff = Date.now() - rules.lookbackDays * 86400_000
  const muted = new Set(rules.mutedChannels)
  const needle = rules.query.trim().toLowerCase()
  const minSec = rules.minMinutes * 60
  const maxSec = rules.maxMinutes > 0 ? rules.maxMinutes * 60 : Infinity

  const filtered = videos.filter((v) => {
    if (new Date(v.publishedAt).getTime() < cutoff) return false
    if (muted.has(v.channelId)) return false
    if (rules.hideShorts && v.durationSec > 0 && v.durationSec <= SHORTS_MAX_SEC) return false
    // Live streams report a zero duration; length filters cannot apply to them.
    if (v.durationSec > 0 && (v.durationSec < minSec || v.durationSec > maxSec)) return false
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
    case 'newest':
      return sorted.sort(byDate)
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
  }
}
