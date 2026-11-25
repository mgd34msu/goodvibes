# Known limitations

This document tracks intentional gaps and current constraints so they are not
mistaken for hidden contracts.

## Chat

- Chat sessions are daemon-owned. Browser local storage is only a cache for the
  active/recent session list while daemon state loads.
- An edited message or a regenerated reply keeps every version: the turn shows
  "‹ 2 of 3 ›", and Previous and Next put that version on the conversation in
  the daemon (`companion.chat.branches.switch`), so it is what every device
  shows, what is still shown after leaving the chat and coming back, and what
  the model continues from. Versions are switched one turn at a time; there is
  no tree of every version and no side-by-side comparison of two.
- Attachments upload as daemon artifacts before send; large outputs open in the
  artifacts slide-over, and the chat header's Files button lists every file
  attached to or made in the chat. A file can be taken off in the composer
  before sending, or removed from a sent message with the × on its row: after
  one confirm (it cannot be put back) the file is deleted from the daemon, the
  message shows "<name> was removed" in its place, and the model no longer
  gets the file. A file cannot be removed while a reply is being written or
  sends are queued; stop the reply or let it finish first.

## Voice

- Dictation and spoken replies depend on the daemon's configured speech
  providers. With no speech-to-text provider configured, the dictation
  control explains what to add rather than recording, and, where the browser
  has its own speech recognition and the page is on HTTPS, offers to dictate
  with the browser's speech service instead, saying first that it sends the
  audio to the browser's maker. The daemon's managed local engines
  (`voice.local.install`) count as a configured provider once installed.
- Wake-word detection runs inside the tab, but it still needs the daemon: the
  models are provisioned on and served by the daemon, and the confirmed
  utterance is transcribed over the daemon's speech-to-text.
- A browser tab cannot retain wake audio clips (no filesystem) or play a
  custom activation-sound file from a local path; both downgrade with a
  stated limitation rather than failing silently.
- Spoken replies are batched synthesis over the wire, not a realtime duplex
  voice conversation.

## Calendar, Mail, and Dates

- The Calendar view shows what the daemon's calendar reads: a CalDAV server
  when one is set, otherwise the machine's one Google connection (the account
  connected with the Agent's `/calendar connect google`, `/google connect` or
  the model's `google` tool; they are the same connection), and beside either
  a Microsoft Outlook account connected with the Agent's `/calendar connect
  outlook` (the same connection the Agent's `/calendar` uses). Outlook's
  calendars are listed as "<name> (Outlook)" in the calendar choice; with no
  calendar chosen the view shows the events of both. An `.ics` import into an
  Outlook calendar is refused: import it in Outlook. With nothing usable the
  daemon's answer names the accounts that exist and why none can be read, and
  a daemon build with no calendar handler at all says the capability is
  missing. The CalDAV keys:

  | Config key | Holds |
  | --- | --- |
  | `surfaces.calendar.caldavUrl` | The CalDAV endpoint URL |
  | `surfaces.calendar.caldavUser` | The CalDAV account username |
  | `surfaces.calendar.caldavPassword` | The CalDAV account password (secret, write-only in settings) |

- Mail and Dates render what the daemon's `email.*` and `occasions.*` verbs
  return. Daemon builds that have not wired those handlers get a stated
  not-available reading; the browser holds no mail credential and computes no
  occasion rules of its own.

## Install and push

- Install (add to home screen) and Web Push require a secure (HTTPS) context.
  On a plain-HTTP LAN address the app says so and points at serving over HTTPS
  (for example `tailscale serve`). On iOS, push works only for the installed
  app, and the app says that too.
- On a plain-HTTP network address the browser also keeps the clipboard API
  from the page. Copy buttons copy another way; when the browser refuses that
  too, they select the text and say "Selected: press Ctrl+C (Cmd+C on a Mac) to
  copy it." The microphone (voice input) and the camera scanner need HTTPS too
  and say so.
- "Skip for now" on a setup step (Settings, General), Reduce motion and the
  code-wrap choice are kept in this browser only.

## Knowledge/Wiki

- The WebUI uses regular Knowledge/Wiki routes only. Home Assistant Home Graph
  remains a separate daemon extension surface and should not be mixed into this
  page.
- Projection and ingest affordances depend on the declared engine exports and
  methods available on the selected daemon.
- If regular Knowledge results contain Home Graph records by default, that is an
  platform/daemon scoping issue. WebUI should report exact endpoints and ids rather
  than adding client-side filters.

## Providers and models

- Provider/model selection follows daemon runtime semantics. Runtime provider
  ids can differ from catalog prefixes, so UI labels should not be treated as
  route payloads without normalization.
- The model dropdown is scoped to the selected provider. Missing models usually
  mean provider discovery or daemon model catalog data needs inspection.

## Network and deployment

- The development server is Vite on the TUI-resolved WebUI binding, normally
  port `3423`. The daemon/control-plane remains on `3421`. For production use
  the daemon serves the built bundle same-origin (see
  [deployment.md](deployment.md)).
- Network binding is intended for local-network/tailnet operator use. Public
  internet exposure needs an explicit deployment design with TLS, auth, and
  host policy.

## Sessions and realtime

- The daemon sends the session list a page at a time; Work's "Show older
  sessions" adds the next older page below the ones already shown, and the
  button goes away once the oldest session is on screen. Chat's history search
  looks in two places at once: session titles over the full history
  (`sessions.search`) and the text of messages (`chat.messages.search`).
- The lists that have no event of their own (mail, calendar, occasions,
  memory and its review queue and consolidation receipts, checkpoints and
  session changes, CI watches, check-ins, who is who and channel profiles,
  paired devices, Tailscale, local voice, the delegated Telegram intake) follow
  the daemon's LIST_CHANGED event, so a change made from another program,
  device or the daemon itself shows with no click; session changes follow the
  checkpoints list, and the Telegram intake also follows the owner-inbox event.
  A native request (New, Ask for work to be done) follows
  NATIVE_REQUEST_CHANGED.
- Where an event can be missed (the connection was down), each of those lists
  is also read again when its view opens, when the window or tab regains focus
  and when the connection comes back, keeping what is on screen until the new
  answer arrives; several say when they were last read ("Read 2 min ago ·
  Refresh"; a CI watch says "status from 5m ago" beside Check now).
- Session gate presets and context usage answer for the daemon's own runtime
  session and every session it hosts (a web chat runs under the daemon-wide
  mode). A session another program runs (the terminal app's or the Agent's own
  conversation), or an active channel session the daemon keeps no context
  figure for, shows an honest unavailable state.

## Screenshots

- Documentation screenshots show a sample daemon with sample data: they show the
  layout, not a real account, provider catalog or chat history.

## Native work and verification

- Native requests use daemon-owned Jev admission and execution. Held or rejected
  readings do not become human approval requests or manual winner selection.
- Legacy approval and attempt-comparison records remain separate compatibility
  views. Their controls do not authorize native work.
