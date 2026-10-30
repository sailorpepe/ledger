// Dates in the log are the member's calendar days, never Greenwich's.
//
// toISOString() answers in UTC. In Chicago that is already tomorrow from 7 pm
// in summer and 6 pm in winter, so a "today" cut from it seals an evening's
// work under the next day's date — and a sealed date can only be voided, never
// fixed.
//
// Nor is the member's day the phone's. The work is in Chicagoland, so the log
// goes by Central time unless he picks another zone in Settings: a phone left
// on Eastern after a trip, or set by a carrier across a state line, does not
// move what day he worked or what time he punched. A member working out of
// state picks that state's zone, or the phone's own. Every day and clock time
// the app reads or shows is worked out here, in that zone, with the zone
// spelled out to Intl; nothing reads the phone's zone by accident.

const pad = (n) => String(n).padStart(2, '0')
const DAY_MS = 86400000

export const DEFAULT_ZONE = 'America/Chicago'
export const DEVICE = 'device'
// The choices Settings offers, in order. Arizona keeps standard time all year.
export const ZONES = [
  'America/Chicago', 'America/New_York', 'America/Denver', 'America/Phoenix',
  'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', DEVICE,
]

// The zone the phone itself is set to, or undefined if it won't say (Intl
// then falls back to the phone's own zone anyway).
export function deviceZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined } catch { return undefined }
}

const knownZone = (z) => {
  if (typeof z !== 'string' || !z) return false
  if (z === DEVICE) return true
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true } catch { return false }
}

// The member's choice, as stored: an IANA zone or DEVICE. Anything this
// engine can't read goes back to Central rather than to the phone's zone.
let choice = DEFAULT_ZONE
export function setZone(z) { choice = knownZone(z) ? z : DEFAULT_ZONE; return choice }
export const zoneChoice = () => choice

// The IANA zone days and times are worked out in.
export const zoneId = (z = choice) => (z === DEVICE ? deviceZone() : z)

// Whether the log's zone and the phone's disagree, so the screen should say
// which one it is showing.
export const zoneDiffers = () => zoneId() !== deviceZone()

const formats = new Map()
function partsIn(ms, zone) {
  const k = zone ?? ''
  let f = formats.get(k)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    })
    formats.set(k, f)
  }
  const p = {}
  for (const x of f.formatToParts(ms)) if (x.type !== 'literal') p[x.type] = Number(x.value)
  // Some engines write midnight as hour 24 of the day it starts.
  if (p.hour === 24) p.hour = 0
  return p
}

// How far the zone's wall clock is ahead of UTC at a moment, in ms.
function offsetAt(ms, zone) {
  const s = Math.floor(ms / 1000) * 1000
  const p = partsIn(s, zone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - s
}

// The moment a zone's wall clock reads y-m-d hh:mm. Where the clock reads it
// twice (the fall-back hour) it is the first time; where it never does (the
// spring-forward hour) it is pushed on by the hour skipped. That is what the
// phone's own Date does, so a zone set in Settings and the phone's zone agree.
function fromWall(y, mo, d, hh, mi, zone) {
  const wall = Date.UTC(y, mo - 1, d, hh, mi)
  if (isNaN(wall)) return null
  const before = offsetAt(wall - DAY_MS, zone), after = offsetAt(wall + DAY_MS, zone)
  if (before === after) return new Date(wall - before)
  const fits = (off) => offsetAt(wall - off, zone) === off
  const a = fits(before) ? wall - before : null
  const b = fits(after) ? wall - after : null
  if (a != null && b != null) return new Date(Math.min(a, b))
  return new Date(a ?? b ?? wall - before)
}

// The YYYY-MM-DD of the day a moment falls on, in the log's zone.
export function localDayKey(d = new Date(), zone = zoneId()) {
  const ms = +d
  if (isNaN(ms)) return ''
  const p = partsIn(ms, zone)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

// A moment as a short date, "Oct 2" or "2 oct", on the day it fell in the
// log's zone: a backup at 11 pm in Chicago was Oct 2 there, whatever UTC or
// the phone says. The year is added only when it isn't this one.
export function shortDate(when, locale, now = new Date(), zone = zoneId()) {
  const d = new Date(when ?? NaN)
  if (when === '' || isNaN(d)) return ''
  const otherYear = localDayKey(d, zone).slice(0, 4) !== localDayKey(now, zone).slice(0, 4)
  return d.toLocaleDateString(locale, { timeZone: zone, month: 'short', day: 'numeric', year: otherYear ? 'numeric' : undefined })
}

// The same day with no year, for the backup reminder, which has two lines on
// a small phone to say everything in. "Dec 15" names the latest Dec 15 gone
// by, the right one only while it is under a year back, so in January last
// December's backup is "Dec 15". Older, or ahead of the clock, it gives ''
// and the reminder goes without a date.
export function recentDate(when, locale, now = new Date(), zone = zoneId()) {
  const d = new Date(when ?? NaN)
  if (when === '' || isNaN(d)) return ''
  const day = localDayKey(d, zone), today = localDayKey(now, zone)
  const yearOn = `${Number(day.slice(0, 4)) + 1}${day.slice(4)}`
  if (day > today || yearOn <= today) return ''
  return d.toLocaleDateString(locale, { timeZone: zone, month: 'short', day: 'numeric' })
}

// A Date the app built from a year, month and day (a calendar cell, a
// holiday), read back as those same three numbers. It names a day, not a
// moment, so no zone is applied to it.
export const calendarKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

// A real calendar day, written YYYY-MM-DD, in a range a work log can mean. A
// cleared date box gives '', a desktop keyboard will take a five-digit year,
// and February 30 rolls quietly into March. None of those may be sealed: an
// entry with no usable date shows as NaN, drops out of every total, and stops
// the backup it sits in from restoring.
export function isDayKey(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  if (y < 1970 || y > 2099) return false
  const dt = new Date(y, m - 1, d, 12)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

// Whole calendar days from one YYYY-MM-DD to another, counted on the calendar
// itself, so a clock change in between never makes a day 23 or 25 hours.
// null when either is not a day.
export function daysBetween(fromKey, toKey) {
  if (!isDayKey(fromKey) || !isDayKey(toKey)) return null
  const utc = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d) }
  return Math.round((utc(toKey) - utc(fromKey)) / DAY_MS)
}

// The day n calendar days on from a YYYY-MM-DD.
export function addDays(key, n) {
  const [y, m, d] = String(key).split('-').map(Number)
  const u = new Date(Date.UTC(y, m - 1, d + n))
  return `${u.getUTCFullYear()}-${pad(u.getUTCMonth() + 1)}-${pad(u.getUTCDate())}`
}

// A wall-clock time on a calendar day in the log's zone: '2026-11-01' at
// '06:00' is six in the morning in Chicago that day, whatever the UTC offset
// happens to be and wherever the phone is set.
export function atLocal(dayKey, hhmm = '12:00', zone = zoneId()) {
  const [y, m, d] = String(dayKey).split('-').map(Number)
  const [hh, mm] = String(hhmm).split(':').map(Number)
  if (![y, m, d, hh, mm].every(Number.isInteger)) return null
  return fromWall(y, m, d, hh, mm, zone)
}

// The finish of a shift whose punch-out was missed. The member types a time,
// not a date: it falls on the day he punched in, in the log's zone, and a time
// earlier than the punch-in means the shift ran past midnight into the next
// day. The next day is a calendar step, not 24 hours, so a shift across the
// November fall-back comes out to the hours actually worked. Compared to the
// minute, so a punch-in at 7:00:40 and a typed 7:00 never become a 24-hour day.
export function finishAfter(inAt, hhmm, zone = zoneId()) {
  const s = new Date(inAt)
  const [hh, mm] = String(hhmm).split(':').map(Number)
  if (isNaN(s) || !Number.isInteger(hh) || !Number.isInteger(mm)) return null
  const startMinute = Math.floor(s.getTime() / 60000) * 60000
  const day = localDayKey(s, zone)
  const out = atLocal(day, hhmm, zone)
  if (out && out.getTime() >= startMinute) return out
  return atLocal(addDays(day, 1), hhmm, zone)
}

// The month the calendar shows, always held on its 1st. Stepped from the 31st
// with setMonth, October went to "November 31" and rolled on into December,
// and March 31 back one was "February 31", which is March 3 — the arrow did
// nothing. Every month has a 1st. Which month it is now is the log's zone's
// to say; the Date that holds it only carries the year and month.
export function monthOf(d = new Date(), zone = zoneId()) {
  const [y, m] = localDayKey(d, zone).split('-').map(Number)
  return new Date(y, m - 1, 1)
}
export const stepMonth = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1)

// Days worked are calendar days: two contractors on one Saturday is two
// entries and one day.
export const distinctDays = (entries) => new Set(entries.map((e) => e.date)).size

// What the date box should hold when the app comes back to the front. Only a
// date the app filled in by itself moves to the new day; a date the member
// picked stays exactly where he put it.
export function rolledDate(shown, untouched, now = new Date()) {
  const today = localDayKey(now)
  return untouched && shown !== today ? today : shown
}
