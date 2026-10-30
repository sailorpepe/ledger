// Where the log actually lives.
//
// localStorage was wrong for this. It is capped around 5MB, it is synchronous,
// and browsers evict it under storage pressure without asking. For a record
// whose entire value is that it existed on the day it was written, "the browser
// quietly threw it away" is not an acceptable failure mode.
//
// IndexedDB instead, with a persistence request. Nothing leaves the device —
// there is no server here and nothing to subpoena from us. The trade is that
// the member is now responsible for backups, so the app has to nag about them.

const DB_NAME = 'ledger'
const STORE = 'entries'
const META = 'meta'
const VERSION = 1
const LEGACY_KEY = 'ledger.entries.v1'

let dbPromise = null

function openDB() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        // hash is the natural key: it is unique by construction and an entry
        // can never legitimately be rewritten under the same one.
        const s = db.createObjectStore(STORE, { keyPath: 'hash' })
        s.createIndex('date', 'date')
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode)
    const out = fn(t.objectStore(store))
    t.oncomplete = () => {
      // Unwrap an IDBRequest by identity, not by truthiness. `out?.result ?? out`
      // looks equivalent and is not: a request whose result is undefined falls
      // through to the request object itself, so "nothing stored" comes back as
      // a truthy value and every `if (value)` downstream reads it as a hit.
      resolve(out instanceof IDBRequest ? out.result : out)
    }
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  }))
}

// Newest work date first. The order must come out whatever a stored row
// holds: this runs before anything paints on every launch, and a row it
// threw on would leave the app with no way into Settings to restore or erase.
const text = (v) => String(v ?? '')
export const newestFirst = (a, b) =>
  text(b.date).localeCompare(text(a.date)) || text(b.loggedAt).localeCompare(text(a.loggedAt))
export const readAll = () => tx(STORE, 'readonly', (s) => s.getAll()).then((rows) => rows.sort(newestFirst))

export const put = (entry) => tx(STORE, 'readwrite', (s) => s.put(entry))

export const replaceAll = (entries) => tx(STORE, 'readwrite', (s) => {
  s.clear()
  for (const e of entries) s.put(e)
})

export const getMeta = (k) => tx(META, 'readonly', (s) => s.get(k))
export const setMeta = (k, v) => tx(META, 'readwrite', (s) => s.put(v, k))
export const metaKeys = () => tx(META, 'readonly', (s) => s.getAllKeys())

// The localStorage keys Erase removes: every one of Ledger's ('ledger.') but
// those it is told to keep. Other pages on a shared web address keep theirs.
// Includes the pre-release copy of the log the old build left behind.
export function erasableKeys(storage, keep) {
  const out = []
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i)
    if (typeof k === 'string' && k.startsWith('ledger.') && !keep.has(k)) out.push(k)
  }
  return out
}

// Everything the database holds for the member, gone in one transaction: the
// log and every record kept beside it — cards and their numbers, paydays, a
// running punch, backup and notice state, the radar's matches against his
// contractors. All or nothing, so an erase that fails halfway leaves nothing
// half-erased. Language, skin and time zone are in localStorage and not
// touched here.
export const eraseAll = () => openDB().then((db) => new Promise((resolve, reject) => {
  const t = db.transaction([STORE, META], 'readwrite')
  t.objectStore(STORE).clear()
  t.objectStore(META).clear()
  t.oncomplete = () => resolve()
  t.onerror = () => reject(t.error)
  t.onabort = () => reject(t.error)
}))

// One-time lift of anything written by the old localStorage build. Left in
// place rather than deleted, so a failed migration doesn't lose the only copy.
export async function migrateLegacy() {
  const raw = localStorage.getItem(LEGACY_KEY)
  if (!raw) return 0
  let rows
  try { rows = JSON.parse(raw) } catch { return 0 }
  if (!Array.isArray(rows) || !rows.length) return 0

  const existing = await readAll()
  const known = new Set(existing.map((e) => e.hash))
  const fresh = rows.filter((e) => e?.hash && !known.has(e.hash))
  for (const e of fresh) await put(e)

  localStorage.setItem(LEGACY_KEY + '.migrated', raw)
  localStorage.removeItem(LEGACY_KEY)
  return fresh.length
}

// Ask the browser to exempt us from automatic eviction. Chrome grants it based
// on engagement, Safari on being added to the home screen. It can be refused,
// which is exactly why the answer to durability is backups, not this call.
export async function requestPersistence() {
  const out = { supported: false, persisted: false, usage: 0, quota: 0 }
  if (!navigator.storage) return out
  out.supported = true
  try {
    out.persisted = await navigator.storage.persisted?.() ?? false
    if (!out.persisted) out.persisted = await navigator.storage.persist?.() ?? false
    const est = await navigator.storage.estimate?.()
    out.usage = est?.usage ?? 0
    out.quota = est?.quota ?? 0
  } catch { /* not fatal — the log still works, it is just evictable */ }
  return out
}
