import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** Extra rows rendered above and below the viewport to cover fast scrolling. */
const OVERSCAN_ROWS = 3

/** Items rendered before measurement, enough to size one card. */
const PROBE_COUNT = 24

interface Metrics {
  columns: number
  rowHeight: number
  top: number
}

/**
 * Renders only the grid rows near the viewport, with spacers standing in for
 * the rest. A feed of several thousand cards otherwise leaves the main thread
 * unresponsive, and growing the list on scroll only defers that: flick to the
 * bottom and every card is mounted again.
 *
 * Cards are a uniform height (`.card-title` is fixed to two lines), so row
 * geometry can be measured once from a single card rather than tracked per
 * item.
 */
export function VirtualGrid<T>({
  items,
  renderItem,
}: {
  items: T[]
  renderItem: (item: T) => ReactNode
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const [metrics, setMetrics] = useState<Metrics>({ columns: 0, rowHeight: 0, top: 0 })
  const [scrollY, setScrollY] = useState(0)
  const [viewportH, setViewportH] = useState(() => window.innerHeight)

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const grid = gridRef.current
    if (!wrap || !grid) return

    const measure = () => {
      const card = grid.querySelector<HTMLElement>('.card')
      // A zero-width viewport (hidden tab) yields degenerate geometry; keep the
      // last good measurement until the grid is laid out for real.
      if (!card || grid.clientWidth <= 0) return
      const style = getComputedStyle(grid)
      const columns = style.gridTemplateColumns.split(' ').filter(Boolean).length
      const rowHeight = card.offsetHeight + (parseFloat(style.rowGap) || 0)
      const top = wrap.getBoundingClientRect().top + window.scrollY
      setMetrics((m) =>
        m.columns === columns && m.rowHeight === rowHeight && m.top === top
          ? m
          : { columns, rowHeight, top },
      )
    }

    measure()

    // React to width only. The grid's height changes as a result of measuring
    // (a new row count mounts a different number of cards), so observing height
    // would feed back into itself.
    let lastWidth = grid.clientWidth
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      if (width === lastWidth) return
      lastWidth = width
      measure()
    })
    observer.observe(grid)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [items.length])

  useEffect(() => {
    // Updating on every scroll event is cheap here: the work is O(1) arithmetic
    // and React bails out when the computed slice is unchanged.
    const onScroll = () => setScrollY(window.scrollY)
    const onResize = () => setViewportH(window.innerHeight)
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  const { columns, rowHeight, top } = metrics
  const ready = columns > 0 && rowHeight > 0

  let start = 0
  let end = Math.min(items.length, PROBE_COUNT)
  let padTop = 0
  let padBottom = 0

  if (ready) {
    const totalRows = Math.ceil(items.length / columns)
    const firstRow = Math.max(0, Math.floor((scrollY - top) / rowHeight) - OVERSCAN_ROWS)
    const rowsInView = Math.ceil(viewportH / rowHeight) + OVERSCAN_ROWS * 2
    const lastRow = Math.min(totalRows, firstRow + rowsInView)
    start = firstRow * columns
    end = Math.min(items.length, lastRow * columns)
    padTop = firstRow * rowHeight
    padBottom = Math.max(0, (totalRows - lastRow) * rowHeight)
  }

  return (
    <div ref={wrapRef}>
      <div style={{ height: padTop }} />
      <div className="grid" ref={gridRef}>
        {items.slice(start, end).map(renderItem)}
      </div>
      <div style={{ height: padBottom }} />
    </div>
  )
}
