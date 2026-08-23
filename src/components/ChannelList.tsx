import { memo, type ReactNode } from 'react'
import { formatAge } from '../lib/format'
import type { ChannelRow } from '../lib/rules'
import type { Video } from '../lib/types'
import { VirtualGrid } from './VirtualGrid'

interface Props {
  rows: ChannelRow[]
  onToggleMute: (channelId: string) => void
  renderVideo: (video: Video) => ReactNode
}

/**
 * One channel per row, with that channel's newest videos beside it.
 *
 * Virtualized through the same component as the video grid, one row per column
 * instead of many. It has to be: 350 subscriptions is 1750 cards and some
 * 11,500 nodes, and React mounts every one of them in the commit that opens the
 * view, which froze the tab for as long as it took. `content-visibility` was
 * not enough — it skips layout and paint for off-screen rows, but the mounting
 * and the nodes are what cost, and those happen either way.
 */
export function ChannelList({ rows, onToggleMute, renderVideo }: Props) {
  return (
    <VirtualGrid
      items={rows}
      className="channels"
      itemSelector=".channel-row"
      renderItem={(row) => (
        <ChannelRowView
          key={row.channel.id}
          row={row}
          onToggleMute={onToggleMute}
          renderVideo={renderVideo}
        />
      )}
    />
  )
}

/**
 * Memoized like `VideoCard`, and for the same reason: virtualizing re-renders
 * the list on every scroll event, and the row object behind each of these is
 * rebuilt only when the cache or the rules change.
 */
const ChannelRowView = memo(function ChannelRowView({
  row,
  onToggleMute,
  renderVideo,
}: {
  row: ChannelRow
  onToggleMute: (channelId: string) => void
  renderVideo: (video: Video) => ReactNode
}) {
  const { channel, videos, videoCount, latestAt, muted } = row
  const channelUrl = `https://www.youtube.com/channel/${channel.id}`

  return (
    <section className={`channel-row${muted ? ' muted' : ''}`}>
      <div className="channel-head">
        <a className="channel-id" href={channelUrl} target="_blank" rel="noreferrer">
          {channel.thumbnail ? (
            <img src={channel.thumbnail} alt="" loading="lazy" />
          ) : (
            <span className="channel-avatar-fallback" />
          )}
          <span className="channel-name">{channel.title}</span>
        </a>

        <span className="channel-stats">
          {videoCount === 0
            ? 'Nothing indexed yet'
            : `${videoCount} indexed · latest ${formatAge(latestAt)}`}
        </span>

        <button
          className="chip channel-mute"
          onClick={() => onToggleMute(channel.id)}
          // Muting hides the channel from the other view, not this one, so say
          // which feed the switch acts on rather than leaving it to be guessed.
          title={muted ? 'Show this channel in the video feed' : 'Hide this channel from the video feed'}
        >
          {muted ? 'Unmute' : 'Mute'}
        </button>
      </div>

      <div className="channel-videos">
        {videos.length > 0 ? videos.map(renderVideo) : <BlankCard />}
      </div>
    </section>
  )
})

/**
 * Stands in for a channel with nothing indexed yet.
 *
 * Built from the card classes rather than styled as a note of its own, which is
 * what keeps every row exactly one card tall — the thumbnail's aspect ratio and
 * the two-line title clamp give it a real card's height at whatever width the
 * column happens to be. Virtualizing measures one row and applies that height
 * to all of them, so a shorter row here would mis-place every row below it.
 */
function BlankCard() {
  return (
    <div className="card blank">
      <div className="thumb" />
      <span className="card-title">Nothing indexed yet</span>
      <div className="card-meta">Refresh to index this channel</div>
    </div>
  )
}
