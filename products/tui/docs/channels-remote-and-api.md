# Channels, remote runtime, and API

## Channels

GoodVibes includes a shared channel/runtime layer. Every surface it drives
(the platform's `ChannelSurface` type) is one of the following:

| Surface | What it is |
| --- | --- |
| `tui` | This terminal app itself. |
| `web` | The browser cockpit surface. |
| `slack` | Slack workspace integration. |
| `discord` | Discord surface integration. |
| `ntfy` | ntfy push-notification topics. |
| `webhook` | The generic inbound/outbound webhook surface. |
| `homeassistant` | The Home Assistant daemon surface (see below). |
| `telegram` | Telegram bot integration. |
| `google-chat` | Google Chat surface integration. |
| `signal` | Signal bridge integration. |
| `whatsapp` | WhatsApp surface integration. |
| `telephony` | SMS/voice via Twilio or a bridge. |
| `imessage` | The iMessage bridge surface. |
| `msteams` | Microsoft Teams surface integration. |
| `bluebubbles` | BlueBubbles (an iMessage server) integration. |
| `mattermost` | Mattermost surface integration. |
| `matrix` | Matrix surface integration. |

Every one of those surfaces is driven by the same channel runtime, which owns
inbound adapters, setup and account metadata, doctor hooks, route bindings,
delivery strategy selection, and reply rendering and delivery. That shared
ownership is what keeps a new surface from needing its own copy of routing,
delivery, or reply logic.

A message that arrives while every agent slot (`fleet.maxSize`) is taken is
accepted and queued, not refused: the sender is told it waits, the provider is
answered as delivered so it does not send the message again, and the message
starts, oldest first, as soon as an agent ends. A message still waiting when
the daemon restarts is started after the restart.

## Home Assistant

The Home Assistant surface is configured from `/setup chat-apps` or Settings > Surfaces. The TUI stores the platform config keys and controls auto-start; the platform daemon owns the actual Home Assistant API/tool surface, callback verification, account metadata, and channel actions.

Relevant settings:

| Key | Default | What it does |
| --- | --- | --- |
| `surfaces.homeassistant.enabled` | `false` | Enable the Home Assistant daemon surface |
| `surfaces.homeassistant.instanceUrl` | *(empty)* | Home Assistant base URL, for example `http://homeassistant.local:8123` |
| `surfaces.homeassistant.accessToken` | *(empty)* | Long-lived access token or `goodvibes://` secret URI |
| `surfaces.homeassistant.webhookSecret` | *(empty)* | Shared secret used to verify inbound Home Assistant callbacks |
| `surfaces.homeassistant.defaultConversationId` | `goodvibes` | Default conversation id used for route binding |
| `surfaces.homeassistant.remoteSessionTtlMs` | `1200000` | Idle TTL before the daemon closes a remote conversation session (20 minutes) |
| `surfaces.homeassistant.deviceId` | `goodvibes-daemon` | Stable Home Assistant device identifier for this daemon |
| `surfaces.homeassistant.deviceName` | `GoodVibes Daemon` | Device display name |
| `surfaces.homeassistant.eventType` | `goodvibes_message` | Event type used for daemon-to-Home Assistant deliveries |

The inbound daemon callback path is `/webhook/homeassistant`. Authenticated Home Assistant Assist clients can also use `GET /api/homeassistant/health`, `POST /api/homeassistant/conversation`, `POST /api/homeassistant/conversation/stream`, and `POST /api/homeassistant/conversation/cancel`. These routes are platform-owned isolated remote-chat paths with daemon-owned sessions. Responses report `mode: "remote-chat"` and expose `assistant.text` / `assistant.speechText`; Home Assistant clients should not expect `agentId`. Use a `goodvibes://` secret reference or an environment-backed secret for tokens when possible.

## Shared reply pipeline

The same runtime pipeline renders and delivers progress updates, reasoning updates, tool output, and final replies. That keeps TUI, web, webhook, and channel-native surfaces aligned around the same runtime events.

## Daemon and control plane

The daemon is the backend surface behind everything the TUI and other
clients do. It runs tasks and sessions, holds the control-plane snapshots
and messages that keep every connected surface in sync, and publishes the
method catalog those surfaces read to know what they can call. It streams
events over SSE and WebSocket, and it fronts the product-domain APIs
covered below (knowledge, voice, web search, artifacts, and multimodal). It
also carries channel status and delivery surfaces, and remote peer and
node-host contracts for the distributed runtime described later in this
document.

Key entrypoints include:

| Entrypoint | Serves |
| --- | --- |
| `GET /status` | Daemon liveness and posture |
| `GET /api/control-plane` | The control-plane descriptor |
| `GET /api/control-plane/web` | Redirects to the web app, opened on the approval (`?approval=<id>`) or session (`?session=<id>`) it names, when the daemon serves it (`controlPlane.webui.serve`) or knows where it runs (`web.publicBaseUrl`, or `web.enabled` with `web.host`/`web.port`); otherwise serves the control plane's built-in page |
| `GET /api/control-plane/methods` | The typed method catalog |
| `GET /api/control-plane/events/catalog` | The event catalog |
| `GET /api/control-plane/events` | The SSE event stream |
| `GET /api/control-plane/ws` | The WebSocket transport |
| `POST /task` | Task submission |
| `GET /api/tasks` | The task list |

The control-plane method catalog is the canonical external-client contract. External clients can use it to inspect method metadata, scopes, schemas, and transport information.

## Knowledge, media, and search APIs

The daemon also exposes dedicated product-domain APIs:

| Domain | Covers |
| --- | --- |
| Knowledge | Status, ingest, search, packets, jobs, schedules, projections, GraphQL, and reports |
| Voice | Status, providers, voices, TTS, streaming TTS, STT, and realtime sessions |
| Web search | Providers and queries |
| Artifacts | Artifact records and their content |
| Multimodal | Status, providers, analyze, packet, and writeback |

These surfaces are what make future web clients and companion apps straightforward to build without duplicating runtime logic.

Streaming TTS is exposed at `POST /api/voice/tts/stream` and returns raw binary audio. The existing `POST /api/voice/tts` JSON synthesis route is unchanged.

## Remote runtime

The remote runtime is a distributed peer system. A peer joins through a pair request with challenge verification and receives a scoped peer token, then heartbeats while connected. Work moves through pull, claim, lease, and complete steps, with direct remote invoke alongside, and peers can be disconnected, revoked, or have their tokens rotated. Node hosts additionally expose an inspectable contract describing what they will run.

Work has a bounded life. Queued work with a `timeoutMs` expires that long after it was queued, and work whose lease lapses more than five times expires instead of being requeued again. A heartbeat renews the leases of the work a peer holds, and a peer silent for 90 seconds is listed as disconnected. A settled work item (completed, failed, cancelled or expired) is final: a later report for it is answered `409` with code `REMOTE_WORK_SETTLED` and the stored record. Approving a pair request that was rejected or expired is also `409`, verifying a settled request is `410`, and invoking a revoked peer is `409`; each response names the state it refused from.

Approving a request creates no peer: the peer is created, under the id the approval returned, when the device verifies its challenge, so a request that expires or is rejected leaves nothing behind. Sending work to a peer that holds no access token is refused with `409` and code `REMOTE_PEER_NOT_PAIRED`. A heartbeat is recorded in memory; it is written, audited (`peer-connected`) and published (`remote-peer-heartbeat`) only when the peer comes back after being listed as disconnected or reports changed capabilities, commands, version, client mode or metadata, so heartbeats do not push pairing and token records out of the audit list.

Key remote API paths:

| Path | Purpose |
| --- | --- |
| `POST /api/remote/pair/request` | Start a pairing request |
| `POST /api/remote/pair/verify` | Answer the pairing challenge |
| `POST /api/remote/heartbeat` | Peer liveness heartbeat |
| `POST /api/remote/work/pull` | Pull available work |
| `POST /api/remote/work/{workId}/complete` | Report a work item complete |
| `GET /api/remote/peers` | List paired peers |
| `GET /api/remote/peers/{peerId}` | One paired peer (404 when no peer has that id) |
| `GET /api/remote/work` | List work items |
| `GET /api/remote/node-host/contract` | Inspect a node host's contract |

## High-signal commands

`/remote` inspects, dispatches, and reviews self-hosted remote runners and artifacts. `/remote` alone opens its list of actions; each asks for what it needs, picking runners, pools and artifacts from lists. The actions most work reaches for:

| Command | Does |
| --- | --- |
| `/remote list` | List runners and their state |
| `/remote show [connection]` | Show one connection in detail |
| `/remote capabilities [runner]` | Show what a runner can execute and what holds it there: files, commands, approvals, artifacts, resume, and containment (an external runner is a host process held to its tools and write scope at each permission ask; nothing contains the process itself) |
| `/remote recover [runner]` | Recover a runner's stalled work |
| `/remote dispatch <task> [--template <kind>]` | Dispatch work to a runner |
| `/remote dispatch-pool <pool> <task>` | Dispatch work to a runner pool |
| `/remote export <runner>` | Export a runner's work record |
| `/remote review <artifact>` | Show a produced artifact |
| `/remote import <file>` | Import an exported record |
| `/remote setup`, `/remote setup-export <file>` | Review or export the remote setup |

A dispatched runner is an external agent that runs its own tools, so its tool ceiling is held at the one place this side decides: its permission asks. The runner is told its tools in its prompt, and an ask for a call outside them (a command from a runner without `exec`, an edit from a read-only one; a call of unknown kind counts as a command) is answered with a refusal before you or Jev are asked, and the reason is kept on the runner. A runner given a write scope has an edit outside it, or any command, refused the same way. `/remote contract <runner>` shows the tools and scope it is held to.

## /channels command

`/channels` is one command in both terminal programs; `/channels` alone lists its actions, and a model or script running it bare gets "See your channels". In this app:

| Line | What you get |
|---|---|
| `/channels status` | Each channel the daemon has, on or off, ready or not |
| `/channels setup <channel>` | What a channel needs to be set up (no value shown) |
| `/channels doctor <channel>` | The daemon's checks on a channel and the repairs it offers |
| `/channels test <channel>` | A real test message through the daemon, with the delivered or error outcome (asks first) |
| `/channels accounts` | The channel accounts: configured, linked, signed in |
| `/channels rules [<channel>]` | The daemon's rules for who may reach the assistant on each channel (direct messages, groups, threads, mention, lists, allowed commands), with whether the channel is on in settings |
| `/channels set-rules <channel> [--enabled on\|off] [--require-mention on\|off] [--dm-policy allow\|deny\|inherit] [--group-policy allow\|deny\|inherit] [--allow-users a,b\|none] ...` | Change those rules through the daemon; asks once first, because it changes who has access, and counts only when the owner types it |
| `/channels profiles`, `profile`, `set-profile`, `remove-profile` | Per-channel model, provider and permission mode |
| `/channels overview` | What the channels carry: route families, sessions, tasks, waiting approvals, remote contracts |
| `/channels routes` | The route binding snapshot |
| `/channels delivery` | The delivery snapshot: per-route delivery counts and last-error state |
| `/channels open` | Opens the Routes view |
| `/channels telegram-cursor` | Recover the Telegram update cursor |

The Agent's own actions (`readiness`, `configured`, `guide`, `triage`, `send`, `deliveries`) are refused here, saying so. Pairing a channel (asking for every missing required value, then switching it on) is "Pair something" under `/devices`: `/devices pair channel <channel>`.

Examples:

```
/channels routes
/channels rules slack
/channels set-rules slack --require-mention on --allow-users U123,U456
```

## GitHub event narration

When the daemon receives an inbound GitHub webhook event, it is narrated into the live transcript as a low-priority system message before the event is dispatched to the orchestrator. The narration format is:

```
[GitHub] <detail> → agent triggered
```

Examples:

- `[GitHub] PR #42 (owner/repo) opened → agent triggered`
- `[GitHub] Issue #7 (owner/repo) closed → agent triggered`
- `[GitHub] push in owner/repo → agent triggered`

Other channel surfaces use a generic format. ntfy includes the topic when available; all others use `inbound event`:

```
[Slack] inbound event → agent triggered
[ntfy] inbound message on topic 'alerts' → agent triggered
[Webhook] inbound event → agent triggered
```

This narration is purely informational; it does not affect routing or delivery.

## Push notifications on long-task completion

When a turn or agent task runs longer than the configured threshold, GoodVibes fires a push notification.

### Configuration

Set `behavior.notifyAfterSeconds` in `/settings open behavior` (or `settings.json`):

```json
{
  "behavior": {
    "notifyAfterSeconds": 60
  }
}
```

- **Default**: 60 seconds
- **Off**: set to `0` to disable all push notifications

### Delivery targets

Notifications are delivered in this order:

1. **Desktop notification.** `notify-send` on Linux, `osascript` on macOS. The platform handles platform detection; the call is a silent no-op when neither is available.
2. **Outbound webhook / ntfy topic.** If you have webhook URLs configured (via `/notify add <url>`), the notification is also sent as a plain-text POST to all configured endpoints. This works with ntfy.sh topics and any service accepting a plain POST body. Each address carries its own key, so it is kept in the secret store and `notifications.webhookUrls` holds only a `goodvibes://secrets/` reference to it; screens show only the address's host.

### Notification content

Notification text contains only structural metadata (task kind, elapsed time, ok/fail status, and the first 8 characters of the session ID). Conversation content (user messages, assistant replies, tool outputs) is **never included**.

### Focus state

Notifications are gated by `behavior.notifyOnlyWhenUnfocused` (on by default). They fire only when the terminal is unfocused, or when focus state was never observed. Set it to `false` to fire regardless of focus.

### Wiring

The threshold is read inside `wireTurnEventHandlers` on every `TURN_COMPLETED` event. The `behavior.notifyAfterSeconds` key is a TUI-local synthetic setting; it is not a field of the platform config interfaces, so it is not a typed `ConfigKey`.

## Related docs

- [Deployment and services](deployment-and-services.md)
- [Knowledge, artifacts, and multimodal](knowledge-artifacts-and-multimodal.md)
- [Tools and commands](tools-and-commands.md)
