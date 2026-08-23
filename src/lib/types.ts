export interface Channel {
  id: string
  title: string
  thumbnail: string
}

/**
 * Which auto-generated channel playlist a video came from. YouTube splits a
 * channel's uploads into long-form (UULF), Shorts (UUSH), and live (UULV);
 * `unknown` means it came from the combined UU fallback and was classified by
 * duration instead.
 */
export type VideoKind = 'long' | 'short' | 'live'

export interface Video {
  id: string
  channelId: string
  channelTitle: string
  title: string
  description: string
  thumbnail: string
  publishedAt: string // ISO 8601
  durationSec: number
  viewCount: number
  likeCount: number
  commentCount: number
  isLive: boolean
  kind: VideoKind
}

export type SortKey =
  | 'newest'
  | 'oldest'
  | 'views'
  | 'viewsPerHour'
  | 'longest'
  | 'shortest'

export interface FeedRules {
  sort: SortKey
  hideShorts: boolean
  minMinutes: number
  maxMinutes: number // 0 = no upper bound
  query: string
  mutedChannels: string[]
}

export const DEFAULT_RULES: FeedRules = {
  sort: 'newest',
  hideShorts: true,
  minMinutes: 0,
  maxMinutes: 0,
  query: '',
  mutedChannels: [],
}

/** Videos read per playlist per channel on a refresh (50 per API call). */
export const PAGES_PER_PLAYLIST = 2
