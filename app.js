// Ledger — your hours, your record.
//
// Two halves. The log is yours and never leaves this device. The filings are
// public and belong to every member. Neither one asks you to sign in.

import * as store from './store.js'
import {
  CERT_TYPES, sortCerts, statusOf, typeOf, cardAlerts, nativeAlerts, cardDateProblem,
  isISODate, localISO, MIN_DATE, MAX_DATE,
} from './certs.js'
import { createDictation } from './dictation.js'
import { STR } from './i18n.js'
import { overtimeSource } from './overtime.js'
import { watchForUpdate, entryBusy, updateCheck } from './update.js'
import { linkHtml, backupShaped } from './guard.js'
import { appVersion } from './version.js'
// Every "today" and every clock time in the app is in the log's zone, Central
// unless the member picks another — see dates.js.
import {
  localDayKey as dayKey, calendarKey, isDayKey, atLocal, finishAfter, rolledDate, daysBetween, monthOf, stepMonth,
  distinctDays, setZone, zoneChoice, zoneId, zoneDiffers, deviceZone, ZONES, DEVICE, shortDate, recentDate,
} from './dates.js'
import { seal, chainHead, verifyChain, serial, oneSealPerTap } from './chain.js'
import { dayTypeFor, holidayInWeek } from './daytype.js'
import { judge, workedHours, punchHours, lunchClaim, floorSplit, shortDayRecord, shortDayLine, inGrievanceWindow, WILL_GRUNDY } from './showup.js'
import { liveNotices } from './notices.js'
import { reportHead } from './report.js'
import { backupDue, reminderKeys } from './backupnag.js'

/* ============================ language ============================ */
// Spanish is not a feature bolted on for show — a large share of the members
// this app exists for speak it first. Auto-detected from the phone, switchable
// in Settings, and every date routes through LOC() so "August 2" becomes
// "2 de agosto" for free.
const LANG_KEY = 'ledger.lang.v1'
let LANG = localStorage.getItem(LANG_KEY)
  ?? ((navigator.language || '').toLowerCase().startsWith('es') ? 'es' : 'en')
function t(key, vars) {
  let out = (STR[LANG] && STR[LANG][key]) ?? STR.en[key] ?? key
  if (vars) for (const k in vars) out = out.split('{' + k + '}').join(vars[k])
  return out
}
function LOC() { return LANG === 'es' ? 'es-MX' : 'en' + '-US' }
// The split literal above is armor: an earlier build did a global 'en-US' →
// LOC() replacement that rewrote this very function's fallback into calling
// itself — an infinite recursion for every English-language user that only
// Spanish testing could miss. Never make this string match that pattern.

/* ============================ time zone ============================ */
// The work is in Chicagoland, so the log goes by Central time whatever zone
// the phone is set to; a member working out of state picks his own in
// Settings. Read before anything below works out a date: the calendar's month
// is set while this file loads.
const ZONE_KEY = 'ledger.zone.v1'
setZone(localStorage.getItem(ZONE_KEY))
const ZONE_TEXT = {
  'America/Chicago': ['tzCentral', 'tzCentralSub'],
  'America/New_York': ['tzEastern', 'tzEasternSub'],
  'America/Denver': ['tzMountain', 'tzMountainSub'],
  'America/Phoenix': ['tzArizona', 'tzArizonaSub'],
  'America/Los_Angeles': ['tzPacific', 'tzPacificSub'],
  'America/Anchorage': ['tzAlaska', 'tzAlaskaSub'],
  'Pacific/Honolulu': ['tzHawaii', 'tzHawaiiSub'],
}
// "Central time", or the zone's own name for one a later version offered.
function zoneName() {
  const c = zoneChoice()
  return c === DEVICE ? t('tzPhoneName') : ZONE_TEXT[c] ? t(ZONE_TEXT[c][0]) : c
}
// A moment drawn as a date or a clock time, in the log's zone.
const inZone = (opts = {}) => ({ ...opts, timeZone: zoneId() })

/* ============================ native bridge ============================ */
// Present only inside the iOS shell. Every call is optional — the web app is
// complete without it; the bridge adds what Safari can't do: local
// notifications and on-device dictation (a browser's speech API sends the
// audio to a server, so the web build has no mic).
const NATIVE = window.webkit?.messageHandlers?.native ?? null
// Launch decision: notifications are OFF. The permission dialog on first open
// reads as the app asking for something before it has given anything — it
// stays dormant until it can be introduced properly (a card in Settings the
// member turns on himself). Dictation is unaffected.
const NOTIFICATIONS_ENABLED = false
function nativePost(msg) { try { NATIVE?.postMessage(msg) } catch { /* shell absent */ } }

/* ============================ helpers ============================ */

// Offline. The native build carries its files with it; on the web they have to
// be cached on purpose, or the app is a blank screen in the one place it is
// most needed — a basement with no bars, at the end of the shift. Registered
// quietly and never blocking: if it fails, the app still works with signal.
// After an update this page is still running the code it booted with, so the
// new version is offered, and only between entries (update.js).
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const sw = navigator.serviceWorker
  const offerUpdate = watchForUpdate({ sw, isBusy: () => entryBusy(document), show: showUpdateBar })
  const later = () => setTimeout(offerUpdate, 0)
  for (const ev of ['focusout', 'click', 'ledger:logchanged']) document.addEventListener(ev, later)
  addEventListener('load', () => sw.register('./sw.js').then((reg) => {
    const check = updateCheck(reg)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check() })
  }).catch(() => {}))
}

function showUpdateBar() {
  if ($('#updateBar')) return
  const bar = el(`<button type="button" class="update-bar" id="updateBar">${esc(t('updateReady'))}</button>`)
  bar.addEventListener('click', () => location.reload())
  document.body.append(bar)
  announce(t('updateReady'))
}

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const el = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild }
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const usd = (n) => n == null ? '—' : '$' + Math.round(n).toLocaleString(LOC())
const usdK = (n) => {
  if (n == null) return '—'
  const a = Math.abs(n)
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M'
  if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K'
  return '$' + Math.round(n)
}
const num = (n) => n == null ? '—' : n.toLocaleString(LOC())
const pct = (n) => n == null ? '—' : n + '%'
// 1st, 2nd, 3rd; in Spanish 1.º, 2.º, 3.º.
const ord = (n) => {
  if (LANG === 'es') return `${n}.º`
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
const hrs = (n) => Number.isInteger(n) ? String(n) : n.toFixed(1)

// The Fox Valley plan year runs June 1 – May 31. Hours are counted against it,
// so the log counts against it too, from today in the log's zone.
function planYearOf(today = dayKey()) {
  const [y, m] = today.split('-').map(Number)
  return m >= 6 ? y : y - 1
}
// Work dates are YYYY-MM-DD, so the plan year is a range of them.
const inPlanYear = (date, py) => typeof date === 'string' && date >= `${py}-06-01` && date <= `${py + 1}-05-31`

/* ============================ the log ============================ */
// Append-only and hash-chained. Every entry commits to the one before it, so a
// later edit breaks the chain and the export says so. That is the whole point:
// a record made the day it happened is worth far more than one reconstructed
// two years later by someone with a reason to remember it differently.

// The log lives in IndexedDB (see store.js). This array is a mirror kept in
// memory so every render stays synchronous; the database is written through on
// each append and is the thing that survives a reload.
let LOG = []
const readLog = () => LOG

async function loadLog() {
  const moved = await store.migrateLegacy()
  LOG = await store.readAll()
  return moved
}

// Things that turn out to matter months later, when you can't remember which
// Tuesday it was. Cheap to flag now, impossible to reconstruct later.
//
// A note is spoken or typed in his language, so each flag reads English and
// Spanish. The Spanish half is stems, held off only by a letter before them:
// a JavaScript \b counts an accented letter as a break, so "me caí" can't
// end on one. The character before a stem is matched rather than looked
// behind at: iOS 16.0 to 16.3 can't parse a lookbehind, and one regex it
// can't parse stops the whole app.
//
// The English half matches the hurt, not a bare word. "Cut", "burn",
// "fell" and "missing" are every day on a job (saw-cut the slab, rain fell,
// missing two guys), and a wrong Injury flag is sealed for good, so those
// count only next to a body, a person, what he fell off or the gear that
// went missing. "Got cut" on a job is mostly being sent home or laid off,
// so it counts only with the hurt after it: bad, deep, to the bone, or on,
// by, with or from the thing that did it, not the crew, the job or the day.
// A Spanish stem that is also an English word takes a Spanish ending:
// "80 grit" is sandpaper, "gritó" is the foreman.
const FLAGS = [
  { id: 'injury',  label: 'Injury',        re: /\b(hurts?|injur\w*|hospital|ambulance|first aid|(strain|sprain)(ed|s)?|back went|stitches|passed out|heat (stroke|exhaustion)|(i|he|she|we|they|someone|somebody|guy|worker|laborer|apprentice|foreman|operator|co-?worker|partner|buddy) (fell|tripped|slipped(?! (me|us|him|them)\b))(?! ((behind|short|asleep|through|apart|up|out|away)|(the |a )?(breakers?|gfc?is?|circuit))\b)|fell (off|from|down|into|through) ((a|an|the|my|his|her|their|that|this|some)|(ladder|scaffold\w*|roof|deck|trench|hole|stairs?|steps|platform|lift|truck|forms?|edge|wall|beam|floor|opening|skylight)s?)|fell \d+ ?(feet|foot|ft)|(slipped|tripped) (on|off|and|over|into|down)|(took|had) a (bad |hard )?fall|(got|gets|getting) (hurt|struck|cut( (on|by|with|from|off) ((a|an|the|my|his|her|their|that|this|some) )?((piece of|pieces of|sharp|flying|falling|hot|rusty|broken|loose|metal|steel) )?((rebar|saw|blade|grinder|knife|razor|box ?cutter|cutter|sheet ?metal|metal|tin|flashing|glass|wire|steel|pipe|nail|screw|edge|stud|debris|chisel|trowel|shears|snips|banding|strap)s?|(hand|finger|thumb|arm|leg|head|face|foot|feet|toe|knee|wrist|ankle|eye|lip|nose|rib|back|shoulder|neck|shin|chest|hip|elbow|palm|knuckle)s?)|( (pretty|real|really|so))? bad(ly)?| deep| open| to the bone)|burn(ed|t)? (on|by|with|from) ((a|an|the|my|his|her|their|that|this|some) )?((piece of|pieces of|sharp|flying|falling|hot|rusty|broken|loose|metal|steel) )?((torch|tar|exhaust|muffler|pipe|concrete|cement|lime|chemical|acid|steam|grease|asphalt|blacktop|fire|flame|welder|welding|slag|spark|sun|heater|salamander|kettle|wire|power line)s?|(hand|finger|thumb|arm|leg|head|face|foot|feet|toe|knee|wrist|ankle|eye|lip|nose|rib|back|shoulder|neck|shin|chest|hip|elbow|palm|knuckle)s?)|hit (by|in|on|with) ((a|an|the|my|his|her|their|that|this|some) )?((piece of|pieces of|sharp|flying|falling|hot|rusty|broken|loose|metal|steel) )?((rebar|pipe|beam|board|plank|2x4|block|brick|bucket|hammer|tool|form|chunk|rock|stone|concrete|slab|lumber|pallet|chain|cable|door|gate|load|bundle|bag|debris|forklift|truck|excavator|backhoe|bobcat|skid ?steer|loader|machine|crane|hook|boom|car|trailer|ladder|scaffold\w*|steel|metal|wrench|bar|sledge\w*|jackhammer|shovel|stud)s?|(hand|finger|thumb|arm|leg|head|face|foot|feet|toe|knee|wrist|ankle|eye|lip|nose|rib|back|shoulder|neck|shin|chest|hip|elbow|palm|knuckle)s?)|(smashed|crushed|pinned) (by|under|between|in) ((a|an|the|my|his|her|their|that|this|some) )?((piece of|pieces of|sharp|flying|falling|hot|rusty|broken|loose|metal|steel) )?((rebar|pipe|beam|board|plank|2x4|block|brick|bucket|hammer|tool|form|chunk|rock|stone|concrete|slab|lumber|pallet|chain|cable|door|gate|load|bundle|bag|debris|forklift|truck|excavator|backhoe|bobcat|skid ?steer|loader|machine|crane|hook|boom|car|trailer|ladder|scaffold\w*|steel|metal|wrench|bar|sledge\w*|jackhammer|shovel|stud)s?|(hand|finger|thumb|arm|leg|head|face|foot|feet|toe|knee|wrist|ankle|eye|lip|nose|rib|back|shoulder|neck|shin|chest|hip|elbow|palm|knuckle)s?|walls?|forms?|rollers?|wheels?|tracks?))|(fell|dropped|landed|came down) on (my|his|her|their|\w+'s) (hand|finger|thumb|arm|leg|head|face|foot|feet|toe|knee|wrist|ankle|eye|lip|nose|rib|back|shoulder|neck|shin|chest|hip|elbow|palm|knuckle)s?|(something|stuff|(rebar|pipe|beam|board|plank|2x4|block|brick|bucket|hammer|tool|form|chunk|rock|stone|concrete|slab|lumber|pallet|chain|cable|door|gate|load|bundle|bag|debris|forklift|truck|excavator|backhoe|bobcat|skid ?steer|loader|machine|crane|hook|boom|car|trailer|ladder|scaffold\w*|steel|metal|wrench|bar|sledge\w*|jackhammer|shovel|stud)s?) (fell|dropped|landed|came down) on (me|him|her|them|us|(?!(the|a|an|it|its|top|time|site|floor|ground|deck|slab|schedule|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b)\w+)|(cut|burn(ed|t)?|hit|smashed|crushed|broke|twisted|banged) (my|his|her|their) (hand|finger|thumb|arm|leg|head|face|foot|toe|knee|wrist|ankle|eye|lip|nose|rib)s?|(cut|burn(ed|t)?) (myself|himself|herself|themselves)|(cut|gash|burn)s? on (my|his|her|their)|(concrete|cement|chemical|lime) burns?)\b|(^|[^\p{L}])(lastim|herid|me ca[ií]|se cay[oó]|ambulancia|hospital|primeros auxilios|me torc[ií]|quemadura)/iu },
  { id: 'ot',      label: 'OT directed',   re: /\b(told (me|us)|made (me|us)|had to stay|kept (me|us)|mandatory|required us|no choice|stay(ed)? (late|till|until))\b|(^|[^\p{L}])(nos obligaron|me obligaron|quedarnos|quedarme|nos hicieron quedar|me hicieron quedar|obligatori)/iu },
  { id: 'offbook', label: 'Off the clock', re: /\b(off the (clock|books)|not on the ticket|didn'?t (write|put) (it|me) down|unpaid|cash)\b|(^|[^\p{L}])(efectivo|por fuera|no me pagaron|no nos pagaron|sin pago|no (me|nos|lo) (apuntaron|anotaron))/iu },
  { id: 'safety',  label: 'Safety',        re: /\b(no (water|harness|rails?|mask|shoring|trench box|fall protection)|unsafe|missing (guard ?rails?|rails?|toe ?boards?|harness(es)?|hole covers?|covers?|barricades?|shoring|trench box|fall protection|tie[- ]?offs?)|(harness(es)?|rails?|covers?|barricades?|shoring|trench box|toe ?boards?) (was |were |is |are )?missing|ppe|guard( ?rails?)?|osha|near miss|exposed(?! aggregate)|fumes)\b|(^|[^\p{L}])(sin arn[eé]s|insegur|sin agua|sin barandal|sin casco|sin mascarilla|casi accidente|vapores)/iu },
  { id: 'treat',   label: 'Treatment',     re: /\b(yell(ed|ing|s)?|scream\w*|slurs?|harass\w*|threat\w*|discriminat\w*|singled out|wrote me up|racis[mt]\w*|retaliat\w*)\b|(^|[^\p{L}])(grit[aeoáéó]|amenaz|acoso|acos[aó]|insult|discrimin|represali|racist)/iu },
]
const detectFlags = (t) => FLAGS.filter((f) => f.re.test(t || '')).map((f) => ({ id: f.id, label: f.label }))
// A flag is sealed with its English label, the way the printed log reads it,
// and drawn in his language by its id. A flag from an older build with an id
// this one doesn't know keeps the label it was sealed with.
const FLAG_TEXT = {
  injury: 'flag_injury', ot: 'flag_ot', offbook: 'flag_offbook', safety: 'flag_safety', treat: 'flag_treat',
  lunch: 'flagLunch', short: 'flagShort',
}
const flagText = (f) => (FLAG_TEXT[f.id] ? t(FLAG_TEXT[f.id]) : f.label)

// Anything that depends on what is in the log listens for this, instead of
// every path that writes the log having to know about it.
const logChanged = () => document.dispatchEvent(new CustomEvent('ledger:logchanged'))

// Every write to the log goes through here, one at a time, so each seal reads
// the end of the chain only after the one before it has landed (see chain.js).
const chainWrite = serial()

function appendEntry(draft) {
  return chainWrite(() => sealEntry(draft))
}

async function sealEntry(draft) {
  // Chain onto the end of the chain, not the newest work date — you can log
  // Monday's hours on Wednesday, and the chain records the order things were
  // written, which is the thing being attested to. The end is found by the
  // links, never by seal time: a phone clock set back would otherwise send
  // the next seal onto an older entry and split the chain.
  const prev = chainHead(readLog())
  const body = {
    date: draft.date,
    contractor: draft.contractor,
    dayType: draft.dayType,
    st: draft.st,
    ot: draft.ot,
    dt: draft.dt,
    rate: draft.rate,
    gross: draft.gross,
    note: draft.note,
    punch: draft.punch ?? null,
    shortDay: draft.shortDay ?? null,
    flags: [
      ...detectFlags(draft.note),
      ...(draft.punch?.lunchWorked ? [{ id: 'lunch', label: t('flagLunch') }] : []),
      ...(draft.shortDay?.claim ? [{ id: 'short', label: t('flagShort') }] : []),
    ],
    loggedAt: new Date().toISOString(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    // The zone the date was worked out in, beside the phone's own.
    zone: zoneId(),
    prev,
  }
  await store.put(await seal(body))
  LOG = await store.readAll()
  logChanged()
  return LOG
}

// Removing a mistake without breaking the seal. A hard delete would snap the
// hash chain — and the chain is the whole reason this log outweighs a memory.
// So a mistake is VOIDED: a new sealed entry that points at the old one. The
// totals, calendar and radar skip voided days; the export shows them struck
// through, which is exactly how a paper logbook handles a crossed-out line —
// and why a lawyer can still trust the rest of the page.
async function voidEntry(hash) {
  await chainWrite(async () => {
    const prev = chainHead(readLog())
    const body = {
      kind: 'void',
      voids: hash,
      date: dayKey(),
      loggedAt: new Date().toISOString(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      zone: zoneId(),
      prev,
    }
    await store.put(await seal(body))
    LOG = await store.readAll()
  })
  logChanged()
  paintEntries()
}

// The log minus voided days and minus the void markers themselves — what every
// total, calendar cell and radar match is computed from.
function activeLog() {
  const log = readLog()
  const voided = new Set(log.filter((e) => e.voids).map((e) => e.voids))
  return log.filter((e) => !e.voids && !voided.has(e.hash))
}

/* ============================ log view ============================ */

let total = 8, dayType = 'weekday'
// Whether the hours are still the form's own default, 8 or a four-10s 10.
// Hours from the punch clock, from + and − or from a show-up floor are his.
let hoursUntouched = true
// If dictation is live, save() kills it. Otherwise the mic keeps
// transcribing after Log it, refills the empty note with everything said so
// far, and the member seals the same day twice — seen in the field, day one.
let stopMic = () => {}
let CONTRACTOR_SUG = []

// The overtime tiers come out of the agreement itself, not folklore. Almost
// everyone on a jobsite will tell you "double after 10" — that is the SATURDAY
// rule. On a weekday it is time and a half for four hours after the eighth, and
// double only after twelve. Getting this wrong costs money in both directions.
let CONTRACT = null
let PREVAILING = null

const CLASS_KEY = 'ledger.classification.v1'

// What you get paid depends on what you were doing, and the two authorities on
// that disagree about nothing: IDOL publishes the county scale, the agreement
// publishes the premiums that stack on top of it. Combining them means a member
// never has to remember whether jackhammer pays extra — it just does, by $0.25.
function classificationRows(county = 'Kane') {
  const rows = []
  const sched = PREVAILING?.counties?.[county] ?? []
  const laborer = sched.find((r) => /^LABORER$/i.test(r.title))
  const base = laborer?.base ?? CONTRACT?.wages?.baseRate ?? 0
  if (!base) return rows

  rows.push({ id: 'laborer', label: t('scaleLaborer'), rate: base, sub: t('scaleCounty', { c: county }) })
  if (laborer?.foreman) {
    rows.push({ id: 'foreman', label: t('scaleForeman'), rate: laborer.foreman, sub: t('scaleCountyOnly') })
  }

  const prem = { ...(CONTRACT?.premiums?.building ?? {}), ...(CONTRACT?.premiums?.heavyHighway ?? {}) }
  for (const [name, add] of Object.entries(prem)) {
    if (!add) continue
    rows.push({
      id: `p:${name}`, label: name, rate: Number((base + add).toFixed(3)),
      sub: t('scalePlus', { a: add.toFixed(2), cite: CONTRACT.premiums.cite }),
    })
  }

  for (const r of sched) {
    if (/^LABORER$/i.test(r.title)) continue
    rows.push({ id: `s:${r.title}`, label: titleCase(r.title), rate: r.base, sub: t('scaleCounty', { c: county }) })
  }
  return rows.sort((a, b) => b.rate - a.rate)
}

const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
  .replace(/\bAbt\b/, 'Abatement').replace(/\bGen\b/, 'General').replace(/\bIi\b/, 'II')

function splitHours(h, type) {
  const rule = overtimeSource(CONTRACT).overtime[type]
  if (!rule) return { st: h, ot: 0, dt: 0 }
  const out = { st: 0, ot: 0, dt: 0 }
  let floor = 0
  for (const tier of rule.tiers) {
    const ceil = tier.upto ?? Infinity
    const inTier = Math.max(0, Math.min(h, ceil) - floor)
    if (tier.mult === 1) out.st += inTier
    else if (tier.mult === 1.5) out.ot += inTier
    else out.dt += inTier
    floor = ceil
    if (h <= ceil) break
  }
  return out
}
const grossOf = ({ st, ot, dt }, rate) => rate > 0 ? st * rate + ot * rate * 1.5 + dt * rate * 2 : null

const RATE_KEY = 'ledger.rate.v1'

// One short sentence, spoken only to whoever is listening. Debounced because
// holding the minus button fires this a dozen times and a screen reader that
// reads every step is worse than one that reads none.
let sayTimer = null
// The last thing said about the hours, for a change that needs a reason first.
let hoursSaid = ''
function announce(msg) {
  clearTimeout(sayTimer)
  sayTimer = setTimeout(() => { const el = $('#liveSay'); if (el) el.textContent = msg }, 350)
}

// The tiers the day is paid by. Four 10s at straight time is allowed only in
// a week with an Art. 17 holiday (Art. 15 ¶1, Art. 17 ¶4). In any other week
// hours 9 and 10 are overtime like any weekday's, so the day is split as one,
// and the line under the day types says why. The day type sealed is still
// the one he picked: a four-10s week outside a holiday week is worth a record.
function payType() {
  return dayType === 'fourTens' && !holidayInWeek($('#fDate').value) ? 'weekday' : dayType
}

// The split the form shows and seals. At a show-up floor only the hours
// worked go by the day's tiers; the hours added to reach it are straight time
// (showup.js).
function daySplit() {
  const type = payType()
  if (!SHORT?.used) return splitHours(total, type)
  return floorSplit(splitHours(SHORT.logged, type), total - SHORT.logged)
}

function paintHours() {
  // First: a floor that no longer applies hands the hours back here.
  paintShort()
  $('#outTotal').value = hrs(total)
  const s = daySplit()
  $('#splitOut').innerHTML = [
    s.st ? `<span>${t('straight')} <b>${hrs(s.st)}</b></span>` : '',
    s.ot ? `<span class="x-ot">${t('timeHalf')} <b>${hrs(s.ot)}</b></span>` : '',
    s.dt ? `<span class="x-dt">${t('double')} <b>${hrs(s.dt)}</b></span>` : '',
  ].filter(Boolean).join('') || `<span>${t('noHours')}</span>`

  const rate = Number($('#fRate').value) || 0
  const g = grossOf(s, rate)
  $('#grossOut').textContent = g == null ? '—' : usd(g)

  const ot = overtimeSource(CONTRACT)
  const rule = ot.overtime[dayType]
  const dayKeyMap = { weekday: 'dayWeekday', saturday: 'daySaturday', sunday: 'daySunday', fourTens: 'dayFourTens' }
  $('#ruleSum').textContent = rule ? t('howPaid', { day: t(dayKeyMap[dayType]).toLowerCase() }) : ''
  // Four 10s carries its whole condition in the app's own words, in his
  // language: the data's note for it once left out the holiday week.
  const note = dayType === 'fourTens' ? t('fourTensRule') : rule && pick(rule, 'note')
  $('#ruleLine').innerHTML = rule
    ? `${esc(note)} <cite>${esc(ot.name.split('—')[0].trim())} ${esc(rule.cite)}</cite>`
    : ''

  const parts = [
    t('hoursWorkedSay', { h: hrs(total) }),
    s.ot ? t('otSay', { h: hrs(s.ot) }) : '',
    s.dt ? t('dtSay', { h: hrs(s.dt) }) : '',
    g == null ? '' : usd(g),
  ].filter(Boolean)
  hoursSaid = parts.join('. ')
  announce(hoursSaid)
}

// Once loading is over and contract.json still isn't here, the split comes
// from the tiers built into the app. It is still the right split, but the
// member is told so, and to look before he seals it.
function paintOvertimeWarning() {
  if (CONTRACT?.overtime || $('#otWarn')) return
  $('.tally')?.after(el(`<p class="ot-warn" id="otWarn" role="status">${esc(t('otBuiltIn'))}</p>`))
}

/* ---- sheet: one big readable list instead of a native dropdown ---- */

// A sheet is a dialog: focus goes into it when it opens, onto its title so a
// screen reader starts at the question, and back to whatever opened it when it
// closes, so a VoiceOver user is not dropped at the top of the page.
let sheetOpener = null
function showSheet() {
  const sheet = $('#sheet')
  if (sheet.hidden && !sheet.contains(document.activeElement)) sheetOpener = document.activeElement
  sheet.hidden = false
  document.body.style.overflow = 'hidden'
  $('#sheetTitle').focus({ preventScroll: true })
}

// A row marked info is there to be read, not picked: it is not a button, so a
// tap on it doesn't close the sheet and VoiceOver doesn't offer it as one.
function openSheet(title, rows, onPick) {
  $('#sheetTitle').textContent = title
  $('#sheetBody').innerHTML = rows.map((r, i) => `<${r.info ? 'div' : 'button'} class="sheet-row${r.on ? ' on' : ''}${r.danger ? ' danger' : ''}${r.info ? ' info' : ''}"${r.info ? '' : ` data-i="${i}" type="button"`}>
    ${r.swatch ? `<span class="swatch" style="background:${r.swatch}"></span>` : ''}
    <span>${esc(r.label)}${r.sub ? `<span class="sub">${esc(r.sub)}</span>` : ''}</span>
  </${r.info ? 'div' : 'button'}>`).join('')
  showSheet()
  $$('#sheetBody button.sheet-row').forEach((b) => b.addEventListener('click', () => {
    closeSheet(); onPick(rows[Number(b.dataset.i)])
  }))
}
// Same sheet, real inputs. prompt() was placeholder work — it can't do a date
// picker, it can't be styled, and Safari lets people switch it off entirely,
// which is exactly how a button ends up doing nothing at all.
function openForm(title, fields, onSubmit) {
  $('#sheetTitle').textContent = title
  $('#sheetBody').innerHTML = `<form id="sheetForm" class="sform">
    ${fields.map((f) => `<label class="sfield">
      <span>${esc(f.label)}${f.required ? '' : ` <i>${t('fOptional')}</i>`}</span>
      <input type="${f.type}" name="${esc(f.id)}" ${f.value ? `value="${esc(f.value)}"` : ''}
             ${f.min ? `min="${esc(f.min)}"` : ''} ${f.max ? `max="${esc(f.max)}"` : ''}
             ${f.required ? 'required' : ''} ${f.type === 'text' ? 'autocomplete="off"' : ''}>
      ${f.err ? `<small class="err" role="alert">${esc(f.err)}</small>` : f.hint ? `<small>${esc(f.hint)}</small>` : ''}
    </label>`).join('')}
    <button type="submit" class="primary">${t('saveWord')}</button>
  </form>`
  showSheet()
  $('#sheetForm').addEventListener('submit', (e) => {
    e.preventDefault()
    const vals = Object.fromEntries(new FormData(e.target))
    closeSheet()
    onSubmit(vals)
  })
}

function closeSheet() {
  $('#sheet').hidden = true
  document.body.style.overflow = ''
  // A pick that opens the next sheet takes focus again at once.
  const back = sheetOpener
  sheetOpener = null
  if (back?.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true })
}

/* ---- dialogs that work everywhere ----
   WKWebView does not implement confirm() or prompt() unless the native side
   provides them, so on the phone both returned undefined and the erase flow
   died silently at its own safety check — the button genuinely did nothing.
   These are the app's own sheets: same guard rails, and they exist on every
   platform. */

function askConfirm(title, message, confirmLabel, danger = false) {
  return new Promise((resolve) => {
    let chose = false
    openSheet(title, [
      { act: 'yes', label: confirmLabel, sub: message, danger },
      { act: 'no', label: t('cancelWord') },
    ], (r) => { chose = true; resolve(r.act === 'yes') })
    const sheet = $('#sheet')
    const watch = new MutationObserver(() => {
      if (sheet.hidden) { watch.disconnect(); if (!chose) resolve(false) }
    })
    watch.observe(sheet, { attributes: true, attributeFilter: ['hidden'] })
  })
}

// Typing the word is the second guard on erase. A gloved thumb finds a button
// by accident; it does not type BORRAR by accident.
function askWord(title, message, word) {
  return new Promise((resolve) => {
    let submitted = false
    openForm(title, [
      { id: 'word', label: message, type: 'text', required: true, hint: t('typeWordHint', { word }) },
    ], (vals) => { submitted = true; resolve((vals.word ?? '').trim().toUpperCase() === word) })
    const sheet = $('#sheet')
    const watch = new MutationObserver(() => {
      if (sheet.hidden) { watch.disconnect(); if (!submitted) resolve(false) }
    })
    watch.observe(sheet, { attributes: true, attributeFilter: ['hidden'] })
  })
}

function tell(title, message) {
  openSheet(title, [{ label: message }], () => {})
}
$$('#sheet [data-close]').forEach((x) => x.addEventListener('click', closeSheet))

/* ---- skins ---- */

const THEMES = [
  { id: '', label: 'Automatic', sub: 'Follows your phone', swatch: 'linear-gradient(135deg,#f4f2ef 50%,#14181f 50%)' },
  { id: 'america', label: 'America', sub: 'Old Glory blue, white and red', swatch: 'linear-gradient(135deg,#16204a 45%,#ffffff 45% 55%,#b22234 55%)' },
  { id: 'dark', label: 'Dark', sub: 'Easy at night and in the gang box', swatch: '#171b21' },
  { id: 'jobsite', label: 'Jobsite', sub: 'Navy and safety orange', swatch: 'linear-gradient(135deg,#0d1b30 50%,#f5821f 50%)' },
  { id: 'sun', label: 'Sunlight', sub: 'Hard contrast for a bright deck', swatch: '#ffffff' },
]
const THEME_KEY = 'ledger.theme.v1'
// The default skin was called 'liuna' before v1.0. The colors did not change —
// the name did, because LiUNA is somebody else's registered mark and this app
// is not theirs. Anyone already carrying the old value keeps their skin.
const migrateTheme = (v) => (v === 'liuna' ? 'jobsite' : v)
const NAME_KEY = 'ledger.title.v1'

// Tap the heading and type. Name it after yourself, your local, your kid, an
// emoji — it costs nothing and it makes the thing yours rather than something
// handed to you.
function initTitle() {
  const h = $('#appTitle')
  const saved = localStorage.getItem(NAME_KEY)
  h.textContent = saved || t('yourHours')

  const commit = () => {
    const v = h.textContent.replace(/\s+/g, ' ').trim().slice(0, 40)
    h.textContent = v || t('yourHours')
    if (v) localStorage.setItem(NAME_KEY, v); else localStorage.removeItem(NAME_KEY)
  }
  h.addEventListener('blur', commit)
  h.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); h.blur() }
    if (e.key === 'Escape') { h.textContent = localStorage.getItem(NAME_KEY) || t('yourHours'); h.blur() }
  })
  // Paste as text only, so a copied heading can't drag markup in with it.
  h.addEventListener('paste', (e) => {
    e.preventDefault()
    document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text'))
  })
}

function applyTheme(id) {
  if (id) document.documentElement.dataset.theme = id
  else delete document.documentElement.dataset.theme
  localStorage.setItem(THEME_KEY, id ?? '')
}

// The date box starts on today. Whether it still holds that default — rather
// than a day the member picked or the punch clock filled in — decides whether
// it may follow the calendar to a new day on its own.
let dateUntouched = true, shownDay = ''
function setDefaultDate() { $('#fDate').value = dayKey(); dateUntouched = true }
// When the phone is set to another zone than the log, the header says whose
// day it is showing: at 12:30 am in New York it is still last night in Chicago.
// Too long to share a line with the gear, it wraps after the dot, the zone's
// name whole on the second line.
function paintToday() {
  shownDay = dayKey()
  const d = new Date().toLocaleDateString(LOC(), inZone({ weekday: 'long', month: 'long', day: 'numeric' }))
  $('#todayLabel').textContent = zoneDiffers() ? `${d}\u00a0· ${zoneName().replace(/ /g, '\u00a0')}` : d
}

// The day type follows the date in the box (see daytype.js): a Saturday picks
// Saturday, a Sunday or an Art. 17 holiday picks Sunday / holiday. A type the
// member tapped himself is his call and stays put until the day is sealed —
// the date only says so, in one line, when it disagrees.
let dayTypeByHand = false
const DAY_LABEL = { weekday: 'dayWeekday', saturday: 'daySaturday', sunday: 'daySunday', fourTens: 'dayFourTens' }
const HOLIDAY_NAME = {
  newYear: 'holNewYear', memorial: 'holMemorial', independence: 'holIndependence',
  labor: 'holLabor', thanksgiving: 'holThanksgiving', christmas: 'holChristmas',
}

function setDayType(next) {
  const was = dayType
  dayType = next
  $$('.daytype button').forEach((x) => {
    x.classList.toggle('on', x.dataset.day === next)
    x.setAttribute('aria-pressed', String(x.dataset.day === next))
  })
  // A four-10s day is ten hours. Making someone tap + four times to say the
  // obvious thing is how an app earns a reputation for being annoying. Only
  // the form's own default moves: a punched 8 is 8 hours worked, not a normal
  // day to stretch to 10, and an 8 that is a show-up floor he took is the
  // floor; paintShort says whether the new day type still has it.
  const normal = { weekday: 8, saturday: 8, sunday: 8, fourTens: 10 }
  if (hoursUntouched && total === normal[was] && !SHORT?.used) total = normal[next]
}

function followDate() {
  const sug = dayTypeFor($('#fDate').value)
  const moved = !!sug && !dayTypeByHand && sug.type !== dayType
  if (moved) setDayType(sug.type)
  paintDayHint(sug)
  paintHours()
  // The pay just changed under him: say why before the new numbers.
  if (moved) announce(`${$('#dayHint').textContent} ${hoursSaid}`)
}

function paintDayHint(sug) {
  const hint = $('#dayHint')
  if (!hint) return
  const lines = []
  if (sug?.why) {
    const d = atLocal($('#fDate').value).toLocaleDateString(LOC(), inZone({ month: 'long', day: 'numeric' }))
    const what = t({ saturday: 'dayIsSat', sunday: 'dayIsSun', holiday: 'dayIsHoliday', observed: 'dayIsObserved' }[sug.why],
      { d, h: sug.holiday ? t(HOLIDAY_NAME[sug.holiday]) : '' })
    lines.push(sug.type === dayType
      ? t(sug.type === 'saturday' ? 'dayAutoSat' : 'dayAutoDouble', { what })
      : t('dayHandOff', { what, sug: t(DAY_LABEL[sug.type]), type: t(DAY_LABEL[dayType]) }))
  }
  // Four 10s says whether the week has the holiday it needs.
  if (dayType === 'fourTens' && sug) {
    const hol = holidayInWeek($('#fDate').value)
    const line = hol ? t('fourTensHoliday', { h: t(HOLIDAY_NAME[hol.id]) }) : t('fourTensNoHoliday')
    lines.push(line.charAt(0).toUpperCase() + line.slice(1))
  }
  hint.textContent = lines.join(' ')
  hint.hidden = !lines.length
}

// A phone app is rarely closed; it waits in the background for days. Back in
// front on a new day, the header, the calendar and an untouched date box move
// to it, and a clock left running gets the missed-punch question that boot
// would have asked. A date the member chose is never moved.
function onResume() {
  if (document.visibilityState !== 'visible') return
  const f = $('#fDate')
  const was = f.value
  f.value = rolledDate(f.value, dateUntouched)
  if (f.value !== was) followDate()
  if (dayKey() !== shownDay) { paintToday(); paintEntries(); paintNotices() }
  if ($('#sheet').hidden) punchForgotCheck()
}

async function initLog() {
  // Settings first, before anything is read from storage: it holds Restore
  // and Erase, the only way back from a store this app can't read.
  $('#btnSettings').addEventListener('click', openSettings)
  await initStorage()
  setDefaultDate()
  paintToday()
  $('#fDate').addEventListener('input', () => { dateUntouched = false; followDate() })
  $('#fDate').addEventListener('change', () => { dateUntouched = false; followDate() })

  // Your rate barely changes. Ask once, remember it, let it be corrected.
  const lastRate = localStorage.getItem(RATE_KEY)
  if (lastRate) $('#fRate').value = lastRate
  $('#fRate').addEventListener('input', paintHours)

  $$('.daytype button').forEach((b) => b.addEventListener('click', () => {
    dayTypeByHand = true
    setDayType(b.dataset.day)
    paintDayHint(dayTypeFor($('#fDate').value))
    paintHours(); navigator.vibrate?.(8)
  }))

  $$('#hMinus, #hPlus').forEach((b) => b.addEventListener('click', () => {
    total = Math.max(0, Math.min(24, total + Number(b.dataset.step)))
    hoursUntouched = false
    SHORT = null
    paintHours(); navigator.vibrate?.(8)
  }))

  followDate()
  // Our own contractor suggestions. The native datalist popup anchors to the
  // window rather than the field in embedded browsers, and phones render it
  // inconsistently — these chips sit under the field, in the skin, everywhere.
  const cIn = $('#fContractor'), cSug = $('#contractorSug')
  const paintSug = () => {
    const q = cIn.value.trim().toLowerCase()
    const hits = CONTRACTOR_SUG
      .filter((c) => c.toLowerCase() !== q && (!q || c.toLowerCase().includes(q)))
      .slice(0, 6)
    cSug.hidden = !hits.length
    cSug.innerHTML = hits.map((c) => `<button type="button">${esc(c)}</button>`).join('')
    $$('button', cSug).forEach((b) => b.addEventListener('mousedown', (ev) => {
      ev.preventDefault() // keep the field focused; fire before blur
      cIn.value = b.textContent
      cSug.hidden = true
    }))
  }
  cIn.addEventListener('focus', paintSug)
  cIn.addEventListener('input', paintSug)
  cIn.addEventListener('blur', () => setTimeout(() => { cSug.hidden = true }, 150))

  $('#fNote').addEventListener('input', (e) => paintFlags(detectFlags(e.target.value)))
  initTitle()
  applyTheme(migrateTheme(localStorage.getItem(THEME_KEY)) ?? 'jobsite')

  $('#btnScale').addEventListener('click', () => {
    const rows = classificationRows()
    if (!rows.length) return
    const cur = localStorage.getItem(CLASS_KEY)
    openSheet(t('whatDoing'), rows.map((r) => ({
      label: r.label, sub: `$${r.rate.toFixed(2)} · ${r.sub}`, id: r.id, rate: r.rate,
      on: r.id === cur,
    })), (r) => {
      localStorage.setItem(CLASS_KEY, r.id)
      localStorage.setItem(RATE_KEY, String(r.rate))
      $('#fRate').value = r.rate.toFixed(2)
      paintHours()
    })
  })

  $('#btnSave').addEventListener('click', save)
  $('#btnPunch').addEventListener('click', () => {
    navigator.vibrate?.(10)
    // A new punch starts a new day: the last punch-out's receipt is stale now.
    $('#punchSummary').hidden = true
    punchMeta = null
    setPunch({ inAt: new Date().toISOString() })
    announce(t('punchedInSay', { t: fmtClock(new Date().toISOString()) }))
  })
  $('#btnPunchOut').addEventListener('click', () => {
    navigator.vibrate?.(10)
    // Sixteen hours or more is a missed punch-out, not a shift: ask for the
    // finish time instead of prefilling the whole span.
    if (punchForgotCheck(true)) return
    punchOutFlow(new Date().toISOString())
  })
  clearInterval(punchTimer)
  if (PUNCH) punchTimer = setInterval(paintPunch, 1000)
  paintPunch()
  punchForgotCheck()
  document.addEventListener('visibilitychange', onResume)
  addEventListener('pageshow', (e) => { if (e.persisted) onResume() })

  $('#calPrev').addEventListener('click', () => { calMonth = stepMonth(calMonth, -1); paintCalendar() })
  $('#calNext').addEventListener('click', () => { calMonth = stepMonth(calMonth, 1); paintCalendar() })
  initMic()
  paintNotices()
  // Cards on their own guard: whatever is stored there, the log still paints.
  try { await loadCerts() } catch (err) { CERTS = []; console.warn('cards', err) }
  try { syncNativeCertAlerts() } catch { /* dormant, and never worth a boot */ }
  $('#btnAddCert').addEventListener('click', addCertFlow)
  paintCards()
  // The countdown moves with the calendar, so it is redrawn when a phone left
  // open overnight comes back. The cards are re-read after every change to the
  // log, so an erase or a restore that touches them shows here too, and the
  // phone's warnings are rebuilt from what is now stored.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) paintCards() })
  document.addEventListener('ledger:logchanged', () => loadCerts().catch(() => {}).then(() => {
    paintCards()
    try { syncNativeCertAlerts() } catch { /* dormant */ }
  }))
  paintEntries()
}

function paintFlags(flags) {
  const strip = $('#flagStrip')
  strip.hidden = !flags.length
  strip.innerHTML = flags.map((f) => `<span class="chip">${esc(flagText(f))}</span>`).join('')
}

// The mic exists only inside the iPhone shell, where dictation runs on the
// phone (dictation.js says why). The button ships hidden, so a browser never
// shows it even for a frame.
function initMic() {
  const btn = $('#btnMic')
  const msg = $('#micMsg')
  const dict = createDictation({
    native: NATIVE,
    start: () => nativePost({ type: 'dictateStart', lang: LANG }),
    stop: () => nativePost({ type: 'dictateStop' }),
    readNote: () => $('#fNote').value,
    writeNote: (v) => { $('#fNote').value = v; paintFlags(detectFlags(v)) },
    setLive: (on) => {
      btn.classList.toggle('live', on)
      $('.mic-text', btn).textContent = t(on ? 'micLive' : 'micIdle')
    },
    showMessage: (key) => {
      msg.hidden = !key
      msg.textContent = key ? t(key) : ''
      if (key) announce(t(key))
    },
  })
  if (!dict) return
  btn.classList.remove('gone')
  window.__nativeDictation = dict.onText
  window.__nativeDictationError = dict.onError
  stopMic = dict.end
  // iOS asks for microphone and speech permission the first time only —
  // if the prompt returns every time, the audio session was never released,
  // so the shell tears it down on stop and reuses the granted status.
  btn.addEventListener('click', dict.toggle)
}

// Log it is locked from the tap until "Sealed" clears: through the write, and
// through the moment after it when the form has already reset to a fresh
// 8-hour day that a second, gloved landing would seal (see chain.js).
const save = oneSealPerTap(sealDay, {
  holdMs: 1600,
  lock: () => { $('#btnSave').disabled = true },
  unlock: () => {
    const btn = $('#btnSave')
    btn.disabled = false
    btn.textContent = t('logIt')
    btn.classList.remove('done')
  },
})

async function sealDay() {
  const btn = $('#btnSave')
  if (total <= 0) { say('addHoursFirst'); return false }
  // One Backspace empties a date box. Asked for, not guessed: the member is
  // the only one who knows which day this was.
  const date = $('#fDate').value
  if (!isDayKey(date)) { say('dateFirst'); $('#fDate').focus(); return false }

  const s = daySplit()
  const rate = Number($('#fRate').value) || 0
  if (rate > 0) localStorage.setItem(RATE_KEY, String(rate))

  try {
    await appendEntry({
      date,
      contractor: $('#fContractor').value.trim(),
      dayType,
      st: s.st, ot: s.ot, dt: s.dt,
      rate: rate || null,
      gross: grossOf(s, rate),
      note: $('#fNote').value.trim(),
      punch: punchMeta,
      shortDay: shortDayRecord(SHORT, dayType),
    })
  } catch {
    // The form is left exactly as it was, so trying again loses nothing.
    say('sealFailed')
    return false
  }
  punchMeta = null
  SHORT = null
  shortNoteLine = ''
  $('#punchSummary').hidden = true

  btn.textContent = t('sealedDone')
  btn.classList.add('done')
  navigator.vibrate?.([12, 40, 12])

  stopMic()
  $('#fNote').value = ''
  // The date picked or prefilled was for the day just sealed. Carried over to
  // the next entry, it is how yesterday's date ends up sealed on today's work.
  // A day type tapped by hand was about that day too.
  setDefaultDate()
  dayTypeByHand = false
  total = 8; hoursUntouched = true; followDate(); paintFlags([])
  $('#saveHint').textContent = t('sealedHint')
  paintEntries()
  // Last, so the fresh day's hours don't talk over it.
  announce(t('sealedDone'))
  return true
}

// Why Log it did nothing, on the screen and to a screen reader.
function say(key) {
  $('#saveHint').textContent = t(key)
  announce(t(key))
}

function paintEntries() {
  const log = readLog()
  const py = planYearOf()
  const inYear = activeLog().filter((e) => inPlanYear(e.date, py))
  const banked = inYear.reduce((s, e) => s + e.st + e.ot + (e.dt ?? 0), 0)
  const earned = inYear.reduce((s, e) => s + (e.gross ?? 0), 0)
  const daysIn = distinctDays(inYear)

  $('#bankedHours').textContent = hrs(banked)
  $('#bankedSub').innerHTML = t('bankedSub', { a: py, b: py + 1 }) +
    (earned ? ` · <b>${usd(earned)}</b> ${t('gross')}` : '')

  // The Fox Valley pension plan (Locals 582 and 1035) counts a plan year
  // under 100 hours as a break in service, or under 500 for anyone who first
  // worked under it on or after June 1, 2004 (its SPD, "Breaks in Service").
  // The app doesn't know when he started, so the meter names both floors and
  // whose rule they are; the sheet behind it says the rest, and that other
  // locals' funds have their own.
  $('#meterFill').style.width = Math.min(100, (banked / 1500) * 100) + '%'
  $('#meterNote').innerHTML = (banked < 100
    ? t('meterUnder', { n: hrs(100 - banked), m: hrs(500 - banked) })
    : banked < 500 ? t('meterMid', { m: hrs(500 - banked) })
    : t('meterOver', { d: daysIn, s: daysIn === 1 ? '' : 's' }))
    + ` <button type="button" class="linky" id="bisWhat">${t('bisWhat')}</button>`
  $('#bisWhat').addEventListener('click', () => openSheet(t('bisTitle'), [
    { label: t('bis1'), sub: t('bis1Sub') },
    { label: t('bis2'), sub: t('bis2Sub') },
    { label: t('bis3'), sub: t('bis3Sub') },
  ], () => {}))

  CONTRACTOR_SUG = [...new Set(activeLog().map((e) => e.contractor).filter(Boolean))]

  paintCalendar()
  paintBackupState()

  const list = $('#entryList')
  if (!log.length) {
    list.innerHTML = `<div class="empty"><p>${t('emptyLog')}</p></div>`
    return
  }
  list.innerHTML = activeLog().slice(0, 30).map((e) => {
    // A day 1.0 sealed with a blank date says so, instead of NaN.
    const d = new Date(e.date + 'T12:00:00')
    const dated = !isNaN(d)
    return `<div class="log-day">
      <div class="log-when">
        <div class="d">${dated ? d.getDate() : '?'}</div>
        <div class="m">${dated ? d.toLocaleDateString(LOC(), { month: 'short' }) : esc(t('noDate'))}</div>
      </div>
      <div class="log-body">
        <div class="log-top">
          <span class="log-co">${esc(e.contractor || t('noContractor'))}</span>
          <span class="log-hrs">${hrs(e.st + e.ot + (e.dt ?? 0))}h${
            e.ot ? ` <span class="ot">${hrs(e.ot)}×1½</span>` : ''}${
            e.dt ? ` <span class="dt">${hrs(e.dt)}×2</span>` : ''}${
            e.gross ? ` <span class="gr">${usd(e.gross)}</span>` : ''}</span>
        </div>
        ${e.note ? `<div class="log-note">${esc(e.note)}</div>` : ''}
        ${e.flags?.length ? `<div class="flags">${e.flags.map((f) => `<span class="chip">${esc(flagText(f))}</span>`).join('')}</div>` : ''}
        ${e.flags?.some((f) => f.id === 'short' || f.id === 'lunch') && inGrievanceWindow(e.date)
          ? `<p class="griev">${esc(t('grievClock'))}</p>` : ''}
        <div class="log-meta">${e.punch ? `${fmtClock(e.punch.inAt)}–${fmtClock(e.punch.outAt)} · ` : ''}${t('sealedAt')} ${new Date(e.loggedAt).toLocaleString(LOC(), inZone())} · ${esc(String(e.hash).slice(0, 12))}</div>
      </div>
      <button type="button" class="log-x" data-void="${esc(e.hash)}" aria-label="${t('voidTitle')}">&times;</button>
    </div>`
  }).join('')

  // A void can't be taken back, so the × asks and only the red button removes:
  // a thumb that lands on the day to read it must not take it off his totals.
  $$('#entryList [data-void]').forEach((b) => b.addEventListener('click', async () => {
    const e = readLog().find((x) => x.hash === b.dataset.void)
    if (!e) return
    const d = new Date(e.date + 'T12:00:00')
    const when = isNaN(d) ? t('noDate') : d.toLocaleDateString(LOC(), { weekday: 'short', month: 'short', day: 'numeric' })
    const day = `${when} · ${e.contractor || t('noContractor')} · ${hrs(e.st + e.ot + (e.dt ?? 0))}h`
    if (await askConfirm(t('voidTitle'), `${day}. ${t('voidSub')}`, t('voidGo'), true)) await voidEntry(e.hash)
  }))
}

/* ============================ short day ============================ */
// A laborer who gets rained out at 10 a.m. may be owed more than the hours on
// his watch, and the ladder that says how much is buried in Article 39 of a
// book almost nobody carries. Every day under 8 hours asks one question, then
// states the floor with the citation and the counties it is written for (see
// showup.js). It never changes the number by itself — it offers once, and the
// member decides. Wrong hours in a sealed log are worse than no log.
const SHORT_REASONS = [
  { id: 'rain',   k: 'shortRain',   sub: 'shortRainSub' },
  { id: 'sent',   k: 'shortSent',   sub: 'shortSentSub' },
  { id: 'nowork', k: 'shortNoWork', sub: 'shortNoWorkSub' },
  { id: 'wait',   k: 'shortWait',   sub: 'shortWaitSub' },
  { id: 'mine',   k: 'shortMine',   sub: 'shortMineSub' },
]
// What the note says happened, by the rule the day fell under.
const SHORT_NOTE = {
  rainout: 'shortNoteRain', calloff: 'shortNoteRainNone', reporting: 'shortNoteSent',
  callin: 'shortNoteNoWork', waiting: 'shortNoteWait',
}
// The condition a floor hangs on, said with it.
const SHORT_IF = { reporting: 'shortIfNotice', calloff: 'shortIfCallOff' }
// Days whose own hours pay a premium, where a floor's added straight-time
// hours need saying.
const PREMIUM_DAY = new Set(['saturday', 'sunday'])

// { id, worked, logged, used } once the member says why the day was short.
// worked is frozen at that moment and every floor comes from it; used marks
// that he took the floor. Changing the hours by hand drops it, since the
// frozen figure is no longer what he says he worked.
let SHORT = null
let shortNoteLine = ''
// A punched span shows to the hundredth: "you worked 4.0" beside the 8-hour
// floor for more than four hours would read as a mistake.
const hrsWorked = (n) => String(+Number(n).toFixed(2))

function paintShort() {
  const box = $('#shortBox')
  if (!box) return
  const j = SHORT ? judge(SHORT.id, SHORT.worked, SHORT.logged, dayType) : null
  // The floor was taken and the day no longer sits on it: the day type
  // changed to one it doesn't cover (¶1 on a Saturday), or something has
  // moved the hours off it. Back to the hours logged, the reason kept, so the
  // floor is offered again or not at all. Never the moved hours with the
  // reason dropped: that sealed a 5-hour day as 10 with no record of why.
  if (SHORT?.used && total !== j.floor) { total = SHORT.logged; SHORT.used = false }
  if (total >= 8 && !SHORT?.used) { box.hidden = true; SHORT = null; return }
  box.hidden = false

  if (!SHORT) {
    box.innerHTML = `<p class="sd-lead">${t('shortLead', { h: hrs(total) })}</p>
      <button type="button" class="sd-ask" id="sdAsk">${esc(t('shortAsk'))}</button>`
    $('#sdAsk').addEventListener('click', askShort)
    return
  }

  const r = SHORT_REASONS.find((x) => x.id === SHORT.id)
  const w = esc(hrsWorked(SHORT.worked))
  const head = !j.rule ? esc(t(j.weekdayOnly ? 'shortWeekdayOnly' : 'shortNone'))
    : j.floor == null ? t('shortAddsNothing', { h: esc(hrs(SHORT.logged)) })
    : SHORT.used ? t('shortUsing', { n: esc(hrs(j.floor)), w })
    : t('shortOwed', { n: esc(hrs(j.floor)), w })
  const wg = j.scope === WILL_GRUNDY
  box.innerHTML = `${j.rule ? `<p class="sd-scope">${esc(t(wg ? 'shortScopeWG' : 'shortScopeAll'))}</p>` : ''}
    <div class="sd-owed">${head}
      ${j.cite ? `<i class="sd-cite">${esc(t(r.k))} · ${esc(j.cite)}</i>` : ''}
    </div>
    ${j.floor != null && SHORT_IF[j.rule] ? `<p class="sd-if">${esc(t(SHORT_IF[j.rule]))}</p>` : ''}
    ${j.floor != null && PREMIUM_DAY.has(dayType) ? `<p class="sd-if">${esc(t('shortRegularRate'))}</p>` : ''}
    ${wg ? `<p class="sd-where">${esc(t('shortWGNote'))}</p>` : ''}
    ${j.floor != null ? `<p class="griev">${esc(t('grievClock'))}</p>` : ''}
    <div class="sd-row">
      ${j.floor != null && !SHORT.used ? `<button type="button" class="sd-use" id="sdUse">${esc(t('shortUse', { n: hrs(j.floor) }))}</button>` : ''}
      <button type="button" class="sd-redo" id="sdRedo">${esc(t('shortAsk'))}</button>
    </div>`
  $('#sdRedo').addEventListener('click', askShort)
  const use = $('#sdUse')
  if (use) use.addEventListener('click', () => {
    // The note keeps saying what actually happened; the hours become the
    // floor, once. The record keeps both, worked and floor, so a payroll
    // clerk arguing the number can be shown the reason.
    total = j.floor
    hoursUntouched = false
    SHORT.used = true
    navigator.vibrate?.(8)
    paintHours()
  })
}

function askShort() {
  openSheet(t('shortQ'), SHORT_REASONS.map((r) => ({
    act: r.id, label: t(r.k), sub: t(r.sub), on: SHORT?.id === r.id,
  })), (pick) => {
    // A second answer keeps the hours frozen by the first, and starts again
    // from the hours logged, not from a floor the first answer put there.
    const prior = SHORT
    if (prior?.used) total = prior.logged
    const worked = prior ? prior.worked : workedHours(total, punchMeta)
    SHORT = { id: pick.act, worked, logged: prior ? prior.logged : total, used: false }

    // The note says what happened once, in the words of the latest answer.
    const n = $('#fNote')
    if (shortNoteLine && n.value.includes(shortNoteLine)) {
      n.value = n.value.replace(shortNoteLine, '').replace(/\s{2,}/g, ' ').trim()
    }
    const j = judge(SHORT.id, worked, SHORT.logged, dayType)
    // Sent home on a Saturday is still what happened, floor or not.
    const key = j.weekdayOnly ? SHORT_NOTE.reporting : SHORT_NOTE[j.rule]
    shortNoteLine = key ? t(key, { h: hrsWorked(worked) }) : ''
    if (shortNoteLine && !n.value.includes(shortNoteLine)) {
      n.value = (n.value ? n.value.trim() + ' ' : '') + shortNoteLine
    }
    paintFlags(detectFlags(n.value))
    paintHours()
  })
}

/* ============================ punch clock ============================ */
// Tap when you start, tap when you stop, and the day fills itself in — but it
// NEVER seals itself. Punch-out prefills the normal entry (rounded to the half
// hour, exact span shown) and the member reviews, adjusts, and logs it. The
// clock is an assistant; the seal stays deliberate.
//
// Lunch is where this earns its keep. Per the agreement, working through lunch
// is paid time at the overtime rate — but crews trade it for leaving half an
// hour early and quietly eat the OT they're owed. "Worked through it" keeps the
// time in the day, writes the claim into the note, and flags the entry.

let PUNCH = null          // { inAt: ISO } while on the clock
let punchTimer = null
let punchMeta = null      // consumed by save(): { inAt, outAt, exact, lunchWorked }

const fmtClock = (iso) => new Date(iso).toLocaleTimeString(LOC(), inZone({ hour: 'numeric', minute: '2-digit' }))

function paintPunch() {
  const btn = $('#btnPunch'), live = $('#punchLive')
  if (!btn) return
  btn.hidden = !!PUNCH
  live.hidden = !PUNCH
  if (PUNCH) {
    // Seconds tick because a number that never moves looks like a frozen app,
    // and a man who thinks the clock stopped writes his hours down on a scrap
    // of cardboard instead.
    const el = Math.floor((Date.now() - new Date(PUNCH.inAt)) / 1000)
    const pad = (n) => String(n).padStart(2, '0')
    $('#punchElapsed').textContent =
      `${Math.floor(el / 3600)}:${pad(Math.floor(el / 60) % 60)}:${pad(el % 60)}`
    $('#punchSince').textContent = t('punchSince', { t: fmtClock(PUNCH.inAt) })
  }
}

async function setPunch(v) {
  PUNCH = v
  await store.setMeta('punch', v)
  clearInterval(punchTimer)
  if (PUNCH) punchTimer = setInterval(paintPunch, 1000)
  paintPunch()
}

function punchOutFlow(outISO) {
  const inAt = PUNCH.inAt
  openSheet(t('lunchQ'), [
    { act: 'took', label: t('lunchTook'), sub: t('lunchTookSub') },
    { act: 'worked', label: t('lunchWorkedL'), sub: t('lunchWorkedSub') },
  ], async (r) => {
    const lunchWorked = r.act === 'worked'
    const span = (new Date(outISO) - new Date(inAt)) / 3.6e6
    // Art. 15 P7: a day worked through the eating period "shall nevertheless
    // work for at least 8.5 hours (inclusive of one half hour paid at time and
    // one half)". So a full day with no lunch does not lose the half hour — it
    // gains one, at premium. A short day is left alone; the floor is about a
    // full shift, and the short-day check below handles the rest. The hours
    // are what was worked, down to none (showup.js): a made-up half hour here
    // would be sealed as time worked and judged under the wrong paragraph.
    const { exact, total: rounded } = punchHours(span, lunchWorked)

    total = rounded
    hoursUntouched = false
    SHORT = null
    // The work date is the day the shift started in the log's zone, so a night
    // shift that punches in at 10 pm belongs to that evening, not the morning
    // after.
    $('#fDate').value = dayKey(new Date(inAt))
    dateUntouched = false
    if (lunchWorked) {
      // The note says what the clock showed, and names the 8.5 floor only on
      // the day it lifted.
      const c = lunchClaim(span)
      const n = $('#fNote')
      n.value = (n.value ? n.value.trim() + ' ' : '') + t(c.floor ? 'lunchNoteFloor' : 'lunchNote', { h: c.clock.toFixed(1) })
      paintFlags(detectFlags(n.value))
    }
    punchMeta = { inAt, outAt: outISO, exact, lunchWorked }
    followDate()
    if (rounded < 8) askShort()
    const sum = $('#punchSummary')
    sum.hidden = false
    announce(t('punchedOutSay', { h: hrs(rounded) }))
    sum.innerHTML = t('punchPrefill', { a: fmtClock(inAt), b: fmtClock(outISO), exact: exact.toFixed(1), rounded: hrs(rounded) }) +
      (lunchWorked ? ` <b class="griev">${esc(t('grievClock'))}</b>` : '')
    await setPunch(null)
  })
}

// Sixteen hours on the clock means a missed punch-out, not a 16-hour day.
// Ask instead of logging garbage. Boot and the Punch out button always ask;
// coming back to the app asks once per punch, so "Still working" sticks.
let forgotAsked = null
function punchForgotCheck(force = false) {
  if (!PUNCH) return false
  const h = (Date.now() - new Date(PUNCH.inAt)) / 3.6e6
  if (h < 16) return false
  if (!force && forgotAsked === PUNCH.inAt) return false
  forgotAsked = PUNCH.inAt
  openSheet(t('forgotTitle'), [
    { act: 'enter', label: t('forgotEnter'), sub: t('forgotMsg', { h: Math.round(h) }) },
    { act: 'keep', label: t('forgotKeep') },
  ], (r) => {
    if (r.act !== 'enter') return
    // The time typed is read in the log's zone, like the punch-in it follows;
    // a phone set elsewhere is told which one.
    openForm(t('forgotTitle'), [
      { id: 'fin', label: t('finishLabel'), type: 'time', value: '15:30', required: true,
        hint: zoneDiffers() ? t('finishZone', { z: zoneName() }) : '' },
    ], (v) => {
      const out = finishAfter(PUNCH.inAt, v.fin)
      if (out) punchOutFlow(out.toISOString())
    })
  })
  return true
}

// A month at a glance. Scrolling a list tells you what you did; a grid tells you
// what you didn't — the gaps, the stretch of Saturdays, the week you never got
// called. That's the view worth having when you're arguing about a season.
let calMonth = monthOf()
let PAYDAY = null // { weekday, everyOther, anchor } — set from a day's sheet

// Everyone's payday is different, so instead of asking, the member marks a day
// he got paid and the app works out the pattern from there.
function isPayday(date) {
  if (!PAYDAY) return false
  if (date.getDay() !== PAYDAY.weekday) return false
  if (!PAYDAY.everyOther) return true
  const anchor = new Date(PAYDAY.anchor + 'T12:00:00')
  const weeks = Math.round((date - anchor) / (7 * 86400000))
  return weeks % 2 === 0
}

function nextPayday(today = dayKey()) {
  if (!PAYDAY) return null
  const [y, m, day] = today.split('-').map(Number)
  const d = new Date(y, m - 1, day)
  for (let i = 0; i <= 21; i++) {
    if (isPayday(d)) return { date: new Date(d), inDays: i }
    d.setDate(d.getDate() + 1)
  }
  return null
}

function askPayday(iso) {
  const d = new Date(iso + 'T12:00:00')
  const wd = d.toLocaleDateString(LOC(), { weekday: 'long' })
  openSheet(t('paydayTitle', { d: d.toLocaleDateString(LOC(), { month: 'long', day: 'numeric' }) }), [
    { label: t('payWeekly', { wd }), sub: t('payWeeklySub'), mode: 'weekly' },
    { label: t('payBiweekly', { wd }), sub: t('payBiweeklySub'), mode: 'biweekly' },
    ...(PAYDAY ? [{ label: t('payClear'), sub: t('payClearSub'), mode: 'clear' }] : []),
  ], async (r) => {
    PAYDAY = r.mode === 'clear' ? null
      : { weekday: d.getDay(), everyOther: r.mode === 'biweekly', anchor: iso }
    await store.setMeta('payday', PAYDAY)
    paintCalendar()
  })
}

// A tap on a day shows what was logged on it. Payday is a row in that sheet
// that says what it does: a man looking up a day's hours is not asked about
// his paycheck, and nothing about paydays changes unless he picks that row.
function openDay(iso) {
  const d = new Date(iso + 'T12:00:00')
  const title = d.toLocaleDateString(LOC(), { weekday: 'long', month: 'long', day: 'numeric' })
  const logged = activeLog().filter((e) => e.date === iso).map((e) => ({
    info: true,
    label: `${e.contractor || t('noContractor')} · ${hrs(e.st + e.ot + (e.dt ?? 0))}h${e.gross ? ` · ${usd(e.gross)}` : ''}`,
    sub: e.note,
  }))
  const pay = isPayday(d)
  openSheet(title.charAt(0).toUpperCase() + title.slice(1), [
    ...(logged.length ? logged : [{ info: true, label: t('calNothing') }]),
    { act: 'pay', label: t(pay ? 'payChange' : 'payMark'), sub: t(pay ? 'payChangeSub' : 'payMarkSub') },
  ], (r) => { if (r.act === 'pay') askPayday(iso) })
}

function paintCalendar() {
  const log = readLog()
  const y = calMonth.getFullYear(), m = calMonth.getMonth()
  const first = new Date(y, m, 1), days = new Date(y, m + 1, 0).getDate()
  const todayKey = dayKey()

  const byDay = new Map()
  for (const e of activeLog()) {
    const d = new Date(e.date + 'T12:00:00')
    if (d.getFullYear() !== y || d.getMonth() !== m) continue
    const k = d.getDate()
    const prev = byDay.get(k) ?? { h: 0, prem: false, gross: 0 }
    byDay.set(k, {
      h: prev.h + e.st + e.ot + (e.dt ?? 0),
      prem: prev.prem || e.ot > 0 || (e.dt ?? 0) > 0,
      gross: prev.gross + (e.gross ?? 0),
    })
  }

  $('#calTitle').textContent = calMonth.toLocaleDateString(LOC(), { month: 'long', year: 'numeric' })

  const cells = []
  for (let i = 0; i < first.getDay(); i++) cells.push('<div class="cal-cell pad"></div>')
  for (let d = 1; d <= days; d++) {
    const hit = byDay.get(d)
    const date = new Date(y, m, d)
    const iso = calendarKey(date)
    const intensity = hit ? Math.min(55, 14 + hit.h * 3.4) : 0
    const pay = isPayday(date)
    cells.push(`<button type="button" class="cal-cell${hit ? ' has' : ''}${hit?.prem ? ' prem' : ''}${iso === todayKey ? ' today' : ''}${pay ? ' pay' : ''}"
      style="--i:${intensity}%" data-iso="${iso}"
      title="${esc(date.toLocaleDateString(LOC(), { weekday: 'long', month: 'long', day: 'numeric' }))}${hit ? ` — ${esc(t('calHours', { h: hrs(hit.h) }))}` : ''}${pay ? ` — ${esc(t('calPayday'))}` : ''}">
      <span class="dn">${d}</span>
      ${hit ? `<span class="dh">${hrs(hit.h)}</span>` : ''}
    </button>`)
  }
  $('#calGrid').innerHTML = cells.join('')
  $$('#calGrid .cal-cell[data-iso]').forEach((c) => c.addEventListener('click', () => openDay(c.dataset.iso)))

  const next = nextPayday()
  const pd = $('#paydayLine')
  pd.innerHTML = next
    ? t('paydayNext', { d: next.date.toLocaleDateString(LOC(), { weekday: 'long', month: 'short', day: 'numeric' }) }) +
      (next.inDays === 0 ? t('payToday') : next.inDays === 1 ? t('payTomorrow') : t('payDays', { n: next.inDays }))
    : t('paydayTap')

  // byDay is keyed by the day of the month, so this counts days, not entries.
  const worked = [...byDay.values()]
  const tot = worked.reduce((s, x) => s + x.h, 0)
  const gross = worked.reduce((s, x) => s + x.gross, 0)
  $('#calFoot').innerHTML = worked.length
    ? `<span><b>${worked.length}</b> ${t(worked.length === 1 ? 'dayWorked' : 'daysWorked')}</span><span><b>${hrs(tot)}</b> ${t('hoursWord')}</span>` +
      (gross ? `<span><b>${usd(gross)}</b> ${t('gross')}</span>` : '')
    : `<span>${t('nothingThisMonth')}</span>`
}

async function exportLog() {
  const log = readLog()
  if (!log.length) return tell(t('saveBackup'), t('exportNothing'))
  const check = await verifyChain(log)
  const chron = [...log].reverse()
  const lines = reportHead(log, check, new Date().toISOString())
  const voidedSet = new Set(chron.filter((e) => e.voids).map((e) => e.voids))
  for (const e of chron) {
    if (e.voids) { lines.push(`${e.date}  VOID -> entry ${e.voids.slice(0, 12)}`, `  sealed ${e.loggedAt}`, `  hash ${e.hash}`, `  prev ${e.prev}`, ''); continue }
    lines.push(`${voidedSet.has(e.hash) ? '[VOIDED] ' : ''}${e.date || '(no date)'}  ${hrs(e.st)} straight${e.ot ? ` + ${hrs(e.ot)} @1.5x` : ''}${e.dt ? ` + ${hrs(e.dt)} @2x` : ''}` +
      `${e.rate ? `  @ $${e.rate.toFixed(2)}/hr = ${usd(e.gross)}` : ''}   ${e.contractor || '(no contractor)'}`)
    if (e.note) lines.push(`  "${e.note}"`)
    if (e.flags?.length) lines.push(`  FLAGS: ${e.flags.map((f) => f.label).join(', ')}`)
    const sd = shortDayLine(e.shortDay)
    if (sd) lines.push(`  ${sd}`)
    lines.push(`  sealed ${e.loggedAt} (${e.tz})`)
    if (e.zone && e.zone !== e.tz) lines.push(`  dated by ${e.zone} time`)
    lines.push(`  hash ${e.hash}`)
    lines.push(`  prev ${e.prev}`, '')
  }

  const stamp = dayKey()
  // Two files on purpose: the .txt is what a human reads, the .json is what
  // restores. Exporting only the readable one is how people lose everything.
  const files = [
    [`work-log-${stamp}.txt`, lines.join('\n'), 'text/plain'],
    [`work-log-${stamp}.json`, JSON.stringify(log), 'application/json'],
  ]

  // "Backed up" is only recorded once the files verifiably left — and the app
  // says so out loud, with the filenames. A save with no confirmation is
  // indistinguishable from a broken button; that is not a guess, it shipped.
  const done = async () => {
    await backedUp(log.length)
    paintBackupState()
    tell(t('saveBackup'), t(log.length === 1 ? 'backupDone1' : 'backupDone', { n: log.length, d: stamp }))
  }

  if (NATIVE) {
    // WKWebView ignores <a download> outright. On the phone the old path was a
    // silent no-op that then RECORDED the backup as taken — the app reassured
    // the member he was safe when nothing had been written anywhere. The files
    // go over the bridge to the iOS share sheet instead: the member picks
    // where they live, and success comes back only when the share completes.
    window.__shareDone = (completed) => { if (completed) done() }
    nativePost({ type: 'share', files: files.map(([name, body]) => ({ name, body })) })
    return
  }

  for (const [name, body, type] of files) {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([body], { type }))
    a.download = name
    a.click()
    URL.revokeObjectURL(a.href)
  }
  await done()
}

/* ---- durability ----
   The log is on this device and nowhere else. That is the privacy guarantee and
   also the risk, so the app has to say so out loud and keep asking. */

// Whether the phone has marked the log's storage protected. Asked once at
// boot; until it answers, nothing is claimed either way.
let PERSISTED = true

async function paintBackupState() {
  try { await paintBackupRow() } finally { foldStatus() }
}

async function paintBackupRow() {
  const bar = $('#backupNag')
  const log = readLog()
  const last = await store.getMeta('lastBackup')
  paintStorageLine(last)

  // 1.0 kept only the count the x was tapped at. Its 30 days run from the
  // first look after the update.
  let snooze = await store.getMeta('nagSnoozedAt')
  if (typeof snooze === 'number') {
    snooze = { count: snooze, day: dayKey() }
    await store.setMeta('nagSnoozedAt', snooze)
  }

  // When to ask is backupnag.js's; this only says it.
  const due = backupDue(log, { last, snooze })
  bar.hidden = !due
  if (!due) { bar.innerHTML = ''; return }

  // A phone that hasn't protected the log's storage is said here, with the
  // ask, rather than under Log it every day. Back up and the +N go at the end
  // of the text, and the whole of it, a 3-digit count and a folded row
  // included, has to stay within 2 lines at 375 wide, or Punch in drops
  // under the tab bar. So the date carries no year; the line under Log it
  // keeps the full one.
  const n = due.since, d = recentDate(due.lastAt, LOC())
  const say = reminderKeys(n, { last, date: d, persisted: PERSISTED })
  bar.innerHTML = `<span class="nag-text">${t(say.head, { n, entries: t(say.entries), d: esc(d) })} ${say.why ? t(say.why) : ''}
    <button type="button" id="nagGo" class="nag-go">${t('backUp')}</button></span>
  <button type="button" id="nagX" class="nag-x" aria-label="${esc(t('ariaDismissReminder'))}">&times;</button>`
  $('#nagGo').addEventListener('click', exportLog)
  $('#nagX').addEventListener('click', async () => {
    bar.hidden = true
    await store.setMeta('nagSnoozedAt', { count: log.length, day: dayKey() })
    paintBackupState()
  })
}

// Under Log it, quietly: where the log is and when it last left the phone.
function paintStorageLine(last) {
  const line = $('#storageLine')
  if (!line) return
  const when = last?.at ? shortDate(last.at, LOC()) : ''
  line.textContent = when ? t('storageLine', { d: when }) : t('storageLineNone')
}

// A copy of every row now exists off the phone: the count starts over, and an
// x tapped before it no longer holds.
async function backedUp(count, at = new Date().toISOString()) {
  await store.setMeta('lastBackup', { at, count })
  await store.setMeta('nagSnoozedAt', null)
}

async function initStorage() {
  const moved = await loadLog()
  PAYDAY = await store.getMeta('payday') ?? null
  PUNCH = await store.getMeta('punch') ?? null
  const p = await store.requestPersistence()
  PERSISTED = p.persisted
  if (moved) console.info(`migrated ${moved} entries out of localStorage`)
}

// The counterpart to export. Without it a backup is a souvenir, not a backup.
function importLog() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json,.txt'
  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    if (!file) return
    let parsed, check
    try {
      parsed = JSON.parse(await file.text())
      // Every entry is checked before anything is written (guard.js): seal
      // codes are only the hex Ledger makes, a blank date from 1.0 gets in,
      // and a field the app draws holds what the app writes there.
      if (!backupShaped(parsed)) throw new Error('not a log file')
      check = await verifyChain(parsed)
    } catch (err) {
      tell(t('restoreBackup'), t('restoreBad', { err: err.message }))
      return
    }
    const entries = t(parsed.length === 1 ? 'entryOne' : 'entryMany')
    const msg = check.ok
      ? t('restoreOk', { n: parsed.length, entries })
      : t(check.fork ? 'restoreSplit' : 'restoreBroken', { n: parsed.length, entries, at: check.at })
    if (!(await askConfirm(t('restoreBackup'), msg, t('restoreGoOn'), !check.ok))) return
    try {
      await chainWrite(async () => {
        await store.replaceAll(parsed)
        LOG = await store.readAll()
      })
    } catch (err) {
      tell(t('restoreBackup'), t('restoreBad', { err: err.message }))
      return
    }
    // The file he picked holds every row now on the phone, so it is his last
    // backup, dated by its newest seal: it was made then or after, never
    // before. Without this a phone restored from a backup said it had none.
    const newest = new Date(parsed.map((e) => String(e.loggedAt ?? '')).sort().pop())
    await backedUp(parsed.length, isNaN(newest) ? undefined : newest.toISOString()).catch(() => {})
    // Written. Whatever happens while repainting, the restore is done, and
    // the member is not told the file couldn't be read.
    logChanged()
    try { paintEntries() } catch (err) { console.warn('restore paint', err) }
  })
  input.click()
}

/* ============================ filings ============================ */

let INDEX, FUNDS, RADAR = null, loadedLocal = null, DATA_VERSION = ''

async function initFilings() {
  // index.json is small and always fetched fresh; its build timestamp then acts
  // as the cache key for everything else. Without this a phone happily serves
  // last week's copy, which would quietly break the notices channel — a notice
  // nobody receives is worse than no notice at all.
  INDEX = await fetch('./data/index.json', { cache: 'no-store' }).then((r) => r.json())
  const v = encodeURIComponent(INDEX.generated)
  const load = (name) => fetch(`./data/${name}.json?v=${v}`).then((r) => r.json()).catch(() => null)

  ;[FUNDS, CONTRACT, PREVAILING, RADAR] = await Promise.all([
    load('funds'), load('contract'), load('prevailing'), load('radar'),
  ])
  DATA_VERSION = v
  // The agreement already says what a laborer makes. Nobody should have to type
  // it in — prefill the scale rate and let anyone whose classification pays a
  // premium correct it once.
  const rateField = $('#fRate')
  if (!rateField.value && CONTRACT?.wages?.baseRate) {
    rateField.value = CONTRACT.wages.baseRate.toFixed(2)
    rateField.placeholder = `$${CONTRACT.wages.baseRate.toFixed(2)} scale`
  }
  paintHours() // contract-driven overtime tiers are only known now

  const choices = INDEX.locals.filter((l) => l.role !== 'dissolved')
  let current = String(INDEX.homeLocal)
  const setLabel = () => {
    const c = choices.find((l) => String(l.slug) === current)
    $('#localPickLabel').textContent = c ? c.label : 'Choose a local'
  }
  $('#localPick').addEventListener('click', () => {
    // A local that stopped filing says when, not a membership from 20 years ago.
    openSheet(t('whichLocal'), choices.map((l) => ({
      label: l.label,
      sub: `${l.city ?? ''}${l.stale ? ` · ${t('lastFiled', { y: l.latestYear })}`
        : l.members ? ` · ${t('membersSuffix', { n: num(l.members) })}` : ''}`,
      slug: String(l.slug), on: String(l.slug) === current,
    })), (r) => { current = r.slug; setLabel(); renderLocal(r.slug).then(renderFund) })
  })
  setLabel()
  await renderLocal(current)
  renderFund()
}

async function renderLocal(slug) {
  const body = $('#localBody')
  body.innerHTML = '<p class="loading">Loading…</p>'
  const L = await fetch(`./data/locals/${slug}.json`).then((r) => r.json())
  loadedLocal = L
  const y = L.years[0]
  const peers = INDEX.peers
  const rank = (k) => {
    const me = peers.find((p) => p.desig === L.desig)
    if (!me || me[k] == null) return null
    const s = peers.filter((p) => p[k] != null).sort((a, b) => b[k] - a[k])
    return { at: s.findIndex((p) => p.desig === L.desig) + 1, of: s.length }
  }
  const rk = (r) => r ? t('rankOf', { at: ord(r.at), of: r.of }) : ''
  // Stale: no filing in years (ingest's peers.mjs). Its figures are that
  // year's, and it is in no rank.
  const stale = L.stale === true
  // Each figure's inputs, so the source note's promise holds for the cards.
  const how = y.spend?.dues != null && y.operatingSpend != null && y.payroll != null
    ? `<p class="note">${t('statsNote', {
      dues: usd(y.spend.dues), m: num(y.members), a: usd(y.assets), p: usd(y.payroll), o: usd(y.operatingSpend),
    })}</p>` : ''

  body.innerHTML = ''
  body.append(el(`<section class="sec">
    <p class="lede">${t(stale ? 'localLedeStale' : 'localLede', { city: esc(L.city ?? ''), n: num(y.members), y: y.year })}</p>
    <div class="stats">
      <div class="card stat"><div class="k">${t('kMembers')}</div><div class="v">${num(y.members)}</div>
        <div class="r">${t('kYearsOnFile', { n: L.years.length })}</div></div>
      <div class="card stat"><div class="k">${t('kDuesIn')}</div><div class="v">${usd(y.duesPerMember)}</div>
        <div class="r">${rk(rank('duesPerMember'))}</div></div>
      <div class="card stat"><div class="k">${t('kTreasury')}</div><div class="v">${usd(y.assetsPerMember)}</div>
        <div class="r">${rk(rank('assetsPerMember'))}</div></div>
      <div class="card stat"><div class="k">${t('kPayrollShare')}</div><div class="v">${pct(y.payrollShareOperating)}</div>
        <div class="r">${t('kOfSpent')}</div></div>
    </div>
    ${how}
  </section>`))

  if (y.spend) body.append(spendSection(L, y))
  if (L.people.length) body.append(peopleSection(L, y))
  if (peers.length > 1) body.append(peerSection(L, peers))
  // Reference material, not headline — it earns a place, at the bottom.
  if (CONTRACT?.scope) body.append(scopeSection())
  // The strongest thing this page can do is refuse to be the only source. Every
  // figure above comes from one filing, and the government publishes its own
  // view of that exact filing — so link straight to it and invite the check.
  body.append(el(`<div class="foot">
    ${linkHtml(`https://olmsapps.dol.gov/olpdr/visualization.jsp?rptId=${encodeURIComponent(y.rptId)}`, `
      <span class="verify-k">${t('checkYourself')}</span>
      <span class="verify-v">${t('dolCharts')}</span>`, 'verify')}
    <p>${t('sourceNote', { id: y.rptId, label: esc(L.label), y: y.year })}</p>
    <p>${t('generatedOn', { d: new Date(INDEX.generated).toLocaleDateString(LOC(), inZone()) })}</p>
  </div>`))
}

// Locals abbreviate titles differently year to year — "PRESIDENT/BUSINESS MGR"
// one year, "PRESIDENT/BUSINESS MANAGE" the next. Without this, every such year
// reads as a role change and the highlighting becomes meaningless.
const TITLE_ABBR = [
  [/\bMGR\b|\bMANAGE\b|\bMNGR\b/g, 'MANAGER'],
  [/\bSEC\b|\bSECY\b|\bSECR\b/g, 'SECRETARY'],
  [/\bTREAS\b|\bTRES\b/g, 'TREASURER'],
  [/\bVP\b/g, 'VICE PRESIDENT'],
  [/\bPRES\b/g, 'PRESIDENT'],
  [/\bREP\b|\bREPRESENTATIVE\b/g, 'REP'],
  [/\bEXEC\b/g, 'EXECUTIVE'],
  [/\bBD\b/g, 'BOARD'],
]
function normTitle(t) {
  let s = String(t ?? '').toUpperCase().replace(/[^A-Z ]+/g, ' ')
  for (const [re, to] of TITLE_ABBR) s = s.replace(re, to)
  return s.split(/\s+/).filter(Boolean).sort().join(' ')
}

// Pay without the expenses paid back for cars, travel and meals (the form's
// Column F). Data built before `pay` existed carries both parts of it.
const payOf = (p) => p.pay ?? p.total - (p.officialBusiness ?? 0)

// Describe the shape of a career instead of printing a year-over-year percentage.
// A jump from $7,573 to $134,450 is not a 1,675% raise — it is an unpaid officer
// seat becoming a full-time job, and the percentage actively hides that.
function arcOf(h) {
  if (h.length < 2) return t('arcOneYear')
  const chron = [...h].reverse()
  const now = chron.at(-1)
  const PAID = 25000 // below this it is a stipend for showing up to meetings

  const firstPaid = chron.find((r) => payOf(r) >= PAID)
  const volunteerYears = firstPaid ? chron.filter((r) => r.year < firstPaid.year) : chron
  const vMax = Math.max(0, ...volunteerYears.map(payOf))

  const bits = [t('arcYears', { n: chron.length, a: chron[0].year, b: now.year })]

  if (volunteerYears.length >= 2) {
    bits.push(t('arcVolunteer', {
      n: volunteerYears.length, a: volunteerYears[0].year, b: volunteerYears.at(-1).year,
      cap: vMax ? t('arcNeverAbove', { v: usd(vMax) }) : t('arcUnpaid'),
    }))
  }
  if (firstPaid) {
    bits.push(t('arcFirstPaid', { y: firstPaid.year, role: esc(firstPaid.roles.map((r) => r.title).filter(Boolean).join(' + ')) }))
    const since = now.year - firstPaid.year
    if (since >= 1 && payOf(firstPaid) > 0) {
      bits.push(t('arcSince', { from: usd(payOf(firstPaid)), to: usd(payOf(now)), n: since, s: since === 1 ? '' : 's' }))
    }
  }
  bits.push(t('arcWeigh'))
  return bits.join(' ')
}

// Pay, with each person's full history one tap away. A single year's salary is
// how people reach confident wrong conclusions; the trend is the real story.
function peopleSection(L, y) {
  const now = L.people.filter((p) => p.year === y.year).sort((a, b) => payOf(b) - payOf(a))
  const top = Math.max(...now.map(payOf), 1)
  const payroll = y.payroll ?? now.reduce((s, p) => s + payOf(p), 0)

  const historyFor = (key) => L.people.filter((p) => p.key === key).sort((a, b) => b.year - a.year)

  return el(`<section class="sec">
    <h2>${t('whoRuns')}</h2>
    <p class="lede">${t('whoRunsLede')}</p>
    <div class="card">
      ${now.map((p) => {
        const h = historyFor(p.key)
        const first = h.at(-1), span = h.length
        const growth = first && first.total > 0 && span > 1
          ? Math.round(((p.total - first.total) / first.total) * 100) : null
        return `<details class="person">
          <summary>
            <div class="p-who">
              <div class="p-nm">${esc(p.name)}${p.dualRole ? `<span class="pill n">${t('bothTag')}</span>` : ''}</div>
              <div class="p-rl">${esc(p.roles.map((r) => r.title).filter(Boolean).join(' + '))}</div>
              <div class="p-bar" style="width:${Math.max(3, (payOf(p) / top) * 100)}%"></div>
            </div>
            <div class="p-amt">${usd(payOf(p))}</div>
            <div class="p-chev"></div>
          </summary>
          <div class="p-detail">
            <table>
              <tbody>${h.map((row, i) => {
                const title = row.roles.map((r) => r.title).filter(Boolean).join(' + ') || '—'
                const prevTitle = h[i + 1]?.roles.map((r) => r.title).filter(Boolean).join(' + ')
                const changed = prevTitle && prevTitle !== title
                return `<tr${changed ? ' class="p-turn"' : ''}>
                  <td class="p-yr">${row.year}</td>
                  <td class="p-role">${esc(title)}</td>
                  <td class="n">${payOf(row) ? usd(payOf(row)) : '—'}</td>
                </tr>`
              }).join('')}</tbody>
            </table>
            ${h.some((row, i) => {
              const ti = row.roles.map((r) => r.title).filter(Boolean).join(' + ')
              const pt = h[i + 1]?.roles.map((r) => r.title).filter(Boolean).join(' + ')
              return pt && pt !== ti
            }) ? `<p class="p-key"><i></i>${t('turnKey')}</p>` : ''}
            <p class="p-sum">${arcOf(h)}</p>
            ${p.officialBusiness > 0 ? `<p class="p-sum">${t('payExpenses', { v: usd(p.officialBusiness), y: p.year })}</p>` : ''}
          </div>
        </details>`
      }).join('')}
    </div>
    <p class="note">${t('payrollTotal', { v: usd(payroll), pct: y.payrollShareOperating ?? '—', d: usd(y.operatingSpend), y: y.year })}
      ${y.staffUnder10k > 0 ? t('payrollSmall', { v: usd(y.staffUnder10k) }) : ''}
      ${y.expensesPaidBack > 0 ? t('payrollExpenses', { v: usd(y.expensesPaidBack) }) : ''}</p>
  </section>`)
}

// Jurisdiction gets argued on the ground by people who have not read the book.
// Naming the work the agreement actually covers is cheap to publish and hard to
// argue with once a laborer has it in his pocket.
function scopeSection() {
  const s = CONTRACT.scope
  return el(`<section class="sec">
    <h2>${t('ourWork')}</h2>
    <p class="lede">${esc(s.body)}</p>
    <details class="card pad scope">
      <summary>${esc(s.title)} <cite>${esc(CONTRACT.name.split('—')[0].trim())} ${esc(s.cite)}</cite></summary>
      <ul>${s.covers.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      <p class="note">${esc(s.note)}</p>
    </details>
  </section>`)
}

// "What am I paying for" — the question the headline totals never answer.
// Investment purchases are excluded: moving money between the local's own
// accounts is not spending, and leaving it in makes every other slice look tiny.
// So is money that only passes through. The rows are the categories ingest
// sums into operatingSpend (metrics.mjs), so they add up to it.
function spendSection(L, y) {
  const s = y.spend
  // Reports before 2004 had no categories by purpose, only lines like
  // professional fees; shown by those, they still add up. Their officer and
  // staff lines are take-home pay, so the taxes withheld from it get a line,
  // or those two fall short of the payroll in the section below.
  const old = y.oldForm ?? s.representational == null
  const rows = (old ? [
    [t('spOfficers'), s.to_officers, ''],
    [t('spStaff'), s.to_employees, ''],
    [t('spWithheld'), s.withheld, t('spWithheldSub')],
    [t('spOffice'), s.off_admin_expense, ''],
    [t('spProFees'), s.pro_fees, t('spProFeesSub')],
    [t('spEdu'), s.edu_pub_expense, ''],
    [t('spOther'), s.other_disbursements, ''],
  ] : [
    [t('spRep'), s.representational, t('spRepSub')],
    [t('spRunning'), s.union_administration, t('spRunningSub')],
    [t('spOverhead'), s.general_overhead, t('spOverheadSub')],
    [t('spPolitics'), s.political, ''],
  ]).concat([
    [t('spBenefits'), s.benefits, t('spBenefitsSub')],
    [t('spGifts'), s.contributions, t('spGiftsSub')],
    [t('spPerCapita'), s.per_capita_tax, t('spPerCapitaSub')],
    [t('spStrike'), s.strike_benefits, t('spStrikeSub')],
    [t('spFees'), s.fees_paid, t('spFeesSub')],
    [t('spSupplies'), s.supplies_bought, t('spSuppliesSub')],
    [t('spTaxes'), s.direct_taxes, ''],
  ]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])

  const operating = y.operatingSpend ?? rows.reduce((t, [, v]) => t + v, 0)
  const per = y.operatingPerWorking
  const w = y.working
  const rest = w && y.members > w ? t('moneyNoteRest', { o: num(y.members - w) }) : ''
  const appr = y.memberClasses?.apprentice ? t('moneyNoteAppr', { p: num(y.memberClasses.apprentice) }) : ''
  // Never "$0 per member" for a report that had no representation line.
  const rep = s.representational > 0
    ? w ? t('moneyRep', { v: usd(y.representationalPerWorking) }) : t('moneyRepAll', { v: usd(y.representationalPerMember) })
    : ''

  return el(`<section class="sec">
    <h2>${t('moneyGoes')}</h2>
    <p class="lede">${t('moneyLede', { y: y.year, total: usd(operating), per: per != null ? t('moneyPer', { v: usd(per) }) : '', inv: usd(s.investments) })}
      ${y.passedThrough > 0 ? t('moneyPass', { v: usd(y.passedThrough) }) : ''}</p>
    <div class="card">
      ${rows.map(([label, v, note]) => `<div class="spend-row">
        <div class="spend-top">
          <span class="spend-label">${esc(label)}</span>
          <span class="spend-amt">${usd(v)}</span>
          <span class="spend-pct">${(v / operating * 100).toFixed(1)}%</span>
        </div>
        <div class="spend-bar"><i style="width:${(v / rows[0][1] * 100).toFixed(1)}%"></i></div>
        ${note ? `<div class="spend-note">${esc(note)}</div>` : ''}
      </div>`).join('')}
    </div>
    <p class="note">${w ? t('moneyNote', { w: num(w), appr, m: num(y.members), rest }) : ''}
      ${rep}${old ? ` ${t('moneyOldForm')}` : ''}</p>
  </section>`)
}

function lineageSection(L) {
  return el(`<section class="sec">
    <h2>Where the leadership came from</h2>
    <p class="lede">People on this payroll who were first paid by a different local. After a
      merger the financials read as one continuous organization — this is the part they hide.</p>
    <div class="card scroll"><table>
      <thead><tr><th>Name</th><th>Now</th><th class="n">Started at</th><th class="n">Year</th></tr></thead>
      <tbody>${L.lineage.map((p) => `<tr>
        <td>${esc(p.name)}</td><td>${esc(p.currentTitle || '—')}</td>
        <td class="n">Local ${p.cameFrom}</td><td class="n">${p.firstPaidYear}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="note">Matched on surname and first initial across every filing since 1999.
      Members who were never on a payroll don't appear — this is officers and staff only.</p>
  </section>`)
}

function peerSection(L, peers) {
  const rows = [...peers].sort((a, b) => (b.duesPerMember ?? 0) - (a.duesPerMember ?? 0))
  return el(`<section class="sec">
    <h2>${t('againstCouncil')}</h2>
    <p class="lede">${t('againstLede')}</p>
    <div class="card scroll"><table>
      <thead><tr><th>${t('tLocal')}</th><th class="n">${t('tMembersCol')}</th><th class="n">${t('tInPer')}</th>
        <th class="n">${t('tTreasPer')}</th><th class="n">${t('tTopPaid')}</th><th class="n">${t('tPayroll')}</th></tr></thead>
      <tbody>${rows.map((p) => `<tr class="${p.desig === L.desig ? 'me' : ''}">
        <td>${p.desig}${p.city ? ' · ' + esc(p.city) : ''}</td>
        <td class="n">${num(p.members)}</td>
        <td class="n">${usd(p.duesPerMember)}</td>
        <td class="n">${usd(p.assetsPerMember)}</td>
        <td class="n">${usdK(p.topPayWithoutExpenses)}</td>
        <td class="n">${pct(p.payrollShareOperating)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </section>`)
}

function timelineSection(L) {
  const fmt = (d, ap) => {
    const dt = new Date(d + 'T00:00:00')
    const s = dt.toLocaleDateString(LOC(), { month: 'long', year: 'numeric', day: ap ? undefined : 'numeric' })
    return ap ? '~' + s : s
  }
  return el(`<section class="sec">
    <h2>What has actually happened here</h2>
    <p class="lede">Mergers, trusteeships, audits, elections. None of it is in the financial
      filings and none of it is on the local's website.</p>
    <div class="card pad"><ul class="tl">${L.events.map((e) => `<li>
      <div class="when">${fmt(e.date, e.approximate)}${e.unverified ? ' · <span class="pill n">unverified</span>' : ''}</div>
      <div class="what">${esc(e.title)}</div>
      <div class="body">${esc(e.body)}</div>
      ${linkHtml(e.source, 'Source document →')}
    </li>`).join('')}</ul></div>
  </section>`)
}

/* ============================ fund view ============================ */

// What a contractor pays into a fund for each hour worked, from the District
// Council's allocation letters as the agreement data carries them, dated from
// the day they took effect. funds.json has a rate typed in by hand, and it sat
// at the 2024 figure for a year after the letters moved it; it is used only
// when the agreement's is missing.
function contributionRate(fund) {
  const group = CONTRACT?.wages?.allocations?.[/fox valley/i.test(fund.name ?? '') ? 'fox-valley' : 'westchester']
  const rate = group?.[fund.type === 'multiemployer-db' ? 'pension' : 'welfare']
  if (typeof rate === 'number') return { rate, from: CONTRACT.wages.effective ?? null }
  return { rate: fund.contributionRatePerHour ?? 0, from: fund.contributionRateFrom ?? null }
}

function renderFund() {
  const body = $('#fundBody')
  const desig = loadedLocal?.desig ?? INDEX.homeLocal
  const fund = Object.values(FUNDS.funds).find((f) => f.servesLocals?.includes(desig))
  if (!fund) {
    const head = $('#view-fund .vhead')
    $('h1', head).textContent = t('pensionTitle')
    $('.eyebrow', head).textContent = `Local ${desig} · ${t('pensionEyebrow')}`
    body.innerHTML = `<p class="lede">${t('westchesterLede', { d: desig })}</p>
      <p class="note">${t('westchesterNote')}</p>`
    return
  }

  const a = fund.actuarial?.at(-1)
  const s = fund.series.at(-1)
  const facts = fund.memberFacts ?? []

  // Name the fund in the heading rather than burying it in a paragraph. Fox
  // Valley covers 582 and 1035; every other local reports to Westchester, and
  // someone switching locals has to see which fund they are looking at.
  const head = $('#view-fund .vhead')
  $('h1', head).textContent = fund.name.replace('Fox Valley & Vicinity', 'Fox Valley')
  $('.eyebrow', head).textContent = `Local ${desig} · ${t('pensionEyebrow')}`

  body.innerHTML = ''
  body.append(el(`<section class="sec">
    <p class="lede">${t('pensionLede', {
      name: esc(fund.name),
      serves: fund.confirmedLocals ? t('servesLocals', { a: fund.confirmedLocals[0], b: fund.confirmedLocals[1] }) : '',
    })}</p>
    ${fund.inferred ? `<p class="caveat">${t('inferredWarn', { d: desig })}</p>` : ''}
    <div class="stats">
      <div class="card stat"><div class="k">${t('fundAssets')}</div><div class="v">${usdK(s.assets)}</div>
        <div class="r">${t('forPeople', { n: num(s.participants), y: s.planYear })}</div></div>
      <div class="card stat"><div class="k">${t('funded')}</div><div class="v">${a ? a.fundedPercentage + '%' : '—'}</div>
        <div class="r"><span class="pill ${a?.zoneCode === 'N' ? 'g' : 'n'}">${a?.zoneCode === 'N' ? t('greenZone') : esc(a?.zoneLabel ?? '')}</span></div></div>
      ${a?.creditBalance != null ? `<div class="card stat"><div class="k">${t('cushion')}</div>
        <div class="v">${usdK(a.creditBalance)}</div>
        <div class="r">${t('noDeficiency')}</div></div>` : ''}
      ${a?.auditorOpinion ? `<div class="card stat"><div class="k">${t('auditK')}</div>
        <div class="v" style="font-size:1.2rem">${a.auditorOpinion === 'unmodified' ? t('auditClean') : esc(a.auditorOpinion)}</div>
        <div class="r">${esc(fund.auditor ?? '')}</div></div>` : ''}
    </div>
  </section>`))

  if (facts.length) body.append(el(`<section class="sec">
    <h2>${t('meansForYou')}</h2>
    <p class="lede">${t('meansLede')}</p>
    ${facts.map((f) => `<div class="callout">
      <h3>${esc(pick(f, 'title'))}</h3>
      <p>${pick(f, 'body')}</p>
      ${f.ask ? `<p>${t('askOffice')} ${esc(pick(f, 'ask'))}</p>` : ''}
    </div>`).join('')}
  </section>`))

  body.append(el(`<section class="sec">
    <h2>${t('alarmingTitle')}</h2>
    <p class="lede">${t('alarmingLede')}</p>
    <div class="card pad">${Object.values(FUNDS.explainers).map((x) => `<details class="ex">
      <summary>${esc(pick(x, 'label'))} ${x.lookScary ? `<span class="pill r">${t('looksScary')}</span>` : `<span class="pill g">${t('theRealOne')}</span>`}</summary>
      <div class="why"><p>${esc(pick(x, 'plain'))}</p>${x.proof ? `<p class="proof">${esc(pick(x, 'proof'))}</p>` : ''}</div>
    </details>`).join('')}</div>
  </section>`))

  // Both district council pension funds are green zone, but they are not in the
  // same shape, and a member is entitled to see their own fund next to the one
  // covering everybody else — same rule as the officer pay table.
  const others = Object.values(FUNDS.funds)
    .filter((f) => f.type === 'multiemployer-db' && f !== fund && f.actuarial?.length)
  if (others.length) body.append(el(`<section class="sec">
    <h2>${t('nextToOther')}</h2>
    <div class="card scroll"><table>
      <thead><tr><th>${t('tFund')}</th><th class="n">${t('funded')}</th><th class="n">${t('fundAssets')}</th>
        <th class="n">${t('tParticipants')}</th><th class="n">${t('tZone')}</th></tr></thead>
      <tbody>${[fund, ...others].map((f) => {
        const fa = f.actuarial.at(-1)
        return `<tr class="${f === fund ? 'me' : ''}">
          <td>${esc(f.city)}</td>
          <td class="n">${fa.fundedPercentage}%</td>
          <td class="n">${usdK(fa.actuarialAssets)}</td>
          <td class="n">${num(f.series.at(-1).participants)}</td>
          <td class="n">${fa.zoneCode === 'N' ? t('zGreen') : esc(fa.zoneLabel)}</td>
        </tr>`
      }).join('')}</tbody>
    </table></div>
    <p class="note">${t('bothGreenNote')}</p>
  </section>`))

  const rate = contributionRate(fund)
  if (fund.topContributors2024?.length) body.append(el(`<section class="sec">
    <h2>${t('whoPaysIn')}</h2>
    <p class="lede">${t('whoPaysLede', { r: rate.rate.toFixed(2), since: rate.from ? esc(t('rateSince', { d: fmtFiled(rate.from) })) : '' })}</p>
    <div class="card scroll"><table>
      <thead><tr><th>${t('tContractor')}</th><th class="n">${t('tContributed')}</th></tr></thead>
      <tbody>${fund.topContributors2024.map((c) => `<tr>
        <td>${esc(c.name)}</td><td class="n">${usd(c.amount)}</td></tr>`).join('')}</tbody>
    </table></div>
  </section>`))
}

/* ============================ settings ============================ */

const APP_VERSION = appVersion(window)

function openSettings() {
  const n = readLog().length
  openSheet(t('settings'), [
    { act: 'skin', label: t('skin'), sub: t('skinSub') },
    { act: 'lang', label: t('language'), sub: t('languageSub') },
    { act: 'zone', label: t('timeZone'), sub: t('timeZoneSub', { z: zoneName() }) },
    { act: 'backup', label: t('saveBackup'), sub: n ? t('saveBackupSub', { n, entries: t(n === 1 ? 'entryOne' : 'entryMany') }) : t('saveBackupSubNone') },
    { act: 'restore', label: t('restoreBackup'), sub: t('restoreSub') },
    { act: 'notices', label: t('noticesAgain'), sub: t('noticesAgainSub') },
    { act: 'report', label: t('report'), sub: t('reportSub') },
    { act: 'about', label: t('about'), sub: `Ledger ${APP_VERSION}` },
    { act: 'reset', label: t('erase'), sub: t('eraseSub') },
  ], (r) => ({
    skin: pickSkin,
    lang: pickLang,
    zone: pickZone,
    backup: exportLog,
    restore: importLog,
    notices: async () => {
      await store.setMeta('noticesSeen', [])
      // notices.json is legitimately empty most of the time — the button still
      // has to answer, or it reads as broken. (It did.) The count is what was
      // put back on this screen: a notice for the other build, or one past
      // its last day, is in the file but never shows here.
      const count = await paintNotices()
      tell(t('noticesAgain'), count ? t(count === 1 ? 'noticesBackOne' : 'noticesBack', { n: count }) : t('noticesEmpty'))
    },
    report: reportProblem,
    about: showAbout,
    reset: resetEverything,
  })[r.act]?.())
}

function pickLang() {
  openSheet(t('language'), [
    { id: 'en', label: 'English', on: LANG === 'en' },
    { id: 'es', label: 'Español', on: LANG === 'es' },
  ], (r) => { localStorage.setItem(LANG_KEY, r.id); location.reload() })
}

// Central for everyone until he says otherwise, whatever the phone is set to.
function pickZone() {
  const cur = zoneChoice()
  openSheet(t('timeZone'), ZONES.map((id) => ({
    id,
    label: t(id === DEVICE ? 'tzPhone' : ZONE_TEXT[id][0]),
    sub: id === DEVICE ? t('tzPhoneSub', { z: deviceZone() ?? '—' }) : t(ZONE_TEXT[id][1]),
    on: id === cur,
  })), (r) => {
    localStorage.setItem(ZONE_KEY, r.id)
    setZone(r.id)
    zoneMoved()
  })
}

// Another zone can make it another day or another hour: everything that
// reads today or a clock is drawn again. A date the member chose stays.
function zoneMoved() {
  if (dateUntouched) { setDefaultDate(); followDate() }
  calMonth = monthOf()
  paintToday()
  paintPunch()
  paintEntries()
  paintCards()
  paintNotices()
}

function pickSkin() {
  const cur = migrateTheme(localStorage.getItem(THEME_KEY)) ?? 'jobsite'
  const subKey = { '': 'skinAuto', america: 'skinAmerica', dark: 'skinDark', jobsite: 'skinJobsite', sun: 'skinSun' }
  openSheet(t('skin'), THEMES.map((th) => ({ ...th, sub: t(subKey[th.id] ?? ''), on: th.id === cur })),
    (r) => applyTheme(r.id))
}

function showAbout() {
  openSheet(t('aboutTitle'), [
    { label: `Ledger ${APP_VERSION}`, sub: t('aboutFree') },
    { label: t('aboutIndependent'), sub: t('aboutIndependentSub') },
    { label: t('aboutDevice'), sub: t('aboutDeviceSub') },
    { label: t('aboutAdvice'), sub: t('aboutAdviceSub') },
    { label: t('aboutClaims'), sub: t('aboutClaimsSub') },
    { label: t('aboutSources'), sub: t('aboutSourcesSub') },
  ], () => {})
}

// mailto rather than a form, because a form needs a server and a server would
// mean this app suddenly collects things. The body is prefilled with version
// and device details only — never with anything the member logged.
function reportProblem() {
  const subject = encodeURIComponent(t('reportSubject', { v: APP_VERSION }))
  const body = encodeURIComponent(t('reportBody', { v: APP_VERSION, ua: navigator.userAgent, n: readLog().length }))
  // The address is the one on the privacy policy and the App Store listing.
  // It was missing entirely — the draft opened addressed to nobody, and a
  // member with a real bug got a dead end dressed as a feature.
  location.href = `mailto:ledger@the-undesirables.com?subject=${subject}&body=${body}`
}

// Two deliberate obstacles: a backup check, and typing a word. A thumb in a
// glove finds a confirm button by accident; it does not type ERASE by accident.
//
// Everything means everything this phone keeps for him: a member erasing
// before he sells or hands on a phone must not leave his card numbers, his
// pay pattern, his rate or the radar's matches against his contractors
// behind. What stays is how the app looks, what language it speaks and what
// time zone it keeps.
const ERASE_KEEPS = new Set([LANG_KEY, THEME_KEY, ZONE_KEY])
const erasableKeys = () => store.erasableKeys(localStorage, ERASE_KEEPS)

async function resetEverything() {
  const n = readLog().length
  const held = n || erasableKeys().length || (await store.metaKeys()).length
  if (!held) { tell(t('erase'), t('eraseNothing')); return }

  const last = n ? await store.getMeta('lastBackup') : null
  const warn = !n ? ''
    : last
      ? t('eraseLastBackup', { date: new Date(last.at).toLocaleDateString(LOC(), inZone()), n: last.count, entries: t(last.count === 1 ? 'entryOne' : 'entryMany'), m: n })
      : t('eraseNoBackup')

  const ok = await askConfirm(
    t('erase'),
    t('eraseConfirm', { n, entries: t(n === 1 ? 'entryOne' : 'entryMany'), warn }).replace(/\n{3,}/g, '\n\n'),
    t('eraseGoOn'), true,
  )
  if (!ok) return

  const word = t('eraseWord')
  if (!(await askWord(t('erase'), t('eraseTypeWord', { word }), word))) {
    tell(t('erase'), t('eraseAborted'))
    return
  }

  await chainWrite(async () => {
    await store.eraseAll()
    LOG = await store.readAll()
  })
  for (const k of erasableKeys()) localStorage.removeItem(k)

  // What the screen still holds from before.
  CERTS = []
  PAYDAY = null
  PUNCH = null
  punchMeta = null
  clearInterval(punchTimer)
  $('#punchSummary').hidden = true
  paintPunch()
  $('#appTitle').textContent = t('yourHours')
  $('#fRate').value = CONTRACT?.wages?.baseRate ? CONTRACT.wages.baseRate.toFixed(2) : ''
  paintHours()
  // The log-changed listeners re-read the cards (none now) and rebuild the
  // phone's card warnings from that, and take down any radar match.
  logChanged()
  paintEntries()
  paintNotices()
  tell(t('erase'), t('eraseDone'))
}

/* ============================ notices ============================ */
// The only part of the app that is somebody talking rather than a record being
// shown, so it is styled and attributed differently on purpose. Dismissals live
// on the device; nobody learns who read what, because there is nowhere to send
// that and no reason to want it. Answers how many it put on the screen.

async function paintNotices() {
  try { return await paintNoticeRows() } finally { foldStatus() }
}

// Minimal markdown: **bold** only. Anything richer invites pasted HTML into a
// file that renders on every member's phone.
const noticeText = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')

// One line on the Log tab: who it is from and the title. The body, which can
// run to a dozen lines, opens in the sheet when he asks for it, in his
// language, with its link.
async function paintNoticeRows() {
  const board = $('#noticeBoard')
  const notices = await fetch('./data/notices.json').then((r) => r.json()).catch(() => [])
  const seen = new Set((await store.getMeta('noticesSeen')) ?? [])
  const live = liveNotices(notices, { platform: NATIVE ? 'ios' : 'web', today: dayKey(), seen })
  if (!live.length) { board.innerHTML = ''; return 0 }

  board.innerHTML = live.map((n, i) => `<article class="notice notice-row">
    <span class="nag-text"><span class="notice-from">${esc(n.from)}</span> ${esc(pick(n, 'title'))}</span>
    <button type="button" class="nag-go" data-read="${i}">${esc(t('noticeRead'))}</button>
    <button class="notice-x" type="button" data-seen="${esc(n.id)}" aria-label="${esc(t('ariaDismissNotice'))}">&times;</button>
  </article>`).join('')

  $$('#noticeBoard [data-read]').forEach((b) => b.addEventListener('click', () => openNotice(live[Number(b.dataset.read)])))
  $$('#noticeBoard [data-seen]').forEach((b) => b.addEventListener('click', async () => {
    await store.setMeta('noticesSeen', [...seen, b.dataset.seen])
    paintNotices()
  }))
  return live.length
}

function openNotice(n) {
  const when = new Date(n.date + 'T12:00:00').toLocaleDateString(LOC(), { month: 'long', day: 'numeric' })
  $('#sheetTitle').textContent = pick(n, 'title')
  $('#sheetBody').innerHTML = `<div class="notice-read">
    <div class="notice-from">${esc(n.from)} · ${esc(when)}</div>
    ${String(pick(n, 'body') ?? '').split(/\n{2,}/).map((p) => `<p>${noticeText(p)}</p>`).join('')}
    ${n.link ? linkHtml(n.link.url, `${esc(pick(n.link, 'label'))} →`) : ''}
  </div>`
  showSheet()
}

// The reminders that can need him — a lapsing card, a backup due, a notice —
// share one row on the Log tab, so Punch in stays on the first screen of a
// small phone however many are due. The most urgent shows: a card that has
// lapsed or is inside 30 days, then a backup due, then a card missing its
// date, then notices. The rest fold behind a +N that opens them in place.
// Each row still paints itself; this only orders and folds them.
let statusOpen = false
function foldStatus() {
  const card = $('#cardNag'), backup = $('#backupNag'), board = $('#noticeBoard')
  if (!card || !backup || !board) return
  const cardFirst = !card.hidden && card.dataset.kind !== 'nodate'
  card.style.order = cardFirst ? '0' : '2'
  backup.style.order = '1'
  board.style.order = '3'
  const rows = [
    ...(cardFirst ? [card] : []),
    ...(backup.hidden ? [] : [backup]),
    ...(!card.hidden && !cardFirst ? [card] : []),
    ...$$('.notice', board),
  ]
  $('#statusMore')?.remove()
  for (const r of [card, backup, ...$$('.notice', board)]) r.classList.remove('folded')
  rows.forEach((r, i) => r.classList.toggle('folded', !statusOpen && i > 0))
  if (rows.length < 2) { statusOpen = false; return }
  const more = rows.length - 1
  const btn = el(`<button type="button" class="status-more" id="statusMore" aria-expanded="${statusOpen}">${statusOpen ? '−' : '+' + more}</button>`)
  btn.setAttribute('aria-label', t(statusOpen ? 'statusFewer' : 'statusMoreSay', { n: more }))
  btn.addEventListener('click', () => { statusOpen = !statusOpen; foldStatus() })
  const text = $('.nag-text', rows[0])
  if (text) text.append(' ', btn); else rows[0].append(btn)
}

/* ============================ cards ============================ */

let CERTS = []

// Only things shaped like cards get in. The card list paints before the log,
// and a bad record in it must never be what keeps the log from showing.
async function loadCerts() {
  const saved = await store.getMeta('certs')
  CERTS = Array.isArray(saved) ? saved.filter((c) => c && typeof c === 'object') : []
}
async function saveCerts() { await store.setMeta('certs', CERTS); paintCards(); syncNativeCertAlerts() }

// Both places a card shows, each on its own guard.
function paintCards() {
  try { paintCerts() } catch (err) { console.warn('cards', err) }
  try { paintCardNag() } catch (err) { console.warn('card line', err) }
  try { foldStatus() } catch (err) { console.warn('status row', err) }
}

const certName = (type) => t(`cert_${typeOf(type).id}`)
const certNote = (type) => (STR.en[`certNote_${typeOf(type).id}`] ? t(`certNote_${typeOf(type).id}`) : '')
// Built from the parts: new Date('2026-03-05') is UTC midnight, which is the
// evening before in Chicago.
const fmtCardDate = (iso) => {
  if (!isISODate(iso)) return String(iso ?? '—')
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(LOC(), { year: 'numeric', month: 'short', day: 'numeric' })
}

// Hand the shell everything it needs to warn the member at 90/30/7 days —
// rebuilt in full on every change so a deleted card never fires a ghost alert.
// The shell has no words of its own: the name and each warning's text go in
// his language, and a language switch reloads the page, which re-sends.
// expires is a plain calendar date, the day printed on the card.
function syncNativeCertAlerts() {
  if (!NATIVE || !NOTIFICATIONS_ENABLED) return
  nativePost({
    type: 'syncCertAlerts',
    alerts: nativeAlerts(CERTS, {
      label: certName,
      body: (expires, n) => t('certAlertBody', { d: fmtCardDate(expires), n }),
    }),
  })
}

function addCertFlow() {
  openSheet(t('certKind'), CERT_TYPES.map((ct) => ({ label: certName(ct.id), sub: certNote(ct.id), id: ct.id })),
    (pick) => cardForm(typeOf(pick.id)))
}

const CARD_ERR = {
  badDate: 'certErrBadDate', issuedFuture: 'certErrIssuedFuture',
  expiresBefore: 'certErrExpiresBefore', expiresNeeded: 'certErrExpiresNeeded',
}

// Training centers usually print the expiry right on the card. When they have,
// use theirs — a computed date that disagrees with the card in a member's hand
// is worse than no date at all. Where the period varies card to card, the
// printed date is the only one asked for. A date that can't be read is sent
// back to the form with what was typed, never saved.
function cardForm(ct, prev = {}, problem = null) {
  const today = localISO()
  const period = ct.months >= 12
    ? `${ct.months / 12} ${t(ct.months > 12 ? 'yearManyLong' : 'yearOneLong')}`
    : `${ct.months} ${t('monthsLong')}`
  const hint = ct.printed ? t(ct.id === 'other' ? 'hintManual' : 'hintPrinted') : t('hintAuto', { p: period })
  const errAt = !problem ? null
    : problem === 'issuedFuture' || !isISODate(prev.issued) ? 'issued' : 'expires'
  const err = (field) => (errAt === field ? t(CARD_ERR[problem]) : null)
  openForm(t('cardFormTitle', { card: certName(ct.id) }), [
    { id: 'issued', label: t('fIssued'), type: 'date', value: prev.issued ?? today, required: true,
      min: MIN_DATE, max: today, err: err('issued') },
    { id: 'expires', label: t('fExpires'), type: 'date', value: prev.expires, required: !!ct.printed,
      min: MIN_DATE, max: MAX_DATE, hint, err: err('expires') },
    { id: 'number', label: t('fCardNum'), type: 'text', value: prev.number, hint: t('hintCardNum') },
  ], (vals) => {
    const why = cardDateProblem(ct.id, vals, today)
    if (why) { cardForm(ct, vals, why); return }
    CERTS.push({
      id: crypto.randomUUID(),
      type: ct.id,
      issued: vals.issued,
      expires: vals.expires || null,
      number: vals.number || null,
      added: new Date().toISOString(),
    })
    saveCerts()
  })
}

// Cards saved before the printed date was asked for carry none. Asking for it
// beats guessing one that can outlast the card.
function addPrintedDate(c, problem = null) {
  openForm(t('cardDateTitle', { card: certName(c.type) }), [
    { id: 'expires', label: t('fExpires'), type: 'date', required: true,
      min: isISODate(c.issued) ? c.issued : MIN_DATE, max: MAX_DATE,
      hint: t('hintPrinted'), err: problem ? t(CARD_ERR[problem]) : null },
  ], (vals) => {
    const why = !isISODate(vals.expires) ? 'badDate' : vals.expires < c.issued ? 'expiresBefore' : null
    if (why) { addPrintedDate(c, why); return }
    c.expires = vals.expires
    saveCerts()
  })
}

function certPeriod(c, ct) {
  if (c.expires) return ` · ${t('fromCard')}`
  if (!ct.months) return ''
  const p = ct.months % 12 ? t('perMonths', { n: ct.months })
    : ct.months === 12 ? t('perYear') : t('perYears', { n: ct.months / 12 })
  return ` · ${t(ct.basis === 'custom' ? 'refreshEvery' : ct.refresher ? 'refresherEvery' : 'renewsEvery', { p })}`
}

function certStatusLabel(st, ct) {
  const d = st.days
  switch (st.state) {
    case 'bad': return t('certBadDate')
    case 'nodate': return t('certNoDate')
    case 'none': return t('noExpiry')
    case 'refresh': return t('certRefresh')
    case 'superseded':
      return t(typeOf(st.by.type).id === ct.id ? 'certReplaced' : 'certKeptBy', { d: fmtCardDate(st.by.issued) })
    case 'expired': return d === -1 ? t('expiredYesterday') : t('expiredAgo', { n: -d })
  }
  if (d === 0) return t('expToday')
  if (d === 1) return t('expTomorrow')
  if (d <= 90) return t('daysLeft', { n: d })
  if (d < 730) return t('monthsLeft', { n: Math.round(d / 30.44) })
  return t('yearsLeft', { n: Math.floor(d / 365) })
}

function paintCerts() {
  const body = $('#certBody')
  if (!CERTS.length) {
    body.innerHTML = `<div class="card pad">
      <p class="lede" style="margin:0 0 .6rem">${t('certEmptyLede')}</p>
      <p class="note" style="margin:0">${t('certEmptyBody')}</p>
      <p class="note">${t('certEmptyBody2')}</p>
    </div>`
    return
  }

  const now = new Date()
  const rows = sortCerts(CERTS, now).map((c) => ({ c, ct: typeOf(c.type), st: statusOf(c, now, CERTS) }))
  // Only real expiries count here. A suggested refresh is not a lapse.
  const bad = rows.filter((r) => r.st.state === 'expired').length
  const soon = rows.filter((r) => r.st.state === 'soon' && !r.st.suggested).length

  body.innerHTML = `
    ${bad || soon ? `<div class="nag" style="margin-bottom:.9rem"><span class="nag-text">${
      bad ? t('certExpiredN', { n: bad, cardHas: t(bad === 1 ? 'cardHasOne' : 'cardHasMany') }) + ' ' : ''
    }${soon ? t('certSoonN', { lead: bad ? '' : '<b>', n: soon, tail: bad ? '' : '</b>', expire: t(soon === 1 ? 'expireOne' : 'expireMany') }) : ''}
      </span></div>` : ''}
    ${rows.map(({ c, ct, st }) => {
      const note = certNote(ct.id)
      return `<div class="cert ${st.state}">
        <div class="cert-main">
          <div class="cert-name">${esc(certName(ct.id))}</div>
          <div class="cert-meta">${t('issued')} ${esc(fmtCardDate(c.issued))}${certPeriod(c, ct)}</div>
          ${c.number ? `<div class="cert-num">${esc(c.number)}</div>` : ''}
          ${st.state === 'nodate' ? `<button type="button" class="cert-fix" data-date="${esc(c.id)}">${t('certAddDate')}</button>` : ''}
        </div>
        <div class="cert-status">
          <div class="cert-days">${esc(certStatusLabel(st, ct))}</div>
          <div class="cert-exp">${st.exp && st.state !== 'superseded' ? esc(fmtCardDate(st.exp)) : '—'}</div>
        </div>
        <button class="cert-del" type="button" data-del="${esc(c.id)}" aria-label="${esc(t('removeCardLabel'))}">&times;</button>
      </div>
      ${note ? `<p class="cert-note">${esc(note)}</p>` : ''}`
    }).join('')}
    <p class="note">${t('certNote')}</p>`

  // The × sits next to the card's status, where a gloved thumb lands by
  // accident, and a removed card takes its number with it.
  $$('#certBody [data-del]').forEach((b) => b.addEventListener('click', async () => {
    const c = CERTS.find((x) => String(x.id) === b.dataset.del)
    if (!c) return
    const what = [certName(c.type), c.number].filter(Boolean).join(' · ')
    if (!(await askConfirm(t('removeCardQ'), t('removeCardSub', { card: what }), t('removeCard'), true))) return
    CERTS = CERTS.filter((x) => x !== c)
    saveCerts()
  }))
  $$('#certBody [data-date]').forEach((b) => b.addEventListener('click', () => {
    const c = CERTS.find((x) => String(x.id) === b.dataset.date)
    if (c) addPrintedDate(c)
  }))
}

// The Log tab is the screen a member opens every day; the Cards tab is the one
// he opens when he remembers to. A card that has lapsed, is inside 30 days or
// is missing its printed date gets one line there: the most urgent one, and a
// count of the rest. Not announced — it is there every time he looks.
function paintCardNag() {
  const bar = $('#cardNag')
  if (!bar) return
  const due = cardAlerts(CERTS)
  bar.hidden = !due.length
  if (!due.length) { bar.innerHTML = ''; return }
  const { cert, kind, days } = due[0]
  bar.dataset.kind = kind
  const key = kind === 'expired' ? 'cardNagExpired' : kind === 'nodate' ? 'cardNagNoDate'
    : days === 0 ? 'cardNagToday' : days === 1 ? 'cardNagTomorrow' : 'cardNagDays'
  const more = due.length - 1
  bar.innerHTML = `<span class="nag-text">${t(key, { card: esc(certName(cert.type)), n: days })}${more
    ? ` <span class="nag-more" aria-hidden="true">${t('cardNagMore', { n: more })}</span><span class="sr-only">${t('cardNagMoreSay', { n: more })}</span>`
    : ''}</span>
    <button type="button" class="nag-go" id="cardNagGo">${t('cardNagSee')}</button>`
  $('#cardNagGo').addEventListener('click', () =>
    $$('.tabs button').find((b) => b.dataset.go === 'certs')?.click())
}


/* ============================ radar ============================ */
// The contractor trouble radar. The feed (radar.json) is public docket facts —
// suits filed by laborers' benefit funds in the Northern District of Illinois.
// The matching against YOUR contractors happens right here, on this device,
// against the names in your own log. The feed never learns who you work for.
//
// normName/radarNamesMatch mirror normalizeName/namesMatch in
// packages/data/src/radar.mjs — keep them in step.

const RADAR_SUFFIX = /\b(INC|LLC|L\.?L\.?C|CORP|CORPORATION|CO|LTD|COMPANY|INCORPORATED)\b\.?/g
function normName(s) {
  return String(s ?? '').toUpperCase()
    .replace(/D\/B\/A.*$/, '').replace(RADAR_SUFFIX, '')
    .replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}
function radarNamesMatch(a, b) {
  const na = normName(a), nb = normName(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const ta = na.split(' '), tb = nb.split(' ')
  return ta.length >= 2 && tb.length >= 2 && ta[0] === tb[0] && ta[1] === tb[1]
}

function radarMatches() {
  if (!RADAR?.events?.length) return []
  const contractors = [...new Set(activeLog().map((e) => e.contractor).filter(Boolean))]
  const out = []
  for (const ev of RADAR.events) {
    const hit = contractors.find((c) => radarNamesMatch(ev.defendant, c))
    if (hit) out.push({ ...ev, matched: hit })
  }
  return out
}

// Data-file prose can carry Spanish alongside English: { body, body_es }.
// Falls back to English rather than showing nothing.
const pick = (obj, key) => (LANG !== 'en' && obj[`${key}_${LANG}`]) || obj[key]

const fmtFiled = (d) => d
  ? new Date(d + 'T12:00:00').toLocaleDateString(LOC(), { month: 'long', day: 'numeric', year: 'numeric' })
  : '—'

// The day the suit list was last fetched in full. The iPhone reads the copy in
// its own bundle, and a failed fetch ships the last good list again, so the
// list can be weeks old; every screen that says what the radar found says as
// of when. A file from before asOf existed is dated by when it was built.
// Past 30 days the member is told suits filed since are not on it.
const RADAR_STALE_DAYS = 30
function radarAsOf() {
  const d = isDayKey(RADAR?.asOf) ? RADAR.asOf
    : RADAR?.generated && !isNaN(new Date(RADAR.generated)) ? dayKey(new Date(RADAR.generated)) : null
  if (!d) return null
  const days = daysBetween(d, dayKey())
  const short = atLocal(d).toLocaleDateString(LOC(), inZone({
    month: 'short', day: 'numeric', year: d.slice(0, 4) === dayKey().slice(0, 4) ? undefined : 'numeric',
  }))
  return { d, text: fmtFiled(d), short, days, stale: days > RADAR_STALE_DAYS }
}
function radarAsOfLine() {
  const a = radarAsOf()
  if (!a) return ''
  return t('radarAsOf', { d: a.text }) + (a.stale ? ' ' + t('radarStale', { n: a.days }) : '')
}

// A suit by a laborers' fund that is not the member's district's (the
// downstate Central Laborers fund) says so. No fundScope is a file from before
// it existed, and reads as the district's, as it always did.
const otherFund = (e) => e.fundScope === 'other'
const otherFundTag = (e) => otherFund(e) ? ` (${esc(t('radarOtherFund'))})` : ''

// The spidey-sense: a banner on the Log tab, only when a fund sues a contractor
// that appears in this member's own log, and only until dismissed.
async function paintRadarBanner() {
  const nag = $('#radarNag')
  if (!nag || !RADAR) return
  const matches = radarMatches()
  const seen = new Set((await store.getMeta('radarSeen')) ?? [])
  const fresh = matches.filter((m) => m.docketNumber && !seen.has(m.docketNumber))
  nag.hidden = !fresh.length
  if (!fresh.length) return

  const m = fresh[0]
  nag.className = 'nag alert'
  // A name match, said as one: the name in the court papers beside his own
  // spelling, never his spelling after "filed suit against". The matcher
  // compares the first two words, and different firms share them.
  // Two lines at most, so it never pushes Punch in off a small screen: his
  // spelling first, the court's name last, where the cut falls on a long
  // one. The whole name, the fund, the date filed and the docket are on the
  // Radar tab, one tap away.
  const asOf = radarAsOf()
  const more = fresh.length > 1 ? `${t('andMore', { n: fresh.length - 1 })} ` : ''
  nag.innerHTML = `<span class="nag-text">${t(otherFund(m) ? 'radarBannerOther' : 'radarBanner', { def: esc(m.defendant.replace(/\.+$/, '')), c: esc(m.matched) })}</span>
    <span class="radar-foot">
      <small class="nag-sub${asOf?.stale ? ' stale' : ''}">${more}${asOf ? esc(t('radarAsOfShort', { d: asOf.short })) : ''}</small>
      <button type="button" class="nag-go" id="radarGo">${t('radarCheck')}</button>
    </span>
    <button type="button" class="nag-x" id="radarX" aria-label="${esc(t('ariaDismissRadar'))}">&times;</button>`
  if (NATIVE && NOTIFICATIONS_ENABLED) {
    const notified = new Set((await store.getMeta('radarNotified')) ?? [])
    const unseen = fresh.filter((m) => !notified.has(m.docketNumber))
    if (unseen.length) {
      nativePost({
        type: 'radarAlert',
        title: t('radarKicker'),
        body: `${unseen[0].plaintiff} v. ${unseen[0].defendant}`,
      })
      await store.setMeta('radarNotified', [...notified, ...unseen.map((m) => m.docketNumber)])
    }
  }
  $('#radarGo').addEventListener('click', () =>
    $$('.tabs button').find((b) => b.dataset.go === 'radar')?.click())
  $('#radarX').addEventListener('click', async () => {
    nag.hidden = true
    await store.setMeta('radarSeen', [...seen, ...fresh.map((f) => f.docketNumber)])
  })
}

// The banner and the Radar tab are matched against the log, so they follow
// it: a day logged for a contractor a fund is suing raises the banner then,
// not on the next launch, and a voided, restored or erased day takes its
// match with it.
document.addEventListener('ledger:logchanged', () => {
  paintRadarBanner().catch(() => {})
  if (!$('#view-radar').hidden) paintRadar()
})

function paintRadar() {
  const body = $('#radarBody')
  if (!RADAR?.events) {
    body.innerHTML = `<p class="loading">${t('radarNotLoaded')}</p>`
    return
  }
  const matches = radarMatches()
  const hasLog = readLog().some((e) => e.contractor)

  const asOf = radarAsOf()
  body.innerHTML = `
    <p class="lede">${t('radarLede')}</p>
    ${asOf ? `<p class="note radar-asof${asOf.stale ? ' stale' : ''}">${esc(radarAsOfLine())}</p>` : ''}

    ${matches.length ? matches.map((m) => `<article class="radar-hit">
      <div class="rh-k">${t('radarKicker')}</div>
      <h3>${esc(m.plaintiff)} v. ${esc(m.defendant)}</h3>
      ${otherFund(m) ? `<p><span class="pill n">${esc(t('radarOtherFund'))}</span></p>` : ''}
      <p>${t('filed')} <b>${fmtFiled(m.dateFiled)}</b> · ${t('docketWord')} ${esc(m.docketNumber ?? '—')} · ${esc(m.court)}.
        ${t('youLogged')} <b>${esc(m.matched)}</b>. ${esc(t('radarNameCheck'))}</p>
      <p>${t(otherFund(m) ? 'whatToDoOther' : 'whatToDo')}</p>
      ${m.url ? linkHtml(m.url, t('viewDocket')) : ''}
    </article>`).join('')
    : `<div class="card pad" style="margin-bottom:1rem"><p class="note" style="margin:0">
        ${hasLog
          ? t('radarNoMatch', { n: RADAR.events.length, m: Math.round((RADAR.lookbackDays ?? 365) / 30), d: esc(asOf ? asOf.text : '—') })
          : t('radarLogFirst')}
      </p></div>`}

    <section class="sec">
      <h2>${t('allRecent')}</h2>
      <p class="lede">${t('feedLede')}</p>
      <div class="card">${(() => {
        // One header per fund instead of the same plaintiff on every row.
        // Apostrophe variants ("Laborers" / "Laborers'") are the same fund.
        const groups = new Map()
        for (const e of RADAR.events) {
          const k = e.plaintiff.replace(/[\u2019']/g, '').replace(/\s+/g, ' ').trim().toUpperCase()
          if (!groups.has(k)) groups.set(k, { name: e.plaintiff, events: [] })
          groups.get(k).events.push(e)
        }
        return [...groups.values()]
          .sort((a, b) => String(b.events[0].dateFiled).localeCompare(String(a.events[0].dateFiled)))
          .map((g) => `<div class="radar-fund"><span>${esc(g.name)}${otherFundTag(g.events[0])}</span>
              <span class="rf-n">${g.events.length === 1 ? t('suitOne') : t('suitsN', { n: g.events.length })}</span></div>
            ${g.events.map((e) => `<div class="radar-row">
              <span class="rr-date">${esc(e.dateFiled ?? '—')}</span>
              <span class="rr-body"><span class="rr-def">${esc(e.defendant)}</span></span>
              ${e.url ? linkHtml(e.url, t('docketLink')) : ''}
            </div>`).join('')}`).join('')
      })()}</div>
      <p class="note">${t('claimsNote')}</p>
    </section>`
}

/* ============================ router ============================ */

$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
  const go = b.dataset.go
  $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b))
  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== go })
  if (go === 'fund') renderFund()
  if (go === 'certs') paintCards()
  if (go === 'radar') paintRadar()
  window.scrollTo({ top: 0 })
}))

// Rewrite the HTML's built-in English once per boot, before anything paints.
function applyStatic() {
  const tabT = { log: 'tabLog', certs: 'tabCards', local: 'tabLocal', fund: 'tabPension', radar: 'tabRadar' }
  $$('.tabs button').forEach((b) => { const sp = $('span', b); if (sp) sp.textContent = t(tabT[b.dataset.go] ?? '') })
  const spans = $$('.entry .line > span')
  if (spans.length >= 3) { spans[0].textContent = t('date'); spans[1].textContent = t('rate'); spans[2].textContent = t('contractor') }
  const scaleBtn = $('#btnScale'); if (scaleBtn) scaleBtn.textContent = t('scale')
  const dayT = { weekday: 'dayWeekday', saturday: 'daySaturday', sunday: 'daySunday', fourTens: 'dayFourTens' }
  $$('.daytype button').forEach((b) => { b.textContent = t(dayT[b.dataset.day] ?? '') })
  const unit = $('.hh-unit'); if (unit) unit.textContent = t('hoursWorked')
  $('#btnSave').textContent = t('logIt')
  $('#saveHint').textContent = t('sealedHint')
  $('#fContractor').placeholder = t('contractorPh')
  $('#fNote').placeholder = t('notePh')
  $('#fNoteLabel').textContent = t('noteLabel')
  const mic = $('.mic-text'); if (mic) mic.textContent = t('micIdle')
  const bankedK = $('.banked-k'); if (bankedK) bankedK.textContent = t('bankedK')
  $$('.recent > h2').forEach((h) => { h.textContent = t('recent') })
  const certHead = $('#view-certs .vhead')
  if (certHead) { $('.eyebrow', certHead).textContent = t('certEyebrow'); $('h1', certHead).textContent = t('cards') }
  const addBtn = $('#btnAddCert'); if (addBtn) addBtn.textContent = t('add')
  const localHead = $('#view-local .vhead')
  if (localHead) { $('.eyebrow', localHead).textContent = t('localEyebrow'); $('h1', localHead).textContent = t('localTitle') }
  const radarHead = $('#view-radar .vhead')
  if (radarHead) { $('.eyebrow', radarHead).textContent = t('radarEyebrow') }
  const cancel = $('.sheet-cancel'); if (cancel) cancel.textContent = t('close')
  const punchBtn = $('#punchLabel'); if (punchBtn) punchBtn.textContent = t('punchIn')
  const punchOutBtn = $('#btnPunchOut'); if (punchOutBtn) punchOutBtn.textContent = t('punchOut')
  const spTag = $('#spTag'); if (spTag) spTag.textContent = t('splashTag')
  // What a screen reader says for each control, in his language.
  const aria = {
    '#appTitle': 'ariaTitle', '#btnSettings': 'settings', '#btnScale': 'ariaScale', '.daytype': 'ariaDayType',
    '#hMinus': 'ariaFewer', '#hPlus': 'ariaMore', '#calPrev': 'ariaPrevMonth', '#calNext': 'ariaNextMonth',
  }
  for (const [sel, key] of Object.entries(aria)) $(sel)?.setAttribute('aria-label', t(key))
  // The calendar's weekday letters, Sunday first, from the phone's own
  // calendar names: S M T W T F S, or D L M M J V S. Nov 1, 2026 is a Sunday.
  const dow = $('.cal-dow')
  if (dow) dow.innerHTML = [0, 1, 2, 3, 4, 5, 6].map((i) =>
    `<span>${esc(new Date(2026, 10, 1 + i).toLocaleDateString(LOC(), { weekday: 'narrow' }))}</span>`).join('')
  document.documentElement.lang = LANG
}
applyStatic()

/* ---- splash ---- */
// Shown from the first paint; leaves when boot finishes but never before 900ms
// (a flash of eagle is worse than none) and never later than 4s (nobody gets
// trapped behind it if a fetch hangs).
const SPLASH_HTML = document.getElementById('splash')?.outerHTML ?? ''
const SPLASH_MIN = new Promise((r) => setTimeout(r, 900))
function hideSplash() {
  const sp = $('#splash')
  if (!sp) return
  sp.classList.add('sp-hide')
  setTimeout(() => sp.remove(), 500)
}
setTimeout(hideSplash, 4000)
// Re-run the splash on demand — for showing it off and for App Store shots.
window.__splashDemo = () => {
  if ($('#splash')) return
  document.body.insertAdjacentHTML('afterbegin', SPLASH_HTML)
  const tag = $('#spTag'); if (tag) tag.textContent = t('splashTag')
  setTimeout(hideSplash, 2400)
}

const bootLog = initLog()
initFilings()
  .catch((e) => {
    $('#localBody').innerHTML = `<p class="loading">Couldn't load filings: ${esc(e.message)}</p>`
  })
  .then(paintOvertimeWarning)
  .then(() => bootLog)
  .then(() => paintRadarBanner())
  .catch(() => {})
  .then(() => SPLASH_MIN)
  .then(hideSplash)
