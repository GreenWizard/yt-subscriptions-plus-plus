import { CHANNEL_SORT_LABELS, randomShuffleSeed, SORT_LABELS } from '../lib/rules'
import type { ChannelSortKey, FeedRules, SortKey } from '../lib/types'

interface Props {
  rules: FeedRules
  onChange: (patch: Partial<FeedRules>) => void
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

export function Controls({ rules, onChange }: Props) {
  return (
    <div className="controls">
      <div className="controls-row">
        <label className="control">
          Sort
          <select
            value={rules.sort}
            onChange={(e) => {
              const sort = e.target.value as SortKey
              // Picking shuffle deals a new order; otherwise the persisted seed
              // would return to the order shuffle was last left in.
              onChange(sort === 'shuffle' ? { sort, shuffleSeed: randomShuffleSeed() } : { sort })
            }}
          >
            {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>

        {/* The only way to re-deal: the order is otherwise fixed by the seed. */}
        {rules.sort === 'shuffle' && (
          <button className="chip" onClick={() => onChange({ shuffleSeed: randomShuffleSeed() })}>
            Shuffle again
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
