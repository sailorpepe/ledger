// Ledger — your hours, your record.
//
// Two halves. The log is yours and never leaves this device. The filings are
// public and belong to every member. Neither one asks you to sign in.

import * as store from './store.js'
import { CERT_TYPES, sortCerts, statusOf, expiryFor, typeOf } from './certs.js'
import { STR } from './i18n.js'

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

/* ============================ native bridge ============================ */
// Present only inside the iOS shell. Every call is optional — the web app is
// complete without it; the bridge adds what Safari can't do: local
// notifications and on-device dictation (WKWebView has no speech API).
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
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}))
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
const ord = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]) }
const hrs = (n) => Number.isInteger(n) ? String(n) : n.toFixed(1)

// The Fox Valley plan year runs June 1 – May 31. Hours are counted against it,
// so the log counts against it too.
function planYearOf(d = new Date()) {
  const y = d.getFullYear()
  return d.getMonth() >= 5 ? y : y - 1
}
const planYearRange = (py) => [new Date(py, 5, 1), new Date(py + 1, 4, 31, 23, 59, 59)]

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

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Things that turn out to matter months later, when you can't remember which
// Tuesday it was. Cheap to flag now, impossible to reconstruct later.
const FLAGS = [
  { id: 'injury',  label: 'Injury',        re: /\b(hurt|injur|hospital|ambulance|first aid|strain|sprain|fell|slipped|cut|burn|back went)\b/i },
  { id: 'ot',      label: 'OT directed',   re: /\b(told (me|us)|made (me|us)|had to stay|kept (me|us)|mandatory|required us|no choice|stay(ed)? (late|till|until))\b/i },
  { id: 'offbook', label: 'Off the clock', re: /\b(off the (clock|books)|not on the ticket|didn'?t (write|put) (it|me) down|unpaid|cash)\b/i },
  { id: 'safety',  label: 'Safety',        re: /\b(no water|unsafe|no harness|missing|ppe|guard(rail)?|osha|near miss|no rail|exposed|fumes|no mask)\b/i },
  { id: 'treat',   label: 'Treatment',     re: /\b(yell|scream|slur|harass|threat|discriminat|singled out|wrote me up|racist|retaliat)\b/i },
]
const detectFlags = (t) => FLAGS.filter((f) => f.re.test(t || '')).map((f) => ({ id: f.id, label: f.label }))

async function appendEntry(draft) {
  const log = readLog()
  // Chain against the newest entry by seal time, not by work date — you can log
  // Monday's hours on Wednesday, and the chain records the order things were
  // written, which is the thing being attested to.
  const prev = [...log].sort((a, b) => b.loggedAt.localeCompare(a.loggedAt))[0]?.hash ?? 'genesis'
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
    prev,
  }
  const hash = await sha256(prev + JSON.stringify(body))
  const entry = { ...body, hash }
  await store.put(entry)
  LOG = await store.readAll()
  return LOG
}

// Removing a mistake without breaking the seal. A hard delete would snap the
// hash chain — and the chain is the whole reason this log outweighs a memory.
// So a mistake is VOIDED: a new sealed entry that points at the old one. The
// totals, calendar and radar skip voided days; the export shows them struck
// through, which is exactly how a paper logbook handles a crossed-out line —
// and why a lawyer can still trust the rest of the page.
async function voidEntry(hash) {
  const log = readLog()
  const prev = [...log].sort((a, b) => b.loggedAt.localeCompare(a.loggedAt))[0]?.hash ?? 'genesis'
  const body = {
    kind: 'void',
    voids: hash,
    date: new Date().toISOString().slice(0, 10),
    loggedAt: new Date().toISOString(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    prev,
  }
  const sealed = { ...body, hash: await sha256(prev + JSON.stringify(body)) }
  await store.put(sealed)
  LOG = await store.readAll()
  paintEntries()
}

// The log minus voided days and minus the void markers themselves — what every
// total, calendar cell and radar match is computed from.
function activeLog() {
  const log = readLog()
  const voided = new Set(log.filter((e) => e.voids).map((e) => e.voids))
  return log.filter((e) => !e.voids && !voided.has(e.hash))
}

// Walk the chain in seal order. Any mismatch means something was altered after
// the fact — which is the whole reason to keep it this way.
async function verifyChain(log) {
  const chron = [...log].sort((a, b) => a.loggedAt.localeCompare(b.loggedAt))
  let prev = 'genesis'
  for (const e of chron) {
    const { hash, ...body } = e
    if (body.prev !== prev) return { ok: false, at: e.date }
    if ((await sha256(prev + JSON.stringify(body))) !== hash) return { ok: false, at: e.date }
    prev = hash
  }
  return { ok: true, count: chron.length }
}

/* ============================ log view ============================ */

let total = 8, dayType = 'weekday', recog = null
// Whichever dictation path is live, save() kills it. Otherwise the mic keeps
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

  rows.push({ id: 'laborer', label: 'Laborer', rate: base, sub: `County scale · ${county}` })
  if (laborer?.foreman) {
    rows.push({ id: 'foreman', label: 'Foreman', rate: laborer.foreman, sub: 'County scale' })
  }

  const prem = { ...(CONTRACT?.premiums?.building ?? {}), ...(CONTRACT?.premiums?.heavyHighway ?? {}) }
  for (const [name, add] of Object.entries(prem)) {
    if (!add) continue
    rows.push({
      id: `p:${name}`, label: name, rate: Number((base + add).toFixed(3)),
      sub: `Scale + $${add.toFixed(2)} · ${CONTRACT.premiums.cite}`,
    })
  }

  for (const r of sched) {
    if (/^LABORER$/i.test(r.title)) continue
    rows.push({ id: `s:${r.title}`, label: titleCase(r.title), rate: r.base, sub: `County scale · ${county}` })
  }
  return rows.sort((a, b) => b.rate - a.rate)
}

const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
  .replace(/\bAbt\b/, 'Abatement').replace(/\bGen\b/, 'General').replace(/\bIi\b/, 'II')

function splitHours(h, type) {
  const rule = CONTRACT?.overtime?.[type]
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
function announce(msg) {
  clearTimeout(sayTimer)
  sayTimer = setTimeout(() => { const el = $('#liveSay'); if (el) el.textContent = msg }, 350)
}

function paintHours() {
  $('#outTotal').value = hrs(total)
  const s = splitHours(total, dayType)
  $('#splitOut').innerHTML = [
    s.st ? `<span>${t('straight')} <b>${hrs(s.st)}</b></span>` : '',
    s.ot ? `<span class="x-ot">${t('timeHalf')} <b>${hrs(s.ot)}</b></span>` : '',
    s.dt ? `<span class="x-dt">${t('double')} <b>${hrs(s.dt)}</b></span>` : '',
  ].filter(Boolean).join('') || `<span>${t('noHours')}</span>`

  const rate = Number($('#fRate').value) || 0
  const g = grossOf(s, rate)
  $('#grossOut').textContent = g == null ? '—' : usd(g)

  const rule = CONTRACT?.overtime?.[dayType]
  const dayKeyMap = { weekday: 'dayWeekday', saturday: 'daySaturday', sunday: 'daySunday', fourTens: 'dayFourTens' }
  $('#ruleSum').textContent = rule ? t('howPaid', { day: t(dayKeyMap[dayType]).toLowerCase() }) : ''
  $('#ruleLine').innerHTML = rule
    ? `${esc(rule.note)} <cite>${esc(CONTRACT.name.split('—')[0].trim())} ${esc(rule.cite)}</cite>`
    : ''

  paintShort()

  const parts = [
    t('hoursWorkedSay', { h: hrs(total) }),
    s.ot ? t('otSay', { h: hrs(s.ot) }) : '',
    s.dt ? t('dtSay', { h: hrs(s.dt) }) : '',
    g == null ? '' : usd(g),
  ].filter(Boolean)
  announce(parts.join('. '))
}

/* ---- sheet: one big readable list instead of a native dropdown ---- */

function openSheet(title, rows, onPick) {
  $('#sheetTitle').textContent = title
  $('#sheetBody').innerHTML = rows.map((r, i) => `<button class="sheet-row${r.on ? ' on' : ''}${r.danger ? ' danger' : ''}" data-i="${i}" type="button">
    ${r.swatch ? `<span class="swatch" style="background:${r.swatch}"></span>` : ''}
    <span>${esc(r.label)}${r.sub ? `<span class="sub">${esc(r.sub)}</span>` : ''}</span>
  </button>`).join('')
  $('#sheet').hidden = false
  document.body.style.overflow = 'hidden'
  $$('#sheetBody .sheet-row').forEach((b) => b.addEventListener('click', () => {
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
             ${f.required ? 'required' : ''} ${f.type === 'text' ? 'autocomplete="off"' : ''}>
      ${f.hint ? `<small>${esc(f.hint)}</small>` : ''}
    </label>`).join('')}
    <button type="submit" class="primary">${t('saveWord')}</button>
  </form>`
  $('#sheet').hidden = false
  document.body.style.overflow = 'hidden'
  $('#sheetForm').addEventListener('submit', (e) => {
    e.preventDefault()
    const vals = Object.fromEntries(new FormData(e.target))
    closeSheet()
    onSubmit(vals)
  })
}

function closeSheet() { $('#sheet').hidden = true; document.body.style.overflow = '' }

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

async function initLog() {
  await initStorage()
  $('#fDate').value = new Date().toISOString().slice(0, 10)
  $('#todayLabel').textContent = new Date().toLocaleDateString(LOC(),
    { weekday: 'long', month: 'long', day: 'numeric' })

  // Your rate barely changes. Ask once, remember it, let it be corrected.
  const lastRate = localStorage.getItem(RATE_KEY)
  if (lastRate) $('#fRate').value = lastRate
  $('#fRate').addEventListener('input', paintHours)

  const today = new Date().getDay()
  if (today === 6) dayType = 'saturday'
  if (today === 0) dayType = 'sunday'
  $$('.daytype button').forEach((b) => {
    b.classList.toggle('on', b.dataset.day === dayType)
    b.addEventListener('click', () => {
      const was = dayType
      dayType = b.dataset.day
      $$('.daytype button').forEach((x) => x.classList.toggle('on', x === b))
      // A four-10s day is ten hours. Making someone tap + four times to say the
      // obvious thing is how an app earns a reputation for being annoying.
      const normal = { weekday: 8, saturday: 8, sunday: 8, fourTens: 10 }
      if (total === normal[was]) total = normal[dayType]
      paintHours(); navigator.vibrate?.(8)
    })
  })

  $$('#hMinus, #hPlus').forEach((b) => b.addEventListener('click', () => {
    total = Math.max(0, Math.min(24, total + Number(b.dataset.step)))
    paintHours(); navigator.vibrate?.(8)
  }))

  paintHours()
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
  $('#btnSettings').addEventListener('click', openSettings)

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
  $('#btnPunchOut').addEventListener('click', () => { navigator.vibrate?.(10); punchOutFlow(new Date().toISOString()) })
  clearInterval(punchTimer)
  if (PUNCH) punchTimer = setInterval(paintPunch, 1000)
  paintPunch()
  punchForgotCheck()

  $('#calPrev').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() - 1); paintCalendar() })
  $('#calNext').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() + 1); paintCalendar() })
  initMic()
  paintNotices()
  await loadCerts()
  syncNativeCertAlerts()
  $('#btnAddCert').addEventListener('click', addCertFlow)
  paintCerts()
  paintEntries()
}

function paintFlags(flags) {
  const strip = $('#flagStrip')
  strip.hidden = !flags.length
  strip.innerHTML = flags.map((f) => `<span class="chip">${esc(f.label)}</span>`).join('')
}

function initMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  const btn = $('#btnMic')
  if (!SR) {
    if (!NATIVE) { btn.classList.add('gone'); return }
    // iOS shell: dictation runs on-device through SFSpeechRecognizer and the
    // partials stream back through __nativeDictation.
    let live = false, base = ''
    stopMic = () => {
      if (!live) return
      nativePost({ type: 'dictateStop' })
      live = false
      btn.classList.remove('live')
      $('.mic-text', btn).textContent = t('micIdle')
    }
    window.__nativeDictation = (text, isFinal) => {
      $('#fNote').value = base + text
      paintFlags(detectFlags($('#fNote').value))
      if (isFinal && live) {
        live = false
        btn.classList.remove('live')
        $('.mic-text', btn).textContent = t('micIdle')
      }
    }
    // iOS asks for microphone and speech permission the first time only —
    // if the prompt returns every time, the audio session was never released,
    // so the shell now tears it down on stop and reuses the granted status.
    btn.addEventListener('click', () => {
      if (live) {
        nativePost({ type: 'dictateStop' })
        live = false
        btn.classList.remove('live')
        $('.mic-text', btn).textContent = t('micIdle')
        return
      }
      base = $('#fNote').value ? $('#fNote').value.trim() + ' ' : ''
      live = true
      btn.classList.add('live')
      $('.mic-text', btn).textContent = t('micLive')
      nativePost({ type: 'dictateStart', lang: LANG })
    })
    return
  }

  recog = new SR()
  recog.continuous = true
  recog.interimResults = true
  recog.lang = LOC()

  let base = ''
  btn.addEventListener('click', () => {
    if (btn.classList.contains('live')) { recog.stop(); return }
    base = $('#fNote').value ? $('#fNote').value.trim() + ' ' : ''
    try { recog.start() } catch {}
  })
  stopMic = () => { try { recog.stop() } catch { /* not running */ } }
  recog.onstart = () => { btn.classList.add('live'); $('.mic-text', btn).textContent = t('micLive') }
  recog.onend = () => { btn.classList.remove('live'); $('.mic-text', btn).textContent = t('micIdle') }
  recog.onerror = () => { btn.classList.remove('live'); $('.mic-text', btn).textContent = t('micErr') }
  recog.onresult = (ev) => {
    let out = ''
    for (let i = 0; i < ev.results.length; i++) out += ev.results[i][0].transcript
    $('#fNote').value = base + out
    paintFlags(detectFlags(base + out))
  }
}

async function save() {
  const btn = $('#btnSave')
  if (total <= 0) { $('#saveHint').textContent = t('addHoursFirst'); return }

  const s = splitHours(total, dayType)
  const rate = Number($('#fRate').value) || 0
  if (rate > 0) localStorage.setItem(RATE_KEY, String(rate))

  await appendEntry({
    date: $('#fDate').value,
    contractor: $('#fContractor').value.trim(),
    dayType,
    st: s.st, ot: s.ot, dt: s.dt,
    rate: rate || null,
    gross: grossOf(s, rate),
    note: $('#fNote').value.trim(),
    punch: punchMeta,
    shortDay: shortReason && shortReason.id !== 'mine'
      ? { reason: shortReason.id, cite: shortReason.cite, claim: shortReason.owed(total) > 0 }
      : null,
  })
  punchMeta = null
  shortReason = null
  $('#punchSummary').hidden = true

  btn.textContent = t('sealedDone')
  btn.classList.add('done')
  navigator.vibrate?.([12, 40, 12])
  setTimeout(() => { btn.textContent = t('logIt'); btn.classList.remove('done') }, 1600)

  stopMic()
  $('#fNote').value = ''
  total = 8; paintHours(); paintFlags([])
  $('#saveHint').textContent = t('sealedHint')
  paintEntries()
}

function paintEntries() {
  const log = readLog()
  const py = planYearOf()
  const [from, to] = planYearRange(py)
  const inYear = activeLog().filter((e) => { const d = new Date(e.date + 'T12:00:00'); return d >= from && d <= to })
  const banked = inYear.reduce((s, e) => s + e.st + e.ot + (e.dt ?? 0), 0)
  const earned = inYear.reduce((s, e) => s + (e.gross ?? 0), 0)

  $('#bankedHours').textContent = hrs(banked)
  $('#bankedSub').innerHTML = t('bankedSub', { a: py, b: py + 1 }) +
    (earned ? ` · <b>${usd(earned)}</b> ${t('gross')}` : '')

  // 100 hours is the break-in-service floor written into the Fox Valley plan.
  // Below it, a plan year doesn't count.
  $('#meterFill').style.width = Math.min(100, (banked / 1500) * 100) + '%'
  $('#meterNote').innerHTML = (banked < 100
    ? t('meterUnder', { n: hrs(100 - banked) })
    : t('meterOver', { d: inYear.length, s: inYear.length === 1 ? '' : 's' }))
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
    const d = new Date(e.date + 'T12:00:00')
    return `<div class="log-day">
      <div class="log-when">
        <div class="d">${d.getDate()}</div>
        <div class="m">${d.toLocaleDateString(LOC(), { month: 'short' })}</div>
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
        ${e.flags?.length ? `<div class="flags">${e.flags.map((f) => `<span class="chip">${esc(f.label)}</span>`).join('')}</div>` : ''}
        <div class="log-meta">${e.punch ? `${fmtClock(e.punch.inAt)}–${fmtClock(e.punch.outAt)} · ` : ''}${t('sealedAt')} ${new Date(e.loggedAt).toLocaleString(LOC())} · ${e.hash.slice(0, 12)}</div>
      </div>
      <button type="button" class="log-x" data-void="${e.hash}" aria-label="${t('voidTitle')}">&times;</button>
    </div>`
  }).join('')

  $$('#entryList [data-void]').forEach((b) => b.addEventListener('click', () => {
    const e = readLog().find((x) => x.hash === b.dataset.void)
    if (!e) return
    openSheet(t('voidTitle'), [{
      label: `${e.date} · ${e.contractor || t('noContractor')} · ${hrs(e.st + e.ot + (e.dt ?? 0))}h`,
      sub: t('voidSub'),
    }], () => voidEntry(e.hash))
  }))
}

/* ============================ short day ============================ */
// A laborer who gets rained out at 10 a.m. is owed more than the hours on his
// watch, and the ladder that says how much is buried in Article 39 of a book
// almost nobody carries. Every day under 8 hours asks one question, then states
// the floor with the citation attached. It never changes the number by itself —
// it offers, and the member decides. Wrong hours in a sealed log are worse than
// no log.
const SHORT_REASONS = [
  { id: 'rain',   k: 'shortRain',   sub: 'shortRainSub',   note: 'shortNoteRain',   cite: 'Art. 39 \u00b64',
    owed: (h) => (h < 4 ? 4 : h < 6 ? 6 : h < 8 ? 8 : 0) },
  { id: 'sent',   k: 'shortSent',   sub: 'shortSentSub',   note: 'shortNoteSent',   cite: 'Art. 39 \u00b61',
    owed: () => 4 },
  { id: 'nowork', k: 'shortNoWork', sub: 'shortNoWorkSub', note: 'shortNoteNoWork', cite: 'Art. 39 \u00b64',
    owed: (h) => (h > 4 ? 8 : 4) },
  { id: 'wait',   k: 'shortWait',   sub: 'shortWaitSub',   note: 'shortNoteWait',   cite: 'Art. 39 \u00b62',
    // Past four hours, waiting time is paid in whole-hour multiples.
    owed: (h) => Math.max(4, Math.ceil(h)) },
  { id: 'mine',   k: 'shortMine',   sub: 'shortMineSub',   note: null,              cite: null,
    owed: () => 0 },
]

let shortReason = null

function paintShort() {
  const box = $('#shortBox')
  if (!box) return
  if (total >= 8) { box.hidden = true; shortReason = null; return }
  box.hidden = false

  if (!shortReason) {
    box.innerHTML = `<p class="sd-lead">${t('shortLead', { h: hrs(total) })}</p>
      <button type="button" class="sd-ask" id="sdAsk">${esc(t('shortAsk'))}</button>`
    $('#sdAsk').addEventListener('click', askShort)
    return
  }

  const owed = shortReason.owed(total)
  const claim = owed > total
  box.innerHTML = `<div class="sd-owed">${claim
      ? t('shortOwed', { n: hrs(owed) })
      : esc(t('shortNone'))}
      ${shortReason.cite && claim ? `<i class="sd-cite">${esc(t(shortReason.k))} \u00b7 ${esc(shortReason.cite)}</i>` : ''}
    </div>
    <div class="sd-row">
      ${claim ? `<button type="button" class="sd-use" id="sdUse">${esc(t('shortUse', { n: hrs(owed) }))}</button>` : ''}
      <button type="button" class="sd-redo" id="sdRedo">${esc(t('shortAsk'))}</button>
    </div>`
  $('#sdRedo').addEventListener('click', askShort)
  const use = $('#sdUse')
  if (use) use.addEventListener('click', () => {
    // The note keeps saying what actually happened; the hours become what the
    // agreement pays. Both belong in the record — a payroll clerk arguing the
    // number can be shown the reason.
    total = owed
    navigator.vibrate?.(8)
    paintHours()
  })
}

function askShort() {
  openSheet(t('shortQ'), SHORT_REASONS.map((r) => ({
    act: r.id, label: t(r.k), sub: t(r.sub), on: shortReason?.id === r.id,
  })), (pick) => {
    shortReason = SHORT_REASONS.find((r) => r.id === pick.act) ?? null
    if (shortReason?.note) {
      const n = $('#fNote')
      const line = t(shortReason.note, { h: hrs(total) })
      if (!n.value.includes(line)) n.value = (n.value ? n.value.trim() + ' ' : '') + line
    }
    paintShort()
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

const fmtClock = (iso) => new Date(iso).toLocaleTimeString(LOC(), { hour: 'numeric', minute: '2-digit' })

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
    // full shift, and the short-day check below handles the rest.
    let hours = lunchWorked ? (span >= 8 ? Math.max(span, 8.5) : span) : span - 0.5
    if (hours < 0.5) hours = 0.5
    const rounded = Math.min(24, Math.round(hours * 2) / 2)

    total = rounded
    $('#fDate').value = inAt.slice(0, 10)
    if (lunchWorked) {
      const n = $('#fNote')
      n.value = (n.value ? n.value.trim() + ' ' : '') + t('lunchNote')
      paintFlags(detectFlags(n.value))
    }
    punchMeta = { inAt, outAt: outISO, exact: +hours.toFixed(2), lunchWorked }
    paintHours()
    if (rounded < 8) askShort()
    const sum = $('#punchSummary')
    sum.hidden = false
    announce(t('punchedOutSay', { h: hrs(rounded) }))
    sum.innerHTML = t('punchPrefill', { a: fmtClock(inAt), b: fmtClock(outISO), exact: hours.toFixed(1), rounded: hrs(rounded) })
    await setPunch(null)
  })
}

// Sixteen hours on the clock means a missed punch-out, not a 16-hour day.
// Ask instead of logging garbage.
function punchForgotCheck() {
  if (!PUNCH) return
  const h = (Date.now() - new Date(PUNCH.inAt)) / 3.6e6
  if (h < 16) return
  openSheet(t('forgotTitle'), [
    { act: 'enter', label: t('forgotEnter'), sub: t('forgotMsg', { h: Math.round(h) }) },
    { act: 'keep', label: t('forgotKeep') },
  ], (r) => {
    if (r.act !== 'enter') return
    openForm(t('forgotTitle'), [
      { id: 'fin', label: t('finishLabel'), type: 'time', value: '15:30', required: true },
    ], (v) => {
      const day = PUNCH.inAt.slice(0, 10)
      let out = new Date(`${day}T${v.fin}:00`)
      if (out <= new Date(PUNCH.inAt)) out = new Date(+out + 864e5)
      punchOutFlow(out.toISOString())
    })
  })
}

// A month at a glance. Scrolling a list tells you what you did; a grid tells you
// what you didn't — the gaps, the stretch of Saturdays, the week you never got
// called. That's the view worth having when you're arguing about a season.
let calMonth = new Date()
let PAYDAY = null // { weekday, everyOther, anchor } — set by tapping a day

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Everyone's payday is different, so instead of asking, the member taps the day
// they got paid and the app works out the pattern from there.
function isPayday(date) {
  if (!PAYDAY) return false
  if (date.getDay() !== PAYDAY.weekday) return false
  if (!PAYDAY.everyOther) return true
  const anchor = new Date(PAYDAY.anchor + 'T12:00:00')
  const weeks = Math.round((date - anchor) / (7 * 86400000))
  return weeks % 2 === 0
}

function nextPayday(from = new Date()) {
  if (!PAYDAY) return null
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate())
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

function paintCalendar() {
  const log = readLog()
  const y = calMonth.getFullYear(), m = calMonth.getMonth()
  const first = new Date(y, m, 1), days = new Date(y, m + 1, 0).getDate()
  const todayKey = dayKey(new Date())

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
    const iso = dayKey(date)
    const intensity = hit ? Math.min(55, 14 + hit.h * 3.4) : 0
    const pay = isPayday(date)
    cells.push(`<button type="button" class="cal-cell${hit ? ' has' : ''}${hit?.prem ? ' prem' : ''}${iso === todayKey ? ' today' : ''}${pay ? ' pay' : ''}"
      style="--i:${intensity}%" data-iso="${iso}"
      title="${iso}${hit ? ` — ${hrs(hit.h)} hours` : ''}${pay ? ' — payday' : ''}">
      <span class="dn">${d}</span>
      ${hit ? `<span class="dh">${hrs(hit.h)}</span>` : ''}
    </button>`)
  }
  $('#calGrid').innerHTML = cells.join('')
  $$('#calGrid .cal-cell').forEach((c) => c.addEventListener('click', () => askPayday(c.dataset.iso)))

  const next = nextPayday()
  const pd = $('#paydayLine')
  pd.innerHTML = next
    ? t('paydayNext', { d: next.date.toLocaleDateString(LOC(), { weekday: 'long', month: 'short', day: 'numeric' }) }) +
      (next.inDays === 0 ? t('payToday') : next.inDays === 1 ? t('payTomorrow') : t('payDays', { n: next.inDays }))
    : t('paydayTap')

  const worked = [...byDay.values()]
  const tot = worked.reduce((s, x) => s + x.h, 0)
  const gross = worked.reduce((s, x) => s + x.gross, 0)
  $('#calFoot').innerHTML = worked.length
    ? `<span><b>${worked.length}</b> ${t('daysWorked')}</span><span><b>${hrs(tot)}</b> ${t('hoursWord')}</span>` +
      (gross ? `<span><b>${usd(gross)}</b> ${t('gross')}</span>` : '')
    : `<span>${t('nothingThisMonth')}</span>`
}

async function exportLog() {
  const log = readLog()
  if (!log.length) return tell(t('saveBackup'), t('exportNothing'))
  const check = await verifyChain(log)
  const chron = [...log].reverse()
  const tot = chron.reduce((s, e) => s + e.st + e.ot, 0)
  const otTot = chron.reduce((s, e) => s + e.ot, 0)

  const lines = [
    'WORK LOG', '='.repeat(60), '',
    `Entries: ${chron.length}`,
    `Range: ${chron[0].date} to ${chron.at(-1).date}`,
    `Total hours: ${hrs(tot)} (${hrs(otTot)} overtime)`,
    `Chain integrity: ${check.ok ? 'VERIFIED — no entry altered after it was sealed' : `BROKEN at ${check.at}`}`,
    `Exported: ${new Date().toISOString()}`, '',
    'Each entry was sealed on the date shown with a SHA-256 hash committing to the',
    'entry before it. Altering any entry after the fact breaks every hash after it.',
    '', '='.repeat(60), '',
  ]
  const voidedSet = new Set(chron.filter((e) => e.voids).map((e) => e.voids))
  for (const e of chron) {
    if (e.voids) { lines.push(`${e.date}  VOID -> entry ${e.voids.slice(0, 12)}`, `  sealed ${e.loggedAt}`, `  hash ${e.hash}`, `  prev ${e.prev}`, ''); continue }
    lines.push(`${voidedSet.has(e.hash) ? '[VOIDED] ' : ''}${e.date}  ${hrs(e.st)} straight${e.ot ? ` + ${hrs(e.ot)} @1.5x` : ''}${e.dt ? ` + ${hrs(e.dt)} @2x` : ''}` +
      `${e.rate ? `  @ $${e.rate.toFixed(2)}/hr = ${usd(e.gross)}` : ''}   ${e.contractor || '(no contractor)'}`)
    if (e.note) lines.push(`  "${e.note}"`)
    if (e.flags?.length) lines.push(`  FLAGS: ${e.flags.map((f) => f.label).join(', ')}`)
    lines.push(`  sealed ${e.loggedAt} (${e.tz})`)
    lines.push(`  hash ${e.hash}`)
    lines.push(`  prev ${e.prev}`, '')
  }

  const stamp = new Date().toISOString().slice(0, 10)
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
    await store.setMeta('lastBackup', { at: new Date().toISOString(), count: log.length })
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

async function paintBackupState() {
  const bar = $('#backupNag')
  const log = readLog()
  if (!log.length) { bar.hidden = true; return }

  const last = await store.getMeta('lastBackup')
  const since = last ? log.length - last.count : log.length
  const days = last ? Math.floor((Date.now() - new Date(last.at)) / 86400000) : null
  const stale = !last || since >= 20 || days >= 14

  // Dismissed at a given entry count. It comes back once there is meaningfully
  // more at risk than when it was waved off — nagging beats losing a year of
  // hours, but nagging every launch just teaches people to ignore it.
  const snooze = await store.getMeta('nagSnoozedAt')
  const snoozed = snooze != null && log.length < snooze + 20

  bar.hidden = !stale || snoozed
  if (bar.hidden) return

  bar.innerHTML = `<span class="nag-text">${last
    ? t('nagStale', { n: since, entries: t(since === 1 ? 'entryOne' : 'entryMany'), ago: days ? t('nagAgo', { d: days }) : '' })
    : t('nagNone', { n: log.length, entries: t(log.length === 1 ? 'entryOne' : 'entryMany') })
  }</span><button type="button" id="nagGo" class="nag-go">${t('backUp')}</button>
  <button type="button" id="nagX" class="nag-x" aria-label="Dismiss reminder">&times;</button>`
  $('#nagGo').addEventListener('click', exportLog)
  $('#nagX').addEventListener('click', async () => {
    bar.hidden = true
    await store.setMeta('nagSnoozedAt', log.length)
  })
}

async function initStorage() {
  const moved = await loadLog()
  PAYDAY = await store.getMeta('payday') ?? null
  PUNCH = await store.getMeta('punch') ?? null
  const p = await store.requestPersistence()
  const line = $('#storageLine')
  if (line) {
    line.innerHTML = p.persisted
      ? `Saved on this device only. Your phone has marked it protected, so it will not be cleared automatically.`
      : `Saved on this device only. Your phone has <b>not</b> marked it protected, so clearing browsing data would erase it. Keep a backup.`
  }
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
    try {
      const parsed = JSON.parse(await file.text())
      if (!Array.isArray(parsed) || !parsed.every((e) => e.hash && e.date)) throw new Error('not a log file')
      const check = await verifyChain(parsed)
      const entries = t(parsed.length === 1 ? 'entryOne' : 'entryMany')
      const msg = check.ok
        ? t('restoreOk', { n: parsed.length, entries })
        : t('restoreBroken', { n: parsed.length, entries, at: check.at })
      if (await askConfirm(t('restoreBackup'), msg, t('restoreGoOn'), !check.ok)) {
        await store.replaceAll(parsed)
        LOG = await store.readAll()
        paintEntries()
      }
    } catch (err) {
      tell(t('restoreBackup'), t('restoreBad', { err: err.message }))
    }
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
    openSheet(t('whichLocal'), choices.map((l) => ({
      label: l.label, sub: `${l.city ?? ''}${l.members ? ` · ${t('membersSuffix', { n: num(l.members) })}` : ''}`,
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

  body.innerHTML = ''
  body.append(el(`<section class="sec">
    <p class="lede">${t('localLede', { city: esc(L.city ?? ''), n: num(y.members), y: y.year })}</p>
    <div class="stats">
      <div class="card stat"><div class="k">${t('kMembers')}</div><div class="v">${num(y.members)}</div>
        <div class="r">${t('kYearsOnFile', { n: L.years.length })}</div></div>
      <div class="card stat"><div class="k">${t('kDuesIn')}</div><div class="v">${usd(y.receiptsPerMember)}</div>
        <div class="r">${rk(rank('receiptsPerMember'))}</div></div>
      <div class="card stat"><div class="k">${t('kTreasury')}</div><div class="v">${usd(y.assetsPerMember)}</div>
        <div class="r">${rk(rank('assetsPerMember'))}</div></div>
      <div class="card stat"><div class="k">${t('kPayrollShare')}</div><div class="v">${y.payrollShare ?? '—'}%</div>
        <div class="r">${t('kOfSpent')}</div></div>
    </div>
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
    <a class="verify" href="https://olmsapps.dol.gov/olpdr/visualization.jsp?rptId=${y.rptId}"
       target="_blank" rel="noopener">
      <span class="verify-k">${t('checkYourself')}</span>
      <span class="verify-v">${t('dolCharts')}</span>
    </a>
    <p>${t('sourceNote', { id: y.rptId, label: esc(L.label), y: y.year })}</p>
    <p>${t('generatedOn', { d: new Date(INDEX.generated).toLocaleDateString(LOC()) })}</p>
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

// Describe the shape of a career instead of printing a year-over-year percentage.
// A jump from $7,573 to $134,450 is not a 1,675% raise — it is an unpaid officer
// seat becoming a full-time job, and the percentage actively hides that.
function arcOf(h) {
  if (h.length < 2) return t('arcOneYear')
  const chron = [...h].reverse()
  const now = chron.at(-1)
  const PAID = 25000 // below this it is a stipend for showing up to meetings

  const firstPaid = chron.find((r) => r.total >= PAID)
  const volunteerYears = firstPaid ? chron.filter((r) => r.year < firstPaid.year) : chron
  const vMax = Math.max(0, ...volunteerYears.map((r) => r.total))

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
    if (since >= 1 && firstPaid.total > 0) {
      bits.push(t('arcSince', { from: usd(firstPaid.total), to: usd(now.total), n: since, s: since === 1 ? '' : 's' }))
    }
  }
  bits.push(t('arcWeigh'))
  return bits.join(' ')
}

// Pay, with each person's full history one tap away. A single year's salary is
// how people reach confident wrong conclusions; the trend is the real story.
function peopleSection(L, y) {
  const now = L.people.filter((p) => p.year === y.year)
  const top = Math.max(...now.map((p) => p.total), 1)

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
              <div class="p-bar" style="width:${Math.max(3, (p.total / top) * 100)}%"></div>
            </div>
            <div class="p-amt">${usd(p.total)}</div>
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
                  <td class="n">${row.total ? usd(row.total) : '—'}</td>
                </tr>`
              }).join('')}</tbody>
            </table>
            ${h.some((row, i) => {
              const ti = row.roles.map((r) => r.title).filter(Boolean).join(' + ')
              const pt = h[i + 1]?.roles.map((r) => r.title).filter(Boolean).join(' + ')
              return pt && pt !== ti
            }) ? `<p class="p-key"><i></i>${t('turnKey')}</p>` : ''}
            <p class="p-sum">${arcOf(h)}</p>
          </div>
        </details>`
      }).join('')}
    </div>
    <p class="note">${t('payrollTotal', { v: usd(now.reduce((s, p) => s + p.total, 0)), pct: y.payrollShare ?? '—', d: usd(y.disbursements), y: y.year })}</p>
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
function spendSection(L, y) {
  const s = y.spend
  const rows = [
    [t('spRep'), s.representational, t('spRepSub')],
    [t('spBenefits'), s.benefits, t('spBenefitsSub')],
    [t('spGifts'), s.contributions, t('spGiftsSub')],
    [t('spRunning'), s.union_administration, t('spRunningSub')],
    [t('spPerCapita'), s.per_capita_tax, t('spPerCapitaSub')],
    [t('spOverhead'), s.general_overhead, t('spOverheadSub')],
    [t('spPolitics'), s.political, ''],
    [t('spTaxes'), s.direct_taxes, ''],
  ].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])

  const operating = rows.reduce((t, [, v]) => t + v, 0)
  const perActive = y.actives ? Math.round(operating / y.actives) : null

  return el(`<section class="sec">
    <h2>${t('moneyGoes')}</h2>
    <p class="lede">${t('moneyLede', { y: y.year, total: usd(operating), per: usd(perActive), inv: usd(s.investments) })}</p>
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
    <p class="note">${y.actives ? t('moneyNote', { a: num(y.actives), m: num(y.members), r: num(y.retirees) }) : ''}
      ${t('moneyRep', { v: usd(y.representationalPerMember) })}</p>
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
  const rows = [...peers].sort((a, b) => (b.receiptsPerMember ?? 0) - (a.receiptsPerMember ?? 0))
  return el(`<section class="sec">
    <h2>${t('againstCouncil')}</h2>
    <p class="lede">${t('againstLede')}</p>
    <div class="card scroll"><table>
      <thead><tr><th>${t('tLocal')}</th><th class="n">${t('tMembersCol')}</th><th class="n">${t('tInPer')}</th>
        <th class="n">${t('tTreasPer')}</th><th class="n">${t('tTopPaid')}</th><th class="n">${t('tPayroll')}</th></tr></thead>
      <tbody>${rows.map((p) => `<tr class="${p.desig === L.desig ? 'me' : ''}">
        <td>${p.desig}${p.city ? ' · ' + esc(p.city) : ''}</td>
        <td class="n">${num(p.members)}</td>
        <td class="n">${usd(p.receiptsPerMember)}</td>
        <td class="n">${usd(p.assetsPerMember)}</td>
        <td class="n">${usdK(p.topPay)}</td>
        <td class="n">${p.payrollShare == null ? '—' : p.payrollShare + '%'}</td>
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
      <a href="${esc(e.source)}" rel="noopener" target="_blank">Source document →</a>
    </li>`).join('')}</ul></div>
  </section>`)
}

/* ============================ fund view ============================ */

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

  if (fund.topContributors2024?.length) body.append(el(`<section class="sec">
    <h2>${t('whoPaysIn')}</h2>
    <p class="lede">${t('whoPaysLede', { r: (fund.contributionRatePerHour ?? 0).toFixed(2) })}</p>
    <div class="card scroll"><table>
      <thead><tr><th>${t('tContractor')}</th><th class="n">${t('tContributed')}</th></tr></thead>
      <tbody>${fund.topContributors2024.map((c) => `<tr>
        <td>${esc(c.name)}</td><td class="n">${usd(c.amount)}</td></tr>`).join('')}</tbody>
    </table></div>
  </section>`))
}

/* ============================ settings ============================ */

const APP_VERSION = '1.0'

function openSettings() {
  const n = readLog().length
  openSheet(t('settings'), [
    { act: 'skin', label: t('skin'), sub: t('skinSub') },
    { act: 'lang', label: t('language'), sub: t('languageSub') },
    { act: 'backup', label: t('saveBackup'), sub: n ? t('saveBackupSub', { n, entries: t(n === 1 ? 'entryOne' : 'entryMany') }) : t('saveBackupSubNone') },
    { act: 'restore', label: t('restoreBackup'), sub: t('restoreSub') },
    { act: 'notices', label: t('noticesAgain'), sub: t('noticesAgainSub') },
    { act: 'report', label: t('report'), sub: t('reportSub') },
    { act: 'about', label: t('about'), sub: `Ledger ${APP_VERSION}` },
    { act: 'reset', label: t('erase'), sub: t('eraseSub') },
  ], (r) => ({
    skin: pickSkin,
    lang: pickLang,
    backup: exportLog,
    restore: importLog,
    notices: async () => {
      await store.setMeta('noticesSeen', [])
      await paintNotices()
      // notices.json is legitimately empty most of the time — the button still
      // has to answer, or it reads as broken. (It did.)
      const count = await fetch('./data/notices.json').then((r) => r.json()).then((n) => n.length).catch(() => 0)
      tell(t('noticesAgain'), count ? t('noticesBack', { n: count }) : t('noticesEmpty'))
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
  location.href = `mailto:?subject=${subject}&body=${body}`
}

// Two deliberate obstacles: a backup check, and typing a word. A thumb in a
// glove finds a confirm button by accident; it does not type ERASE by accident.
async function resetEverything() {
  const n = readLog().length
  if (!n) { tell(t('erase'), t('eraseNothing')); return }

  const last = await store.getMeta('lastBackup')
  const warn = last
    ? t('eraseLastBackup', { date: new Date(last.at).toLocaleDateString(LOC()), n: last.count, entries: t(last.count === 1 ? 'entryOne' : 'entryMany'), m: n })
    : t('eraseNoBackup')

  const ok = await askConfirm(
    t('erase'),
    t('eraseConfirm', { n, entries: t(n === 1 ? 'entryOne' : 'entryMany'), warn }),
    t('eraseGoOn'), true,
  )
  if (!ok) return

  const word = t('eraseWord')
  if (!(await askWord(t('erase'), t('eraseTypeWord', { word }), word))) {
    tell(t('erase'), t('eraseAborted'))
    return
  }

  await store.replaceAll([])
  LOG = await store.readAll()
  await store.setMeta('lastBackup', null)
  await store.setMeta('nagSnoozedAt', null)
  paintEntries()
  tell(t('erase'), t('eraseDone'))
}

/* ============================ notices ============================ */
// The only part of the app that is somebody talking rather than a record being
// shown, so it is styled and attributed differently on purpose. Dismissals live
// on the device; nobody learns who read what, because there is nowhere to send
// that and no reason to want it.

async function paintNotices() {
  const board = $('#noticeBoard')
  const notices = await fetch('./data/notices.json').then((r) => r.json()).catch(() => [])
  const seen = new Set((await store.getMeta('noticesSeen')) ?? [])
  const live = notices.filter((n) => !seen.has(n.id))
  if (!live.length) { board.innerHTML = ''; return }

  // Minimal markdown: **bold** only. Anything richer invites pasted HTML into a
  // file that renders on every member's phone.
  const fmt = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')

  board.innerHTML = live.map((n) => `<article class="notice">
    <button class="notice-x" type="button" data-seen="${esc(n.id)}" aria-label="Dismiss notice">&times;</button>
    <div class="notice-from">${esc(n.from)} · ${new Date(n.date + 'T12:00:00')
      .toLocaleDateString(LOC(), { month: 'long', day: 'numeric' })}</div>
    <h3>${esc(n.title)}</h3>
    <p>${fmt(n.body)}</p>
    ${n.link ? `<a href="${esc(n.link.url)}" target="_blank" rel="noopener">${esc(n.link.label)} →</a>` : ''}
  </article>`).join('')

  $$('#noticeBoard [data-seen]').forEach((b) => b.addEventListener('click', async () => {
    await store.setMeta('noticesSeen', [...seen, b.dataset.seen])
    paintNotices()
  }))
}

/* ============================ cards ============================ */

let CERTS = []

async function loadCerts() { CERTS = (await store.getMeta('certs')) ?? [] }
async function saveCerts() { await store.setMeta('certs', CERTS); paintCerts(); syncNativeCertAlerts() }

// Hand the shell everything it needs to warn the member at 90/30/7 days —
// rebuilt in full on every change so a deleted card never fires a ghost alert.
function syncNativeCertAlerts() {
  if (!NATIVE || !NOTIFICATIONS_ENABLED) return
  nativePost({
    type: 'syncCertAlerts',
    alerts: CERTS.map((c) => {
      const exp = expiryFor(c)
      return exp ? { id: c.id, label: typeOf(c.type).label, expires: exp } : null
    }).filter(Boolean),
  })
}

function addCertFlow() {
  openSheet(t('certKind'), CERT_TYPES.map((t) => ({ label: t.label, sub: t.note ?? '', id: t.id })),
    (pick) => cardForm(typeOf(pick.id)))
}

// Training centers usually print the expiry right on the card. When they have,
// use theirs — a computed date that disagrees with the card in a member's hand
// is worse than no date at all.
function cardForm(ct) {
  const today = new Date().toISOString().slice(0, 10)
  const period = ct.months >= 12
    ? `${ct.months / 12} ${t(ct.months > 12 ? 'yearManyLong' : 'yearOneLong')}`
    : `${ct.months} ${t('monthsLong')}`
  openForm(t('cardFormTitle', { card: ct.label }), [
    { id: 'issued', label: t('fIssued'), type: 'date', value: today, required: true },
    {
      id: 'expires', label: t('fExpires'), type: 'date',
      hint: ct.months ? t('hintAuto', { p: period }) : t('hintManual'),
      required: !ct.months,
    },
    { id: 'number', label: t('fCardNum'), type: 'text', hint: t('hintCardNum') },
  ], (vals) => {
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

  const rows = sortCerts(CERTS)
  const bad = rows.filter((c) => statusOf(c).state === 'expired').length
  const soon = rows.filter((c) => statusOf(c).state === 'soon').length

  body.innerHTML = `
    ${bad || soon ? `<div class="nag" style="margin-bottom:.9rem"><span class="nag-text">${
      bad ? t('certExpiredN', { n: bad, cardHas: t(bad === 1 ? 'cardHasOne' : 'cardHasMany') }) + ' ' : ''
    }${soon ? t('certSoonN', { lead: bad ? '' : '<b>', n: soon, tail: bad ? '' : '</b>', expire: t(soon === 1 ? 'expireOne' : 'expireMany') }) : ''}
      </span></div>` : ''}
    ${rows.map((c) => {
      const ct = typeOf(c.type), st = statusOf(c), exp = expiryFor(c)
      const stLabel = st.state === 'none' ? t('noExpiry')
        : st.state === 'expired' ? (st.days === 0 ? t('expToday') : t('expiredAgo', { n: Math.abs(st.days) }))
        : st.days <= 90 ? t('daysLeft', { n: st.days })
        : Math.round(st.days / 30.4) >= 12 ? t('yearsLeft', { n: (st.days / 365).toFixed(1) })
        : t('monthsLeft', { n: Math.round(st.days / 30.4) })
      return `<div class="cert ${st.state}">
        <div class="cert-main">
          <div class="cert-name">${esc(ct.label)}</div>
          <div class="cert-meta">${t('issued')} ${esc(c.issued)}${
            c.expires ? ` · ${t('fromCard')}` : ct.months ? ` · ${t('renewsEvery', { p: ct.months >= 12 ? `${ct.months / 12} ${t('yr')}` : `${ct.months} ${t('mo')}` })}` : ''}</div>
          ${c.number ? `<div class="cert-num">${esc(c.number)}</div>` : ''}
        </div>
        <div class="cert-status">
          <div class="cert-days">${esc(stLabel)}</div>
          <div class="cert-exp">${exp ? esc(exp) : '—'}</div>
        </div>
        <button class="cert-del" type="button" data-del="${c.id}" aria-label="Remove card">&times;</button>
      </div>
      ${ct.note ? `<p class="cert-note">${esc(ct.note)}</p>` : ''}`
    }).join('')}
    <p class="note">${t('certNote')}</p>`

  $$('#certBody [data-del]').forEach((b) => b.addEventListener('click', () => {
    CERTS = CERTS.filter((c) => c.id !== b.dataset.del)
    saveCerts()
  }))
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
  nag.innerHTML = `<span class="nag-text">${t('radarBanner', { fund: esc(m.plaintiff), c: esc(m.matched), d: fmtFiled(m.dateFiled) })}
      ${fresh.length > 1 ? t('andMore', { n: fresh.length - 1 }) : ''}</span>
    <button type="button" class="nag-go" id="radarGo">${t('seeRadar')}</button>
    <button type="button" class="nag-x" id="radarX" aria-label="Dismiss">&times;</button>`
  if (NATIVE && NOTIFICATIONS_ENABLED) {
    const notified = new Set((await store.getMeta('radarNotified')) ?? [])
    const unseen = fresh.filter((m) => !notified.has(m.docketNumber))
    if (unseen.length) {
      nativePost({
        type: 'radarAlert',
        title: t('radarKicker'),
        body: `${unseen[0].plaintiff} v. ${unseen[0].matched}`,
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

function paintRadar() {
  const body = $('#radarBody')
  if (!RADAR?.events) {
    body.innerHTML = `<p class="loading">${t('radarNotLoaded')}</p>`
    return
  }
  const matches = radarMatches()
  const hasLog = readLog().some((e) => e.contractor)

  body.innerHTML = `
    <p class="lede">${t('radarLede')}</p>

    ${matches.length ? matches.map((m) => `<article class="radar-hit">
      <div class="rh-k">${t('radarKicker')}</div>
      <h3>${esc(m.plaintiff)} v. ${esc(m.defendant)}</h3>
      <p>${t('filed')} <b>${fmtFiled(m.dateFiled)}</b> · ${t('docketWord')} ${esc(m.docketNumber ?? '—')} · ${esc(m.court)}.
        ${t('youLogged')} <b>${esc(m.matched)}</b>.</p>
      <p>${t('whatToDo')}</p>
      ${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener">${t('viewDocket')}</a>` : ''}
    </article>`).join('')
    : `<div class="card pad" style="margin-bottom:1rem"><p class="note" style="margin:0">
        ${hasLog
          ? t('radarNoMatch', { n: RADAR.events.length, m: Math.round((RADAR.lookbackDays ?? 365) / 30) })
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
          .map((g) => `<div class="radar-fund"><span>${esc(g.name)}</span>
              <span class="rf-n">${g.events.length === 1 ? t('suitOne') : t('suitsN', { n: g.events.length })}</span></div>
            ${g.events.map((e) => `<div class="radar-row">
              <span class="rr-date">${esc(e.dateFiled ?? '—')}</span>
              <span class="rr-body"><span class="rr-def">${esc(e.defendant)}</span></span>
              ${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${t('docketLink')}</a>` : ''}
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
  if (go === 'certs') paintCerts()
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
  .then(() => bootLog)
  .then(() => paintRadarBanner())
  .catch(() => {})
  .then(() => SPLASH_MIN)
  .then(hideSplash)
