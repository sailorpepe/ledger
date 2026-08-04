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

// Renewal periods in months. Where an agency sets no expiry but general
// contractors demand a refresh anyway, that's noted — the card is technically
// valid and you still won't get on the job without it.
export const CERT_TYPES = [
  { id: 'osha10', label: 'OSHA 10', months: 60, note: 'No federal expiry. Most general contractors want a refresh every 5 years.' },
  { id: 'osha30', label: 'OSHA 30', months: 60, note: 'No federal expiry. Most general contractors want a refresh every 5 years.' },
  { id: 'hazwoper40', label: 'HAZWOPER 40-hour', months: 12, note: 'Requires an 8-hour refresher every year to stay current.' },
  { id: 'hazwoper8', label: 'HAZWOPER 8-hour refresher', months: 12 },
  { id: 'asbestos', label: 'Asbestos abatement', months: 12, note: 'Annual refresher required by law. Illinois licenses this separately.' },
  { id: 'lead', label: 'Lead abatement', months: 12, note: 'Annual refresher.' },
  { id: 'silica', label: 'Silica awareness', months: 12 },
  { id: 'confined', label: 'Confined space', months: 12 },
  { id: 'scaffold', label: 'Scaffold / competent person', months: 12, note: 'Retraining required whenever conditions or the scaffold type change.' },
  { id: 'respirator', label: 'Respirator fit test', months: 12, note: 'Required annually, and again after any change in face shape or weight.' },
  { id: 'cpr', label: 'CPR / AED', months: 24 },
  { id: 'firstaid', label: 'First aid', months: 24 },
  { id: 'flagger', label: 'Flagger', months: 24 },
  { id: 'cdlmed', label: 'CDL medical card', months: 24, note: 'Two years is the maximum. An examiner can certify you for less.' },
  { id: 'forklift', label: 'Forklift', months: 36, note: 'Three years, and again after any incident or unsafe operation.' },
  { id: 'mewp', label: 'Aerial lift / MEWP', months: 36, note: 'ANSI A92 calls for retraining every 3 years.' },
  { id: 'rigging', label: 'Rigging / signalperson', months: 60 },
  { id: 'other', label: 'Something else', months: null, note: 'Set the expiry date yourself.' },
]

export const typeOf = (id) => CERT_TYPES.find((t) => t.id === id) ?? CERT_TYPES.at(-1)

const addMonths = (iso, months) => {
  const d = new Date(iso + 'T12:00:00')
  const day = d.getDate()
  d.setMonth(d.getMonth() + months)
  // Rolling 31 Jan forward a month must not silently land in March.
  if (d.getDate() !== day) d.setDate(0)
  return d.toISOString().slice(0, 10)
}

export function expiryFor(cert) {
  if (cert.expires) return cert.expires
  const t = typeOf(cert.type)
  return t.months ? addMonths(cert.issued, t.months) : null
}

// Amber at 90 days is deliberate: most refreshers need scheduling, and a class
// you can't get into for six weeks is not much use with two weeks left.
export function statusOf(cert, now = new Date()) {
  const exp = expiryFor(cert)
  if (!exp) return { state: 'none', label: 'No expiry set', days: null }
  const days = Math.ceil((new Date(exp + 'T12:00:00') - now) / 86400000)
  if (days < 0) return { state: 'expired', label: `Expired ${Math.abs(days)} days ago`, days }
  if (days === 0) return { state: 'expired', label: 'Expires today', days }
  if (days <= 90) return { state: 'soon', label: `${days} days left`, days }
  const months = Math.round(days / 30.4)
  return { state: 'ok', label: months >= 12 ? `${(days / 365).toFixed(1)} years left` : `${months} months left`, days }
}

export const sortCerts = (certs) => [...certs].sort((a, b) => {
  const da = statusOf(a).days, db = statusOf(b).days
  if (da == null) return 1
  if (db == null) return -1
  return da - db
})
