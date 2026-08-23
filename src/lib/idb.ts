// Minimal promise-based key/value store on IndexedDB. No dependencies.
const DB_NAME = 'ytd'
const STORE = 'kv'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE)
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = fn(t.objectStore(STORE))
        t.oncomplete = () => resolve(req.result)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      }),
  )
}

export function idbGet<T>(key: string): Promise<T | undefined> {
  return tx<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>)
}

export function idbSet(key: string, value: unknown): Promise<unknown> {
  return tx('readwrite', (s) => s.put(value, key))
}

export function idbDel(key: string): Promise<unknown> {
  return tx('readwrite', (s) => s.delete(key))
}
