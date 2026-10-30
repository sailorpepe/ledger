// What the page takes from outside itself, checked before it is written in.
//
// Two things reach the page that the app did not make. The data files — the
// notices, the radar, the filings — are built by a script and fetched over the
// network, and every link in them becomes something a member taps. A backup
// file can come from anyone ("here's my log so you can compare hours"), and
// once it is restored, whatever it holds is drawn on every launch. The
// Content-Security-Policy in index.html is the second line; this is the first.

// A link from the data is followed only if it is a web page or an email
// address. javascript:, data:, a file path or anything that doesn't parse has
// no business on a member's phone. An address carrying a user name
// ("https://www.courtlistener.com@other.host/") shows one host and goes to
// another, so it is turned down too. Returns the address the way the browser
// will read it, or null.
const SCHEMES = new Set(['https:', 'http:', 'mailto:'])

export function safeUrl(raw) {
  if (typeof raw !== 'string') return null
  let u
  try { u = new URL(raw) } catch { return null }
  if (!SCHEMES.has(u.protocol) || u.username || u.password) return null
  return u.href
}

const attr = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// The anchor for a link from the data, or just its words when the address is
// turned down: the member still reads what was meant, with nothing to tap.
// inner is HTML the caller has already escaped; cls is a class the app chose.
// A web page opens outside the app. An email address opens Mail in place,
// because the iPhone shell hands only web addresses on to a new window.
export function linkHtml(url, inner, cls = '') {
  const href = safeUrl(url)
  const c = cls ? ` class="${attr(cls)}"` : ''
  if (!href) return `<span${c}>${inner}</span>`
  const away = href.startsWith('mailto:') ? '' : ' target="_blank" rel="noopener"'
  return `<a${c} href="${attr(href)}"${away}>${inner}</a>`
}

// Every seal the app has ever made is SHA-256 in lowercase hex, and the first
// entry points back at 'genesis'. Seal codes are printed on the Log tab, so a
// backup whose seals are anything else was not written by Ledger and is not
// restored, whatever its chain says.
const HEX64 = /^[0-9a-f]{64}$/
const isSeal = (s) => typeof s === 'string' && HEX64.test(s)

export function sealShaped(e) {
  return !!e && typeof e === 'object'
    && isSeal(e.hash)
    && (e.prev === 'genesis' || isSeal(e.prev))
    && (e.voids === undefined || isSeal(e.voids))
}

// A backup is the stored entries in an array, each exactly as it was sealed.
// Every one carries its seal and a date, but version 1.0 sealed whatever the
// date box held, and one Backspace left it ''. That day is still in the
// chain, the chain still verifies, and the backup may be the only copy of the
// log left once the phone is gone, so a blank date gets in. Whether anything
// was altered is the chain's to say; this only says whether the file is a
// Ledger log at all.
//
// Anyone can compute a seal, so a chain that verifies says nothing about what
// the fields hold. Every field the app reads must hold what Ledger writes
// there, or the restore replaces a good log with one the app cannot draw: a
// date that is a number stops the store from sorting, and the next launch
// never gets as far as Settings. A field is checked, never fixed: the seal
// covers the entry as written, key order included.
const isText = (v) => typeof v === 'string'
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const optional = (v, ok) => v === undefined || ok(v)
const orNull = (ok) => (v) => v === null || ok(v)

const punchShaped = (p) => isObj(p) && isText(p.inAt) && isText(p.outAt)
  && optional(p.exact, isNum) && optional(p.lunchWorked, (v) => typeof v === 'boolean')

const shortShaped = (s) => isObj(s) && isText(s.reason)
  && optional(s.cite, orNull(isText)) && optional(s.claim, (v) => typeof v === 'boolean')
  && optional(s.worked, isNum) && optional(s.floor, orNull(isNum))
  && optional(s.used, (v) => typeof v === 'boolean') && optional(s.scope, orNull(isText))

const flagShaped = (f) => isObj(f) && isText(f.id) && isText(f.label)

export function entryShaped(e) {
  if (!sealShaped(e) || !isText(e.date) || !isText(e.loggedAt) || !optional(e.tz, isText)
    || !optional(e.zone, isText)) return false
  if (e.voids !== undefined) return e.kind === 'void'
  return e.kind === undefined
    && isNum(e.st) && isNum(e.ot) && optional(e.dt, isNum)
    && optional(e.rate, orNull(isNum)) && optional(e.gross, orNull(isNum))
    && optional(e.contractor, orNull(isText)) && optional(e.note, orNull(isText))
    && optional(e.dayType, isText)
    && optional(e.flags, (v) => Array.isArray(v) && v.every(flagShaped))
    && optional(e.punch, orNull(punchShaped))
    && optional(e.shortDay, orNull(shortShaped))
}

export function backupShaped(list) {
  return Array.isArray(list) && list.every(entryShaped)
}
