import { useCallback, useEffect, useMemo, useState } from 'react'
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
  type FeedCache,
} from './lib/store'
import type { FeedRules } from './lib/types'
import { fetchFeed, fetchSubscriptions, type RefreshProgress } from './lib/youtube'

const SUBS_TTL_MS = 12 * 3600_000

export default function App() {
  const [configured, setConfigured] = useState(() => Boolean(getClientId()))
  const [signedIn, setSignedIn] = useState(false)
  const [cache, setCache] = useState<FeedCache | null>(null)
  const [rules, setRules] = useState<FeedRules>(loadRules)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string>('')
  const [error, setError] = useState<string>('')

  // Restore the cached feed and, if Google can renew silently, the session too.
  useEffect(() => {
    void loadCache().then((c) => c && setCache(c))
    if (!configured) return
    if (hasValidToken()) {
      setSignedIn(true)
      return
    }
    getAccessToken(false)
      .then(() => setSignedIn(true))
      .catch(() => setSignedIn(false))
  }, [configured])

  useEffect(() => saveRules(rules), [rules])

  const updateRules = useCallback((patch: Partial<FeedRules>) => {
    setRules((prev) => ({ ...prev, ...patch }))
  }, [])

  const refresh = useCallback(
    async (force = false) => {
      setBusy(true)
      setError('')
      try {
        await getAccessToken(false).catch(() => getAccessToken(true))
        setSignedIn(true)

        const current = (await loadCache()) ?? null
        const subsStale = !current || Date.now() - current.subsFetchedAt > SUBS_TTL_MS
        let channels = current?.channels ?? []

        if (force || subsStale || channels.length === 0) {
          setProgress('Loading subscriptions…')
          channels = await fetchSubscriptions((n) => setProgress(`Loading subscriptions… ${n}`))
        }

        const known = new Set((current?.videos ?? []).map((v) => v.id))
        const describe = (p: RefreshProgress) =>
          p.stage === 'uploads'
            ? `Scanning channels… ${p.done}/${p.total}`
            : p.stage === 'details'
              ? `Fetching ${p.total} new videos…`
              : 'Finishing up…'

        const { videos } = await fetchFeed(channels, rules.lookbackDays, known, (p) =>
          setProgress(describe(p)),
        )

        const merged = pruneVideos(
          mergeVideos(current?.videos ?? [], videos),
          Math.max(rules.lookbackDays, 30),
        )
        const next: FeedCache = {
          channels,
          videos: merged,
          subsFetchedAt: subsStale || force ? Date.now() : (current?.subsFetchedAt ?? Date.now()),
          feedFetchedAt: Date.now(),
        }
        await saveCache(next)
        setCache(next)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
        setProgress('')
      }
    },
    [rules.lookbackDays],
  )

  const channelsById = useMemo(
    () => new Map((cache?.channels ?? []).map((c) => [c.id, c])),
    [cache],
  )

  const visible = useMemo(() => applyRules(cache?.videos ?? [], rules), [cache, rules])

  if (!configured) return <Setup onReady={() => setConfigured(true)} />

  return (
    <>
      <header className="topbar">
        <div className="brand">
          YouTube <span>Decomposer</span>
        </div>
        <div className="spacer" />
        {cache && (
          <span className="control">
            {visible.length} of {cache.videos.length} · {cache.channels.length} channels
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

      {(progress || error) && (
        <div className="status">
          {progress && <span>{progress}</span>}
          {error && <span className="error">{error}</span>}
          {error && (
            <button
              onClick={() => {
                void clearCache().then(() => setCache(null))
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
            : cache
              ? 'No videos match your current rules. Try widening the length range or the lookback window.'
              : 'Sign in to pull your subscriptions and build the feed.'}
        </div>
      )}
    </>
  )
}
