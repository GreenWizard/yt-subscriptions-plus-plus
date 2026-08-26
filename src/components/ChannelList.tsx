import { memo, type ReactNode } from 'react'
import { formatAge } from '../lib/format'
import type { ChannelRow } from '../lib/rules'
import type { Tag, Video } from '../lib/types'
import { ChannelTagPicker, type TagActions } from './Tags'
import { VirtualGrid } from './VirtualGrid'

interface Props {
  rows: ChannelRow[]
  tags: Tag[]
  tagActions: TagActions
  onToggleMute: (channelId: string) => void
  renderVideo: (video: Video) => ReactNode
}

/**
 * One channel per row, virtualized through the same component as the video grid
 * with a single column. It has to be: 350 subscriptions is 1750 cards mounted in
 * the commit that opens the view. `content-visibility` does not help — it skips
 * layout and paint, but mounting is what costs.
 */
export function ChannelList({ rows, tags, tagActions, onToggleMute, renderVideo }: Props) {
  return (
    <VirtualGrid
      items={rows}
      className="channels"
      itemSelector=".channel-row"
      renderItem={(row) => (
        <ChannelRowView
          key={row.channel.id}
          row={row}
          tags={tags}
          tagActions={tagActions}
          onToggleMute={onToggleMute}
          renderVideo={renderVideo}
        />
      )}
    />
  )
}

/** Memoized like `VideoCard`: virtualizing re-renders the list on every scroll. */
const ChannelRowView = memo(function ChannelRowView({
  row,
  tags,
  tagActions,
  onToggleMute,
  renderVideo,
}: {
  row: ChannelRow
  tags: Tag[]
  tagActions: TagActions
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

        <ChannelTagPicker channelId={channel.id} tags={tags} actions={tagActions} />

        <span className="channel-stats">
          {videoCount === 0
            ? 'Nothing indexed yet'
            : `${videoCount} indexed · latest ${formatAge(latestAt)}`}
        </span>

        <button
          className="chip channel-mute"
          onClick={() => onToggleMute(channel.id)}
          // Muting acts on the video feed, not on this list.
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
 * Built from the card classes rather than styled as a note of its own: that is
 * what gives it a real card's height at any column width. Virtualizing measures
 * one row and applies that height to all of them, so a shorter row here would
 * mis-place every row below it.
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
