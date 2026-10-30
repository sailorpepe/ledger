// Which notices this phone shows.
//
// notices.json is one file for both builds: the iPhone bundle is a copy of the
// web one. A notice can name the builds it is for (platforms: 'web', 'ios';
// none named means both), so the web's "it's on the App Store" never tells a
// member to install the app he is already reading it in.
//
// until is the last day a notice runs, inclusive, by the log's calendar
// (dates.js, Central unless he picked another zone): he reads it through that
// day and it is gone the morning after. The iPhone reads the data compiled
// into its bundle until the next release, so this is what takes an expired
// notice down there; ingest only stops it shipping again.
// A notice whose platforms or until can't be read is not shown, since the one
// thing those fields do is keep a notice off a screen.

import { localDayKey } from './dates.js'

const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)

// list: notices.json as parsed. platform: 'web' or 'ios'. today: the
// YYYY-MM-DD in the log's zone. seen: ids the member has dismissed on this phone.
export function liveNotices(list, { platform, today = localDayKey(), seen = new Set() }) {
  if (!Array.isArray(list)) return []
  return list.filter((n) => n && typeof n === 'object'
    && !seen.has(n.id)
    && (n.platforms == null || (Array.isArray(n.platforms) && n.platforms.includes(platform)))
    && (n.until == null || (isDay(n.until) && n.until >= today)))
}
