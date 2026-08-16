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
 *   version bump below installs the new copy and drops the old one.
 *
 *   The data — filings, prevailing wage, the radar, notices — is
 *   network-first with a cached fallback. Fresh when there is signal, last
 *   known good when there isn't. A notice nobody receives is worse than no
 *   notice at all, so this side must not go stale silently.
 *
 * Nothing a member logs passes through here. That lives in IndexedDB and has
 * never touched a network.
 */

const VERSION = 'ledger-1.0-b3'
const SHELL = `${VERSION}-shell`
const DATA = `${VERSION}-data`

const SHELL_FILES = [
  './',
  './index.html',
  './app.js',
  './i18n.js',
  './store.js',
  './certs.js',
  './style.css',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
]

self.addEventListener('install', (e) => {
  // addAll fails the whole install if one file 404s, which is the behaviour we
  // want — a half-cached app that boots to a broken screen is worse than one
  // that simply falls back to the network.
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return

  // Data: fresh if we can get it, last known good if we can't.
  if (url.pathname.includes('/data/')) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone()
          caches.open(DATA).then((c) => c.put(e.request, copy))
          return res
        })
        .catch(() => caches.match(e.request).then((hit) => hit ?? Response.error()))
    )
    return
  }

  // The app: cached copy first, and a navigation that misses falls back to the
  // start page rather than the browser's offline dinosaur.
  e.respondWith(
    caches.match(e.request).then((hit) => hit ?? fetch(e.request).catch(() => {
      if (e.request.mode === 'navigate') return caches.match('./index.html')
      return Response.error()
    }))
  )
})
