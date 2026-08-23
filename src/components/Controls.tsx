import { SORT_LABELS } from '../lib/rules'
import type { FeedRules, SortKey } from '../lib/types'

interface Props {
  rules: FeedRules
  onChange: (patch: Partial<FeedRules>) => void
}

export function Controls({ rules, onChange }: Props) {
  return (
    <div className="controls">
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

      <label className="checkbox">
        <input
          type="checkbox"
          checked={rules.hideShorts}
          onChange={(e) => onChange({ hideShorts: e.target.checked })}
        />
        Hide Shorts
      </label>

      <label className="control">
        Length
        <input
          type="number"
          min={0}
          value={rules.minMinutes}
          onChange={(e) => onChange({ minMinutes: Math.max(0, Number(e.target.value) || 0) })}
        />
        to
        <input
          type="number"
          min={0}
          placeholder="∞"
          value={rules.maxMinutes || ''}
          onChange={(e) => onChange({ maxMinutes: Math.max(0, Number(e.target.value) || 0) })}
        />
        min
      </label>

      <label className="control">
        Last
        <input
          type="number"
          min={1}
          max={90}
          value={rules.lookbackDays}
          onChange={(e) =>
            onChange({ lookbackDays: Math.min(90, Math.max(1, Number(e.target.value) || 1)) })
          }
        />
        days
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
  )
}
