/* Ledger service worker.
 *
 * The whole point of this app is that a laborer can open it standing in a
 * basement with no signal and log the day he just worked. On the phone the
 * native build carries its own copy of everything. On the web it has to be
 * cached deliberately, or the app is a blank page exactly when it matters.
 *
 * Two policies, for two kinds of file:
 *
 *   The app itself — HTML, JS, CSS, icons — is cache-first. It changes only
 *   when a new version ships, and it must never depend on the network. A
 *   version bump below installs the new copy and drops the old one; the open
 *   page then offers a reload instead of forcing one (update.js).
 *
 *   The data — filings, the agreement, prevailing wage, the radar, notices —
 *   is network-first with a cached fallback. Fresh when there is signal, last
 *   known good when there isn't. A notice nobody receives is worse than no
 *   notice at all, so this side must not go stale silently.
 *
 * The data cache is the one that has to be there in the basement, and without
 * contract.json a 10-hour weekday splits as 10 straight and is sealed that way.
 * So the data is fetched at install (a first visit loads its data before this
 * worker exists to see it), it lives in one cache that no version bump clears,
 * each file is stored once whatever ?v= the page put on it, and only a real
 * JSON answer ever replaces the copy that is there.
 *
 * Nothing a member logs passes through here. That lives in IndexedDB and has
 * never touched a network.
 */

const VERSION = 'ledger-1.0-b6'
const SHELL = `${VERSION}-shell`
const DATA = 'ledger-data'

// Every module the page imports belongs here, one quoted path per line: a
// module missing from this list is a blank screen offline.
const SHELL_FILES = [
  './',
  './index.html',
  './app.js',
  './i18n.js',
  './store.js',
  './certs.js',
  './dictation.js',
  './overtime.js',
  './update.js',
  './guard.js',
  './version.js',
  './dates.js',
  './chain.js',
  './daytype.js',
  './showup.js',
  './notices.js',
  './report.js',
  './backupnag.js',
  './style.css',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
]

// What the page reads at boot. The home local's filings are added from
// index.json; any other local is kept the first time it is opened with signal.
const INDEX = './data/index.json'
const DATA_FILES = [
  './data/contract.json',
  './data/prevailing.json',
  './data/funds.json',
  './data/radar.json',
  './data/notices.json',
]

const abs = (path) => new URL(path, location.href).href
const DATA_PATH = new URL('./data/', location.href).pathname
const LOCALS_PATH = new URL('./data/locals/', location.href).pathname

// One entry per file. The page asks for contract.json?v=<build> to get past
// the browser's HTTP cache, and a phone that loses signal halfway through a
// refresh must still find the copy it stored under the previous build.
function keyOf(req) {
  const u = new URL(typeof req === 'string' ? req : req.url, location.href)
  u.search = ''
  u.hash = ''
  return u.href
}

// Only a real answer is kept. A 404 or 500 from the host, or a hotel or
// jobsite wifi login page answering 200 with HTML, never replaces a good copy.
const usable = (res) => !!res && res.ok && /json/i.test(res.headers.get('content-type') ?? '')

const lastGood = (key) => caches.open(DATA).then((c) => c.match(key))

async function precacheData() {
  const cache = await caches.open(DATA)
  const keep = async (path) => {
    const res = await fetch(new Request(abs(path), { cache: 'no-cache' }))
    if (!usable(res)) return null
    await cache.put(keyOf(abs(path)), res.clone())
    return res
  }
  const index = await keep(INDEX).then((res) => res?.json()).catch(() => null)
  const files = [...DATA_FILES]
  if (index?.homeLocal != null) files.push(`./data/locals/${encodeURIComponent(index.homeLocal)}.json`)
  await Promise.all(files.map((f) => keep(f).catch(() => null)))
}

// Versions before this one kept data in a cache named after the version, which
// every update deleted. Whatever good copy they hold moves over before they go,
// newest first, without displacing anything fetched fresh at install.
async function adoptOldData() {
  const data = await caches.open(DATA)
  const have = new Set((await data.keys()).map(keyOf))
  for (const name of await caches.keys()) {
    if (name === DATA || !/^ledger-.+-data$/.test(name)) continue
    const old = await caches.open(name)
    for (const req of (await old.keys()).reverse()) {
      const key = keyOf(req)
      if (have.has(key)) continue
      const res = await old.match(req)
      if (!usable(res)) continue
      await data.put(key, res)
      have.add(key)
    }
  }
}

// Only stale URLs leave the data cache: a copy stored under a query string, or
// filings for a local that index.json no longer lists.
async function pruneData() {
  const cache = await caches.open(DATA)
  const index = await cache.match(abs(INDEX)).then((r) => r?.json()).catch(() => null)
  const listed = Array.isArray(index?.locals)
    ? new Set(index.locals.map((l) => abs(`./data/locals/${encodeURIComponent(l.slug)}.json`)))
    : null
  for (const req of await cache.keys()) {
    const u = new URL(req.url)
    const stale = u.search
      || !u.pathname.startsWith(DATA_PATH)
      || (listed && u.pathname.startsWith(LOCALS_PATH) && !listed.has(u.href))
    if (stale) await cache.delete(req)
  }
}

self.addEventListener('install', (e) => {
  // addAll fails the whole install if one file 404s, which is the behaviour we
  // want — a half-cached app that boots to a broken screen is worse than one
  // that simply falls back to the network. no-cache makes the browser check
  // with the host, so a copy it fetched minutes ago can't slip into the new
  // version. The data is best effort: whatever misses here is kept the next
  // time the page asks for it.
  e.waitUntil(
    Promise.all([
      caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((f) => new Request(abs(f), { cache: 'no-cache' })))),
      precacheData().catch(() => {}),
    ]).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    await adoptOldData().catch(() => {})
    // Only Ledger's own caches. Other projects share this origin, and theirs
    // are not ours to clear.
    for (const name of await caches.keys()) {
      if (name.startsWith('ledger-') && name !== SHELL && name !== DATA) await caches.delete(name)
    }
    await pruneData().catch(() => {})
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return

  // Data: fresh if we can get it, last known good if we can't.
  if (url.pathname.startsWith(DATA_PATH)) {
    const key = keyOf(e.request)
    // The copy is taken in the same step that receives the response, before
    // the page starts reading its body.
    const fresh = fetch(e.request).then((res) => ({ res, copy: usable(res) ? res.clone() : null }))
    e.waitUntil(fresh.then(({ copy }) => copy && caches.open(DATA).then((c) => c.put(key, copy))).catch(() => {}))
    e.respondWith(fresh.then(
      ({ res, copy }) => (copy ? res : lastGood(key).then((hit) => hit ?? res)),
      () => lastGood(key).then((hit) => hit ?? Response.error()),
    ))
    return
  }

  // The app: cached copy first, and a navigation that misses falls back to the
  // start page rather than the browser's offline dinosaur.
  e.respondWith(
    caches.open(SHELL).then((c) => c.match(e.request)).then((hit) => hit ?? fetch(e.request).catch(() => {
      if (e.request.mode !== 'navigate') return Response.error()
      return caches.open(SHELL).then((c) => c.match(abs('./index.html'))).then((page) => page ?? Response.error())
    }))
  )
})
