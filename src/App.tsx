import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChannelList } from './components/ChannelList'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ChannelControls, Controls } from './components/Controls'
import { Setup } from './components/Setup'
import { VideoCard } from './components/VideoCard'
import { VirtualGrid } from './components/VirtualGrid'
import { getAccessToken, getClientId, hasValidToken, signOut } from './lib/auth'
import { applyRules, channelRows } from './lib/rules'
import {
  clearCache,
  getLastUserId,
  loadCache,
  loadRules,
  mergeChannels,
  mergeVideos,
  rowsForUser,
  saveCache,
  saveRules,
  setLastUserId,
} from './lib/store'
import {
  METADATA_REFRESH_MAX_AGE_MS,
  METADATA_TTL_MS,
  type Channel,
  type FeedRules,
  type Video,
} from './lib/types'
import { fetchCurrentUser, fetchFeed, fetchSubscriptions } from './lib/youtube'

/** How often a long paced index writes its progress to IndexedDB. */
const CHECKPOINT_MS = 5_000

/** Rebuilding a feed costs minutes of paced indexing, so the button is worth a pause. */
const CLEAR_CONFIRM_SEC = 5

/** Not persisted with the rules: this is navigation, not a filter. */
type View = 'subscriptions' | 'channels'

const VIEWS: { id: View; label: string }[] = [
  { id: 'subscriptions', label: 'subscriptions' },
  { id: 'channels', label: 'channels' },
]


export default function App() {
  const [configured, setConfigured] = useState(() => Boolean(getClientId()))
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

    void loadCache(last).then((c) => {
      if (c) {
        setUserId(c.userId)
        // Merge rather than assign: a refresh started before this read resolved
        // has already streamed newer rows into state, and they must win.
        setChannels((prev) => mergeChannels(rowsForUser(c.channels, c.userId), prev))
        setVideos((prev) => mergeVideos(rowsForUser(c.videos, c.userId), prev))
      }
      setLoaded(true)
    })
  }, [configured])

  useEffect(() => saveRules(rules), [rules])

  const updateRules = useCallback((patch: Partial<FeedRules>) => {
    setRules((prev) => ({ ...prev, ...patch }))
  }, [])

  // Mirrors the feed so a refresh can fold what is on screen into the record it
  // writes, without taking `videos` as a dependency.
  const videosRef = useRef<Video[]>([])
  videosRef.current = videos

  const refresh = useCallback(async () => {
    setBusy(true)
    setError('')
    setFailed([])
    try {
      // Read the cache alongside authorization, so the feed is back on screen
      // the instant a token lands rather than after the account check.
      const last = getLastUserId()
      const restoring = last ? loadCache(last).catch(() => undefined) : undefined

      await getAccessToken(false).catch(() => getAccessToken(true))
      setSignedIn(true)

      const restored = await restoring
      if (restored) {
        setUserId(restored.userId)
        setChannels(rowsForUser(restored.channels, restored.userId))
        setVideos(rowsForUser(restored.videos, restored.userId))
      }

      // Signing in as a different account swaps to that account's cache rather
      // than overwriting the previous one.
      const me = await fetchCurrentUser()
      setUserId(me.id)
      setLastUserId(me.id)

      // Usually the record just restored; only a different account needs another
      // read, and it swaps the feed rather than adding to it.
      let current = restored?.userId === me.id ? restored : undefined
      if (!current) {
        current = await loadCache(me.id)
        setChannels(current ? rowsForUser(current.channels, me.id) : [])
        setVideos(current ? rowsForUser(current.videos, me.id) : [])
      }

      // Read every time rather than on a TTL: a handful of API units next to the
      // video indexing, and it is how a run notices an unsubscribe.
      setProgress('Loading subscriptions…')
      const subs = await fetchSubscriptions(me.id, (n) =>
        setProgress(`Loading subscriptions… ${n}`),
      )
      const subscribed = new Set(subs.map((c) => c.id))
      setChannels(subs)

      // Accumulate outside React state so streamed batches cannot race.
      const collected: Video[] = []
      const cached = current ? rowsForUser(current.videos, me.id) : []
      const known = new Set(cached.map((v) => v.id))
      // Cached rows whose details aged out are re-read in place. Only recent
      // uploads qualify: re-reading the back catalogue would crowd out new videos.
      const staleBefore = Date.now() - METADATA_TTL_MS
      const publishedAfter = Date.now() - METADATA_REFRESH_MAX_AGE_MS
      const stale = new Set(
        cached
          .filter(
            (v) =>
              (v.fetchedAt ?? 0) < staleBefore &&
              new Date(v.publishedAt).getTime() >= publishedAfter,
          )
          .map((v) => v.id),
      )

      // Flipped once the run has succeeded: an interrupted refresh must not
      // delete anything, since its picture of the account is incomplete.
      let dropUnsubscribed = false
      // Union of what is on disk, on screen, and fetched by this run.
      const persist = () => {
        const all = mergeVideos(mergeVideos(cached, videosRef.current), collected)
        return saveCache({
          userId: me.id,
          channels: subs,
          videos: dropUnsubscribed ? all.filter((v) => subscribed.has(v.channelId)) : all,
          feedFetchedAt: Date.now(),
        })
      }

      // Indexing is deliberately slow, so checkpoint: a tab closed mid-run must
      // not discard everything already fetched.
      let lastSave = Date.now()

      const result = await fetchFeed(
        subs,
        me.id,
        known,
        stale,
        (p) => {
          const queued = p.queued > 0 ? ` · ${p.queued} queued` : ''
          if (p.scanned < p.channels) {
            setProgress(`Scanning ${p.scanned}/${p.channels} channels · ${p.videos} new${queued}…`)
          } else if (p.queued > 0) {
            setProgress(`Fetching new videos · ${p.videos} done${queued}…`)
          } else if (p.queuedStale > 0) {
            setProgress(`Refreshing details · ${p.updated} updated · ${p.queuedStale} to go…`)
          } else {
            setProgress(`Finishing up · ${p.videos} new · ${p.updated} updated…`)
          }
        },
        (batch) => {
          collected.push(...batch)
          setVideos((prev) => mergeVideos(prev, batch))
          if (Date.now() - lastSave > CHECKPOINT_MS) {
            lastSave = Date.now()
            void persist()
          }
        },
      )

      // The run completed, so the subscription list read at the top is a complete
      // picture: a channel missing from it was unsubscribed and leaves with its
      // videos rather than lingering as orphaned rows.
      dropUnsubscribed = true

      // Merge over live state, not the snapshot, so the final write drops nothing.
      setVideos((prev) => mergeVideos(prev, collected).filter((v) => subscribed.has(v.channelId)))
      setChannels(subs)
      setFailed(result.failed)
      await persist()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setProgress('')
    }
  }, [])

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
          } for this account from this browser. Rebuilding them means re-reading every subscription, which takes several minutes of paced indexing.`}
          confirmLabel="Clear cache"
          delaySec={CLEAR_CONFIRM_SEC}
          onCancel={() => setConfirmingClear(false)}
          onConfirm={() => {
            setConfirmingClear(false)
            void clearCache(userId).then(() => {
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
