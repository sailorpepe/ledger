// A new version of the web app, offered and never forced.
//
// The service worker installs a new version in the background and takes over
// the open page, but the page keeps running the code it booted with until it
// reloads. Reloading under a member mid-entry would throw away the day he is
// typing, so the page only offers it: a bar that reloads when tapped, put up
// only once he isn't in the middle of something.
//
// The iPhone shell serves its own files and runs no service worker, so none of
// this happens there.

// sw: navigator.serviceWorker. isBusy: true while the member is mid-entry.
// show: put the offer on screen. Returns a function to call whenever he may
// have finished (a field lost focus, a sheet closed, a day was logged); it puts
// the offer up if one is waiting and the moment is right.
export function watchForUpdate({ sw, isBusy, show }) {
  // The first worker ever installed also takes over the page it was installed
  // from. Nothing changed then — page and worker are the same version — so only
  // a takeover of a page that already had a worker is an update.
  let hadWorker = !!sw.controller
  let waiting = false
  let shown = false
  const offer = () => {
    if (!waiting || shown || isBusy()) return
    shown = true
    show()
  }
  sw.addEventListener('controllerchange', () => {
    if (!hadWorker) { hadWorker = true; return }
    waiting = true
    offer()
  })
  return offer
}

// Mid-entry: a field has focus, a note is written but not logged, or a sheet
// is open (a form, a confirm). A reload in any of those loses what he put in.
export function entryBusy(doc) {
  const a = doc.activeElement
  if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName ?? ''))) return true
  if ((doc.getElementById('fNote')?.value ?? '').trim()) return true
  const sheet = doc.getElementById('sheet')
  return !!sheet && !sheet.hidden
}

// A phone keeps a home-screen web app in memory for days, and an app that
// never navigates never makes the browser look for a new worker. So look when
// it comes back on screen, at most once an hour; sw.js is a few KB.
export function updateCheck(reg, { every = 60 * 60 * 1000, now = () => Date.now() } = {}) {
  let last = now()
  return () => {
    if (now() - last < every) return
    last = now()
    Promise.resolve().then(() => reg.update()).catch(() => {}) // no signal: next time
  }
}
