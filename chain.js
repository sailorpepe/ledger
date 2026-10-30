// The seal: how an entry joins the chain, and how the chain is checked.
//
// Every entry commits to the one before it with sha256(prev + JSON of the
// entry). The chain is the order things were WRITTEN, and the only thing that
// records that order is the links themselves. The phone's clock does not: it
// gets set by hand, corrected by the carrier, moved by travel. Both appending
// and checking therefore go by the links; seal time never decides what came
// after what.
//
// Stored entries are never rebuilt, reordered or normalized here. The hash is
// over JSON.stringify of the entry exactly as it was sealed, key order
// included, so an entry is only ever read or hashed as it stands.

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// The body goes in exactly as the caller laid it out, prev included.
export async function seal(body) {
  return { ...body, hash: await sha256(body.prev + JSON.stringify(body)) }
}

// The entry the next one chains onto: the end of the chain, the one nothing
// points to yet. In an intact log there is exactly one. A log split by an
// older version (two entries sealed onto the same one) has two ends; the next
// seal goes on the longer line, the one that has kept being written.
export function chainHead(log) {
  if (!log.length) return 'genesis'
  const byHash = new Map(log.map((e) => [e.hash, e]))
  const pointedAt = new Set(log.map((e) => e.prev))
  const depth = new Map()
  const depthOf = (e) => {
    const path = [], onPath = new Set()
    let cur = e
    while (cur && !depth.has(cur.hash) && !onPath.has(cur.hash)) {
      path.push(cur); onPath.add(cur.hash)
      cur = byHash.get(cur.prev)
    }
    let d = cur && depth.has(cur.hash) ? depth.get(cur.hash) : 0
    for (let i = path.length - 1; i >= 0; i--) depth.set(path[i].hash, ++d)
    return depth.get(e.hash)
  }
  const ends = log.filter((e) => !pointedAt.has(e.hash))
  let best = null, bestDepth = -1
  for (const e of ends.length ? ends : log) {
    const d = depthOf(e)
    if (d > bestDepth || (d === bestDepth && String(e.loggedAt) > String(best.loggedAt))) {
      best = e; bestDepth = d
    }
  }
  return best.hash
}

// Walk the chain from 'genesis' along its links. The order of the array does
// not matter (the store hands entries back by work date), and neither does
// the clock each one was sealed by.
//
//   { ok: true, count }             one unbroken line through every entry
//   { ok: false, at }               an entry no longer matches its seal, or
//                                   one it points to is gone
//   { ok: false, at, fork: true }   every entry matches its seal, but two were
//                                   sealed onto the same one — a double tap
//                                   or a clock change under version 1.0, not
//                                   an edit
//
// `at` is the work date of the first entry in question, as it always was.
export async function verifyChain(log) {
  // Seal time only orders two entries sealed onto the same one, and the
  // strays; it never decides whether the chain holds. The sort still throws
  // on an entry with no seal time, as it always has, so a restore refuses a
  // file this app could not have written instead of storing it.
  const chron = [...log].sort((a, b) => a.loggedAt.localeCompare(b.loggedAt))

  const altered = new Set()
  for (const e of chron) {
    const { hash, ...body } = e
    if ((await sha256(body.prev + JSON.stringify(body))) !== hash) altered.add(e)
  }

  const next = new Map()
  for (const e of chron) {
    if (!next.has(e.prev)) next.set(e.prev, [])
    next.get(e.prev).push(e)
  }

  // Breadth-first from genesis: the order written, as far as the links say.
  // Anything never reached hangs off an entry that is no longer in the log.
  const walked = [], reached = new Set()
  const queue = ['genesis'], queued = new Set(queue)
  let fork = null
  for (let i = 0; i < queue.length; i++) {
    const kids = next.get(queue[i]) ?? []
    if (kids.length > 1 && !fork) fork = kids[1]
    for (const k of kids) {
      if (reached.has(k)) continue
      reached.add(k); walked.push(k)
      if (!queued.has(k.hash)) { queued.add(k.hash); queue.push(k.hash) }
    }
  }
  const stray = chron.filter((e) => !reached.has(e))

  const firstAltered = [...walked, ...stray].find((e) => altered.has(e))
  if (firstAltered) return { ok: false, at: firstAltered.date }
  if (stray.length) return { ok: false, at: stray[0].date }
  if (fork) return { ok: false, at: fork.date, fork: true }
  return { ok: true, count: log.length }
}

// One write at a time. Each append reads the end of the chain and then waits
// on the database; a second append that starts inside that wait reads the same
// end and seals onto it too, splitting the chain for good. Queued, each one
// starts only after the last has landed. A failed write does not stall the
// queue behind it.
export function serial() {
  let tail = Promise.resolve()
  return (task) => {
    const run = tail.then(task)
    tail = run.catch(() => {})
    return run
  }
}

// One seal per tap. A gloved thumb lands twice. The second landing must do
// nothing while the first is still writing, and nothing for a moment after,
// while the form has already reset to a fresh 8-hour day: that default day is
// exactly what a second tap would seal. The task answers true only when it
// sealed; a refusal (no hours, no date) or a failure frees the button at once.
export function oneSealPerTap(task, { holdMs = 0, lock = () => {}, unlock = () => {} } = {}) {
  let held = false
  return async (...args) => {
    if (held) return false
    held = true
    lock()
    let sealed = false
    try {
      sealed = (await task(...args)) === true
      return sealed
    } finally {
      const free = () => { held = false; unlock() }
      if (sealed && holdMs > 0) setTimeout(free, holdMs)
      else free()
    }
  }
}
