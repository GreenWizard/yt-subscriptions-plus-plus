import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { ChannelList } from './components/ChannelList'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ChannelControls, Controls } from './components/Controls'
import { Setup } from './components/Setup'
import { VideoCard } from './components/VideoCard'
import { VirtualGrid } from './components/VirtualGrid'
import { getAccessToken, getClientId, hasValidToken, invalidateToken, signOut } from './lib/auth'
import type { FromWorker, ToWorker } from './lib/feed-protocol'
import { applyRules, channelRows, randomShuffleSeed, shuffled, tagFilterChannels } from './lib/rules'
import {
  clearFeed,
  getLastUserId,
  loadFeed,
  loadQuotaUsed,
  loadRules,
  loadTags,
  removeTag,
  saveRules,
  saveTag,
  setLastUserId,
} from './lib/store'
import type { TagActions } from './components/Tags'
import {
  FEED_PAGE_SIZE,
  MAX_TAGS_PER_CHANNEL,
  TAG_COLORS,
  type Channel,
  type FeedRules,
  type Tag,
  type Video,
} from './lib/types'

/**
 * Streamed batches are buffered and folded into React state on this interval
 * rather than one `setVideos` per batch: each state change re-sorts the whole
 * feed, so coalescing is what keeps the grid smooth now that the Worker streams
 * batches in as fast as the API returns them.
 */
/**
 * The DB is the single source of truth, so the feed is re-read from it to
 * repaint. During a run the worker writes rows continuously; this throttles the
 * main thread's re-reads so a burst of writes turns into at most one read per
 * window rather than one per batch. The final read on `done` is immediate.
 *
 * The window adapts to how expensive the last read was: reading a full 200k-row
 * cache costs ~1.5s of deserialization, so a fixed short window spent ~20% of
 * the main thread re-reading the store by the end of a cold run (measured as
 * 200–280ms long tasks every cycle). Scaling the wait by the last read keeps
 * repaints frequent while the cache is small and backs off as it grows,
 * bounding the read's share of the main thread to roughly 1/READ_BACKOFF.
 */
const DB_READ_MS = 300
const READ_BACKOFF = 4

/** Rebuilding a feed costs minutes of indexing, so the button is worth a pause. */
const CLEAR_CONFIRM_SEC = 5

/** Not persisted with the rules: this is navigation, not a filter. */
type View = 'subscriptions' | 'channels'

const VIEWS: { id: View; label: string }[] = [
  { id: 'subscriptions', label: 'subscriptions' },
  { id: 'channels', label: 'channels' },
]

// Offline fixtures mode (VITE_YT_MOCK=fixtures…): the worker fabricates all data
// and needs no Google account, so the main thread skips OAuth setup and sign-in.
const OFFLINE = (import.meta.env.VITE_YT_MOCK as string | undefined)?.startsWith('fixtures') ?? false


export default function App() {
  const [configured, setConfigured] = useState(() => OFFLINE || Boolean(getClientId()))
  const [signedIn, setSignedIn] = useState(false)
  const [userId, setUserId] = useState<string | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [videos, setVideos] = useState<Video[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [loaded, setLoaded] = useState(false)
  const [rules, setRules] = useState<FeedRules>(loadRules)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [failed, setFailed] = useState<{ title: string; message: string }[]>([])
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [view, setView] = useState<View>('subscriptions')
  // Feed pagination. The page is not persisted — it is navigation, like `view`.
  // `pageSeed` orders the current page randomly when set; it is per page and
  // per rules, so leaving the page or changing a filter/sort un-shuffles.
  const [page, setPage] = useState(0)
  const [pageSeed, setPageSeed] = useState<number | null>(null)
  // API calls used since the last quota reset (midnight PT), shown in the header.
  const [apiUsed, setApiUsed] = useState<number | null>(null)

  // The account currently on screen, so a throttled DB read that resolves late
  // is dropped rather than painting a feed the user has switched away from.
  const shownUserRef = useRef<string | null>(null)
  // Live for the duration of a run: the worker and the read-throttle timer.
  const workerRef = useRef<Worker | null>(null)
  const readTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Duration of the last DB read, driving the adaptive throttle window.
  const lastReadMsRef = useRef(0)

  // Read one account's feed from the DB and paint it. This is the only path by
  // which feed data reaches the UI: the worker writes to the DB, never to state.
  const project = useCallback(async (uid: string) => {
    const started = performance.now()
    const feed = await loadFeed(uid)
    lastReadMsRef.current = performance.now() - started
    if (shownUserRef.current !== uid) return
    setChannels(feed.channels)
    setVideos(feed.videos)
  }, [])

  // Throttle re-reads to at most one per window; a run writes far faster than
  // the grid needs to repaint, and the window grows with the cost of reading.
  const scheduleRead = useCallback(
    (uid: string) => {
      if (readTimerRef.current) return
      const wait = Math.max(DB_READ_MS, READ_BACKOFF * lastReadMsRef.current)
      readTimerRef.current = setTimeout(() => {
        readTimerRef.current = null
        void project(uid)
      }, wait)
    },
    [project],
  )

  // Authorization is never attempted on mount: the GIS token client always opens
  // a popup, and a popup not tied to a user gesture gets blocked.
  useEffect(() => {
    const session = configured && hasValidToken()
    setSignedIn(session)

    const last = getLastUserId()
    if (!session || !last) {
      setLoaded(true)
      return
    }

    setUserId(last)
    shownUserRef.current = last
    void project(last).finally(() => setLoaded(true))
  }, [configured, project])

  // Show today's API usage straight from the DB on load, before any refresh.
  useEffect(() => {
    void loadQuotaUsed().then(setApiUsed)
  }, [])

  // Tags are read once per account, not on the worker's read-throttle path:
  // only the UI below writes them, so state and DB cannot drift mid-run.
  useEffect(() => {
    if (!userId) return
    let stale = false
    void loadTags(userId).then((rows) => {
      if (!stale) setTags(rows)
    })
    return () => {
      stale = true
    }
  }, [userId])

  useEffect(() => saveRules(rules), [rules])

  const updateRules = useCallback((patch: Partial<FeedRules>) => {
    setRules((prev) => ({ ...prev, ...patch }))
  }, [])

  useEffect(
    () => () => {
      workerRef.current?.terminate()
      if (readTimerRef.current) clearTimeout(readTimerRef.current)
    },
    [],
  )

  const refresh = useCallback(async () => {
    setBusy(true)
    setError('')
    setFailed([])

    // Acquire the token here, inside the click handler, so the OAuth popup stays
    // tied to the user gesture and is not blocked. The worker then obtains tokens
    // silently over the RPC and never needs a popup on the common path.
    if (!OFFLINE) {
      try {
        await getAccessToken(false).catch(() => getAccessToken(true))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
        return
      }
    }
    setSignedIn(true)
    setProgress('Loading subscriptions…')

    // Replace any worker still running from a previous refresh.
    workerRef.current?.terminate()
    if (readTimerRef.current) clearTimeout(readTimerRef.current)
    readTimerRef.current = null

    const worker = new Worker(new URL('./lib/feed.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    const post = (msg: ToWorker) => worker.postMessage(msg)

    // The account this run is for, learned from the worker's first message and
    // used to read the right rows back from the DB.
    let runUser: string | null = null

    const cleanup = () => {
      if (readTimerRef.current) clearTimeout(readTimerRef.current)
      readTimerRef.current = null
      worker.terminate()
      if (workerRef.current === worker) workerRef.current = null
      setBusy(false)
      setProgress('')
    }

    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const msg = event.data
      switch (msg.kind) {
        case 'auth-request':
          void (async () => {
            try {
              post({ kind: 'auth-result', id: msg.id, token: await getAccessToken(msg.interactive) })
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              post({ kind: 'auth-error', id: msg.id, message })
            }
          })()
          break
        case 'auth-invalidate':
          invalidateToken()
          break
        case 'user':
          runUser = msg.id
          setUserId(msg.id)
          setLastUserId(msg.id)
          // Paint this account's existing cache straight from the DB. Switching
          // accounts repoints `shownUserRef` first, so a late read for the old
          // account is dropped rather than shown.
          shownUserRef.current = msg.id
          void project(msg.id)
          break
        case 'subs-progress':
          setProgress(`Loading subscriptions… ${msg.count}`)
          break
        case 'quota':
          setApiUsed(msg.used)
          break
        case 'backfill-progress':
          setProgress(
            msg.remaining > 0
              ? `Backfilling history · ${msg.remaining} channel${msg.remaining > 1 ? 's' : ''} left · ${msg.added} videos added…`
              : `Backfilling history · ${msg.added} videos added…`,
          )
          break
        case 'feed-progress': {
          const p = msg.progress
          const queued = p.queued > 0 ? ` · ${p.queued} queued` : ''
          const unchanged = p.skipped > 0 ? ` (${p.skipped} unchanged)` : ''
          if (p.scanned + p.skipped < p.channels) {
            setProgress(
              `Scanning ${p.scanned + p.skipped}/${p.channels} channels${unchanged} · ${p.videos} new${queued}…`,
            )
          } else if (p.queued > 0) {
            setProgress(`Fetching videos · ${p.videos} new · ${p.updated} updated${queued}…`)
          } else {
            setProgress(`Finishing up · ${p.videos} new · ${p.updated} updated…`)
          }
          break
        }
        case 'updated':
          if (runUser) scheduleRead(runUser)
          break
        case 'done':
          setFailed(msg.failed)
          // One final, immediate read reflecting the settled DB — but only when
          // the run actually changed it; otherwise what is on screen is current
          // and a full re-read of the cache would be pure waste.
          if (readTimerRef.current) clearTimeout(readTimerRef.current)
          readTimerRef.current = null
          if (runUser && msg.changed) void project(runUser).finally(cleanup)
          else cleanup()
          break
        case 'error':
          setError(msg.message)
          cleanup()
          break
      }
    }

    // A thrown error inside the worker never arrives as a message, so without
    // this the run would hang with the spinner stuck on. Surface it and stop.
    worker.onerror = (event) => {
      setError(event.message || 'The feed worker failed.')
      cleanup()
    }
    worker.onmessageerror = () => {
      setError('The feed worker sent a message that could not be read.')
      cleanup()
    }

    post({ kind: 'start' })
  }, [project, scheduleRead])

  const channelsById = useMemo(() => new Map(channels.map((c) => [c.id, c])), [channels])

  // The search box is controlled by `rules.query` and must echo a keystroke
  // instantly; refiltering and resorting 200k videos costs ~150ms. Deferring the
  // query that feeds the heavy memo lets React commit the input first and
  // rebuild the list at deferred priority, so typing never blocks.
  const deferredQuery = useDeferredValue(rules.query)

  // Both views read one cache. Each memo keys on exactly the rule fields it
  // consumes rather than the whole `rules` object, so a keystroke in one view's
  // filter cannot invalidate the other view — and switching views costs only a
  // render, since the hidden view's result is still cached.
  // The selected tags collapse to a Set of admitted channels once, outside the
  // per-video filter, and only when the tag rows or the selection change.
  const tagChannels = useMemo(
    () => tagFilterChannels(tags, rules.selectedTags, rules.tagMode),
    [tags, rules.selectedTags, rules.tagMode],
  )

  const visible = useMemo(
    () => applyRules(videos, { ...rules, query: deferredQuery }, tagChannels),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applyRules reads only these rule fields
    [videos, rules.sort, deferredQuery, rules.fromDate, rules.toDate, rules.mutedChannels, tagChannels],
  )
  const rows = useMemo(
    () => channelRows(videos, channels, rules),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- channelRows reads only these rule fields
    [videos, channels, rules.channelQuery, rules.channelSort, rules.mutedChannels],
  )

  // Feed-rule changes rebuild the filtered feed, so the old page number and
  // shuffle no longer point at the same items — snap back to the first page,
  // unshuffled. Channel-view rules are deliberately absent: they never change
  // what the feed pages over.
  useEffect(() => {
    setPage(0)
    setPageSeed(null)
  }, [rules.sort, rules.query, rules.fromDate, rules.toDate, rules.mutedChannels, tagChannels])

  // Clamped rather than reset when the feed shrinks under the current page
  // (e.g. a refresh pruning an unsubscribed channel mid-scroll).
  const pageCount = Math.max(1, Math.ceil(visible.length / FEED_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)

  const pageItems = useMemo(() => {
    const slice =
      visible.length > FEED_PAGE_SIZE
        ? visible.slice(currentPage * FEED_PAGE_SIZE, (currentPage + 1) * FEED_PAGE_SIZE)
        : visible
    return pageSeed === null ? slice : shuffled(slice, pageSeed)
  }, [visible, currentPage, pageSeed])

  const pager = useMemo(
    () => ({
      page: currentPage,
      pageCount,
      onPage: (p: number) => {
        setPage(Math.max(0, Math.min(p, pageCount - 1)))
        setPageSeed(null)
        window.scrollTo(0, 0)
      },
      onShuffle: () => setPageSeed(randomShuffleSeed()),
    }),
    [currentPage, pageCount],
  )

  // --- Tag CRUD. Each action writes the row to IDB and mirrors it in state;
  // the worker never touches the tags store, so state is the only other copy.

  const upsertTag = useCallback((tag: Tag) => {
    void saveTag(tag)
    setTags((prev) => {
      const i = prev.findIndex((t) => t.id === tag.id)
      return i === -1 ? [...prev, tag] : prev.map((t) => (t.id === tag.id ? tag : t))
    })
  }, [])

  /** Tags a channel already carries; the per-channel cap counts these. */
  const channelTagCount = useCallback(
    (channelId: string) => tags.filter((t) => t.channelIds.includes(channelId)).length,
    [tags],
  )

  const tagActions = useMemo<TagActions>(() => {
    const toggleChannel = (tagId: string, channelId: string) => {
      const tag = tags.find((t) => t.id === tagId)
      if (!tag) return
      const assigned = tag.channelIds.includes(channelId)
      if (!assigned && channelTagCount(channelId) >= MAX_TAGS_PER_CHANNEL) return
      upsertTag({
        ...tag,
        channelIds: assigned
          ? tag.channelIds.filter((id) => id !== channelId)
          : [...tag.channelIds, channelId],
      })
    }

    return {
      onCreate: (name, channelId) => {
        if (!userId) return
        const trimmed = name.trim()
        if (!trimmed) return
        // Names are unique per account (case-insensitively): creating an
        // existing name from a channel's picker assigns that tag instead.
        const existing = tags.find((t) => t.name.toLowerCase() === trimmed.toLowerCase())
        if (existing) {
          if (channelId && !existing.channelIds.includes(channelId)) {
            toggleChannel(existing.id, channelId)
          }
          return
        }
        if (channelId && channelTagCount(channelId) >= MAX_TAGS_PER_CHANNEL) return
        upsertTag({
          id: crypto.randomUUID(),
          userId,
          name: trimmed,
          // Walk the palette so fresh tags start distinct; the picker can
          // change it to any of the 32 afterwards.
          color: TAG_COLORS[tags.length % TAG_COLORS.length],
          channelIds: channelId ? [channelId] : [],
        })
      },
      onRename: (tagId, name) => {
        const tag = tags.find((t) => t.id === tagId)
        const trimmed = name.trim()
        if (!tag || !trimmed || trimmed === tag.name) return
        // A rename onto an existing name is dropped rather than merged.
        if (tags.some((t) => t.id !== tagId && t.name.toLowerCase() === trimmed.toLowerCase()))
          return
        upsertTag({ ...tag, name: trimmed })
      },
      onRecolor: (tagId, color) => {
        const tag = tags.find((t) => t.id === tagId)
        if (!tag || !(TAG_COLORS as readonly string[]).includes(color)) return
        upsertTag({ ...tag, color })
      },
      onDelete: (tagId) => {
        if (!userId) return
        void removeTag(userId, tagId)
        setTags((prev) => prev.filter((t) => t.id !== tagId))
        // Also drop it from the persisted filter selection.
        setRules((prev) => ({
          ...prev,
          selectedTags: prev.selectedTags.filter((id) => id !== tagId),
        }))
      },
      onToggleChannel: toggleChannel,
    }
  }, [tags, userId, channelTagCount, upsertTag])

  const toggleMute = useCallback((channelId: string) => {
    setRules((prev) => ({
      ...prev,
      mutedChannels: prev.mutedChannels.includes(channelId)
        ? prev.mutedChannels.filter((id) => id !== channelId)
        : [...prev.mutedChannels, channelId],
    }))
  }, [])


  if (!configured) return <Setup onReady={() => setConfigured(true)} />

  return (
    <>
      <div className="head">
        <header className="topbar">
        <nav className="brand">
          {VIEWS.map(({ id, label }) => (
            <button
              key={id}
              className={`brand-tab${view === id ? ' is-active' : ''}`}
              aria-current={view === id}
              onClick={() => setView(id)}
            >
              {label}
              <span>++</span>
            </button>
          ))}
        </nav>
        <div className="spacer" />
        {apiUsed !== null && (
          <span
            className="control"
            title="YouTube API units used since the last quota reset (midnight Pacific time). The default daily quota is 10,000."
          >
            {apiUsed.toLocaleString()} API
          </span>
        )}
        {videos.length > 0 && (
          <span className="control">
            {view === 'channels'
              ? `${rows.length} of ${channels.length} channels`
              : `${visible.length} of ${videos.length} · ${channels.length} channels`}
          </span>
        )}
        {signedIn ? (
          <>
            <button className="primary" onClick={() => void refresh()} disabled={busy}>
              {busy ? 'Refreshing…' : 'Refresh'}
            </button>
            {userId && videos.length > 0 && (
              <button onClick={() => setConfirmingClear(true)} disabled={busy}>
                Clear cache
              </button>
            )}
            <button
              onClick={() => {
                signOut()
                setSignedIn(false)
                // Hide the feed, but keep the cache: signing back in restores it.
                // Clearing the shown-account marker is what makes that restore
                // happen — the next refresh sees the account as not-yet-painted.
                shownUserRef.current = null
                setChannels([])
                setVideos([])
                setFailed([])
                setError('')
              }}
              disabled={busy}
            >
              Sign out
            </button>
          </>
        ) : (
          <button className="primary" onClick={() => void refresh()} disabled={busy}>
            Sign in with Google
          </button>
        )}
        </header>

        {view === 'channels' ? (
          <ChannelControls rules={rules} onChange={updateRules} tags={tags} tagActions={tagActions} />
        ) : (
          <Controls rules={rules} onChange={updateRules} pager={pager} tags={tags} />
        )}
      </div>

      {(progress || error || failed.length > 0) && (
        <div className="status">
          {progress && <span>{progress}</span>}
          {error && <span className="error">{error}</span>}
          {failed.length > 0 && (
            <span
              className="error"
              title={failed.map((f) => `${f.title}: ${f.message}`).join('\n')}
            >
              {failed.length} channel{failed.length > 1 ? 's' : ''} failed to load (hover for
              details)
            </span>
          )}
        </div>
      )}

      {confirmingClear && userId && (
        <ConfirmDialog
          title="Clear the cached feed?"
          message={`This deletes all ${videos.length} indexed ${
            videos.length === 1 ? 'video' : 'videos'
          } for this account from this browser. Rebuilding them means re-reading every subscription, which takes several minutes of indexing.`}
          confirmLabel="Clear cache"
          delaySec={CLEAR_CONFIRM_SEC}
          onCancel={() => setConfirmingClear(false)}
          onConfirm={() => {
            setConfirmingClear(false)
            shownUserRef.current = null
            void clearFeed(userId).then(() => {
              setChannels([])
              setVideos([])
              setFailed([])
              setError('')
            })
          }}
        />
      )}

      {view === 'channels' ? (
        rows.length > 0 ? (
          <ChannelList
            rows={rows}
            tags={tags}
            tagActions={tagActions}
            onToggleMute={toggleMute}
            renderVideo={(v) => (
              <VideoCard
                key={v.id}
                video={v}
                channel={channelsById.get(v.channelId)}
                sort={rules.sort}
                showChannel={false}
              />
            )}
          />
        ) : (
          <div className="empty">
            {busy
              ? 'Loading your subscriptions…'
              : !loaded
                ? ''
                : channels.length > 0
                  ? 'No channels match your search.'
                  : signedIn
                    ? 'No subscriptions indexed for this account. Hit Refresh to load them.'
                    : 'Sign in to pull your subscriptions and build the feed.'}
          </div>
        )
      ) : visible.length > 0 ? (
        <VirtualGrid
          items={pageItems}
          renderItem={(v) => (
            <VideoCard
              key={v.id}
              video={v}
              channel={channelsById.get(v.channelId)}
              sort={rules.sort}
            />
          )}
        />
      ) : (
        <div className="empty">
          {busy
            ? 'Building your feed…'
            : !loaded
              ? ''
              : videos.length > 0
                ? 'No videos match your current rules. Try widening the release-date window or clearing the search.'
                : signedIn
                  ? 'Nothing indexed for this account. Hit Refresh to build the feed.'
                  : 'Sign in to pull your subscriptions and build the feed.'}
        </div>
      )}
    </>
  )
}
