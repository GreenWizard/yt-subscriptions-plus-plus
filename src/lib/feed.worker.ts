// The feed Worker: all subscription/video requests, JSON parsing and IndexedDB
// writes run here, off the main thread. Auth stays on the main thread (Google
// Identity Services needs `window`), reached through the auth-request RPC.

import type { FromWorker, ToWorker } from './feed-protocol'
import { installFeedMock } from './feed-mock'
import {
  loadChannels,
  loadQuotaUsed,
  loadVideoIds,
  loadVideosSince,
  markFetched,
  pacificDay,
  pruneToSubscribed,
  saveChannels,
  saveQuota,
  saveVideos,
} from './store'
import { METADATA_REFRESH_MAX_AGE_MS, METADATA_TTL_MS, type Video } from './types'
import {
  fetchAllVideoRefs,
  fetchCurrentUser,
  fetchFeed,
  fetchSubscriptions,
  fetchVideoDetails,
  getApiCalls,
  setApiCalls,
  setAuthBridge,
} from './youtube'

// The backfill pass stops once the day's usage reaches this, leaving headroom
// under the 10,000-unit daily quota for the next refresh's own scanning.
// Overridable via env so tests can exercise the cutoff without 6000 real calls.
const BACKFILL_QUOTA_LIMIT = Number(import.meta.env.VITE_BACKFILL_LIMIT ?? 6000)
const DETAIL_CHUNK = 50

// `self` is a DedicatedWorkerGlobalScope, but the project's tsconfig ships the
// DOM lib rather than WebWorker, so pin down just the surface we use.
interface WorkerScope {
  postMessage(message: FromWorker): void
  addEventListener(type: 'message', handler: (event: { data: ToWorker }) => void): void
}
const ctx = self as unknown as WorkerScope

const post = (message: FromWorker) => ctx.postMessage(message)

// --- Auth bridge: token requests answered by the main thread ----------------

let nextAuthId = 0
const pendingAuth = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>()
// Cache the last token so most requests need no round trip; cleared on 401.
let cachedToken: string | null = null

function requestToken(interactive: boolean): Promise<string> {
  const id = nextAuthId++
  return new Promise<string>((resolve, reject) => {
    pendingAuth.set(id, { resolve, reject })
    post({ kind: 'auth-request', id, interactive })
  })
}

setAuthBridge({
  async getToken(interactive) {
    if (!interactive && cachedToken) return cachedToken
    const token = await requestToken(interactive)
    cachedToken = token
    return token
  },
  invalidate() {
    cachedToken = null
    post({ kind: 'auth-invalidate' })
  },
})

// No-op unless VITE_YT_MOCK is set; installs a fetch interceptor for testing.
// Runs after the real auth bridge above so the offline `fixtures` scenario can
// replace it with a dummy that needs no Google account.
installFeedMock()

// --- The run ----------------------------------------------------------------

async function run(): Promise<void> {
  // Quota accounting, set up before the first API call so none is missed. Seed
  // the counter from the day's stored total so the reported number spans app
  // restarts, and reset it when the Pacific day rolls over — that is when
  // YouTube resets the quota. `flushQuota` posts the running total to the UI
  // every time and persists it to the DB at most once a second (plus a forced
  // write at each milestone).
  let quotaDate = pacificDay()
  let quotaBase = await loadQuotaUsed()
  let lastQuotaSave = 0
  setApiCalls(0)
  const flushQuota = async (force = false): Promise<void> => {
    const today = pacificDay()
    if (today !== quotaDate) {
      quotaDate = today
      quotaBase = 0
      setApiCalls(0)
    }
    const used = quotaBase + getApiCalls()
    post({ kind: 'quota', date: quotaDate, used })
    const now = Date.now()
    if (force || now - lastQuotaSave > 1000) {
      lastQuotaSave = now
      await saveQuota(quotaDate, used)
    }
  }
  await flushQuota(true)

  const me = await fetchCurrentUser()
  post({ kind: 'user', id: me.id, title: me.title })

  // Previous channel rows, read before saveChannels overwrites them: their
  // upload counts drive the skip-scan decision, and their isFullyUpdated flags
  // must be carried forward onto the freshly fetched rows.
  const prevChannels = await loadChannels(me.id)
  const prevById = new Map(prevChannels.map((c) => [c.id, c]))
  const prevCounts = new Map(prevChannels.map((c) => [c.id, c.totalItemCount]))

  // Stage 1: channels. Fetch the current list, persist it, and drop any the
  // account unsubscribed from since last time — the fetched list is complete, so
  // whatever is missing from it is gone.
  const subs = await fetchSubscriptions(me.id, (count) => post({ kind: 'subs-progress', count }))
  const subscribed = new Set(subs.map((c) => c.id))
  // Carry isFullyUpdated forward; the fetched rows do not include it, so without
  // this every refresh would reset it and the backfill pass would never finish.
  for (const c of subs) c.isFullyUpdated = prevById.get(c.id)?.isFullyUpdated ?? false
  await saveChannels(subs)
  // Pruning cursor-walks the entire video store, so only pay for it when some
  // previously known channel is actually gone from the subscription list.
  const unsubscribed = prevChannels.some((c) => !subscribed.has(c.id))
  if (unsubscribed) await pruneToSubscribed(me.id, subscribed)
  post({ kind: 'updated' })
  await flushQuota()

  // Stage 2: pick channels to scan — new to us, or with a changed upload count.
  const channelsToScan = subs.filter((c) => {
    const prev = prevCounts.get(c.id)
    return prev === undefined || c.totalItemCount === undefined || prev !== c.totalItemCount
  })
  const skipped = subs.length - channelsToScan.length

  // The known-id set needs only keys, and staleness only applies to videos
  // published in the last METADATA_REFRESH_MAX_AGE_MS — so read ids without
  // materializing rows, and full rows only for that recent slice, instead of
  // loading the whole store. Read after the prune, so both reflect only
  // still-subscribed channels.
  const staleBefore = Date.now() - METADATA_TTL_MS
  const publishedAfter = Date.now() - METADATA_REFRESH_MAX_AGE_MS
  const [ids, recent] = await Promise.all([
    loadVideoIds(me.id),
    loadVideosSince(me.id, new Date(publishedAfter).toISOString()),
  ])
  const known = new Set(ids)
  const stale = new Set(recent.filter((v) => (v.fetchedAt ?? 0) < staleBefore).map((v) => v.id))

  // Writes a batch and keeps the working sets current, so neither the rest of
  // this run nor the backfill pass re-fetches a video just written.
  let wrote = 0
  const saveBatch = async (batch: Video[]): Promise<void> => {
    await saveVideos(batch)
    wrote += batch.length
    for (const v of batch) {
      known.add(v.id)
      stale.delete(v.id)
    }
    post({ kind: 'updated' })
    void flushQuota()
  }

  // Stages 3–5: scan first page → filter out cached-and-fresh ids → videos.list.
  // Each batch is written to the DB as it arrives; the main thread re-reads on
  // the `updated` ping.
  const result = await fetchFeed(
    { channelsToScan, totalChannels: subs.length, skipped, knownIds: known, staleIds: stale },
    me.id,
    (progress) => {
      post({ kind: 'feed-progress', progress })
      void flushQuota()
    },
    saveBatch,
  )

  // Any channel whose head page was entirely new likely has uploads past it, so
  // drop its isFullyUpdated flag to re-index it below. Persist the flip so an
  // interrupted run still records that the channel needs re-indexing.
  const reindex = subs.filter((c) => c.isFullyUpdated && result.needsBackfill.has(c.id))
  if (reindex.length) {
    for (const c of reindex) c.isFullyUpdated = false
    await saveChannels(reindex)
  }

  // Backfill: once the main refresh is done, fill in each not-yet-fully-indexed
  // channel's entire back catalogue — all playlist pages, not just the head —
  // one channel at a time, until the day's quota budget is spent. Marking a
  // channel done only after its videos are written means an interrupted run
  // simply retries it next time.
  const currentUsed = () => quotaBase + getApiCalls()
  const pending = subs.filter((c) => !c.isFullyUpdated)
  let backfilled = 0
  let added = 0
  for (const channel of pending) {
    if (currentUsed() >= BACKFILL_QUOTA_LIMIT) break
    post({ kind: 'backfill-progress', remaining: pending.length - backfilled, added })
    try {
      const refs = await fetchAllVideoRefs(channel.id)
      const toFetch = refs.filter((r) => !known.has(r.id) || stale.has(r.id))
      // Re-check between detail batches: a channel with a deep back catalogue can
      // otherwise blow far past the budget mid-channel. On a cutoff the channel
      // keeps isFullyUpdated=false and its fetched-so-far videos; the next run's
      // ref fetch filters those out as known, so it resumes where it stopped.
      let cutOff = false
      for (let i = 0; i < toFetch.length; i += DETAIL_CHUNK) {
        if (currentUsed() >= BACKFILL_QUOTA_LIMIT) {
          cutOff = true
          break
        }
        const videos = await fetchVideoDetails(toFetch.slice(i, i + DETAIL_CHUNK), me.id)
        added += videos.length
        await saveBatch(videos)
      }
      if (cutOff) break
      channel.isFullyUpdated = true
      await saveChannels([channel])
    } catch (err) {
      // Leave isFullyUpdated false so the channel is retried on the next refresh.
      result.failed.push({
        title: channel.title,
        message: err instanceof Error ? err.message : String(err),
      })
    }
    backfilled++
    post({ kind: 'backfill-progress', remaining: pending.length - backfilled, added })
  }

  await markFetched(me.id)
  await flushQuota(true)

  post({ kind: 'done', changed: wrote > 0 || unsubscribed, failed: result.failed })
}

ctx.addEventListener('message', (event) => {
  const msg = event.data
  switch (msg.kind) {
    case 'start':
      run().catch((err) =>
        post({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
      )
      break
    case 'auth-result':
      pendingAuth.get(msg.id)?.resolve(msg.token)
      pendingAuth.delete(msg.id)
      break
    case 'auth-error':
      pendingAuth.get(msg.id)?.reject(new Error(msg.message))
      pendingAuth.delete(msg.id)
      break
  }
})
