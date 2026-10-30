// The head of the printed log.
//
// The .txt backup is the copy a steward or a lawyer reads, in English, beside
// the hours. Its totals count the days that stand: not a voided day, and not
// the void marker that struck it out (a marker carries no hours, and adding
// one in made the total NaN). Double time counts with the rest.
//
// The seal is described as what it is. The entries link to each other in the
// order they were written, and each one carries the time it was sealed by
// this phone's clock. That shows nothing was edited after it was linked; it
// is not a stamp from anyone else, and a day logged late shows a seal time
// after its work date.

const hrs = (n) => Number.isInteger(n) ? String(n) : n.toFixed(1)

// The days that count: every entry but the void markers and the days they
// struck out.
export function standingDays(log) {
  const voided = new Set(log.filter((e) => e.voids).map((e) => e.voids))
  return log.filter((e) => !e.voids && !voided.has(e.hash))
}

// log: every stored entry. check: verifyChain's answer. exportedAt: ISO time.
export function reportHead(log, check, exportedAt) {
  const days = standingDays(log)
  const sum = (pick) => days.reduce((s, e) => s + (Number(pick(e)) || 0), 0)
  const st = sum((e) => e.st), ot = sum((e) => e.ot), dt = sum((e) => e.dt ?? 0)
  const dates = days.map((e) => e.date).filter((d) => typeof d === 'string' && d).sort()
  const undated = days.length - dates.length
  // Two contractors on one Saturday is two entries and one day worked.
  const dayCount = new Set(dates).size + undated
  const chain = check.ok
    ? 'INTACT. Every entry links to the one written before it, in the order written'
    : check.fork
      ? `SPLIT at ${check.at}. Two entries were sealed onto the same earlier one (a double tap or a clock change); every entry still matches its seal`
      : `BROKEN at ${check.at}. An entry no longer matches its seal, or one it links to is missing`
  return [
    'WORK LOG', '='.repeat(60), '',
    `Entries: ${log.length} sealed, ${dayCount} ${dayCount === 1 ? 'day' : 'days'} counted (voided days and void markers are not)`,
    `Range: ${dates.length ? `${dates[0]} to ${dates.at(-1)}` : '-'}${undated ? ` (and ${undated} with no date)` : ''}`,
    `Total hours: ${hrs(st + ot + dt)} (${hrs(st)} straight, ${hrs(ot)} at time and a half, ${hrs(dt)} at double time)`,
    `Chain: ${chain}`,
    `Exported: ${exportedAt}`, '',
    'Each entry shows the time it was sealed, by this phone\'s clock, and a',
    'SHA-256 hash over the entry and the hash of the entry written before it.',
    'Changing an entry afterwards breaks its hash and the link after it. A day',
    'logged late shows its work date and the later time it was sealed.',
    '', '='.repeat(60), '',
  ]
}
