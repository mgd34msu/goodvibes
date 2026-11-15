# Channel surfaces

Channel surfaces connect external messaging systems and automation sources to
the daemon. They provide ingress, delivery, policy, account lifecycle, directory
lookup, route binding, and surface-specific tools.

Public API surfaces:

- `@goodvibes-jev/engine/platform/platform/channels` (channel surface contract; home of the `ChannelSurface`, `ChannelRenderPolicy`, and `ChannelRouteBinding` types)
- `@goodvibes-jev/engine/platform/platform/daemon` (daemon HTTP routes)
- `@goodvibes-jev/engine/platform/platform/integrations` (notifier integrations)
- operator control-plane methods for channel setup, delivery, and route binding

## Supported surfaces

The `ChannelSurface` contract names every conversational or notification
system the daemon can sit behind. `tui` and `web` are the two first-party
surfaces the daemon itself ships; everything else is a built-in managed
external surface, meaning the daemon owns its account setup, ingress, and
delivery rather than treating it as a generic webhook target.

| Surface | What it is |
|---|---|
| `tui` | The daemon's own terminal UI, treated as a channel like any other for routing purposes. |
| `web` | The browser-facing operator surface. |
| `slack` | A Slack app, driven over bot/app-level tokens and Socket Mode. |
| `discord` | A Discord bot, driven over gateway dispatch and interactions. |
| `ntfy` | Push notifications and chat over the ntfy pub/sub protocol. |
| `webhook` | A generic signed inbound/outbound webhook connector for systems with no dedicated adapter. |
| `homeassistant` | Home Assistant, over its REST API, webhooks, and Assist conversation protocol. |
| `telegram` | A Telegram bot, over `getUpdates` polling or a registered webhook. |
| `google-chat` | A Google Chat app, over webhook events. |
| `signal` | The Signal messenger. |
| `whatsapp` | WhatsApp Business messaging. |
| `telephony` | SMS and voice, either through a bridge or direct Twilio calls. |
| `imessage` | iMessage. |
| `msteams` | Microsoft Teams. |
| `bluebubbles` | iMessage reached through a BlueBubbles server. |
| `mattermost` | Mattermost. |
| `matrix` | The Matrix protocol. |

## Capabilities

Channel capabilities are declared per adapter, and the channel runtime uses
them to decide which setup fields, operator actions, tools, directory
queries, and delivery routes are available for that surface.

| Capability | What it grants |
|---|---|
| `ingress` | The adapter can receive inbound messages or events from the provider. |
| `egress` | The adapter can deliver outbound messages to the provider. |
| `threaded_reply` | Replies can be posted inside a thread rather than only at the top level of a conversation. |
| `interactive_actions` | The provider's interactive elements (buttons, components, commands) are supported. |
| `session_binding` | An external conversation can be bound to daemon runtime state (a route binding), so follow-ups return to the right place. |
| `delivery_only` | Replies can be delivered without an interactive, session-bound conversation, the shape notification and webhook-style channels need. |
| `account_lifecycle` | The surface exposes account setup, connect/disconnect, and repair actions rather than being config-only. |
| `target_resolution` | A human-readable target (a user, channel, or group) can be resolved to a concrete delivery address before dispatch. |
| `agent_tools` | The surface contributes tool definitions into GoodVibes agent runtimes. |

The channel runtime uses these capabilities to decide which setup fields,
operator actions, tools, directory queries, and delivery routes are available.

## Ingress

Adapters parse provider-specific payloads into GoodVibes work:

- Slack webhook and Socket Mode payloads
- Discord webhooks, interactions, and gateway dispatches
- ntfy JSON stream messages
- Home Assistant signed webhooks and Assist conversation requests
- Telegram webhook updates
- Google Chat webhook events
- Signal, WhatsApp, Telephony, iMessage, BlueBubbles, Mattermost, Matrix, and
  generic webhook payloads
- GitHub automation webhooks

Ingress applies request-size limits, signature/token checks where configured,
channel policy, conversation-kind mapping, route binding, and surface-specific
reply setup before handing work to the daemon.

Chat adapters (Slack, Matrix, Mattermost, Signal, iMessage, BlueBubbles, Google
Chat, Microsoft Teams, GitHub) handle one provider message once: a redelivery
with the same provider message id (a Slack retry, the `message` and
`app_mention` events for one mention, a repeated GitHub delivery id) is
acknowledged as `duplicate-delivery` and starts no second agent. The record is
held in memory for ten minutes. A delivery that was refused or failed before
work started can be retried.

`requireMention` in a channel policy is judged from what the payload shows: a
Teams `mention` entity for the bot, Matrix `m.mentions`, Google Chat
annotations, Slack's own mention markup, a Mattermost outgoing-webhook trigger
word, or a bridge's explicit `mentioned` boolean. Signal, iMessage, BlueBubbles,
ntfy and Home Assistant payloads carry no mention information of their own, so
with `requireMention` on, a message from them is refused (`mention-required`)
unless the bridge sets `mentioned: true`.

A message names a command only when its first word is written as one (`/status`,
`!status`, or `/status@yourbot`). `allowedCommands` limits those commands, and
`allowTextCommandsWithoutMention` lets only an allowed command past
`requireMention`; ordinary conversation is never held to the command list and
never counts as a command.

An answer longer than a surface's message size is sent as several messages in
order, split at paragraph, line or word breaks, so nothing is cut off. Surfaces
that take JSON (webhook, Home Assistant) receive the whole answer in one body.
Over Slack Socket Mode a slash command or button is answered through its
`response_url`, and a mention that could not be started is answered in its
channel, because the socket acknowledges the event before it is handled.

Slash commands and interactive components (Slack, Discord) answer a
policy-refused request with HTTP 200 and an ephemeral message that names the
reason, because the providers show a reply only when it arrives with 200. A
slash command's one-shot reply credential (Slack `response_url`, Discord
interaction token) is not stored on the channel's route binding; the reply to
that command carries it.

A GitHub automation webhook starts an agent only from text written by the
repository's `OWNER`, a `MEMBER` or a `COLLABORATOR`: the opener of an issue or
pull request, or the writer of a comment. A maintainer's comment on an issue an
outside contributor opened is therefore answered, and text from anyone else is
acknowledged as `untrusted-author` and starts no agent. A comment counts only
when it mentions the bot as a whole handle: the login of the configured GitHub
token, `@goodvibes` or `@bot`. A comment that names no handle is ignored without
any request to GitHub, and the token's login is looked up once per token. When
the daemon posts results, the agent's answer is posted to the issue or pull
request for it (a review comment on a pull request), marked so it never starts
another agent.

Every chat surface (Slack, Discord, Telegram, Google Chat, Microsoft Teams,
Mattermost, Matrix, Signal, WhatsApp, Telephony, iMessage, BlueBubbles, ntfy,
Home Assistant and the generic webhook) answers `status <id>`, `cancel <id>` and
`retry <id>` for a run, agent or session the daemon knows. A command acts only
on work started from the same conversation; for anything else the answer says
so and names where to send it. Where the provider shows the answer to its
request (a slash command, Google Chat, Mattermost, Home Assistant, a webhook
caller) the answer comes back in it; elsewhere it is sent to the conversation.

## Conversation kinds

Channel conversation kinds are:

- direct
- group
- channel
- thread
- service

Policies can match at surface or group scope. The default policy posture is
allow/deny/inherit by conversation kind, with command allowlists and actor
authorization records available for managed surfaces.

A Matrix reply to an earlier message stays in the room's conversation and
session; only an `m.thread` relation starts a thread. A Signal message that
carries a group id (`groupId`, or `dataMessage.groupInfo.groupId`) is a `group`
conversation: group policies apply, the sender is read from `source`, and the
answer goes to the group.

## Route bindings

Route bindings preserve the connection between an external conversation and
GoodVibes runtime state. A binding can include surface kind, surface id,
external id, thread id, channel id, session id, automation job/run ids, and
metadata.

Bindings allow follow-up messages, threaded replies, agent progress, approval
responses, and automation deliveries to return to the correct external target.

## Delivery

The delivery router sends runtime output to channel targets. Delivery records
track status, attempts, errors, metadata, and dead-letter posture. The reply
pipeline listens to turn, agent, and workflow events and renders progress,
approval, and final messages according to the channel render policy.

Channel render policy controls:

- reasoning visibility: suppress, private, public, or summary
- output format: plain, Markdown, or JSON
- phase: progress, final, or approval

## Account lifecycle

Managed surfaces expose account records, secret status, setup schemas, repair
actions, doctor reports, lifecycle state, allowlist resolution, allowlist edit,
directory lookup, target resolution, and account actions.

Account lifecycle actions include inspect, setup, retest, connect, disconnect,
start, stop, login, logout, and wait-login. A secret's reported source is one
of the service registry, config, environment variables, or a derived value;
`unresolved` marks a value that is declared but resolves to nothing, distinct
from `missing`, which marks a value that was never declared at all.

Where a surface's credential lives is stated once, in its setup schema's secret
targets (service-registry slot, config key, environment variables). Setup
stores a credential in the secret store and writes the matching
`goodvibes://secrets/...` reference into that config key, so delivery, the
provider connection and status all find it; a setup that stored a credential
this daemon cannot read back answers `ok: false` and says so.

An account's `state` and `authState` are read off the same health answer the
status snapshot gives. Which credentials a surface needs before it can send is
also stated once: none for ntfy, a bridge-mode telephony line, Signal, iMessage
and the generic webhook; a bot token or a webhook URL for Slack and Discord; the
auth token for direct Twilio telephony; the surface's token or password
elsewhere. A connection observed to be open is healthy whatever the credentials
say, so tokenless ntfy reads healthy and can carry the dead-channel notice.

`surfaces.list` is built on each call: one record per registered surface,
`enabled` from the same switched-on rule delivery uses (its setting, a
credential or its environment variable; an explicit off wins) and `state` from
that surface's health answer (`healthy`, `degraded`, `error` for a dead or
unconfigured channel, `disabled`), with the exact health in `metadata.health`.
A surface turned on, or a channel that died, shows without a restart.

Every channel tool and operator action call ends in one of four outcomes: ok,
not found, refused, or unknown action (with the surface's valid action ids).
Only ok is reported as success; the others carry the reason and the next step.
Provider-native operations are separate actions, each with a closed input and
its own dangerous flag: `runtime-status`, `live-directory`, `oauth-url` and
`subscribe-url` read; `runtime-start`, `runtime-stop`, `register-command`
(Discord) and `poll` (ntfy) are flagged. A surface's agent tools are offered
only while the surface is switched on.

## Allowlists

A direct conversation is admitted when the surface's user list is empty or
holds its sender. A group, channel or thread is admitted when the conversation
is on the group or channel list, or its sender is on the user list. Empty lists
restrict nobody.

A surface with every list empty has no owner yet. The first message from an
unknown sender is not answered; it raises an owner claim in the owner inbox
(`/questions` in the terminal apps, the web UI inbox, any owned channel) naming
the sender. Accepting it puts that sender on the user list and records the
policy's `ownerId` and `ownerSince`; declining it is remembered, so the same
sender is not asked about again. At most three claims per surface are open at
once. For a shared channel, set the surface policy `open: true`: every sender
is admitted while the lists are empty and no claim is raised. A host without an
owner inbox makes the first identified sender the owner and records the same
two fields.

An allowlist edit names its `kind` (`user`, `channel` or `group`) unless every
entry is a typed id (`user:U0123`, `channel:C0123`). Names and handles are
looked up in the provider directory and stored as provider ids; an entry that
matches no one, or more than one, refuses the whole edit and nothing changes.
An edit that would refuse the caller's own conversation (`callerUserId`,
`callerConversationId`), or that puts the first entry on an empty user list
without keeping the caller, is refused unless `force` is set.

## Directory and targets

Directory entries represent self, users, channels, groups, threads, members,
and services. Target resolution can use explicit input, provider directories,
route bindings, normalized identifiers, synthetic targets, or miss records.

The conversations a surface already knows (every conversation that has written
to it) come from its route bindings, are listed once, and stay listed when a
default target is configured. With `live`, the provider's own directory is
searched after them. Entries carry ids, kind, label and handle, never raw
provider records or stored binding metadata. A provider search stops at the
first exact name; one that stops at its page limit is marked `truncated`, and a
target that matched nothing within it says `searchTruncated`.

This is what lets a client resolve names like a Slack channel, Discord thread,
or Home Assistant service target before dispatching work.

## Surface-specific notes

- ntfy has configurable chat, agent, and remote-chat topics. Chat-to-TUI routes
  into the active shared session; agent topics submit agent work; remote-chat
  topics use daemon-owned remote chat and inherit the daemon/TUI provider/model.
  A message the daemon fails to process is delivered again a few times; if it
  still fails, it is skipped so the messages behind it keep flowing, and the
  owner is told it was skipped. A message refused on purpose (an answer that
  was consumed, a command the policy does not allow) is neither retried nor
  counted as a failure. A topic whose stream keeps dropping, or that
  the server refuses, reports `degraded` or `dead` with the reason.
- Home Assistant uses signed ingress, isolated remote sessions, Assist
  submit-and-wait conversation routes, event-bus delivery, setup manifest
  discovery, REST-backed tools, and an inactivity TTL for remote sessions.
- Slack uses bot and app-level tokens, Socket Mode runtime, final delivery with
  bot-token resolution, and service-backed secret refs. A Slack or Discord start
  is reported as running only once the socket has actually opened; a socket that
  fails or does not open within 30 seconds is a failed start, handled like a
  dropped connection.
- A surface switched on, or given a credential, while the daemon runs is picked
  up without a restart: Telegram, ntfy topics, Slack and Discord register to be
  read as soon as the setting or the stored credential changes, and are
  withdrawn again when switched off, when a topic is renamed, or when the
  Telegram token belongs to a different bot. Clustered nodes contest a new
  surface like any other.
- Discord supports interactions, gateway dispatch, commands, and component
  responses.
- Telephony supports bridge-backed SMS/voice delivery or direct Twilio SMS/voice
  calls, token-authenticated inbound callbacks, default recipient routing, and
  plain-text reply rendering tuned for phone channels.
- Generic webhooks support signed ingress and generic reply delivery.

## Operator methods

The operator contract exposes channel surfaces, accounts, setup schemas,
doctor reports, repairs, lifecycle state, directory lookup, target resolution,
policies, allowlists, route bindings, and delivery inspection. The generated
[Operator API reference](./reference-operator.md) is the exact method/schema
inventory.

## Inbox triage

Each inbox account whose privacy screening is admitted also triages its mail:
after a poll stores new messages, one model request per batch reads each one as
spam, priority or normal, on the same model route and under the same retention
promise as that account's screening. Turning decision models off (Classic) turns
triage off too. The label is stored beside the message in the account's own
inbox store and shows in `channels.inbox.list` (`triageLabel`, `triageScore`,
`triageTags`) only while the message's content is the content that was scored;
a changed message is scored again. Reading the inbox never asks a model.
Spam wins over priority: a message that reads as both is labelled spam.

Labels are not written back to Slack, Discord or the mailbox unless the owner
turns that on for the account.
