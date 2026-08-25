import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChannelList } from './components/ChannelList'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ChannelControls, Controls } from './components/Controls'
import { Setup } from './components/Setup'
import { VideoCard } from './components/VideoCard'
import { VirtualGrid } from './components/VirtualGrid'
import { getAccessToken, getClientId, hasValidToken, invalidateToken, signOut } from './lib/auth'
import type { FromWorker, ToWorker } from './lib/feed-protocol'
import { applyRules, channelRows } from './lib/rules'
import { clearFeed, getLastUserId, loadFeed, loadRules, saveRules, setLastUserId } from './lib/store'
import { type Channel, type FeedRules, type Video } from './lib/types'

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
 */
const DB_READ_MS = 500

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
  const [loaded, setLoaded] = useState(false)
  const [rules, setRules] = useState<FeedRules>(loadRules)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [failed, setFailed] = useState<{ title: string; message: string }[]>([])
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [view, setView] = useState<View>('subscriptions')

  // The account currently on screen, so a throttled DB read that resolves late
  // is dropped rather than painting a feed the user has switched away from.
  const shownUserRef = useRef<string | null>(null)
  // Live for the duration of a run: the worker and the read-throttle timer.
  const workerRef = useRef<Worker | null>(null)
  const readTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Read one account's feed from the DB and paint it. This is the only path by
  // which feed data reaches the UI: the worker writes to the DB, never to state.
  const project = useCallback(async (uid: string) => {
    const feed = await loadFeed(uid)
    if (shownUserRef.current !== uid) return
    setChannels(feed.channels)
    setVideos(feed.videos)
  }, [])

  // Throttle re-reads to at most one per window; a run writes far faster than the
  // grid needs to repaint.
  const scheduleRead = useCallback(
    (uid: string) => {
      if (readTimerRef.current) return
      readTimerRef.current = setTimeout(() => {
        readTimerRef.current = null
        void project(uid)
      }, DB_READ_MS)
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
        case 'feed-progress': {
          const p = msg.progress
          const queued = p.queued > 0 ? ` · ${p.queued} queued` : ''
          const unchanged = p.skipped > 0 ? ` (${p.skipped} unchanged)` : ''
          if (p.scanned < p.channels) {
            setProgress(`Scanning ${p.scanned}/${p.channels} channels${unchanged} · ${p.videos} new${queued}…`)
          } else if (p.queued > 0) {
            setProgress(`Fetching new videos · ${p.videos} done${queued}…`)
          } else if (p.queuedStale > 0) {
            setProgress(`Refreshing details · ${p.updated} updated · ${p.queuedStale} to go…`)
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
          // One final, immediate read: the worker has written everything and
          // pruned unsubscribed rows, so this reflects the settled DB.
          if (readTimerRef.current) clearTimeout(readTimerRef.current)
          readTimerRef.current = null
          if (runUser) void project(runUser).finally(cleanup)
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

  // Both views read one cache, but each is built only for the view on screen:
  // `rules` is a single object, so any change to it is a new identity, and
  // without the guard a keystroke in the channel filter re-sorted the whole
  // video feed behind the view — a second of work on a 300k-video cache.
  const visible = useMemo(
    () => (view === 'subscriptions' ? applyRules(videos, rules) : []),
    [view, videos, rules],
  )
  const rows = useMemo(
    () => (view === 'channels' ? channelRows(videos, channels, rules) : []),
    [view, videos, channels, rules],
  )

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
          <ChannelControls rules={rules} onChange={updateRules} />
        ) : (
          <Controls rules={rules} onChange={updateRules} />
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
          items={visible}
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
