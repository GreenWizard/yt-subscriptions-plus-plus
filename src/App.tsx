import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Controls } from './components/Controls'
import { Setup } from './components/Setup'
import { VideoCard } from './components/VideoCard'
import { getAccessToken, getClientId, hasValidToken, signOut } from './lib/auth'
import { applyRules } from './lib/rules'
import {
  clearCache,
  loadCache,
  loadRules,
  mergeVideos,
  pruneVideos,
  saveCache,
  saveRules,
} from './lib/store'
import type { Channel, FeedRules, Video } from './lib/types'
import { fetchFeed, fetchSubscriptions } from './lib/youtube'

const SUBS_TTL_MS = 12 * 3600_000

/** How often a long paced index writes its progress to IndexedDB. */
const CHECKPOINT_MS = 5_000

export default function App() {
  const [configured, setConfigured] = useState(() => Boolean(getClientId()))
  const [signedIn, setSignedIn] = useState(false)
  const [channels, setChannels] = useState<Channel[]>([])
  const [videos, setVideos] = useState<Video[]>([])
  const [loaded, setLoaded] = useState(false)
  const [rules, setRules] = useState<FeedRules>(loadRules)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [failed, setFailed] = useState<{ title: string; message: string }[]>([])

  // Restore the cached feed, and the session only if a token is already held.
  // Authorization is never attempted on mount: the GIS token client always
  // opens a popup, and a popup not tied to a user gesture gets blocked.
  useEffect(() => {
    void loadCache().then((c) => {
      if (c) {
        setChannels(c.channels)
        setVideos(c.videos)
      }
      setLoaded(true)
    })
    setSignedIn(configured && hasValidToken())
  }, [configured])

  useEffect(() => saveRules(rules), [rules])

  const updateRules = useCallback((patch: Partial<FeedRules>) => {
    setRules((prev) => ({ ...prev, ...patch }))
  }, [])

  const hideShorts = rules.hideShorts
  // Read inside refresh without making it a dependency, so a rule edit mid-run
  // cannot rebuild the callback underneath an in-flight refresh.
  const hideShortsRef = useRef(hideShorts)
  hideShortsRef.current = hideShorts

  const refresh = useCallback(async (force = false) => {
    setBusy(true)
    setError('')
    setFailed([])
    try {
      await getAccessToken(false).catch(() => getAccessToken(true))
      setSignedIn(true)

      const current = await loadCache()
      const subsStale = !current || Date.now() - current.subsFetchedAt > SUBS_TTL_MS
      let subs = current?.channels ?? []

      if (force || subsStale || subs.length === 0) {
        setProgress('Loading subscriptions…')
        subs = await fetchSubscriptions((n) => setProgress(`Loading subscriptions… ${n}`))
        setChannels(subs)
      }

      // Accumulate outside React state so streamed batches cannot race.
      const collected: Video[] = []
      const known = new Set((current?.videos ?? []).map((v) => v.id))

      const subsFetchedAt = subsStale || force ? Date.now() : (current?.subsFetchedAt ?? Date.now())
      const persist = () =>
        saveCache({
          channels: subs,
          videos: pruneVideos(mergeVideos(current?.videos ?? [], collected)),
          subsFetchedAt,
          feedFetchedAt: Date.now(),
        })

      // Indexing is deliberately slow, so checkpoint along the way: a tab
      // closed mid-run must not discard everything already fetched and pay to
      // request it all again.
      let lastSave = Date.now()

      const result = await fetchFeed(
        subs,
        known,
        !hideShortsRef.current,
        (p) => {
          const queued = p.queued > 0 ? ` · ${p.queued} queued` : ''
          setProgress(
            p.scanned < p.channels
              ? `Scanning ${p.scanned}/${p.channels} channels · ${p.videos} videos${queued}…`
              : `Fetching videos · ${p.videos} done${queued}…`,
          )
        },
        (batch) => {
          collected.push(...batch)
          // Show each batch immediately rather than waiting for the whole run.
          setVideos((prev) => mergeVideos(prev, batch))
          if (Date.now() - lastSave > CHECKPOINT_MS) {
            lastSave = Date.now()
            void persist()
          }
        },
      )

      const merged = pruneVideos(mergeVideos(current?.videos ?? [], collected))
      setVideos(merged)
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
  const visible = useMemo(() => applyRules(videos, rules), [videos, rules])

  if (!configured) return <Setup onReady={() => setConfigured(true)} />

  return (
    <>
      <header className="topbar">
        <div className="brand">
          YouTube <span>Decomposer</span>
        </div>
        <div className="spacer" />
        {videos.length > 0 && (
          <span className="control">
            {visible.length} of {videos.length} · {channels.length} channels
          </span>
        )}
        {signedIn ? (
          <>
            <button className="primary" onClick={() => void refresh(false)} disabled={busy}>
              {busy ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              onClick={() => {
                signOut()
                setSignedIn(false)
              }}
              disabled={busy}
            >
              Sign out
            </button>
          </>
        ) : (
          <button className="primary" onClick={() => void refresh(true)} disabled={busy}>
            Sign in with Google
          </button>
        )}
      </header>

      <Controls rules={rules} onChange={updateRules} />

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
          {error && (
            <button
              onClick={() => {
                void clearCache().then(() => {
                  setVideos([])
                  setChannels([])
                })
                setError('')
              }}
            >
              Clear cache
            </button>
          )}
        </div>
      )}

      {visible.length > 0 ? (
        <div className="grid">
          {visible.map((v) => (
            <VideoCard
              key={v.id}
              video={v}
              channel={channelsById.get(v.channelId)}
              sort={rules.sort}
            />
          ))}
        </div>
      ) : (
        <div className="empty">
          {busy
            ? 'Building your feed…'
            : !loaded
              ? ''
              : videos.length > 0
                ? 'No videos match your current rules. Try widening the length range.'
                : 'Sign in to pull your subscriptions and build the feed.'}
        </div>
      )}
    </>
  )
}
