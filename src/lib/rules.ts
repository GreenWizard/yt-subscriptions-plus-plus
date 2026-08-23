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

/**
 * Whether a video belongs in either view at all. Shorts do not: the Shorts
 * playlist is never read, so in practice this only catches the `UU` fallback
 * path, which returns a channel's uploads undivided and has nothing but
 * duration to go on. Shared so the grid and the channel list cannot disagree
 * about what the feed contains.
 */
function inFeed(video: Video): boolean {
  return video.kind !== 'short'
}

/**
 * Newest first.
 *
 * Compares the ISO strings rather than parsing them. The API returns UTC
 * timestamps in one fixed width (`2024-01-02T03:04:05Z`), so lexicographic
 * order is chronological order — the same property `insertNewest` leans on.
 * Were a row ever to carry milliseconds where another does not, the only thing
 * at stake is the order of two videos published in the same second.
 *
 * Parsing instead cost two `Date` objects per comparison, which on a 300k-video
 * feed is some 11 million of them: measured at 1130ms to order the feed, where
 * this is under 100ms. It is the comparator behind every sort here, either
 * directly or as the tie-break, so it is the one worth being careful with.
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

/**
 * A local calendar day's midnight as a string that `publishedAt` can be
 * compared against directly, or '' when that end of the window is unbounded.
 * `nextDay` gives the following midnight, which is how the inclusive end of the
 * window is expressed: everything strictly before it.
 *
 * Converting the two bounds once turns the filter into a pair of string
 * comparisons; parsing every video's date instead cost 596ms over a 300k-video
 * feed. `setDate` rather than arithmetic on the timestamp so the next midnight
 * is still midnight across a DST change.
 *
 * The trailing `Z` is dropped so the bound is a strict prefix of any instant
 * inside that second, which is what keeps the comparison right whatever
 * precision the timestamps carry. `toISOString` always writes milliseconds and
 * the API never does, and comparing those two widths directly gets the edges
 * wrong: `…T23:59:59Z` sorts *after* `…T23:59:59.999Z`, so the last second of
 * the window would have been excluded from it.
 *
 * A day that does not parse gives '', disabling that end rather than throwing —
 * `toISOString` raises on an invalid date, and this runs on rules restored from
 * storage.
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
    // Strictly before the following midnight, which is the whole of `toDate`.
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
    // 'newest', and anything that is not a SortKey at all. The type says that
    // cannot happen, but the value can come from persisted state, and falling
    // out of the switch returns `undefined` — which blanks the entire app.
    // `loadRules` screens it too; this is the half that cannot be bypassed.
    case 'newest':
    default:
      return sorted.sort(compareDate)
  }
}

/**
 * Videos by views per hour, highest first.
 *
 * Decorated like the shuffle: the rate is the one ordering here that genuinely
 * needs a parsed date, so it is computed once per video rather than on each of
 * the ~18 comparisons that video takes part in. That is 300k parses instead of
 * 11 million — measured at 1630ms before, and roughly a tenth of that now.
 */
function byRate(videos: Video[]): Video[] {
  return videos
    .map((video) => ({ video, rate: viewsPerHour(video) }))
    .sort((a, b) => b.rate - a.rate || compareDate(a.video, b.video))
    .map((entry) => entry.video)
}

/** One channel's row in the channel list: the channel, and its newest videos. */
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
 * Inserts a video into a list held newest-first and capped at
 * `VIDEOS_PER_CHANNEL_ROW`, dropping whatever falls off the end.
 *
 * Selecting the head like this costs a handful of comparisons per video, where
 * collecting each channel's full history and sorting it would allocate and sort
 * the entire cache — on every keystroke in the channel search.
 *
 * The comparison is on the ISO strings rather than parsed dates: the API
 * returns UTC timestamps in one fixed width (`2024-01-02T03:04:05Z`), so they
 * order lexicographically exactly as they do chronologically, and this way
 * nothing here parses a date at all.
 */
function insertNewest(newest: Video[], video: Video): void {
  let i = newest.length
  while (i > 0 && newest[i - 1].publishedAt < video.publishedAt) i--
  if (i >= VIDEOS_PER_CHANNEL_ROW) return
  newest.splice(i, 0, video)
  if (newest.length > VIDEOS_PER_CHANNEL_ROW) newest.pop()
}

/**
 * Builds the channel list out of the same two cached collections the grid reads.
 *
 * Subscriptions are the authority on which rows exist, so a channel with
 * nothing indexed yet still gets a row — an empty row is a true statement about
 * the cache, and hiding it would make a half-finished index look complete.
 * Muted channels get a row too, since the channel list is where muting is
 * undone.
 */
export function channelRows(
  videos: Video[],
  channels: Channel[],
  rules: FeedRules,
): ChannelRow[] {
  const needle = rules.channelQuery.trim().toLowerCase()
  const muted = new Set(rules.mutedChannels)

  // Match the channels first, then walk the videos once. A video whose channel
  // no row will show is skipped on a single map lookup, so searching gets
  // cheaper as it narrows rather than more expensive.
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
    // 'recent', and anything a persisted rule may hold that is not a
    // ChannelSortKey at all: falling out of the switch would return `undefined`
    // and blank the view, the same way an unrecognized video sort once did.
    case 'recent':
    default:
      // Channels with nothing indexed have no date to sort by, and '' compares
      // below every real timestamp, which lands them last where they belong.
      return sorted.sort((a, b) => (a.latestAt < b.latestAt ? 1 : a.latestAt > b.latestAt ? -1 : byName(a, b)))
  }
}
