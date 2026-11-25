# Channel surfaces

Channel surfaces connect external messaging systems and automation sources to
the daemon. They provide ingress, delivery, policy, account lifecycle, directory
lookup, route binding, and surface-specific tools.

Public API surfaces:

- `@goodvibes/engine/platform/platform/channels` (channel surface contract; home of the `ChannelSurface`, `ChannelRenderPolicy`, and `ChannelRouteBinding` types)
- `@goodvibes/engine/platform/platform/daemon` (daemon HTTP routes)
- `@goodvibes/engine/platform/platform/integrations` (notifier integrations)
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

A direct delivery (an automation, a send tool, a notice) longer than one
message on Telegram, WhatsApp, Google Chat, Teams, Mattermost, Matrix, Signal,
iMessage or BlueBubbles is sent as up to ten messages in order. Past that, or
when a following message fails after the first went out, the result says
`truncated` with the number of characters that did not arrive, and the
recipient sees the same count in the last message. WhatsApp in bridge mode
sends through `surfaces.whatsapp.bridgeUrl`; the doctor fails the surface
while it is unset.

A channel credential kept in a password manager or behind a command is
resolved once per daemon process and reused by status, the doctor and every
send, until its setting or the secret store changes or the provider refuses it.

Channel render policy controls:

- reasoning visibility: suppress, private, public, or summary
- output format: plain, Markdown, or JSON
- phase: progress, final, or approval

## Account lifecycle

Managed surfaces expose account records, secret status, setup schemas, repair
actions, doctor reports, lifecycle state, allowlist resolution, allowlist edit,
directory lookup, target resolution, and account actions.

Account lifecycle actions are inspect, setup, retest, start and stop on every
managed surface, plus connect, login, disconnect and logout on Slack, Discord and
ntfy, which have a provider login. An action keeps its id whatever the account's
state; `available` says whether it can run now. `retest` makes one
authenticated call to the provider (Slack `auth.test`, Discord `/users/@me`,
Telegram `getMe`, Matrix `whoami`, Mattermost `users/me`, Twilio, Meta Cloud,
Home Assistant, BlueBubbles, ntfy, a bridge URL, or a Bot Framework token for
Teams) and answers with the provider's own reason; a surface that can only be
checked by sending (an incoming webhook, Google Chat) says so and sends nothing.
`start` on a switched-off surface switches it on and `stop` switches it off
(`surfaces.<surface>.enabled`); on Slack, Discord and ntfy `stop` closes the live
connection. A setup that stored working credentials and a retest the provider
accepted record the setup version completed (`surfaces.<surface>.setupVersion`);
the doctor asks for setup again only when that version is older than the
current one. The doctor's credential checks read the account's resolved
secrets, so a credential supplied through the services file or the environment
passes. A secret's reported source is one
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

The daemon's channel health watcher is the one place that tells the owner a
surface stopped working and that it works again. A surface that receives
messages it cannot process reads `degraded`, with the reason and how many
messages were skipped (they are not retried); the watcher hears of it at once
rather than at its next one-minute sweep. A webhook surface, otherwise
unwatched, reads `degraded` while what it delivers fails and `healthy` once a
message it delivered goes through. The notice goes over another working
surface, otherwise to the owner's own conversation on the failing surface,
otherwise into a receipt the next attached terminal or web UI shows. A surface
that stays failing is mentioned again every six hours.

Every channel tool and operator action call ends in one of four outcomes: ok,
not found, refused, or unknown action (with the surface's valid action ids).
Only ok is reported as success; the others carry the reason and the next step.
The model's `channel` tool names a surface it was given that the daemon does
not know, or one that is disabled, with the enabled surfaces, instead of
answering it with no accounts or an unknown action.
Provider-native operations are separate actions, each with a closed input and
its own dangerous flag: `runtime-status`, `live-directory`, `oauth-url` and
`subscribe-url` read; `runtime-start`, `runtime-stop`, `register-command`
(Discord) and `poll` (ntfy) are flagged. A surface's agent tools are offered
only while the surface is switched on.

## Allowlists

Every list that is set must admit a message; an empty list restricts nobody.
A group, channel or thread is admitted when it is on the group list (if one is
set), on the channel list (if one is set), and its sender is on the user list
(if one is set): listing a group and a user admits that user in that group, not
everyone in it, and not that user in other groups. A direct conversation is
judged by the user list when one is set. When only group or channel lists are
set, the surface is restricted to those conversations: a direct message is
admitted only from the surface's owner, or when the chat itself is listed.

A surface with every list empty has no owner yet. The first message from an
unknown sender is not answered; it raises an owner claim in the owner inbox
(`/questions` in the terminal apps, the web UI inbox, any owned channel) naming
the sender. Accepting it puts that sender on the user list and records the
policy's `ownerId` and `ownerSince`; declining it is remembered, so the same
sender is not asked about again. At most three claims per surface are open at
once. For a shared channel, set the surface policy `open: true`
(`/channels set-rules <surface>`, or `open` on
`channels.policies.update`): every sender is admitted while the lists are
empty and no claim is raised, and every sender talks as a guest. The daemon always
raises claims; only an embedding host without an owner inbox makes the first
identified sender the owner and records the same two fields.

The surface's owner (`ownerId`) is the one sender who can answer a permission
ask, a purchase approval or veto, and send `status`, `cancel` or `retry`. Anyone
else the allowlists admit can talk to the assistant, but cannot approve tool use
or spending, or act on the owner's runs. A policy saved before owners were
recorded takes its first allowlisted user as its owner when it loads; when the
owner is no longer on a non-empty user list, its first entry becomes the owner.
An approval button pressed by anyone else is refused with the same rule (403,
`APPROVAL_ANSWER_REFUSED`), and the approval stays pending.

Authority belongs to the person, not the surface. A message from anyone else
the channel admits (a guest) starts a turn under the guest form of the surface,
`guest:<surface>`, which carries no authority on any surface, Telegram
included: the turn may read files inside the allowed directories and answer,
and every other call is an approval for the owner, in every permission mode and
with or without a decision model. Its approvals go to the owner's own direct
conversations (that surface's first), never to the guest's chat, and are listed
in the owner inbox; the owner answers from any of his direct conversations.
Work a guest asks for is proposed to the owner the same way, and only his
answer starts it; the agreed work still runs as the guest's turn. A guest's
message is never handed to an agent already running in the conversation.

A channel conversation can ask the assistant to read, search and summarize. A
request that would change something (write a file, run a command, send a
message) is not refused: it becomes an approval for the owner, shown on the
terminal apps, the web UI, Telegram and in that conversation, where the
channel's owner can answer it. It is asked each time; an answer is not
remembered for later calls. Email, webhook and ntfy are the exception, as is
anything read from a web page or another source that is not a channel: anyone
can write to them, so a change asked for there is refused and no approval is
raised; the owner asks for it himself on a command surface.

An approval prompt that cannot be shown in the conversation it belongs to (no
route, a refused or failed send) is taken to the owner's other conversations,
and the approval record carries `metadata.promptDelivery` (`delivered: false`,
the reason, and the surface that took it), so every attached surface and the
waiting agent can see that the prompt was not seen where it was raised. A
Discord reply that comes after the fifteen-minute interaction window is posted
to the command's channel instead of being dropped.

What a provider is told about a message ingress did not start: an answer that
was acted on (a permission ask, a purchase window or a work proposal took it) is
acknowledged with `outcome: "consumed"`, so it is never delivered again as a new
message. A message the policy refuses is answered by who reads the answer. A
provider that redelivers failures and shows the answer to nobody (Slack events,
Telegram, WhatsApp, Twilio) gets an acknowledgement with `outcome: "ignored"`
and the `policyReason`, so it does not repeat the refusal or hold the messages
beside it. A caller that reads the status (the generic webhook, Home Assistant,
ntfy, and the iMessage, Signal, BlueBubbles, Matrix, Mattermost and Teams
bridges) gets `403` with `ok: false`, `outcome: "refused"`, the `policyReason`
and the next step, so a script or agent never reads a blocked request as
accepted. Slash commands and buttons show the same outcome as a line.

Each inbound message costs at most one decision-model request. Code decides
which questions it needs: whether it gives card details (only when it uses card
words, such as card, CVV, security code or expiry, beside a short number or a
month/year pair), its answer to a work proposal or permission
ask (only when one is pending on that conversation for that sender), and
whether it asks for work (only on a gated surface). They are asked together
in one request, which ends when the decision model answers or fails. A card number is refused by its checksum without
any reading; an unsure reading refuses nothing, so a message with an ordinary
number is answered. A message whose work intent is unsure gets a conversational
reply rather than a request to send it again; only a confident work reading
proposes work.

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
  On the public server a topic name is the only thing keeping strangers out,
  so the topics ship unset: switching ntfy on (`goodvibes surfaces enable ntfy`,
  or the daemon starting with `surfaces.ntfy.enabled` true) gives each unset
  topic an unguessable name, saves it and says which names to subscribe to.
  Each topic name is kept in the secret store, with only a reference in the
  settings file, and is shown masked.
  The names earlier builds shipped (`goodvibes-chat`, `goodvibes-agent`,
  `goodvibes-ntfy`) are not subscribed on ntfy.sh; `surfaces check ntfy` names
  the setting to clear or change.
  A message the daemon fails to process is delivered again a few times; if it
  still fails, it is skipped so the messages behind it keep flowing, and the
  owner is told it was skipped. A message refused on purpose (an answer that
  was consumed, a command the policy does not allow) is neither retried nor
  counted as a failure. A topic whose stream keeps dropping, or that
  the server refuses, reports `degraded` or `dead` with the reason.
- Home Assistant uses signed ingress, isolated remote sessions, Assist
  submit-and-wait conversation routes, event-bus delivery, setup manifest
  discovery, REST-backed tools, and an inactivity TTL for remote sessions. A
  message whose turn runs past two minutes is answered "Still working on that."
  (event status `running`), and the final reply follows as a second event when
  the turn ends. A stopped or failed turn is spoken as a short sentence; the
  internal reason stays in the event's `metadata.error`.
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

## Inbox sources

The daemon mirrors the Slack, Discord and email inboxes you configure so the
owner inbox (`channels.inbox.list`) can show them. A provider you have not
configured is listed as `unconfigured`: nothing is polled and nothing is stored
for it. A credential store that cannot be read is reported as such, never as a
fresh install.

- **Screening.** A configured Slack or Discord inbox runs only with an
  established trusted screening host (the local service that screens message
  content before a model reads it). An email inbox whose screening consent or
  credentials are missing runs without screening: its rows carry
  `screening: not-screened` with the reason, and triage and label write-back stay
  off for it.
- **Discord.** The inbox reads the one-to-one DMs you list:
  `surfaces.discord.inboxBotUserId` names the bot, and
  `surfaces.discord.inboxChannelIds` is a comma-separated list of 1 to 200 DM
  channel ids the bot can read. The token must prove it is that bot, and every
  listed channel must check out, before any history is read; replacing the account
  or the list ends the source, even if the old setting is restored later. Group DMs
  are not supported. The account and its screening scope are recorded under
  stable ids in `.goodvibes/tui/operator/discord-inbox-identities.json` in the
  workspace: keep that file with the inbox database files when you back up or move
  a workspace. When it is missing or damaged while mirrors exist, the daemon holds
  the inbox instead of starting an empty one; restore the matching file.
- **Email.** An email inbox is fed by the daemon's one mailbox reader (IMAP over
  TLS, or plain IMAP to a loopback host only). The first poll records where
  history starts and reads content from the next poll on; history left out and
  backlog still pending are reported apart from provider failures.
- **Retention.** While the daemon runs it expires message previews in inactive
  mirrors by each mirror's recorded retention policy (the native default is 30 days
  and 5,000 rows; a custom policy it does not recognise is left for you to
  inspect, never replaced). This contacts no provider and no decision model. The
  mirror databases live in an owner-only folder with owner-only file permissions.
- **Machine groups.** In a group, each inbox is polled by one machine at a time,
  chosen by election. Each machine keeps its own mirror: a machine that comes back
  resumes from its own, and a new one starts from the provider's bounded first
  read. The cursor is not handed between machines, the feed is not guaranteed
  identical on every machine, and a message may be read more than once across a
  hand-over.

## Inbox triage

Each inbox account whose privacy screening is admitted also triages its mail:
after a poll stores new messages, one model request per batch reads each one as
spam, priority or normal, on the same model route and under the same retention
promise as that account's screening. Turning decision models off (no decision model) turns
triage off too. The label is stored beside the message in the account's own
inbox store and shows in `channels.inbox.list` (`triageLabel`, `triageScore`,
`triageTags`) only while the message's content is the content that was scored
and the questions that scored it are the current version; a changed message, or
one labelled by an earlier version of the questions, is scored again. Reading
the inbox never asks a model. Spam wins over priority: a message that reads as
both is labelled spam.

Labels are not written back to Slack, Discord or the mailbox unless the owner
turns that on for the account: `surfaces.slack.inboxTagging`,
`surfaces.discord.inboxTagging` or `surfaces.email.inboxTagging` (off by
default; read at each write, so switching it does not restart the inbox). A
label is written with `channels.inbox.applyLabels { itemIds, labels }` (the
Agent's `agent_harness mode:"inbox_labels_apply"`), which answers per message
`applied`, `refused` (nothing written, with the setting or step to take) or
`failed`. When they are written, the three labels exclude each other: writing one takes the other two off the message (a Slack or Discord
reaction, a Discord forum tag, an IMAP keyword) once the new one is on, and the
answer says, label by label, what was added, already there, removed, skipped
(no forum tag mapped) or refused and why.
