// Which Ledger this is, for the About sheet and the Report-a-problem email. A
// bug report is only useful if it names the build the member actually has.
//
// The iPhone shell reads its version out of the app bundle and sets
// window.__LEDGER_VERSION ("1.0.1 (4)") before this page runs. The web has no
// bundle to read, so it names the release its code belongs to. That number
// moves with MARKETING_VERSION in ios/project.yml, and tests/version.test.mjs
// fails if it falls behind.
export const WEB_VERSION = '1.0.1 (web)'

// Anything but a non-empty string is not the shell talking: an element with
// that id also shows up as a window property.
export function appVersion(win = globalThis) {
  const v = win?.__LEDGER_VERSION
  return typeof v === 'string' && v.trim() ? v.trim() : WEB_VERSION
}
