# Known limitations

This document tracks intentional gaps and current constraints so they are not
mistaken for hidden contracts.

## Chat

- Chat sessions are daemon-owned. Browser local storage is only a cache for the
  active/recent session list while daemon state loads.
- Edit-with-branching keeps superseded turns viewable, but branches are linear
  alternatives on one conversation. There is no tree browser across branches.
- Attachments upload as daemon artifacts before send; large outputs open in the
  artifacts slide-over. There is no dedicated attachment-management panel.

## Voice

- Dictation and spoken replies depend on the daemon's configured speech
  providers. With no speech-to-text provider configured, the dictation
  control explains what to add rather than recording; there is no in-browser
  transcription fallback. The daemon's managed local engines
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
  the model's `google` tool; they are the same connection). A Microsoft
  account connected with `/calendar connect outlook` is read by the Agent's
  `/calendar` only, not by the daemon's calendar. With nothing usable the
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
  sessions" loads the next page, back to the first. Chat's history search
  looks in two places at once: session titles over the full history
  (`sessions.search`) and the text of messages (`chat.messages.search`).
- Several verb families emit no wire event yet (fleet workstream rows,
  checkpoints, CI watches, check-in, principals, memory, local-voice status).
  Their freshness comes from mutation-driven invalidation, polling, and
  manual refresh, not realtime push.
- Session gate presets and context usage answer only for the session that is the
  daemon's own live local runtime; other sessions show an honest unavailable
  state.

## Route shims

- Hand-written per-route shims stay retired. The method-to-route table is
  generated from `@goodvibes/engine/contracts/generated/webui-facade`,
  and a drift test pins the derived table against it so a hand-written row
  can never shadow a generated one. Method types remain contract-derived
  (`src/lib/contract-bridge-types.ts`).

## Screenshots

- Documentation screenshots are captured against the end-to-end suite's seeded
  mock daemon. They prove layout, not authenticated daemon data, provider
  catalog content, or operator chat history.

## Native work and verification

- Native requests use daemon-owned Jev admission and execution. Held or rejected
  readings do not become human approval requests or manual winner selection.
- Legacy approval and attempt-comparison records remain separate compatibility
  views. Their controls do not authorize native work.
- Unit and synthetic browser tests exercise bounded behavior with fixtures.
  Connected-daemon tests and genuine provider calibration require separate
  receipts. The connected-browser smoke covers status, configuration and session
  lifecycle without model calls; it does not establish chat, account or relay parity.
