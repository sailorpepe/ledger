// Certification tracking.
//
// There is no API for any of this. Not from OSHA, not from the training funds,
// not from any of the contractor prequal platforms — I looked. The cards in a
// laborer's wallet are the only complete record of what he is qualified to do,
// which is exactly why holding that record is worth something.
//
// So the app does the two things that need doing: remember what you have, and
// tell you before it lapses. An expired card means you don't get the call, and
// nobody phones to warn you.

import { localDayKey } from './dates.js'

// Renewal periods in months. Names and notes live in i18n.js as cert_<id> and
// certNote_<id>, in English and Spanish, because the note is where the legal
// guidance is and a Spanish-first member needs it most.
//
// basis 'custom': no law and no card sets the period; it is what contractors
//   commonly ask for. Past it the card reads "refresh suggested", never
//   "expired" — telling a member he is out of compliance when he is not
//   costs him a day's class, and teaches him to ignore the red.
// printed: the period varies card to card (examiners, training providers), so
//   the date has to come off the card. A computed date here can outlast the
//   real one, which is the one failure this tab exists to prevent.
// chain: cards that keep each other current. The newest card in a chain is
//   the one that counts; older ones stay as history.
// renews: one credential, so a newer card of this type replaces the older.
//   Opt-in, because several lines here hold two credentials that each run
//   out on their own: NCCCO Rigger and Signalperson, asbestos and lead worker
//   and supervisor, scaffold user and competent person, and a fit test for
//   each facepiece (29 CFR 1910.134(f)(2)). A newer one of those must never
//   hide an older one that is lapsing.
// refresher: kept current by a refresher of that type rather than retaken.
export const CERT_TYPES = [
  // OSHA's Outreach cards do not expire. Five years is what general
  // contractors commonly ask for, and most journeymen's cards are older.
  { id: 'osha10', months: 60, basis: 'custom' },
  { id: 'osha30', months: 60, basis: 'custom' },
  // 29 CFR 1910.120(e)(8): eight hours of refresher training annually. The
  // 40 hours are never retaken while the refreshers are kept up.
  { id: 'hazwoper40', months: 12, chain: 'hazwoper', refresher: 'hazwoper8' },
  { id: 'hazwoper8', months: 12, chain: 'hazwoper' },
  { id: 'asbestos', months: 12 },
  // 77 Ill. Adm. Code 845.125(a)(2)(B): training certificates are valid 3
  // years from the exam.
  { id: 'lead', months: 36 },
  // 845.125(c)(2): licenses expire March 31 of each year, except that a
  // first-time license issued January through March runs to March 31 of the
  // next year. Which March 31 turns on whether it was his first license,
  // which the form does not ask, so the date comes off the license.
  { id: 'leadlicense', printed: true },
  { id: 'silica', months: 12, basis: 'custom' },
  { id: 'confined', months: 12, basis: 'custom' },
  // 29 CFR 1926.454(c): retraining when conditions or the scaffold type
  // change, not on a date.
  { id: 'scaffold', months: 12, basis: 'custom' },
  { id: 'respirator', months: 12 },
  { id: 'cpr', months: 24, renews: true },
  { id: 'firstaid', months: 24, renews: true },
  // ATSSA cards run 4 years; Illinois also accepts NSC and the Laborers' own
  // training, on their own periods.
  { id: 'flagger', printed: true },
  // 49 CFR 391.45: 24 months is the maximum, and 12 months or less is common.
  { id: 'cdlmed', printed: true, renews: true },
  { id: 'forklift', months: 36 },
  // ANSI A92.22/.24 set no period at all.
  { id: 'mewp', months: 36, basis: 'custom' },
  { id: 'rigging', months: 60 },
  { id: 'other', printed: true },
]

export const typeOf = (id) => CERT_TYPES.find((t) => t.id === id) ?? CERT_TYPES.at(-1)

/* ---- calendar dates ----
   Every date here is a calendar date, 'YYYY-MM-DD', with no clock and no zone.
   A card is good through the day printed on it wherever the member is
   standing, so the arithmetic is done on the calendar itself. Counting in
   hours from noon made the countdown run a day high every morning: a card
   that lapsed yesterday read "Expires today". */

export const MIN_DATE = '1950-01-01'
export const MAX_DATE = '2099-12-31'

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/
const pad = (n) => String(n).padStart(2, '0')
const fmt = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const parts = (iso) => { const m = ISO.exec(iso); return [Number(m[1]), Number(m[2]), Number(m[3])] }

// Desktop browsers accept a 5-digit year in a date field. One of those once
// stopped the whole app from starting, so nothing below trusts a date that
// has not passed through here.
export function isISODate(s) {
  if (typeof s !== 'string' || !ISO.test(s) || s < MIN_DATE || s > MAX_DATE) return false
  const [y, m, d] = parts(s)
  return m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m)
}

// Today in the log's zone (dates.js), the day the countdown counts from.
// toISOString() is UTC, which in Chicago is tomorrow from 7 pm on, and the
// phone's own zone is wherever it was last set.
export const localISO = (d = new Date()) => localDayKey(d)

const dayNumber = (iso) => { const [y, m, d] = parts(iso); return Date.UTC(y, m - 1, d) / 86400000 }
export const daysBetween = (from, to) => dayNumber(to) - dayNumber(from)

export function addMonths(iso, months) {
  const [y, m, d] = parts(iso)
  const n = y * 12 + (m - 1) + months
  const ny = Math.floor(n / 12), nm = (n % 12) + 1
  // Rolling 31 Jan forward a month must not silently land in March.
  return fmt(ny, nm, Math.min(d, daysIn(ny, nm)))
}

/* ---- status ---- */

export function expiryFor(cert) {
  if (!cert) return null
  if (cert.expires) return isISODate(cert.expires) ? cert.expires : null
  if (!isISODate(cert.issued)) return null
  const t = typeOf(cert.type)
  if (t.printed) return null
  return t.months ? addMonths(cert.issued, t.months) : null
}

const datesReadable = (c) => !!c && isISODate(c.issued) && (!c.expires || isISODate(c.expires))
const chainOf = (t) => t.chain ?? (t.renews ? t.id : null)

// The newest card in the same chain, if one was issued after this one. A
// renewed CPR card makes the old one history; this year's HAZWOPER refresher
// keeps the 40-hour current. Cards outside a chain are never compared: two
// rigging cards can be a rigger and a signalperson card, each with its own
// date.
export function newerInChain(cert, all) {
  const chain = chainOf(typeOf(cert?.type))
  if (!chain || !Array.isArray(all) || !isISODate(cert.issued)) return null
  let newest = null
  for (const o of all) {
    if (!o || o === cert || (cert.id != null && o.id === cert.id) || chainOf(typeOf(o.type)) !== chain) continue
    if (!isISODate(o.issued) || o.issued <= cert.issued) continue
    if (!newest || o.issued > newest.issued) newest = o
  }
  return newest
}

// Amber at 90 days is deliberate: most refreshers need scheduling, and a class
// you can't get into for six weeks is not much use with two weeks left.
//
// Never throws, whatever is stored: the card list paints before the log does.
// days is the expiry minus today in calendar days: 0 is the last good day.
export function statusOf(cert, now = new Date(), all = null) {
  if (!datesReadable(cert)) return { state: 'bad', days: null, exp: null }
  const t = typeOf(cert.type)
  const exp = expiryFor(cert)
  const by = newerInChain(cert, all)
  if (by) return { state: 'superseded', days: null, exp, by }
  if (!exp) return { state: t.printed ? 'nodate' : 'none', days: null, exp: null }
  const days = daysBetween(localISO(now), exp)
  // A date the member typed off the card is the card's own, whatever the type.
  const suggested = !cert.expires && t.basis === 'custom'
  if (suggested && days <= 0) return { state: 'refresh', days, exp, suggested }
  if (days < 0) return { state: 'expired', days, exp, suggested }
  if (days <= 90) return { state: 'soon', days, exp, suggested }
  return { state: 'ok', days, exp, suggested }
}

// Most in need of attention first; within a group, nearest its date first.
const RANK = { expired: 0, soon: 1, nodate: 2, bad: 3, refresh: 4, ok: 5, none: 6, superseded: 7 }
export function sortCerts(certs, now = new Date()) {
  const list = Array.isArray(certs) ? certs : []
  return list
    .map((c, i) => ({ c, i, st: statusOf(c, now, list) }))
    .sort((a, b) => RANK[a.st.state] - RANK[b.st.state] || Math.abs(a.st.days ?? 0) - Math.abs(b.st.days ?? 0) || a.i - b.i)
    .map((x) => x.c)
}

// What earns a line on the Log tab: a card that has lapsed, one inside 30
// days, or one still waiting for the date printed on it. Suggested refreshes
// and replaced cards never do — an alarm that is wrong once is ignored after.
export function cardAlerts(certs, now = new Date()) {
  const list = Array.isArray(certs) ? certs : []
  const out = []
  for (const cert of list) {
    const st = statusOf(cert, now, list)
    if (st.state === 'expired') out.push({ cert, kind: 'expired', days: st.days })
    else if (st.state === 'soon' && !st.suggested && st.days <= 30) out.push({ cert, kind: 'soon', days: st.days })
    else if (st.state === 'nodate') out.push({ cert, kind: 'nodate', days: null })
  }
  // Lapsed first, then inside 30 days. Within each, nearest today first: a
  // card that lapsed yesterday outranks one that lapsed two years ago.
  const order = { expired: 0, soon: 1, nodate: 2 }
  return out.sort((a, b) => order[a.kind] - order[b.kind] || Math.abs(a.days ?? 0) - Math.abs(b.days ?? 0))
}

// What the phone would schedule a reminder for: real expiries only.
export function alertSchedule(certs, now = new Date()) {
  const list = Array.isArray(certs) ? certs : []
  return list.flatMap((cert) => {
    const st = statusOf(cert, now, list)
    if (!st.exp || st.suggested || !['expired', 'soon', 'ok'].includes(st.state)) return []
    return [{ id: cert.id, type: typeOf(cert.type).id, expires: st.exp }]
  })
}

// Days ahead of an expiry that the phone warns on.
export const WARN_DAYS = [90, 30, 7]

// The schedule in the shape the iPhone shell reads:
// { id, label, expires: 'YYYY-MM-DD', warnings: [{ days, body }] }.
// The shell has no words of its own and skips an alert that carries no
// warnings, so the page writes every one: label(type) names the card and
// body(expires, days) is the text, both in the member's language.
export function nativeAlerts(certs, { label, body }, now = new Date()) {
  return alertSchedule(certs, now).map((a) => ({
    id: a.id,
    label: label(a.type),
    expires: a.expires,
    warnings: WARN_DAYS.map((days) => ({ days, body: body(a.expires, days) })),
  }))
}

// Why the card form can't be saved as typed, or null.
export function cardDateProblem(type, { issued, expires } = {}, today = localISO()) {
  const t = typeOf(type)
  if (!isISODate(issued)) return 'badDate'
  if (issued > today) return 'issuedFuture'
  if (expires) {
    if (!isISODate(expires)) return 'badDate'
    if (expires < issued) return 'expiresBefore'
  } else if (t.printed) return 'expiresNeeded'
  return null
}
