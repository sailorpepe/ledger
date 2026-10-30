// The pay a date carries by itself.
//
// A Saturday is a Saturday whichever day the member gets around to logging it,
// and Memorial Day is double time even when he types it in on Wednesday. Taken
// from the phone's clock instead of the date, a late entry for a premium day
// seals at weekday pay: $212 short on 8 Saturday hours, $424 on a holiday.
//
// The holidays are the six in the agreement's Art. 17 ¶1 and no others: New
// Year's Day, Memorial Day, Independence Day, Labor Day, Thanksgiving Day and
// Christmas Day. "If a holiday falls on a Sunday, it shall be celebrated on
// the following Monday. If a holiday falls on a day other than Sunday, it
// shall be celebrated on that date" — so a Saturday July 4 is a holiday, not a
// Saturday, and nothing moves to a Friday.

import { isDayKey, calendarKey } from './dates.js'

// The nth given weekday (0 = Sunday) of a month; n = -1 for the last one.
function nthWeekday(y, month, weekday, n) {
  if (n < 0) {
    const last = new Date(y, month + 1, 0, 12)
    last.setDate(last.getDate() - ((last.getDay() - weekday + 7) % 7))
    return last
  }
  const first = new Date(y, month, 1, 12)
  first.setDate(1 + ((weekday - first.getDay() + 7) % 7) + 7 * (n - 1))
  return first
}

export const HOLIDAYS = [
  { id: 'newYear',      on: (y) => new Date(y, 0, 1, 12) },
  { id: 'memorial',     on: (y) => nthWeekday(y, 4, 1, -1) },  // last Monday in May
  { id: 'independence', on: (y) => new Date(y, 6, 4, 12) },
  { id: 'labor',        on: (y) => nthWeekday(y, 8, 1, 1) },   // first Monday in September
  { id: 'thanksgiving', on: (y) => nthWeekday(y, 10, 4, 4) },  // fourth Thursday in November
  { id: 'christmas',    on: (y) => new Date(y, 11, 25, 12) },
]

const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

// The Art. 17 holiday a YYYY-MM-DD falls on, or null. `observed` marks the
// Monday after a holiday that fell on a Sunday.
export function holidayOn(key) {
  if (!isDayKey(key)) return null
  const [y, m, d] = key.split('-').map(Number)
  const day = new Date(y, m - 1, d, 12)
  for (const h of HOLIDAYS) {
    const on = h.on(y)
    if (sameDay(on, day)) return { id: h.id, observed: false }
    if (on.getDay() === 0) {
      const monday = new Date(on.getFullYear(), on.getMonth(), on.getDate() + 1, 12)
      if (sameDay(monday, day)) return { id: h.id, observed: true }
    }
  }
  return null
}

// The Art. 17 holiday celebrated in the Monday-to-Sunday week a YYYY-MM-DD
// falls in, as { id, key }, or null. Four 10s at straight time is allowed
// only "in weeks that have designated holidays, but not more often than six
// (6) times per year" (Art. 15 ¶1, Art. 17 ¶4): the holiday takes a weekday
// out of the week and four 10s make up the 40 hours. A holiday that falls on
// a Sunday is celebrated the Monday after, so it belongs to the next week.
export function holidayInWeek(key) {
  if (!isDayKey(key)) return null
  const [y, m, d] = key.split('-').map(Number)
  const day = new Date(y, m - 1, d, 12)
  const monday = new Date(y, m - 1, d - ((day.getDay() + 6) % 7), 12)
  for (let i = 0; i < 6; i++) {
    const k = calendarKey(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i, 12))
    const hol = holidayOn(k)
    if (hol) return { id: hol.id, key: k }
  }
  return null
}

// The day type a date suggests, and why:
//   { type: 'sunday', why: 'holiday' | 'observed', holiday }   Art. 17
//   { type: 'sunday', why: 'sunday' }
//   { type: 'saturday', why: 'saturday' }
//   { type: 'weekday', why: null }
// null for anything that is not a real calendar day. Four 10s is never
// suggested: it is a schedule the employer announces, not something a date
// can say.
export function dayTypeFor(key) {
  if (!isDayKey(key)) return null
  const hol = holidayOn(key)
  if (hol) return { type: 'sunday', why: hol.observed ? 'observed' : 'holiday', holiday: hol.id }
  const [y, m, d] = key.split('-').map(Number)
  const wd = new Date(y, m - 1, d, 12).getDay()
  if (wd === 0) return { type: 'sunday', why: 'sunday' }
  if (wd === 6) return { type: 'saturday', why: 'saturday' }
  return { type: 'weekday', why: null }
}
