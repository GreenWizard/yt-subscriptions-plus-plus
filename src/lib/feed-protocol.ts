// The message contract between the main thread and the feed Worker.
//
// The Worker owns everything network- and IndexedDB-bound: it resolves the
// account, reads and writes the cache, scans subscriptions and fetches video
// details. IndexedDB is the single source of truth, so the Worker never sends
// feed data over the wire — it writes rows to the DB and posts a lightweight
// `updated` ping, and the main thread re-reads the DB to render. The main thread
// owns auth (Google Identity Services needs `window`); tokens travel main ->
// Worker on request.

import type { RefreshProgress } from './youtube'

/** Messages the main thread posts into the Worker. */
export type ToWorker =
  | { kind: 'start' }
  | { kind: 'auth-result'; id: number; token: string }
  | { kind: 'auth-error'; id: number; message: string }

/** Messages the Worker posts back to the main thread. */
export type FromWorker =
  // The Worker needs an access token; the main thread answers with auth-result.
  | { kind: 'auth-request'; id: number; interactive: boolean }
  // A 401 was hit: the main thread should drop its cached token before the next
  // auth-request so it re-authorizes.
  | { kind: 'auth-invalidate' }
  | { kind: 'user'; id: string; title: string }
  | { kind: 'subs-progress'; count: number }
  | { kind: 'feed-progress'; progress: RefreshProgress }
  // Cumulative API calls (≈ quota units) used so far in the current Pacific day.
  | { kind: 'quota'; date: string; used: number }
  // Background backfill pass: channels still awaiting full history, and videos
  // it has added so far this run.
  | { kind: 'backfill-progress'; remaining: number; added: number }
  // The DB has new rows for the current account; the main thread should re-read.
  | { kind: 'updated' }
  // The run finished and its final state is already persisted. `changed` says
  // whether the run altered the DB (videos written or rows pruned); when false
  // the main thread skips the final full re-read — what is on screen is current.
  | { kind: 'done'; changed: boolean; failed: { title: string; message: string }[] }
  | { kind: 'error'; message: string }
