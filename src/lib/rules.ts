import {
  VIDEOS_PER_CHANNEL_ROW,
  type Channel,
  type ChannelSortKey,
  type FeedRules,
  type SortKey,
  type Video,
} from './types'

export const SORT_LABELS: Record<SortKey, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  views: 'Most views',
  viewsPerHour: 'Trending (views/hour)',
  longest: 'Longest first',
  shortest: 'Shortest first',
  shuffle: 'Shuffle',
}

export const CHANNEL_SORT_LABELS: Record<ChannelSortKey, string> = {
  recent: 'Most recent upload',
  name: 'Channel name (A–Z)',
}

/** Shared so the grid and the channel list cannot disagree about the feed. */
function inFeed(video: Video): boolean {
  return video.kind !== 'short'
}

/**
 * Newest first, comparing the ISO strings rather than parsing them: the API
 * returns UTC timestamps in one fixed width, so lexicographic order is
 * chronological order. Parsing cost two `Date` objects per comparison — 11
 * million of them on a 300k-video feed, measured at 1130ms against under 100ms
 * here. This is the comparator behind every sort below, directly or as the
 * tie-break.
 */
function compareDate(a: Video, b: Video): number {
  return a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0
}

function ageHours(video: Video): number {
  return Math.max(1, (Date.now() - new Date(video.publishedAt).getTime()) / 3_600_000)
}

export function viewsPerHour(video: Video): number {
  return video.viewCount / ageHours(video)
}

export function randomShuffleSeed(): number {
  return (Math.random() * 0x1_0000_0000) >>> 0
}

/**
 * Where one video lands in the shuffle: the seed mixed with the video id (FNV-1a
 * plus an avalanche step, so neighbouring seeds do not give neighbouring
 * orders). Hashing rather than dealing a permutation keeps the order a property
 * of the video itself, so it survives filtering — a search narrowing the feed
 * does not move what is left, and a refresh drops new videos into the existing
 * order rather than re-dealing it.
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

/** Ranks are computed once per video, not inside the comparator's ~log n calls. */
function shuffled(videos: Video[], seed: number): Video[] {
  return videos
    .map((video) => ({ video, rank: shuffleRank(video.id, seed) }))
    // Two ids can hash to the same 32-bit rank, and `sort` is only stable with
    // respect to input order. Breaking ties on the id keeps one seed meaning one
    // exact order.
    .sort((a, b) => a.rank - b.rank || (a.video.id < b.video.id ? -1 : 1))
    .map((entry) => entry.video)
}

/**
 * A local midnight as a string comparable against `publishedAt` directly, or ''
 * when that end is unbounded. `nextDay` gives the following midnight, which is
 * how the inclusive end of the window is expressed. Converting the bounds once
 * turns the filter into two string comparisons; parsing every video's date
 * instead cost 596ms over a 300k-video feed.
 *
 * The trailing `Z` is dropped so the bound is a strict prefix of any instant
 * inside that second. `toISOString` always writes milliseconds and the API never
 * does, and comparing the two widths directly gets the edges wrong:
 * `…T23:59:59Z` sorts after `…T23:59:59.999Z`, which excluded the last second of
 * the window. `setDate` rather than timestamp arithmetic so the next midnight is
 * still midnight across a DST change.
 */
function isoBound(day: string, nextDay: boolean): string {
  if (!day) return ''
  const d = new Date(`${day}T00:00:00`)
  if (Number.isNaN(d.getTime())) return ''
  if (nextDay) d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, -1)
}

export function applyRules(videos: Video[], rules: FeedRules): Video[] {
  const muted = new Set(rules.mutedChannels)
  const needle = rules.query.trim().toLowerCase()
  const from = isoBound(rules.fromDate, false)
  const to = isoBound(rules.toDate, true)

  const filtered = videos.filter((v) => {
    if (muted.has(v.channelId)) return false
    if (!inFeed(v)) return false
    if (from && v.publishedAt < from) return false
    if (to && v.publishedAt >= to) return false
    if (needle && !v.title.toLowerCase().includes(needle) && !v.channelTitle.toLowerCase().includes(needle)) {
      return false
    }
    return true
  })

  return sortVideos(filtered, rules.sort, rules.shuffleSeed)
}

export function sortVideos(videos: Video[], sort: SortKey, shuffleSeed: number): Video[] {
  const sorted = [...videos]
  switch (sort) {
    case 'oldest':
      return sorted.sort((a, b) => -compareDate(a, b))
    case 'views':
      return sorted.sort((a, b) => b.viewCount - a.viewCount || compareDate(a, b))
    case 'viewsPerHour':
      return byRate(sorted)
    case 'longest':
      return sorted.sort((a, b) => b.durationSec - a.durationSec || compareDate(a, b))
    case 'shortest':
      return sorted.sort((a, b) => a.durationSec - b.durationSec || compareDate(a, b))
    case 'shuffle':
      return shuffled(sorted, shuffleSeed)
    // The `default` is not dead: the value can come from persisted state, and
    // falling out of the switch returns `undefined`, which blanks the app.
    case 'newest':
    default:
      return sorted.sort(compareDate)
  }
}

/** Decorated like the shuffle: the rate needs a parsed date, so parse once per video. */
function byRate(videos: Video[]): Video[] {
  return videos
    .map((video) => ({ video, rate: viewsPerHour(video) }))
    .sort((a, b) => b.rate - a.rate || compareDate(a.video, b.video))
    .map((entry) => entry.video)
}

export interface ChannelRow {
  channel: Channel
  /** Newest first, at most `VIDEOS_PER_CHANNEL_ROW` of them. */
  videos: Video[]
  /** Everything indexed for this channel, not just what the row shows. */
  videoCount: number
  /** `publishedAt` of the newest indexed video; '' when nothing is indexed. */
  latestAt: string
  muted: boolean
}

/**
 * Selecting the head costs a handful of comparisons per video, where collecting
 * each channel's full history and sorting it would sort the entire cache on
 * every keystroke in the channel search.
 */
function insertNewest(newest: Video[], video: Video): void {
  let i = newest.length
  while (i > 0 && newest[i - 1].publishedAt < video.publishedAt) i--
  if (i >= VIDEOS_PER_CHANNEL_ROW) return
  newest.splice(i, 0, video)
  if (newest.length > VIDEOS_PER_CHANNEL_ROW) newest.pop()
}

/**
 * Subscriptions are the authority on which rows exist, so a channel with nothing
 * indexed still gets a row — hiding it would make a half-finished index look
 * complete. Muted channels get a row too, since this is where muting is undone.
 */
export function channelRows(
  videos: Video[],
  channels: Channel[],
  rules: FeedRules,
): ChannelRow[] {
  const needle = rules.channelQuery.trim().toLowerCase()
  const muted = new Set(rules.mutedChannels)

  // Match channels first, then walk the videos once: a video whose channel no
  // row will show is skipped on a single map lookup, so searching gets cheaper
  // as it narrows rather than more expensive.
  const rows = new Map<string, ChannelRow>()
  for (const channel of channels) {
    if (needle && !channel.title.toLowerCase().includes(needle)) continue
    rows.set(channel.id, {
      channel,
      videos: [],
      videoCount: 0,
      latestAt: '',
      muted: muted.has(channel.id),
    })
  }

  for (const video of videos) {
    const row = rows.get(video.channelId)
    if (!row || !inFeed(video)) continue
    row.videoCount++
    if (video.publishedAt > row.latestAt) row.latestAt = video.publishedAt
    insertNewest(row.videos, video)
  }

  return sortChannelRows([...rows.values()], rules.channelSort)
}

export function sortChannelRows(rows: ChannelRow[], sort: ChannelSortKey): ChannelRow[] {
  const byName = (a: ChannelRow, b: ChannelRow) =>
    a.channel.title.localeCompare(b.channel.title, undefined, { sensitivity: 'base' })

  const sorted = [...rows]
  switch (sort) {
    case 'name':
      return sorted.sort(byName)
    // Same guard as `sortVideos`: a persisted value that is not a ChannelSortKey
    // would fall through and return `undefined`.
    case 'recent':
    default:
      // '' compares below every real timestamp, landing un-indexed channels last.
      return sorted.sort((a, b) => (a.latestAt < b.latestAt ? 1 : a.latestAt > b.latestAt ? -1 : byName(a, b)))
  }
}
