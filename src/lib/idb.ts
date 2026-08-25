// Per-row IndexedDB store. Videos and channels live as individual records keyed
// by [userId, id] and indexed by userId, so the feed Worker can put a batch as
// soon as it arrives without rewriting the whole account, and the main thread
// can read one account's rows back to render. This store is the single source
// of truth: the Worker only writes here, the UI only reads from here.
const DB_NAME = 'ytd'
const DB_VERSION = 2

/** Stores of [userId, id]-keyed rows. */
export type RowStore = 'videos' | 'channels'

export interface Meta {
  userId: string
  feedFetchedAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = (event) => {
        const db = req.result
        for (const name of ['videos', 'channels'] as const) {
          if (!db.objectStoreNames.contains(name)) {
            const store = db.createObjectStore(name, { keyPath: ['userId', 'id'] })
            store.createIndex('by_user', 'userId', { unique: false })
          }
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'userId' })
        }
        // v1 kept one JSON blob per account under `cache.v3.*` in a `kv` store.
        // Fold those into the per-row stores so existing accounts need not
        // re-index, then drop the blob. The whole thing rides the one
        // versionchange transaction, so it is all-or-nothing.
        if (event.oldVersion >= 1 && db.objectStoreNames.contains('kv') && req.transaction) {
          migrateBlobs(req.transaction)
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

interface LegacyBlob {
  userId?: string
  videos?: unknown[]
  channels?: unknown[]
  feedFetchedAt?: number
}

/** A row is only writable if its compound key parts are present and strings. */
function keyable(row: unknown, userId: string): row is { userId: string; id: string } {
  return (
    typeof row === 'object' &&
    row !== null &&
    (row as { userId?: unknown }).userId === userId &&
    typeof (row as { id?: unknown }).id === 'string'
  )
}

function migrateBlobs(tx: IDBTransaction): void {
  const kv = tx.objectStore('kv')
  const videos = tx.objectStore('videos')
  const channels = tx.objectStore('channels')
  const meta = tx.objectStore('meta')
  kv.openCursor().onsuccess = (event) => {
    const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result
    if (!cursor) return
    if (typeof cursor.key === 'string' && cursor.key.startsWith('cache.v3.')) {
      const blob = cursor.value as LegacyBlob
      if (blob?.userId) {
        for (const v of blob.videos ?? []) if (keyable(v, blob.userId)) videos.put(v)
        for (const c of blob.channels ?? []) if (keyable(c, blob.userId)) channels.put(c)
        meta.put({ userId: blob.userId, feedFetchedAt: blob.feedFetchedAt ?? 0 })
      }
      cursor.delete()
    }
    cursor.continue()
  }
}

/** Insert or update rows, one transaction for the whole batch. */
export function putRows<T>(store: RowStore, rows: T[]): Promise<void> {
  if (rows.length === 0) return Promise.resolve()
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite')
        const os = tx.objectStore(store)
        for (const row of rows) os.put(row)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

/** Every row belonging to one account. */
export function getRowsByUser<T>(store: RowStore, userId: string): Promise<T[]> {
  return openDb().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).index('by_user').getAll(userId)
        req.onsuccess = () => resolve(req.result as T[])
        req.onerror = () => reject(req.error)
      }),
  )
}

/** Delete the account's rows for which `keep` returns false. */
export function pruneUserRows<T>(
  store: RowStore,
  userId: string,
  keep: (row: T) => boolean,
): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite')
        const cursorReq = tx.objectStore(store).index('by_user').openCursor(userId)
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result
          if (!cursor) return
          if (!keep(cursor.value as T)) cursor.delete()
          cursor.continue()
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

export function getMeta(userId: string): Promise<Meta | undefined> {
  return openDb().then(
    (db) =>
      new Promise<Meta | undefined>((resolve, reject) => {
        const req = db.transaction('meta', 'readonly').objectStore('meta').get(userId)
        req.onsuccess = () => resolve(req.result as Meta | undefined)
        req.onerror = () => reject(req.error)
      }),
  )
}

export function putMeta(meta: Meta): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction('meta', 'readwrite')
        tx.objectStore('meta').put(meta)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

/** Remove an account's entire cache across all stores in one transaction. */
export function clearUser(userId: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['videos', 'channels', 'meta'], 'readwrite')
        for (const store of ['videos', 'channels'] as const) {
          const cursorReq = tx.objectStore(store).index('by_user').openCursor(userId)
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result
            if (!cursor) return
            cursor.delete()
            cursor.continue()
          }
        }
        tx.objectStore('meta').delete(userId)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}
