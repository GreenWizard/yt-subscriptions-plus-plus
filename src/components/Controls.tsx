import { CHANNEL_SORT_LABELS, SORT_LABELS } from '../lib/rules'
import type { ChannelSortKey, FeedRules, SortKey, Tag } from '../lib/types'
import { TagFilterRow, type TagActions } from './Tags'

/** Pagination of the filtered feed; rendered inside the sticky controls bar. */
export interface Pager {
  /** Zero-based current page. */
  page: number
  pageCount: number
  onPage: (page: number) => void
  /** Re-deals the page on screen (and only it) into a new random order. */
  onShuffle: () => void
}

interface Props {
  rules: FeedRules
  onChange: (patch: Partial<FeedRules>) => void
  pager?: Pager
  tags?: Tag[]
  tagActions?: TagActions
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `YYYY-MM-DD` in the viewer's own timezone, which is what a date input takes. */
function dateInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Presets fill the two pickers rather than acting as modes of their own, so the
// range stays visible and can be nudged afterwards.
const DATE_PRESETS: { label: string; from: (now: Date) => Date }[] = [
  { label: 'Last week', from: (n) => new Date(n.getFullYear(), n.getMonth(), n.getDate() - 7) },
  { label: 'Last month', from: (n) => new Date(n.getFullYear(), n.getMonth() - 1, n.getDate()) },
  { label: 'This year', from: (n) => new Date(n.getFullYear(), 0, 1) },
]

export function Controls({ rules, onChange, pager, tags, tagActions }: Props) {
  return (
    <div className="controls">
      <div className="controls-row">
        <label className="control">
          Sort
          <select
            value={rules.sort}
            onChange={(e) => onChange({ sort: e.target.value as SortKey })}
          >
            {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>

        {/* Shuffle is not a sort: it re-deals only the page on screen. */}
        {pager && (
          <button className="chip" onClick={pager.onShuffle}>
            Shuffle page
          </button>
        )}

        <label className="control">
          <input
            type="search"
            placeholder="Filter by title or channel…"
            value={rules.query}
            onChange={(e) => onChange({ query: e.target.value })}
          />
        </label>

        {pager && pager.pageCount > 1 && (
          <span className="control pager">
            <button
              className="chip"
              onClick={() => pager.onPage(pager.page - 1)}
              disabled={pager.page <= 0}
            >
              ‹ Prev
            </button>
            Page {pager.page + 1} of {pager.pageCount}
            <button
              className="chip"
              onClick={() => pager.onPage(pager.page + 1)}
              disabled={pager.page >= pager.pageCount - 1}
            >
              Next ›
            </button>
          </span>
        )}
      </div>

      <div className="controls-row">
        <label className="control">
          Released
          <input
            type="date"
            value={rules.fromDate}
            // Bound each end by the other, so the picker cannot offer an
            // inverted range that would match nothing.
            max={rules.toDate || undefined}
            onChange={(e) => onChange({ fromDate: e.target.value })}
          />
          to
          <input
            type="date"
            value={rules.toDate}
            min={rules.fromDate || undefined}
            onChange={(e) => onChange({ toDate: e.target.value })}
          />
        </label>

        {DATE_PRESETS.map((preset) => (
          <button
            key={preset.label}
            className="chip"
            onClick={() => {
              const now = new Date()
              onChange({
                fromDate: dateInputValue(preset.from(now)),
                toDate: dateInputValue(now),
              })
            }}
          >
            {preset.label}
          </button>
        ))}

        <button
          className="chip"
          onClick={() => onChange({ fromDate: '', toDate: '' })}
          disabled={!rules.fromDate && !rules.toDate}
        >
          Reset
        </button>
      </div>

      {tags && tagActions && (
        <TagFilterRow tags={tags} rules={rules} onChange={onChange} actions={tagActions} />
      )}
    </div>
  )
}

/**
 * The channel list's own control bar. It shares the rules object and the muting
 * it writes, but not these two controls: the search matches channel names rather
 * than video titles, and the video sorts and date window have no meaning here.
 */
export function ChannelControls({ rules, onChange }: Props) {
  return (
    <div className="controls">
      <div className="controls-row">
        <label className="control">
          Sort
          <select
            value={rules.channelSort}
            onChange={(e) => onChange({ channelSort: e.target.value as ChannelSortKey })}
          >
            {(Object.keys(CHANNEL_SORT_LABELS) as ChannelSortKey[]).map((key) => (
              <option key={key} value={key}>
                {CHANNEL_SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>

        <label className="control">
          <input
            type="search"
            placeholder="Filter by channel…"
            value={rules.channelQuery}
            onChange={(e) => onChange({ channelQuery: e.target.value })}
          />
        </label>

        <button
          className="chip"
          onClick={() => onChange({ channelQuery: '' })}
          disabled={!rules.channelQuery}
        >
          Reset
        </button>
      </div>
    </div>
  )
}
