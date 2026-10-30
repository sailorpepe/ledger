// The spoken note, and only ever on the phone.
//
// A note is where a member says who got hurt, which foreman kept the crew late,
// who paid cash. The browser's speech API sends that audio to Google or Apple
// to be typed, so it is never used: not on the web, and not inside the iPhone
// shell either, where WebKit can expose the same API. The only path is the
// shell's own on-device recognizer. Without the shell there is no mic at all,
// which is what the web README promises.
//
// The shell streams the whole transcript so far through
// window.__nativeDictation(text, isFinal) and reports a failed start or a dead
// recognizer through window.__nativeDictationError(code). What those callbacks
// may do to the note is decided here, and the rule is that words already heard
// are never taken back: an empty transcript is never written (a cancelled task
// reports one), a late result never lands on a note the member has started
// editing, and once Log it has cleared the note nothing more goes into it.

// Messages are i18n keys; the page turns them into words. micErr covers a code
// from a newer shell that this page does not know yet.
const ERR_KEYS = { unavailable: 'micErrUnavailable', denied: 'micErrDenied', failed: 'micErrFailed' }

// native: the shell's message handler, or null in a browser.
// start/stop: ask the shell to begin or end recognition.
// readNote/writeNote: the note field. setLive: the button's listening look.
// showMessage: an i18n key to show beside the mic, or null to clear it.
export function createDictation({ native, start, stop, readNote, writeNote, setLive, showMessage }) {
  if (!native) return null

  // One session at a time. stopping means the member tapped stop: the button
  // is idle again, but the recognizer may still hand over its last words.
  let s = null

  function toggle() {
    if (s && !s.stopping) {
      s.stopping = true
      setLive(false)
      stop()
      return
    }
    const typed = readNote().trim()
    s = { base: typed ? typed + ' ' : '', shown: readNote(), stopping: false }
    showMessage(null)
    setLive(true)
    start()
  }

  function onText(text, isFinal) {
    if (!s) return
    const words = typeof text === 'string' ? text : ''
    // After a stop the note is his again, so a late result lands only on a
    // note nobody has touched since.
    if (words.trim() && (!s.stopping || readNote() === s.shown)) {
      writeNote(s.base + words)
      s.shown = readNote()
    }
    if (!isFinal) return
    const ownEnd = !s.stopping
    s = null
    // Recognition ended by itself (a final, a timeout, an error). Tell the
    // shell too, so the mic is never left hot behind an idle button.
    if (ownEnd) { setLive(false); stop() }
  }

  function onError(code) {
    if (!s) return
    const asked = s.stopping
    s = null
    if (!asked) { setLive(false); stop() }
    // A stop he asked for can come back as a failure. That is not news.
    if (asked && code === 'failed') return
    showMessage(ERR_KEYS[code] ?? 'micErr')
  }

  // Log it: silence the mic and forget the session, so nothing said before
  // the save can refill the note it just cleared.
  function end() {
    if (s && !s.stopping) { setLive(false); stop() }
    s = null
    showMessage(null)
  }

  return { toggle, onText, onError, end, isLive: () => !!s && !s.stopping }
}
