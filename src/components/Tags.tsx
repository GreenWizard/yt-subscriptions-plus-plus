import { useState, type CSSProperties } from 'react'
import {
  DEFAULT_TAG_COLOR,
  MAX_TAGS_PER_CHANNEL,
  TAG_COLORS,
  type FeedRules,
  type Tag,
} from '../lib/types'

/** Tag CRUD, implemented by App (state + IDB writes live there). */
export interface TagActions {
  /** Creates the tag, optionally assigning it to a channel in the same write. */
  onCreate: (name: string, channelId?: string) => void
  onRename: (tagId: string, name: string) => void
  onRecolor: (tagId: string, color: string) => void
  onDelete: (tagId: string) => void
  /** Assigns or unassigns one tag on one channel. */
  onToggleChannel: (tagId: string, channelId: string) => void
}

const byName = (a: Tag, b: Tag) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })

/**
 * Near-black or white, whichever is legible on `bg` — perceived luminance by
 * the Rec. 601 weights, split at the midpoint. Flipping the text beats fencing
 * the palette: it lets the palette carry both light and dark shades.
 */
export function tagTextColor(bg: string): string {
  const r = parseInt(bg.slice(1, 3), 16)
  const g = parseInt(bg.slice(3, 5), 16)
  const b = parseInt(bg.slice(5, 7), 16)
  return 0.299 * r + 0.587 * g + 0.114 * b > 128 ? '#111114' : '#ffffff'
}

const tagColor = (tag: Tag): string => tag.color ?? DEFAULT_TAG_COLOR

/** Inline styles for a chip wearing its tag's color. */
function tagChipStyle(tag: Tag): CSSProperties {
  const bg = tagColor(tag)
  return { background: bg, borderColor: bg, color: tagTextColor(bg) }
}

/**
 * The feed's tag filter row: one chip per tag (click to include it in the
 * filter), an AND/OR switch once two are selected, and a collapsible manage
 * panel for create/rename/delete. Tags are assigned to channels in the
 * channels view; this row only filters by them.
 */
export function TagFilterRow({
  tags,
  rules,
  onChange,
  actions,
}: {
  tags: Tag[]
  rules: FeedRules
  onChange: (patch: Partial<FeedRules>) => void
  actions: TagActions
}) {
  const [managing, setManaging] = useState(false)
  const selected = new Set(rules.selectedTags)

  const toggle = (id: string) =>
    onChange({
      selectedTags: selected.has(id)
        ? rules.selectedTags.filter((t) => t !== id)
        : [...rules.selectedTags, id],
    })

  return (
    <>
      <div className="controls-row">
        <span className="control">Tags</span>

        {[...tags].sort(byName).map((tag) => (
          <button
            key={tag.id}
            className="chip tag-chip"
            style={selected.has(tag.id) ? tagChipStyle(tag) : undefined}
            onClick={() => toggle(tag.id)}
            title={`${tag.channelIds.length} channel${tag.channelIds.length === 1 ? '' : 's'}`}
          >
            {!selected.has(tag.id) && (
              <span className="tag-dot" style={{ background: tagColor(tag) }} />
            )}
            {tag.name}
          </button>
        ))}

        {tags.length === 0 && (
          <span className="control">No tags yet — create one and tag channels in the channels view.</span>
        )}

        {rules.selectedTags.length > 1 && (
          <button
            className="chip"
            onClick={() => onChange({ tagMode: rules.tagMode === 'or' ? 'and' : 'or' })}
            title={
              rules.tagMode === 'or'
                ? 'Matching any selected tag. Click to require all of them.'
                : 'Matching only channels with all selected tags. Click to match any.'
            }
          >
            Match: {rules.tagMode === 'or' ? 'any (OR)' : 'all (AND)'}
          </button>
        )}

        {rules.selectedTags.length > 0 && (
          <button className="chip" onClick={() => onChange({ selectedTags: [] })}>
            Clear
          </button>
        )}

        <button className="chip" onClick={() => setManaging((m) => !m)}>
          {managing ? 'Done' : 'Manage tags'}
        </button>
      </div>

      {managing && <TagManager tags={tags} actions={actions} />}
    </>
  )
}

/** Create / rename / delete. Renames commit on Enter or blur. */
function TagManager({ tags, actions }: { tags: Tag[]; actions: TagActions }) {
  return (
    <div className="controls-row tag-manager">
      <NewTagInput onCreate={(name) => actions.onCreate(name)} />
      {[...tags].sort(byName).map((tag) => (
        <span className="control tag-edit" key={tag.id}>
          <ColorPicker tag={tag} onPick={(color) => actions.onRecolor(tag.id, color)} />
          <input
            type="text"
            // Keyed by id, so an uncontrolled defaultValue survives re-renders
            // of unrelated tags and resets only when the row's tag changes.
            defaultValue={tag.name}
            size={Math.max(6, tag.name.length)}
            onBlur={(e) => actions.onRename(tag.id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
          <button
            className="chip"
            onClick={() => actions.onDelete(tag.id)}
            title={`Delete this tag (removes it from ${tag.channelIds.length} channel${
              tag.channelIds.length === 1 ? '' : 's'
            })`}
          >
            ✕
          </button>
        </span>
      ))}
    </div>
  )
}

/**
 * The tag's current color as a swatch button; clicking it drops down the whole
 * palette. Picking a swatch closes the `<details>` by hand — a plain click only
 * toggles it when it lands on the summary.
 */
function ColorPicker({ tag, onPick }: { tag: Tag; onPick: (color: string) => void }) {
  return (
    <details className="tag-picker">
      <summary
        className="tag-swatch"
        style={{ background: tagColor(tag) }}
        title="Tag color"
      />
      <div className="tag-picker-menu tag-palette">
        {TAG_COLORS.map((color) => (
          <button
            key={color}
            className={`tag-swatch${color === tagColor(tag) ? ' is-current' : ''}`}
            style={{ background: color }}
            onClick={(e) => {
              onPick(color)
              e.currentTarget.closest('details')?.removeAttribute('open')
            }}
          />
        ))}
      </div>
    </details>
  )
}

function NewTagInput({ onCreate }: { onCreate: (name: string) => void }) {
  const [name, setName] = useState('')
  const submit = () => {
    if (!name.trim()) return
    onCreate(name)
    setName('')
  }
  return (
    <span className="control">
      <input
        type="text"
        placeholder="New tag…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      <button className="chip" onClick={submit} disabled={!name.trim()}>
        Add
      </button>
    </span>
  )
}

/**
 * Per-channel tag editor for the channel list: the channel's tags as chips
 * (click to remove) and a native `<details>` dropdown for assigning existing
 * tags or creating one straight onto the channel.
 */
export function ChannelTagPicker({
  channelId,
  tags,
  actions,
}: {
  channelId: string
  tags: Tag[]
  actions: TagActions
}) {
  const own = tags.filter((t) => t.channelIds.includes(channelId)).sort(byName)
  const atCap = own.length >= MAX_TAGS_PER_CHANNEL

  return (
    <span className="channel-tags">
      {own.map((tag) => (
        <button
          key={tag.id}
          className="chip tag-chip"
          style={tagChipStyle(tag)}
          onClick={() => actions.onToggleChannel(tag.id, channelId)}
          title="Remove this tag from the channel"
        >
          {tag.name} ✕
        </button>
      ))}

      <details className="tag-picker">
        <summary className="chip">+ tag</summary>
        <div className="tag-picker-menu">
          {atCap && <span className="tag-cap">Limit of {MAX_TAGS_PER_CHANNEL} tags reached</span>}
          {[...tags].sort(byName).map((tag) => {
            const assigned = tag.channelIds.includes(channelId)
            return (
              <button
                key={tag.id}
                className="chip tag-chip"
                style={assigned ? tagChipStyle(tag) : undefined}
                disabled={!assigned && atCap}
                onClick={() => actions.onToggleChannel(tag.id, channelId)}
              >
                {!assigned && <span className="tag-dot" style={{ background: tagColor(tag) }} />}
                {assigned ? '✓ ' : ''}
                {tag.name}
              </button>
            )
          })}
          {!atCap && <NewTagInput onCreate={(name) => actions.onCreate(name, channelId)} />}
        </div>
      </details>
    </span>
  )
}
