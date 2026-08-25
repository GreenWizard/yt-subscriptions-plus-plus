// The feed Worker: all subscription/video requests, JSON parsing and IndexedDB
// writes run here, off the main thread. Auth stays on the main thread (Google
// Identity Services needs `window`), reached through the auth-request RPC.

import type { FromWorker, ToWorker } from './feed-protocol'
import { installFeedMock } from './feed-mock'
import {
  loadChannels,
  loadVideos,
  markFetched,
  pruneToSubscribed,
  saveChannels,
  saveVideos,
} from './store'
import { METADATA_REFRESH_MAX_AGE_MS, METADATA_TTL_MS } from './types'
import { fetchCurrentUser, fetchFeed, fetchSubscriptions, setAuthBridge } from './youtube'

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
  const me = await fetchCurrentUser()
  post({ kind: 'user', id: me.id, title: me.title })

  // Read the previous refresh's upload counts before the new subscription list
  // overwrites the channel rows, so fetchFeed can skip channels that are
  // unchanged since then.
  const prevChannels = await loadChannels(me.id)
  const prevCounts = new Map(prevChannels.map((c) => [c.id, c.totalItemCount]))

  const subs = await fetchSubscriptions(me.id, (count) => post({ kind: 'subs-progress', count }))
  const subscribed = new Set(subs.map((c) => c.id))
  // Channels land in the DB before any video, so the account's avatars are ready
  // by the time its first videos are read back.
  await saveChannels(subs)
  post({ kind: 'updated' })

  const cached = await loadVideos(me.id)
  const known = new Set(cached.map((v) => v.id))
  // Cached rows whose details aged out are re-read in place. Only recent uploads
  // qualify: re-reading the back catalogue would crowd out new videos.
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

  // Each batch is written to the DB as it arrives — the DB is the durable record,
  // so there is no separate checkpoint. The main thread re-reads on the ping.
  const result = await fetchFeed(
    subs,
    me.id,
    known,
    stale,
    prevCounts,
    (progress) => post({ kind: 'feed-progress', progress }),
    async (batch) => {
      await saveVideos(batch)
      post({ kind: 'updated' })
    },
  )

  // The run completed, so the subscription list is a complete picture: a channel
  // missing from it was unsubscribed and its rows are dropped from the DB.
  await pruneToSubscribed(me.id, subscribed)
  await markFetched(me.id)

  post({ kind: 'done', failed: result.failed })
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
