import { memo } from 'react'
import { formatAge, formatCount, formatDuration } from '../lib/format'
import { viewsPerHour } from '../lib/rules'
import type { Channel, SortKey, Video } from '../lib/types'

interface Props {
  video: Video
  channel?: Channel
  sort: SortKey
}

/**
 * Memoized because VirtualGrid re-renders on every scroll event, which rebuilds
 * every mounted card's element ~60 times a second. All three props are stable
 * identities — `mergeVideos` keeps untouched rows, and the channel map is
 * memoized — so the shallow compare actually bails rather than just moving the
 * cost around.
 */
export const VideoCard = memo(function VideoCard({ video, channel, sort }: Props) {
  const watchUrl = `https://www.youtube.com/watch?v=${video.id}`
  const channelUrl = `https://www.youtube.com/channel/${video.channelId}`

  return (
    <div className="card">
      <a className="thumb" href={watchUrl} target="_blank" rel="noreferrer">
        {video.thumbnail && <img src={video.thumbnail} alt="" loading="lazy" />}
        <span className={`badge${video.isLive ? ' live' : ''}`}>
          {video.isLive ? 'LIVE' : formatDuration(video.durationSec)}
        </span>
      </a>

      <a className="card-title" href={watchUrl} target="_blank" rel="noreferrer" title={video.title}>
        {video.title}
      </a>

      <div className="card-channel">
        {channel?.thumbnail && <img src={channel.thumbnail} alt="" loading="lazy" />}
        <a href={channelUrl} target="_blank" rel="noreferrer">
          {video.channelTitle}
        </a>
      </div>

      <div className="card-meta">
        {formatCount(video.viewCount)} views · {formatAge(video.publishedAt)}
        {sort === 'viewsPerHour' && (
          <>
            {' '}
            <span className="trend">{formatCount(Math.round(viewsPerHour(video)))}/h</span>
          </>
        )}
      </div>
    </div>
  )
})
