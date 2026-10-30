// What a short day may be owed, and what can honestly be said about it.
//
// The floors are Art. 39 of the 2021-2026 CAICA book, and Art. 39 is printed
// under "Working conditions applicable to Will and Grundy Counties". Only its
// ¶5 says it "applies to the Contract in total". Building work elsewhere goes
// by Art. 19 ¶1, road work by Art. 26, sewer and tunnel by Art. 32, and they
// differ — so every floor here carries the place it comes from, and the screen
// says "may be owed", never "the agreement pays".
//
// A floor is worked out from the hours actually worked, frozen when the member
// says why the day was short. It is never worked out from the hours on the
// form after he takes the floor: that is how a 3-hour rain-out used to climb
// 4 → 6 → 8 with three taps and seal 8 hours.

import { localDayKey, daysBetween } from './dates.js'

export const REASONS = ['rain', 'sent', 'nowork', 'wait', 'mine']

// Where a cited paragraph applies.
export const WILL_GRUNDY = 'willGrundy'
export const WHOLE_AGREEMENT = 'contract'

// Art. 15 ¶7's floor is for a full day: it lifts a span of 8 hours or more
// that falls short of 8.5. A shorter day is left to the short-day check.
const LUNCH_FLOOR = 8.5
const lunchFloorLifts = (span) => span >= 8 && span < LUNCH_FLOOR

// The day a punch in and a punch out make. Lunch taken comes off as a half
// hour. Worked through, the span stays, and Art. 15 ¶7 makes a full day
// worked through the eating period at least 8.5 hours. exact is the time
// worked, to the hundredth, and never less than none: 20 minutes on the clock
// with lunch taken is no time worked, and a rain-out with no time worked is
// ¶5's 2 hours, not ¶4's ladder for those "who perform any work". total is
// the form's prefill, rounded to the half hour from exact so the two always
// agree (workedHours below).
export function punchHours(spanHours, lunchWorked) {
  const span = Math.max(0, Number(spanHours) || 0)
  const worked = lunchWorked ? (lunchFloorLifts(span) ? LUNCH_FLOOR : span) : Math.max(0, span - 0.5)
  const exact = +worked.toFixed(2)
  return { exact, total: Math.min(24, Math.round(exact * 2) / 2) }
}

// What the note can honestly say about a day worked through the eating
// period. clock is the span punched, cut to the tenth so it never reads more
// than the clock showed. floor is 8.5 only when the floor lifted the day, and
// null otherwise: a 20-minute punch or a 9-hour one was never an "8.5 hour
// day", and the sealed note must not say it was.
export function lunchClaim(spanHours) {
  const span = Math.max(0, Number(spanHours) || 0)
  return {
    clock: Math.floor(span * 10 + 1e-9) / 10,
    floor: lunchFloorLifts(span) ? LUNCH_FLOOR : null,
  }
}

// The hours a short day is judged by. The form rounds a punched day to the
// half hour; the thresholds in the book ("more than four (4) hours") are about
// the time actually worked, so while the form still holds the punch clock's
// prefill, the exact span decides. Once the member sets the hours himself,
// his number is the one.
export function workedHours(total, punch) {
  const exact = punch?.exact
  if (typeof exact === 'number' && Number.isFinite(exact) && exact >= 0 &&
      Math.round(exact * 2) / 2 === total) return exact
  return total
}

const NO_RULE = Object.freeze({ rule: null, cite: null, scope: null, floor: null })
const MONDAY_TO_FRIDAY = new Set(['weekday', 'fourTens'])

// The rule a reason and the hours worked fall under:
//   { rule, cite, scope, floor }
// rule is the guarantee's id in contract.json (reporting, waiting, callin,
// rainout, calloff), or null when nothing in Art. 39 speaks to it. floor is
// the hours the day may be owed, or null when the rule adds nothing to what
// was worked and logged — the screen then says nothing is added, and the day
// is not flagged as show-up pay.
//
// dayType is the pay the day carries (weekday, saturday, sunday for a Sunday
// or an Art. 17 holiday, fourTens). ¶1 is for a laborer "called by the
// Employer Monday through Friday", so a Saturday, Sunday or holiday sent home
// unworked has no floor, and says why: { rule: null, ..., weekdayOnly: true }.
export function judge(reason, worked, logged, dayType = 'weekday') {
  const w = Number(worked) || 0
  const l = logged == null ? w : Number(logged) || 0
  const out = (rule, cite, scope, floor) => ({
    rule, cite, scope,
    floor: floor > w && floor > l ? floor : null,
  })

  switch (reason) {
    case 'rain':
      // ¶4's ladder is for employees "who perform any work and then are
      // prevented from completing a day's work". With nothing worked it is
      // ¶5: 2 hours show-up time, owed only when nobody called him off.
      if (w <= 0) return out('calloff', 'Art. 39 ¶5', WHOLE_AGREEMENT, 2)
      // Minimum 4; MORE than 4 and less than 6 → 6; MORE than 6 and less
      // than 8 → 8. Exactly 4 is paid 4 and exactly 6 is paid 6.
      return out('rainout', 'Art. 39 ¶4', WILL_GRUNDY,
        w > 6 && w < 8 ? 8 : w > 4 && w < 6 ? 6 : 4)
    case 'sent':
    case 'nowork':
      // Nothing worked is ¶1: reported, not put to work for any reason but
      // weather — 4 hours, unless told 2 hours before starting time that
      // there was no work. Any work at all is ¶4's call-in pay: 4 hours, and
      // 8 for one who "works more than four (4) hours".
      if (w <= 0 && !MONDAY_TO_FRIDAY.has(dayType)) return { ...NO_RULE, weekdayOnly: true }
      return w <= 0
        ? out('reporting', 'Art. 39 ¶1', WILL_GRUNDY, 4)
        : out('callin', 'Art. 39 ¶4', WILL_GRUNDY, w > 4 ? 8 : 4)
    case 'wait':
      // ¶2: not less than 4 hours, and past 4 "all additional time shall be
      // paid on multiples of one (1) hour".
      return out('waiting', 'Art. 39 ¶2', WILL_GRUNDY, Math.max(4, Math.ceil(w)))
    default:
      return { ...NO_RULE }
  }
}

// How a day at its floor is paid. ¶2 and ¶4 pay the floor "at his regular
// rate of pay", and show-up time is not time worked, so the hours added to
// reach a floor are straight time whatever the day. The hours worked keep the
// day's own tiers: a Saturday call-in after 2 hours is 2 at time and a half
// plus 2 straight, not 4 at time and a half. workedSplit is the day's split
// of the hours worked ({ st, ot, dt }); added is floor minus those hours.
export function floorSplit(workedSplit, added) {
  return { ...workedSplit, st: workedSplit.st + Math.max(0, Number(added) || 0) }
}

// What the sealed entry keeps about a short day, or null when there is nothing
// to keep. reason, cite and claim are 1.0's fields, in 1.0's order; worked,
// floor, used and scope come after them. The record stays whole when the floor
// takes the day to 8 hours — that is the strongest claim, and the one a
// payroll clerk will argue.
//   pick: { id, worked, logged, used } — what the form froze when the reason
//   was picked, and whether the member took the floor.
//   dayType: the pay the day is sealed with, as judge() takes it.
export function shortDayRecord(pick, dayType = 'weekday') {
  if (!pick || !REASONS.includes(pick.id) || pick.id === 'mine') return null
  const j = judge(pick.id, pick.worked, pick.logged, dayType)
  return {
    reason: pick.id,
    cite: j.cite,
    claim: j.floor != null,
    worked: pick.worked,
    floor: j.floor,
    used: j.floor != null && !!pick.used,
    scope: j.scope,
  }
}

// The printed log is read by a steward or a lawyer, in English, beside the
// hours. 1.0's entries carry only the reason and the citation.
const REASON_TEXT = {
  rain: 'weather stopped the day', sent: 'sent home before starting',
  nowork: 'sent home early, not weather', wait: 'waited on site',
}
const SCOPE_TEXT = { [WILL_GRUNDY]: 'Will & Grundy', [WHOLE_AGREEMENT]: 'whole agreement' }
const h = (n) => `${+Number(n).toFixed(2)}h`

export function shortDayLine(sd) {
  if (!sd || !REASON_TEXT[sd.reason]) return ''
  const where = [sd.cite, SCOPE_TEXT[sd.scope]].filter(Boolean).join(', ')
  const cite = where ? ` (${where})` : ''
  if (typeof sd.worked !== 'number') return `SHORT DAY: ${REASON_TEXT[sd.reason]}${cite}`
  const what = sd.floor == null ? 'nothing added'
    : sd.used ? `${h(sd.floor)} floor used` : `${h(sd.floor)} floor may be owed`
  return `SHORT DAY: ${REASON_TEXT[sd.reason]}, worked ${h(sd.worked)}, ${what}${cite}`
}

// Art. 11 ¶2: the union must file a grievance within 45 days of the day it
// happened, or it is "deemed waived". A flagged day keeps saying so for those
// 45 days, counted in calendar days from today in the log's zone (dates.js).
export const GRIEVANCE_DAYS = 45
export function inGrievanceWindow(dayKey, today = new Date()) {
  const n = daysBetween(String(dayKey), localDayKey(today))
  return n != null && n <= GRIEVANCE_DAYS
}
