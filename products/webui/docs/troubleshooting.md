# Troubleshooting

## The page does not open

The web UI is served by the GoodVibes daemon. If the address does not answer:

- check that GoodVibes is running on that computer (`goodvibes-daemon status`);
- on the same computer, open `http://127.0.0.1:3421/`;
- from a phone or another computer, the daemon must be serving your network
  (Settings, General, Network, or "Yes, serve it to my network" when pairing a
  phone), and both must be on the same network; a firewall must allow the
  daemon's port. A plain `http://` address on your network works; the
  camera-based QR scanner, notifications and the browser's own dictation need
  HTTPS (for example through Tailscale).

## The page shows the sign-in screen

This browser is not signed in to this daemon. On the computer running
GoodVibes, run `goodvibes pair` and scan the code or open its link, or paste
the code under "Other ways to sign in". A refused code says why on the sign-in
screen. See "Auth fails" below for what each sign-in path uses.

## "Can't reach the daemon"

The page lost the daemon. It keeps what is on screen, unsent text included,
and comes back by itself when the daemon answers again; "Retry now" checks at
once.

## A view says "Loading…" for a long time

Work, Library, Personal and Settings load their script the first time each is
opened. On a slow connection that takes a moment once; after that they open at
once. A page older than the daemon's current one reloads itself once when it
fails to load a view.

## Page loads but API calls fail

Check daemon status:

```bash
curl -sS http://127.0.0.1:3421/status
```

If auth is required, sign in from Settings, Account, or use an authenticated request. Confirm the
daemon/control-plane listener:

```bash
ss -ltnp | rg ':3421'
```

When the daemon binds `0.0.0.0` (every interface), open it at `127.0.0.1` or the
machine's own address, never at `0.0.0.0`.

## Auth fails

Expected auth paths:

- username/password through daemon login
- the code from `goodvibes pair`, scanned or opened as its link
- a sign-in code pasted by the user under "Other ways to sign in" and checked
  by the daemon
- on the direct route, the daemon's HttpOnly sign-in cookie (`goodvibes_session`,
  unreadable by the page) and the readable marker beside it (`goodvibes_identity`,
  no credential); over the relay, a bearer held in the page's memory until it reloads

The browser must not read:

- `~/.goodvibes/tui/auth-users.json`
- `~/.goodvibes/tui/auth-bootstrap.txt`
- `operator-tokens.json`

If token auth works but username/password fails, inspect local auth status from
Settings, Account after authenticating with a valid token. Check that the daemon reports the
expected user store and username list.

## The QR scanner will not open

Every way the scanner can fail renders its own titled explanation with a next
step, never a dead control. The named failures:

| Failure | What it means |
| --- | --- |
| Scanning needs a secure (HTTPS) connection | The page is on plain HTTP, so the browser withholds the camera; serve over HTTPS (for example `tailscale serve`) or paste the token instead |
| This browser does not offer camera access | No camera API is exposed to web pages; use another browser or paste the token |
| This page does not have permission to use the camera | Camera permission is blocked for this site; allow it in site settings and retry |
| No camera was found on this device | The browser reported no usable camera |
| The camera is already in use | Another app or tab holds the camera |
| The camera could not be started | The camera exists but failed to open |
| This browser has no QR decoder available | Neither the built-in barcode detector nor the fallback decoder could load |

A scan that decodes but is rejected by the daemon (an expired or malformed
pairing QR) surfaces as a banner on the sign-in screen, never a silent
bounce.

## Wake word never reaches "listening"

Wake detection starts only when all of these hold: the models are provisioned
on the daemon (the setup button in the wake settings shows the download size),
`voice.wake.enabled` is on, and this surface's own opt-in
(`voice.wake.surfaces.webui`) is on. The settings surface renders the
resolver's blockers verbatim, so read the stated reason there first; a missing
speech gate artifact or a refused microphone permission each name themselves.
`voice.wake.models` must include the pinned model; a list of custom ids or an
empty list stops the tab before it asks for the microphone. "Wake detection is
running in another tab" means another tab or window of this browser is the one
listening: close it, or turn wake off there, and this tab starts.
While the surface opt-in is off, the tab deliberately never asks for the
microphone.

## Chat does not show new messages immediately

When you send, the composer clears, your message appears at once and then shows
as sent or failed, and the reply streams in. If messages only appear after the
next send, reload the page (a page older than the daemon's build reloads itself
when nothing would be lost) and check that the daemon is answering
(`goodvibes-daemon status`).

## `SESSION_NOT_FOUND`

This usually means browser local storage contains a stale companion chat session
id. The app should prune stale ids when daemon list/get/message calls return
`SESSION_NOT_FOUND`.

Manual recovery in browser dev tools:

```js
localStorage.removeItem('goodvibes.webui.activeCompanionSessionId')
localStorage.removeItem('goodvibes.webui.companionSessions')
```

Then refresh the page.

## Provider or model is rejected

If the daemon returns "No provider available" or a provider-qualified registry
key error, inspect:

```bash
curl -sS http://127.0.0.1:3421/api/models/current
```

Use authenticated access where required. OpenAI's ChatGPT subscription and API
key are two sign-ins of the one `openai` provider; there is no separate
subscription provider id.

## Attachments fail

A file is uploaded first and then sent with the message. When the upload fails,
or the daemon no longer has the file, the message shows the daemon's error; an
attachment is never dropped silently. Attach the file again.

## Knowledge shows Home Assistant or Home Graph records

Regular Knowledge shows only regular knowledge; Home Graph records belong to the
Home Assistant views. If they appear in Knowledge, note what you opened and the
records shown, and report it: it is a daemon-side scoping fault, not something
to filter in the page.
