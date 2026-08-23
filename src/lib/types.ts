export interface Channel {
  id: string
  title: string
  thumbnail: string
}

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
  lookbackDays: number
  query: string
  mutedChannels: string[]
}

export const DEFAULT_RULES: FeedRules = {
  sort: 'newest',
  hideShorts: true,
  minMinutes: 0,
  maxMinutes: 0,
  lookbackDays: 14,
  query: '',
  mutedChannels: [],
}
