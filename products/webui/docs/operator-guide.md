# Operator guide

This guide describes the WebUI from an operator point of view.

Available actions depend on the selected daemon and its current authority. Native
work uses Jev admission and recorded outcomes.

## Navigation

GoodVibes has four places: Chat, Work, Library and Personal. The sidebar lists
them in order:

- New chat, a fresh conversation
- Search (Ctrl K), the command palette
- Work, what is running for you and what needs you. Its dot or count is the
  number of items waiting on you.
- Library, what GoodVibes remembers and knows
- Personal, your calendar, mail and occasions
- Recent, your chats, newest first, each with a permanent delete

Work, Library and Personal open with a section switch across the top, so every
section inside them is one click away. Settings, Devices and pairing, People
and channels, and Check-ins are in the account menu at the foot of the
sidebar, together with the theme (Light, Dark, Auto and the opt-in GoodVibes
Neon), the connection to your daemon in plain words with its latency, and Sign
out. The dot on your avatar is the connection at a glance; when the connection
drops, a toast and a thin banner say so. Settings also opens with Ctrl comma.

Links from earlier versions still work. `?view=fleet`, `?view=sessions`,
`?view=approvals-tasks`, `?view=workstream`, `?view=ci-watches` and
`?view=checkpoints` open Work; `?view=memory` and `?view=knowledge` open the
Library; `?view=calendar`, `?view=mail` and `?view=dates` open Personal;
`?view=admin`, `?view=providers`, `?view=principals` and `?view=checkin` open
the settings dialog on the matching section. The address is rewritten in place
to the new form, and a notification's `#...` fragment is kept.

The sidebar collapses to a 56-wide icon rail with its panel button or Ctrl B,
and folds to that rail on its own while something large is open on the right
(a peek or a detail), returning when it closes. A sidebar you collapsed
yourself stays collapsed. Pin it to keep it open (under 1280 wide a detail
still folds it). Hover the rail, or press Ctrl B while a detail holds it, to
see the full sidebar over the page. Drag its edge to resize it (220 to 360).

At phone width there is no rail: the sidebar is a drawer behind the header's
menu button (or a swipe from the left edge). Tapping the dimmed area beside it,
or picking anything in it, closes it. The drawer never traps.

## Settings

Settings is a dialog, not a page, so it opens over whatever you were doing.
Open it from the account menu, with Ctrl comma, or from a `?settings=<section>`
link. It has seven pages, each holding one or more sections; a search box at
the top finds a section by name or by the setting inside it.

| Page | Sections | What it covers |
| --- | --- | --- |
| General | Display, Network, About, Advanced | Theme (including GoodVibes Neon), density, how devices reach the daemon (Tailscale, relay, listeners), the daemon and connection status, and every remaining daemon setting |
| Account | Sign-in, Devices and pairing, People and channels | How this browser signs in, passkey step-up, owner profile and mail/calendar accounts, paired devices and their tokens, power keep-awake, this browser as a phone node, and the named identities behind each channel |
| Models and providers | Model, Credentials, Usage | The model new chats use, provider status and sign-in routes, what the credential store holds, and per-provider usage and budgets |
| Voice | Voice | Dictation, spoken replies and the wake word |
| Notifications | Notifications, Check-ins | Push notifications and install, occasion reminders, and the proactive check-in schedule and receipts |
| Memory | Memory | Provenance chips, consolidation and the daemon's memory use |
| Permissions | Permissions | The four permission modes as cards, each with what it does, and why the mode in force differs when it does; under Advanced, approval rules, MCP tool rules, the permission evaluator, the sandbox and tool policy |

Settings read and write the daemon's own configuration through typed editors:
secrets are masked and write-only, a refusal for lack of admin scope is
reported as that, and a change that needs a restart is marked as pending. Every
setting the daemon reports is reachable somewhere in the dialog, so a key this
build has never heard of lands in Advanced instead of disappearing.

## Signing in and pairing

The sign-in screen leads with scanning: "Run goodvibes pair on your computer
and scan the code." Run `goodvibes pair` in the terminal (or open the desktop
app's pairing panel) and either open the QR's link on the phone or press "Scan
the code" for the in-page camera scanner. A scanned code feeds the same
validation path as a pasted one, and the one-time secret is stripped from the
URL immediately so it never lingers in the address bar or history. Everything
else is under "Other ways to sign in": pasting a sign-in code by hand, the relay
code, username and password, and where to find a code.

A pairing link can also carry a hand-off bundle with up to three offers, so
one scan can finish the whole device setup. Each offer is independently
declinable, and the outcome of each is reported per offer, never silently
half-applied.

| Offer | What accepting it does |
| --- | --- |
| Push notifications | Runs the real browser ceremony (permission prompt, VAPID key fetch, push subscribe) and registers this device with the daemon, so approval and completion alerts arrive even when the app is closed |
| Remote connectivity | Acknowledges the relay offer, so this device can reach the daemon through the rendezvous relay when it is off your LAN |
| Passkey | Runs the WebAuthn registration ceremony and registers the credential with the daemon, used later to step up state-changing calls over the relay |

An offer whose ceremony fails locally (permission denied, no authenticator)
is reported as failed with the real reason, never downgraded to "declined",
because that would misrepresent an attempt as a choice never made. Scanning
needs a secure (HTTPS) context; over plain HTTP the scanner says so and
points at serving the app over HTTPS instead of failing quietly.

## Chat

Chat is daemon-owned companion chat. It is intended for direct LLM conversation
through the daemon's configured provider/model route.

Supported chat behavior:

- create new chats
- list daemon companion chat sessions
- preserve current/recent sessions across refresh while daemon data loads
- rename chats from the title
- delete chats from the sidebar; the delete closes first, hard-deletes, then
  verifies against a fresh list rather than trusting the call's success
  response
- send plain text with Enter (the daemon queues it behind an active turn)
- steer with Ctrl+Enter or Cmd+Enter (press and hold Send on touch), which
  sends immediately and interrupts the in-flight turn
- insert a newline with Shift+Enter
- stop generation with a server-side cancel; the stopped partial reply stays
  in the transcript with an honest stopped marker
- attach files through daemon artifact upload
- copy whole messages and individual code blocks
- resend user messages
- regenerate assistant replies; the superseded reply is retained, not erased
- edit a user message and branch; the old branch stays viewable inline as
  retained history
- search chat history, both session titles across full history (a daemon-side
  search) and message text within recently loaded sessions
- see queued messages while a turn is active, and dictate or speak replies
  with the voice controls. A queued message whose chat closed, or whose daemon
  restarted, before it ran is marked "Not answered"; send it again to get a
  reply. A reply that could not be saved because the chat's storage was full or
  unwritable is retried by the daemon on its own, and the chat accepts changes
  again once that works

Provider/model controls in the composer update daemon model selection. Message
sends themselves do not include provider/model routing.

An approval or question a chat is waiting on appears in that chat, as a card
below the last message with its choices and the links "Why am I asked?" and
"Details" (the tool, the folder, the decision and the arguments, read when you
open it), and the chat header shows a chip ("asking you · 1") that lists them.
On a phone the header keeps the chat's title and that chip; the permission mode
chip steps aside while it shows, and the chip's sheet ends with the mode in
force and Change. Work lists the same asks. Once one is decided, here or
anywhere else, the card folds to one dim line saying what was decided.

A turn's tool calls read as one collapsed line ("Read 2 files, edited 1 · 4 s")
that opens to one line per call, worded as the terminal words it; the raw
result is behind each call's Details. A reply that failed or was refused is a
row in the conversation: what happened, the cause and what was changed, then
buttons for the next step (Try again, Use another model, Details, or Choose a
model or Sign in again for a refusal). The prompt above it stays as typed, and
the row is the same after a reload.

## Command palette and guided sheets

Search (Ctrl K) opens the command palette: chats, places to go, settings
sections, and every slash-command action the daemon can run. Picking an action
opens its guided sheet, with the same blanks, the same sentence above the
button and the same "what happened" line as the terminal. A schedule or trigger
described in words is read back by the daemon first, and the sheet shows what
will be kept before you save it. An action only a terminal can do is listed
with the reason. The palette also opens four screens built the same way:
Schedules, MCP servers and tools, Repeat purchases, and Triggers. Typing `/`
in the chat composer offers only `/new`; other commands are run from the
palette.

## Attachments

Attachments are uploaded as daemon artifacts before the chat message is sent.

Expected flows:

- text only
- attachment only
- text plus attachments

If upload fails, the optimistic message is marked failed and the error remains
visible near the composer. Large outputs open in the artifacts slide-over.

## Markdown responses

Assistant and Knowledge responses support Markdown rendering. Registered language
tags use their declared grammar. Untagged or unsupported fences require a current
daemon-owned language reading; unavailable or held readings leave escaped plaintext.

Code block line numbers are optional and controlled from Settings, General. They are
decorative and are not copied.

## Voice

Spoken replies and microphone dictation are available in Chat:

- spoken replies synthesize through the daemon's text-to-speech route,
  batched and concurrency-capped, with quiet retry
- dictation records in the browser, transcribes over the daemon's
  speech-to-text, and always shows the transcript for review before send,
  never auto-sending
- voice configuration (provider, voice, settings) is the shared tier used by
  the terminal and agent. Change it once, it applies everywhere
- a managed local-voice install is available from the voice settings when the
  daemon supports it, provisioning daemon-side local speech engines with live
  install progress

### Wake word

The browser tab can listen for the wake phrase continuously and drop the
transcribed follow-up into the Chat composer. Detection runs inside the tab
(the model is downloaded from the daemon and inference runs locally), so the
microphone never streams to the daemon while idle. It is off by default and
gated twice: the models must be provisioned on the daemon (an explicit act,
size shown on the button), and the tab's own surface opt-in
(`voice.wake.surfaces.webui`) must be turned on, because the microphone
permission is granted per origin. While the opt-in is off, the tab loads no
model and never asks for the microphone.

While listening, an indicator is always visible, either a persistent banner or
a chip in the header depending on the configured indicator style. Settings a
tab cannot honor (retaining audio clips, playing a local activation-sound
file, a custom model id) are reported verbatim as limitations rather than
silently ignored. A tab can score only the pinned model: when
`voice.wake.models` does not name it, the tab says so and does not open the
microphone. With several tabs or an installed window open, one of them listens
and the others show "Wake detection is running in another tab"; when that one
closes or stops, the next takes over, so one wake phrase is heard and sent once.
Words heard while no chat is open are kept: the indicator reads `Heard:
"<words>"` with "Open a chat to use it; it will be placed in the draft.", and
the next chat that opens puts them in its composer to review, never sending
them by itself.

## Work

Work is one list of everything working for you, grouped by what you would do
about it: Waiting for you (approvals, questions, purchase windows and anything
else that needs your answer, each in a sentence, with who asked and, when it
loosens a protection, "this weakens a safety setting"; a purchase window reads
"Buy a drip irrigation kit from Example Garden Supply for $38.40?" with "From
"Plan the spring garden beds" · inside your daily budget · goes ahead in 9 min
unless you say no", naming the chat whose turn began it, or the schedule), Running now (each
agent by what it is doing in words, "Reading 2 files", or its task when nothing
is known; never a tool's name), Scheduled
(schedules, triggers and CI watches between runs, with when they run and how the
last run went) and Finished (the ten newest). The header chip says how many
things wait for you; the sidebar badge and the account menu's "running" are the
same counts. The platform's own services (heartbeats, pollers, the code index)
sit behind one line, "Background services: 4 healthy", which opens to each one
and its state; a service that stalls or fails becomes a row under Needs
attention, with Restart when it can be restarted. Open sessions between turns
are behind their own line. When the inbox cannot be read, the list keeps the
asks it last read and says so above them: "Questions and purchase windows could
not be read: <reason>." with Retry. A search box narrows the rows, and the Show select
switches between Active (the default) and Archive. Select a row to open its
detail beside the list (over the page on a phone). An ask opens as its card:
who asked and when, the question, what it acts on, what it will do, the
choices, and "Why am I asked?" and "Details" (the tool, its arguments, who
requested it, the session and the decision trail). "I'll handle this" marks an
ask as yours when more than one person can answer; "Cancel this request" is
offered to the person who asked. New offers Ask for work to be done, Run a
background task, Start a session in a folder, CI watch and a one-off CI status
check.

Under the list, Archive finished processes moves fully finished processes out of
the default list straight away, without a confirmation. They stay readable under
Show, Archive, which is view-only: this page has no unarchive control yet.
Workspace checkpoints opens the workspace's snapshots.

Work plan (also `?tab=plan`) opens the project's work plan: the checklist the
terminal app's `/todo`, the Agent's todo list and the model's `work_plan`
tool keep, one plan per project in every app. It lists the items in order with
their status and the plan's counts. Add an item with the field at the top;
change an item's status with its status select; move it up or down; edit its
title, owner and notes with the pencil; delete it (confirms first); Clear
finished removes every done and cancelled item (confirms first). The list
follows edits made anywhere, in this page, the terminal app, the Agent or a
model's tool call, without refreshing. Done and cancelled items are also
removed automatically once untouched for 30 days or beyond the 200 most
recent, by the edit that finishes an item; that edit says so.

What the list brings together:

- sessions from the terminal, the agent and this browser, with daemon-hosted
  sessions
- the live process tree: agents, workstreams, watchers, background processes
  and observed external agents, with per-agent state
- native contracts, task records and legacy approval/attempt records
- standing CI watches

### Native requests and contracts

Choose New, Ask for work to be done, type what you want and press Send. The
daemon decides whether it becomes work or a reply in a session and carries it
through; the message box stays open for the next message. Each message you sent
is a row with one status line that refreshes by itself every few seconds while
the message is still moving. "Needs you" appears only when the daemon cannot go
on without you (an interrupted start, a reply that failed without changing
anything, a result that did not pass its final check), with the one button that
answers it; Cancel stops a message that is still in progress. Identifiers and
revisions are under Details. A message is kept in this browser only until the
daemon has finished with it. Files and images cannot be attached here yet; note
them as missing so the daemon knows what it was not given.

Contract details show the original ask, criteria, recorded readings, checks,
attempts and terminal result. Inspection is read-only. Recorded confirmation or
escalation history does not create a new approval or owner-reply action.

Cost shows on a row only when the daemon priced it; an unpriced item shows no
cost rather than a fabricated zero. Changes arrive over a live subscription,
and a background poll keeps the list fresh while it is down.

### Sessions

Open sessions between turns sit behind their own line; the daemon sends them a
page at a time, and "Show older sessions" at the end of the list loads the next
page, back to the first. When a page cannot be read, the same line says why
("Older sessions could not be read: ...") and selecting it tries again. In a
session's detail you can:

- read its transcript
- steer a live session (on a phone, plain Enter sends); a steer sent while the
  live stream is paused says so
- follow up on a closed session, which is offered honestly as a follow-up (a
  new linked session), never disguised as steering
- tell reaped sessions apart by their badge: an idle-reaped session reopens
  automatically on the next activity, so it is labeled differently from a
  deliberate close
- read and set the session's gate preset through the permission-mode picker.
  Labels and choices come from the engine. The preset is session-scoped, and
  a session the daemon cannot answer for shows an honest unavailable state; the
  picker offers exactly the five modes `ask-me`, `jev-decides`, `just-vibes`, `yolo` and `plan`
- read the context-usage figure, an estimate marked with `~`, and the
  per-session cost for the last 24 hours; a session with no recorded cost says
  so instead of showing a fabricated zero
- review the session's file changes hunk by hunk, with comment and revert
  sheets, and rewind the session where the wire supports it
- browse, create, restore and compare checkpoints on its Checkpoints tab.
  Selecting one shows its diff against the live working tree, restore is
  destructive and always confirmed with exactly what gets overwritten, and a
  create that finds the tree unchanged says so instead of making a checkpoint
- close, reopen, or delete a session. Close and reopen are reversible,
  history-preserving actions; delete is permanent, requires the session to be
  closed first, and is verified against a fresh list before it is reported
  done

Compaction receipts render as distinct cards appended to the transcript as
they arrive live. There is no history endpoint for past receipts, so only
receipts observed while the session detail is open appear.

### Hosted sessions

A hosted session's conversation loop runs inside the daemon, so it does not
end when the tab that started it goes away. They appear in the Sessions list.
From New you can create one from a workspace path, an optional title, and what
happens when the last client leaves (end the session, keep it running, or the
daemon default). You can attach to one (stored history first, then the live
stream), steer it, leave it (a confirm sheet states what leaving does, read
from the session's own detach policy), or end it, which terminates it for every
attached client and is confirmed first. While it has not ended, its Transcript
tab has a Share section: "Share with" takes a user name, or `pairing:<id>` for a
paired device, who can then open the session, read it and watch it live; the
owners are listed with Remove beside each (the last owner cannot be removed).
Terminated sessions are hidden unless you ask for them, and show the daemon's
own termination reason.

### Agents and processes

The process tree refreshes on live events. Nodes retain the daemon's attention
state and recorded reasons; timestamp quietness does not decide semantic status.
You can steer or detach a node where a live session backs it and
stop watcher nodes; a capability the wire cannot address gets an honest note
instead of a fabricated button. Observed foreign-agent nodes carry a liveness
tell that states what `quiet` does and does not mean. Orchestration runs
(workstreams) show their phases and work items; phases are grouping rows and
carry no fabricated usage or cost. On a phone the tree stays fully browsable;
the mutation actions are desktop-only and an honest note says so.

### Legacy records and tasks

Legacy approval details preserve the recorded request, hunks, attribution and
audit trail. Resolved records render as history. A legacy pending record may
still show compatibility controls; a claimed record keeps Approve, Deny and
Withdraw because a claim is advisory. Legacy attempt groups may show their
comparison view. These controls are separate from native contract admission;
they do not supply a human fallback for held Jev decisions.

Tasks show the daemon task queue with create, cancel and retry; cancel appears
only when a task reports itself cancellable, and retry only for failed or
cancelled tasks. The daemon reports the resulting state; a browser click alone
does not establish that a mutation completed.

### CI watches

A watch for a repo, ref or pull request is created from New, and deleting one
(which stops its notifications) is confirmed first. Select one to poll it
immediately and read the per-job report. An ad hoc check looks up any
repo/ref/PR without creating a watch. The detail always lists every job with
its own conclusion, marks continue-on-error jobs distinctly, and lists the
daemon's own reasons a verdict is not a clean pass.

## Library

Library holds what GoodVibes remembers and knows, in three sections: Memory,
Knowledge and Review. Review shows a count when something is waiting.

### Memory

Memory is the shared cross-surface memory store (terminal, agent, and browser
see the same records). Use it to:

- browse and search records; the recall-honesty details (which search mode
  actually ran, why the semantic index could not be consulted, exclusion
  counts) render verbatim from the daemon. A literal-match fallback says it
  is one
- add records
- delete records: deletion is real and verified (the page proves the record
  is gone rather than just dropping it from the list)
- read the read-only personas for constraint records

A daemon that does not serve memory at all gets an honest "this daemon does
not serve memory" state, never a blank panel that reads as empty.

### Knowledge

Knowledge is the regular GoodVibes Knowledge/Wiki surface. Browse shows what it
knows by subject: the subjects (the store's topics, first letter capital) on
the left, the facts filed under the chosen one on the right, each with "From
<source> · <when>" (on a phone the facts open as their own page with Back).
Facts are read from documents by the decision model; while sources are listed
and no fact names one, a line under the subjects says so ("Documents are listed
under Sources; facts are read from them when a decision model is set"). Below the subjects are the
sources it read, and a Details disclosure holds the graph itself: nodes with
their kinds and states, issues and wiki projections. It is also for asking the
knowledge base, searching it, the map, rendering projections when the
platform/daemon exposes them, and ingesting URLs or artifacts where supported.

Home Assistant Home Graph is not part of this page. If Home Graph data appears
in regular Knowledge results by default, that is an upstream scoping issue and
should be fixed in platform/daemon, not filtered in the WebUI.

### Review

Review presents daemon-selected records in one list: consolidation
proposals (contradictions, cross-scope duplicates, stale deletes) first, then
the memory review queue, then knowledge candidates. Selecting a proposal also
highlights the queue rows it points at. The queue and the candidate list each
load at most 50 rows and report no total, so a full page shows the tab count as
"50+" and a note that more may be waiting; decide some and the next ones appear.

## Personal

Personal has three sections: Calendar, Mail and Occasions.

### Calendar

Calendar renders events from the daemon's CalDAV-backed calendar module, with
ICS import and export. Three refusal shapes render distinctly: an unconfigured
daemon points at the bring-your-own-CalDAV config keys, a daemon build with no
calendar handler says the capability is missing, and a genuine error offers a
retry. None of the three is ever shown as a fake-empty calendar.

### Mail

Mail is the inbox, message reader, and composer over the daemon's `email.*`
verbs. The browser never holds a mail credential; every call goes through the
daemon. A daemon build with no mail handler renders an honest not-available
state, a handler with no account yet points at settings, and a genuinely empty
inbox says it is empty. When the surface is refusing, Send and Save draft are
disabled with the reason named beside them rather than left live to fail.

### Occasions

Occasions shows occasions and plans over the daemon's `occasions.*` verbs:
upcoming dates with real dates and day counts, pending questions to answer,
conflicts to resolve, interviews to continue, and gift history. Every
proximity word, lead time, and nudge rule is computed by the daemon; this
page only renders answers and calls the write verbs. It is a pull surface:
it never originates a nudge.

## Models and providers

Open Settings, Models and providers when the current model is wrong, the
composer's model list looks incomplete, a provider appears unavailable, or
account posture needs inspection. The page shows the current model (Change
opens the model browser), then the providers with their sign-in state, then
Credentials and Usage.

Provider status derives from the daemon's own per-route freshness rather than a
generic status guess. Open a provider for its models and sign-in routes.
Model selection is provider-first, so the model list is scoped to the selected
provider.

## Sign-in, devices and people

Settings, Account holds the supporting workflows:

- sign in with daemon-owned username/password auth, or paste and validate an
  operator token; inspect the current sign-in and passkey step-up
- the owner profile, mail and calendar accounts
- paired devices with their tokens (revoking one is a deliberate action), power
  keep-awake, and this browser as a phone node. Revoking a device or the
  shared token, removing a user or changing its password ends that
  credential's open connections and event streams at once; a single revoked
  sign-in session's streams end at their next event. Each is told the
  credential was revoked and to sign in or pair again
- People and channels: principals list every identity with its channel
  identities, and create, update and delete each go through a confirm sheet
  (delete is permanent); channel profiles list every surface/channel binding
  and the model, provider and permission defaults a channel's sessions inherit,
  with upsert and confirmed delete

Devices and pairing, People and channels and Check-ins also have their own
entries in the account menu.

## Check-ins

Check-ins live in Settings, Notifications. They show the proactive check-in
configuration with an edit control, a run-now trigger with its receipt inline,
and the receipts list. Every save is confirmed, because the configuration can
enable proactive contact. Each receipt states its outcome plainly, never
collapsed to a bare status dot.

The status row says whether the daemon's scheduler really holds the check-in
job: Enabled, scheduled; or Enabled, but not scheduled, with the reason (for
example, automation is turned off). A save that stored the settings but could
not schedule the job says so instead of reporting success. Turning automation
on schedules the job at once.

A check-in looks at what needs you: approvals and questions waiting in the
owner inbox, and automation runs that failed since the previous check-in. When
none of those is waiting, the run records Ran quiet without asking a model.
Messages a session has not picked up yet are listed as that, never as the
session waiting on you.

| Outcome | Meaning |
| --- | --- |
| Delivered | The check-in ran and something was sent |
| Ran quiet | The check-in ran and found nothing worth surfacing |
| Skipped: check-in is disabled | The scheduled run was skipped because the feature is off |
| Skipped: within quiet hours | The scheduled run was skipped by the quiet-hours window |
| Skipped | A run-now was skipped for a reason the daemon states generically |
| Error | The run failed; the error is shown |

## Phone node

The phone node page (reached from Settings, Account, Devices and pairing, or
the account menu) turns this browser into a paired device node. Open it on a phone, pair
once, and the device's capabilities become things the agent can ask for.
Nothing is served silently. Every capture and effect is confirmed with the
person first, and the page keeps an honest log of everything it served. A
capability the browser cannot actually provide on this origin is not
announced at all, so the desktop side explains why it is unavailable instead
of offering a control that would fail.

The node's peer token is never kept in browser storage. Paired directly, the
daemon holds it in an HttpOnly cookie of its own (`goodvibes_node`, sent only to
the peer routes under `/api/remote`, never usable as a sign-in), and the page
keeps only the node's id and name, so a reload stays paired. Paired over the
relay, the token is held in the page's memory and a reload asks to pair again.
Unpairing clears the cookie.

Pair this phone sends a pairing request that waits for the owner. It is
listed under "Waiting to pair" in Settings, Devices and pairing on any device
signed in as the owner (and by `/devices requests` in the terminal), with the
device's name, platform, the capabilities it offers and the node id it pairs
as; the list updates as requests arrive. Approve or Reject answers it (`/devices
approve <request>` and `/devices reject <request>` in the terminal). A request
that names a device already paired asks once more before it replaces that
device's pairing. After approving, press Finish pairing on the phone.

The capabilities a phone can announce:

| Capability | What it serves |
| --- | --- |
| Rear camera picture | A photo from the back camera |
| Front camera picture | A photo from the front camera |
| Screen picture | A capture of the phone's screen |
| Approximate location | A coarse position fix |
| Precise location | An exact position fix |
| Read the clipboard | The phone clipboard's current text |
| Put text on the clipboard | Writes text to the phone clipboard |
| Show a notification | Displays a notification on the phone |
| Open a link | Opens a URL on the phone |
| Vibrate | Buzzes the phone |

## Installing the app

The WebUI installs from the browser as a standalone app (add to home screen on
iOS/Android, install prompt on desktop). The installed app caches only the app
shell, never daemon data, so opening it offline shows the honest "can't
reach the daemon" state. Web Push subscription for approvals/completions lives
in Settings, Notifications. Install and push require HTTPS; see
[deployment.md](deployment.md).

## Expected failure handling

The WebUI should keep failures visible and retryable:

- send failures keep the draft behavior clear and mark local messages failed
- stale chat session ids are pruned when the daemon returns `SESSION_NOT_FOUND`
- auth failures land on the signed-out gate rather than a half-rendered shell
- provider/model failures should show daemon error text rather than silently
  falling back to invalid routes
- a daemon build that does not serve a verb family (mail, dates, calendar,
  memory) gets a stated not-available reading, never a blank page dressed as
  empty
