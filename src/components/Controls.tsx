import { SORT_LABELS } from '../lib/rules'
import type { FeedRules, SortKey } from '../lib/types'

interface Props {
  rules: FeedRules
  onChange: (patch: Partial<FeedRules>) => void
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `YYYY-MM-DD` in the viewer's own timezone, which is what a date input takes. */
function dateInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Presets fill the two pickers rather than acting as modes of their own, so the
 * range they chose stays visible and can be nudged afterwards.
 */
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
          <select value={rules.sort} onChange={(e) => onChange({ sort: e.target.value as SortKey })}>
            {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>

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
            // Bound each end by the other so the picker cannot offer an
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
