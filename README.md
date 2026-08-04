# Ledger — web version

**The browser build of [Ledger](https://sailorpepe.github.io/ledger/), a free
work log for union construction laborers. Open the link, use the app. Nothing
to install.**

| | |
|---|---|
| **Open it** | https://sailorpepe.github.io/ledger/ |
| **Support** | https://sailorpepe.github.io/ledger-help/ |
| **Privacy** | https://sailorpepe.github.io/ledger-help/privacy.html |
| **Contact** | ledger@the-undesirables.com |

Built by a member of LIUNA Local 582, for the guys he works with.

---

## Why a web version exists

The iPhone app is on the App Store. This is for everyone else — Android, an old
phone, a borrowed one, or a guy who does not want to install anything to try
something a stranger handed him at a picnic.

It is the same app: the same punch clock, the same overtime rules read out of
the collective agreement, the same hash-chained log, the same federal filings.

**Add to Home Screen** puts an icon on the phone that opens it full screen with
no browser chrome. On iPhone: Share → Add to Home Screen. On Android: the menu
→ Add to Home Screen.

## It works with no signal

A service worker caches the app itself on first visit, so it opens in a basement
or a hole with no bars — which is exactly where a day gets logged. Filings and
court data refresh when there is signal and fall back to the last copy when
there is not.

## What the web version cannot do

- **The microphone.** Dictation on the iPhone app runs on-device through Apple's
  speech recognition. A browser has no equivalent that keeps the audio on the
  phone, and sending a laborer's voice to somebody's server to save him typing
  is not a trade worth making. Type the note here.
- **Notifications.** Held back in both builds for now.

Everything else is identical.

## Your data still never leaves your phone

Same as the app: no account, no server, no analytics. What you log is written to
storage in your own browser and stays there. Use **Settings → Back up** and keep
the files somewhere safe — clearing your browser data would erase the log, and
nobody else has a copy.

## About this repository

This is a deployed copy, generated from the private `union-tools` repository by
`tools/deploy-web.sh`. Edits belong upstream, not here.

A web app's code is readable by anyone who opens it — that is true of every web
page ever served, and no amount of minifying changes it. Publishing it here is
just being honest about that.

## Licence

Copyright © 2026 The Undesirables LLC. All rights reserved. Free to use; not
licensed for copying, modification or redistribution.

The public records it reads — U.S. Department of Labor filings, Form 5500
filings, Illinois wage schedules, federal court dockets — belong to nobody.
