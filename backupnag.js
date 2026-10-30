// When the Log tab asks for a backup.
//
// The log is on this phone and nowhere else, so the app has to ask for a copy,
// and an ask that comes too soon or too often is one he learns to swipe past.
// It used to come seconds after the first day was saved, and after a winter
// layoff it asked him to back up "0 entries". So it waits until a copy is
// worth making: 5 entries the last backup doesn't have, or a week since the
// first of them was sealed. A void counts: the backup doesn't have it either.
// Once waved off, it comes back when there is real work at risk again, 20
// more entries or 30 days on.

import { localDayKey, daysBetween } from './dates.js'

export const ASK_AT = 5
export const ASK_AFTER_DAYS = 7
export const SNOOZE_ENTRIES = 20
export const SNOOZE_DAYS = 30

// The rows a backup doesn't have yet: every one sealed since it, voids too.
// A stored backup count above the log (a smaller file restored over it) means
// nothing is missing, never a negative.
export function unsavedCount(log, last) {
  const rows = Array.isArray(log) ? log.length : 0
  const saved = last ? Math.min(Math.max(Math.floor(Number(last.count)) || 0, 0), rows) : 0
  return rows - saved
}

// The day a row was sealed, in the log's zone.
const sealDay = (iso) => localDayKey(new Date(iso))

// The reminder that is due, or null. `log` is every stored row, voids
// included; `last` is what a backup recorded, { at, count }; `snooze` is what
// the x recorded, { count, day }, or the bare count 1.0 stored, which comes
// back on the count alone. Days are calendar days in the log's zone.
export function backupDue(log, { last = null, snooze = null, today = localDayKey(), dayOf = sealDay } = {}) {
  const since = unsavedCount(log, last)
  if (since <= 0) return null

  // A backup holds the rows sealed before it. The store keeps them by work
  // date, so the first one it lacks is found by when each was sealed: a day
  // backdated after the backup is still new.
  const sealed = log.map((e) => String(e?.loggedAt ?? '')).sort()
  const age = daysBetween(dayOf(sealed[log.length - since]), today)
  if (since < ASK_AT && !(age >= ASK_AFTER_DAYS)) return null

  const s = typeof snooze === 'number' ? { count: snooze } : snooze
  if (s && Number.isFinite(Number(s.count))) {
    const more = log.length - Number(s.count)
    const days = s.day ? daysBetween(s.day, today) : null
    if (more < SNOOZE_ENTRIES && !(days >= SNOOZE_DAYS)) return null
  }
  return { since, lastAt: last?.at ?? null }
}

// Which sentences say it, as i18n keys: the count, then why it matters. A
// phone that hasn't protected the log's storage is the why whenever it's
// true. 1 entry is "it", never "them". `date` is the backup's day with no
// year, or '' when there is no backup or it is too old to name that way.
export function reminderKeys(since, { last = null, date = '', persisted = true } = {}) {
  const one = since === 1
  return {
    entries: one ? 'entryOne' : 'entryMany',
    head: !last ? 'nagNone' : date ? 'nagStale' : 'nagStaleOld',
    why: !persisted ? (one ? 'nagRiskOne' : 'nagRisk') : last ? null : (one ? 'nagOnlyOne' : 'nagOnly'),
  }
}
