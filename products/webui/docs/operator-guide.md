# Operator guide

This guide describes the WebUI from an operator point of view.

Available actions depend on the selected daemon and its current authority. Native
work uses Jev admission and recorded outcomes.

## Navigation

GoodVibes has four places: Chat, Work, Library and Personal. The sidebar lists
them in order:

- New chat, a fresh conversation (G then N, outside a text field)
- Search (Ctrl K), the command palette

Every key named on the page follows the platform: on a Mac, iPhone or iPad,
Ctrl reads ⌘ (⌘ K, ⌘ B, ⌘ comma) and so does the key that works.
- Work, what is running for you and what needs you. Its dot or count is the
  number of items waiting on you.
- Library, what GoodVibes remembers and knows
- Personal, your calendar, mail and occasions
- Recent, your chats, newest first. Each row's "…" menu (shown on hover, on
  the open chat, and always on a touch screen and in the phone drawer) holds
  Rename, which opens the chat with its title ready to edit, and "Delete
  chat…", which asks before it deletes for good. Two chats whose titles read
  alike show when each was last used ("2h ago", "Nov 14") beside the title.

Work, Library and Personal open with a section switch across the top, so every
section inside them is one click away. Settings, Devices and pairing, People
and channels, and Check-ins are in the account menu at the foot of the
sidebar, together with the theme (Light, Dark, Auto and the opt-in GoodVibes
Neon), the connection to your daemon in plain words with its latency, "N
waiting for you" while something waits (it opens Work on only those), what is
running, and Sign out. While a recommended setup step is neither done nor
skipped, the menu starts with "Finish setting up" and how many are left. The
dot on your avatar is the connection at a glance; when the connection drops, a
toast and a thin banner say so. Settings also opens with Ctrl comma.

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
yourself stays collapsed. Pin it to keep it open beside a detail; that holds
wherever the window has room for the sidebar plus 880 for the detail and the
page beside it, and where it has not, the pin's label says the sidebar folds
while a detail is open. Hover the rail, or press Ctrl B while a detail holds it, to
see the full sidebar over the page. Drag its edge to resize it (220 to 360).

At phone width there is no rail: the sidebar is a drawer behind the header's
menu button (or a swipe from the left edge). Tapping the dimmed area beside it,
or picking anything in it, closes it. The drawer never traps.

## Settings

Settings is a dialog, not a page, so it opens over whatever you were doing.
Open it from the account menu, with Ctrl comma, or from a `?settings=<section>`
link. It has seven pages, each holding one or more sections; a search box at
the top finds a section by name or by the setting inside it. Its script loads
the first time it opens, as Work's, the Library's and Personal's do the first
time each is opened; the chat loads first.

Density (General, Display) set to Compact tightens rows and spacing in every
list (Work, Library, Personal, Settings, the sidebar, menus and the palette)
and in the transcript; on a touch screen rows keep their 44-point height and
only the spacing tightens.

Focus is always shown: a 2-point ring in the accent colour, which stands at
least 3 to 1 against every surface in every theme (dark, light and Neon); a
text field shows it on its box, and the row the keyboard is on in a menu, the
palette or the model menu carries an accent bar at its start.

| Page | Sections | What it covers |
| --- | --- | --- |
| General | Display, Network, About, Advanced | What is set up and what is left, theme (including GoodVibes Neon), density, reduce motion, how devices reach the daemon (Tailscale, relay, listeners), the daemon and connection status, and every remaining daemon setting |
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

General opens with "Setting up" and how many steps are done ("3 of 5 set up"):
connect a model provider, choose the model new chats use and decide when
GoodVibes asks you (each Recommended until done), get notified on this device
and pair a phone or another browser (Optional). Each step not done says why in
a sentence and has the button that opens where it is done, and "Skip for now"
(kept in this browser; "Show again" undoes it). Notifications on a page served
over plain http read "Not on this page" with the reason.

When the daemon serves a newer web UI than the one open, the page reloads by
itself as soon as nothing would be lost: no text typed and not sent, no reply
streaming, nothing open over the page. Until then the header shows a "Reload
to update" button, and the page reloads at the next moment those are all clear.

The wake word starts listening again by itself after it stopped, when a
microphone is plugged in or changed or the tab comes back into focus; its
indicator offers "Listen again" to start it at once.

Reduce motion (Settings, General) holds the page still in this browser: menus,
panels and notices appear without moving, the "Thinking…" line does not shimmer
and nothing scrolls smoothly. It is off until you turn it on and follows nothing
else, not your system's own motion setting. A screen reader hears "GoodVibes
is replying…" when a reply starts and "GoodVibes replied." when it ends, not the
reply word by word as it streams; the finished reply is the newest message.

## Signing in and pairing

The sign-in screen leads with scanning: "Run goodvibes pair on the computer
running GoodVibes, then scan the code it shows, or open the link it prints in a
browser on that computer." Run `goodvibes pair` in the terminal (or open the
desktop app's pairing panel) and either open the QR's link on the phone or press
"Scan the code" for the in-page camera scanner. On a daemon only its own machine
can reach (the default, bound to `127.0.0.1`), `goodvibes pair` draws no QR
code: it prints `This link signs in a browser on this computer. A phone cannot
open it: ...`, the steps that let a phone reach it (`goodvibes-daemon webui
enable --lan`), the link and a sign-in code; open the link in a browser on that
computer, or paste the code under "Other ways to sign in". A scanned code feeds the same
validation path as a pasted one, and the one-time secret is stripped from the
URL immediately so it never lingers in the address bar or history. Everything
else is under "Other ways to sign in": pasting a sign-in code by hand, the relay
code, username and password, and where to find a code.

In Settings, Devices and pairing, when a phone could not open a code because
the daemon serves only its own computer, the page asks "Phones on your network
cannot reach GoodVibes yet. Serve it to your network?" (No is the default),
saying that every device on the network can then reach the sign-in page and
only a device with a code signs in. "Yes, serve it to my network" asks the
daemon to serve the network and make the phone's code in one step; the code
(QR and link) shows when the daemon answers. No keeps the link for a browser
on the daemon's own computer, below. A refused sign-in code
says what can be wrong (already used, revoked, made for a different daemon, or
mistyped); a code that could not be checked because the page could not reach
GoodVibes says a phone must be on the same network or use Tailscale.

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
- send plain text with Enter; while a reply is running, Send reads "Queue"
  (its name is "Queue message after this reply") and the daemon queues the
  message behind the reply
- interrupt the running reply with the "Send now" button beside Queue, Ctrl+Enter
  or Cmd+Enter, or by holding Queue; each sends at once and interrupts the
  in-flight turn
- insert a newline with Shift+Enter
- stop generation with a server-side cancel; the stopped partial reply stays
  in the transcript with an honest stopped marker
- attach files through daemon artifact upload, and remove a sent file for good
  (see Attachments)
- copy whole messages and individual code blocks; on a phone each message shows
  Copy and a More menu holding Edit and resend, Resend or Regenerate, Read aloud
  and the reply's code and files, each by name
- wrap long lines in code blocks with the wrap button on any block; the choice
  holds for every code block on this device. Until it is made, code wraps on a
  screen narrower than 640 px and scrolls on a wider one, where a block with
  more to its right fades at its right edge and keeps a thin scrollbar
- open every file attached to or made in the chat, newest first, from the Files
  button in the chat header; each one jumps to the message that brought it
- resend user messages
- regenerate assistant replies; the superseded reply is retained, not erased
- edit a user message and branch; the old branch is kept
- switch between the versions of an edited message or a regenerated reply with
  the "‹ 2 of 3 ›" switcher under it ("Previous version", "Next version"): the
  version chosen goes on the conversation, the model continues from it, and it
  is still the one shown after leaving the chat and coming back, on any device.
  It waits while a reply is being written
- search chat history, both session titles across full history (a daemon-side
  search) and message text within recently loaded sessions
- see queued messages while a turn is active, and dictate or speak replies
  with the voice controls. A queued message whose chat closed, or whose daemon
  restarted, before it ran is marked "Not answered"; send it again to get a
  reply. A reply that could not be saved because the chat's storage was full or
  unwritable is retried by the daemon on its own, and the chat accepts changes
  again once that works

The model control in the composer reads the chat's model and effort ("Alpha
Chat 1 Medium"). One click opens one menu in three steps: the provider, then
that provider's models, then the chosen model's effort (only for a model that
has effort levels; the one in use is checked). Providers you are connected to
come first; the others are listed under "Not connected" with the one action
that connects them ("Connect in Settings", or "Sign in in Settings" for a
subscription, which is signed in to from Settings, Models and providers, in the
browser). With no model set up the control reads "Connect a model" and still
opens: the menu says "No model
is set up yet. Choose a provider to connect it in Settings." over the providers
to connect. Its label keeps at least six characters of the model's name; the
effort beside it gives way first. Each model says what it costs to use
("free", "paid", "subscription" or "price not known", the daemon's price
tier); when a model you use stops being free, the daemon's warning shows as a
notice that stays until you close it. Within a provider: Favorites (pinned
models), Recent, "Recommended" (at most five, each with why in the catalog's
own facts: "newest claude-sonnet", "largest context: 1M tokens", "lowest
price: $0.15 in, $0.60 out per 1M tokens"; none when the catalog has no such
facts for the provider), then the rest, and last, under "Not described by the
catalog", models marked "kind unknown"; image, speech and embedding models are
not listed. The filter box at the top searches every connected provider's
models at once. Keys: arrows move, Right or Enter goes into the next step, Left
or Escape goes back one step, typing filters. On a phone the same steps open in
a bottom sheet.

A pick is for this chat only, an open chat at once and a new chat when its first
message creates it; the menu says so ("For this chat only.") and offers "Make
this the default for new chats", which saves the chat's model and effort as the
default (also changed in Settings, Models and providers). When the chat's model
and effort already are the default, the menu says "This is the default for new
chats." instead. The menu opens beside the composer on the side with more room,
below the composer on a new chat and above it in an open chat, and stays there
through the three steps; a list longer than the room scrolls inside it. In a
window too short for six rows on either side of the composer, it opens in the
middle of the page over a dimmed backdrop; Escape or a click outside closes it. When a provider's list was read more than a
day ago the menu says when ("List read 3 days ago"), and when its last reading
failed it says "Could not read its list now"; "Refresh models" reads the lists
again from the providers (one provider in its step, every provider in the first
step) and says what it found, for example "Microsoft Foundry: 2 models found (1
new, 1 retired).".

A new chat offers starters. "What's on my calendar" and "Check my mail" show only
when that account answers a one-item read (the same reads Settings, Account shows
the account status from); "What's running" and "What do you remember about..."
always show.

Typing `/` lists what the composer can do from the browser, and only that:
`/new` starts a new chat; `/mcp` and `/payments` open their screens (schedules,
triggers, CI watches and check-ins are the Automation screen, in the command
palette); every other command with an action the daemon carries out for
the browser (`/calendar` and the rest) opens
that action's guided sheet, or the command palette narrowed to its actions when
it has several. Commands whose every action runs only in the terminal app are
not listed. Arrows move, Tab or Enter on a partly typed name completes it,
Enter on a whole name runs it, Escape closes the list. A listed command typed
with words after it is held ("takes nothing after it here"); any other
`/word` is not sent either: the composer says it is not a command here, points
at `/` and Ctrl K (⌘ K on a Mac), keeps the text, and offers "Send as a
message". A slash that starts a path (`/etc/hosts is broken`,
`/var/log/app.log`) is sent as written. The list of commands loads the first
time `/` is typed; a command sent before it has loaded runs once it has.

What you type in a chat and have not sent stays with that chat: it is still
there after going to Work and back or reloading the tab, and another chat shows
its own (a new chat has one too). Files attached and not sent stay with it the
same way. Sending clears it; signing out clears every chat's.

While a reply is being written, Escape stops it (the Stop button shows "Esc").
An approval card answers to its keys while it has focus (click it or Tab to
it): Y for "Yes, once", A for "Yes, and remember", N for "No", and a question's
options to their numbers; the keys show on the buttons while the card has
focus.

On a phone, when something outside this chat waits for you, a banner at the top
of the chat names the most urgent one (a purchase that goes ahead soonest
first, the order Work uses). With one waiting, "Open its chat" or "Open it"
opens it (its chat, where the card is, or its detail in Work); with more,
"Review 6" opens Work on only what waits for you. While a purchase window runs,
the banner adds "nearest: goes ahead in 8 min".

An approval or question a chat is waiting on appears in that chat, as a card
below the last message with its choices and the links "Why am I asked?" and
"Details" (the tool, the folder, the decision and the arguments, read when you
open it), and the chat header shows a chip ("asking you · 1") that lists them.
On a phone the header keeps the chat's title and that chip; the "When GoodVibes
asks" chip steps aside while it shows, and the chip's sheet ends with the mode
in force and Change. Otherwise on a phone the "When GoodVibes asks" chip is its
shield and one word for the mode in force ("Asking", "Jev"), so the chat's
title keeps its room; tapping it opens the whole line. Work lists the same asks. Once one is decided, here or
anywhere else, the card folds to one dim line saying what was decided ("You
said yes once", "You said yes and to remember: Any bun command in this
project", "You said no").

A turn's tool calls read as one collapsed line ("Read 2 files, edited 1 · 4 s")
that opens to one line per call, worded as the terminal words it; the raw
result is behind each call's Details. A call the model sent malformed reads
"The model's call to find was malformed; it was asked to send it again." (the
words written for the model are not shown). A long chat draws only the messages
near what is on screen; the rest keep their place and their words, so the
scrollbar, the browser's find, a selection across messages and jumping to a
message from search all work on the whole chat. A reply that failed or was refused is a
row in the conversation: what happened, the cause and what was changed, then
buttons for the next step (Try again, Use another model, Details, or Choose a
model or "How to sign in again" for a refusal, which opens Models and
providers). The prompt above it stays as typed, and
the row is the same after a reload.

## Command palette and guided sheets

Search (Ctrl K, ⌘ K on a Mac) opens the command palette: chats, places to go,
settings sections, and every slash-command action the daemon can run for the
browser (they load the first time the palette opens). Picking an action opens
its guided sheet, with the same blanks, the same sentence above the button and
the same "what happened" line as the terminal. A schedule or trigger described
in words is read back by the daemon first, and the sheet shows what will be
kept before you save it. An action only a terminal can do is not listed here;
it is run from the terminal app. New chat is G then N and Toggle theme is G then
T, both outside a text field: the browsers keep Ctrl Shift N, O and T for
themselves. The palette also opens four screens built the same way:
Schedules, MCP servers and tools, Repeat purchases, and Triggers. The same
actions and screens are listed when you type `/` in the chat composer (see
Chat).

## Attachments

Attachments are uploaded as daemon artifacts before the chat message is sent.

Expected flows:

- text only
- attachment only
- text plus attachments

If upload fails, the optimistic message is marked failed and the error remains
visible near the composer. Large outputs open in the artifacts slide-over.

A file attached in the composer comes off with the × on its chip before you
send. A file on a sent message has its own × ("Remove <name>"); it asks once,
because the file cannot be put back ("Remove notes.txt?", "The file is deleted
for good and cannot be put back. The message keeps a line saying it was
removed, and GoodVibes no longer gives the file to the model."). After Remove,
the file is gone from the daemon, the message shows "notes.txt was removed" in
its place, and later replies do not see it (the model is told only its name
and that it was removed). It is refused while a reply is being written or sends
are queued; stop the reply or let it finish, then remove it.

## Markdown responses

Assistant and Knowledge responses support Markdown rendering. Registered language
tags use their declared grammar. An untagged or unsupported fence is matched in the
page against the registered grammars (nothing is sent anywhere); it is coloured and
named only when the match is clear, else it is shown plain under "code" (a
directory tree or a sentence is never labelled with a guessed language).

Code block line numbers are optional and controlled from Settings, General. They are
decorative and are not copied.

## Voice

Spoken replies and microphone dictation are available in Chat:

- spoken replies synthesize through the daemon's text-to-speech route,
  batched and concurrency-capped, with quiet retry
- dictation records in the browser, transcribes over the daemon's
  speech-to-text, and always shows the transcript for review before send,
  never auto-sending. When the daemon has no speech-to-text provider and the
  browser has its own speech recognition (over HTTPS), the crossed mic's note
  offers "Dictate with this browser's speech service", saying that it sends
  what you say to the browser's maker; the words land in the draft the same way.
  Agreed once, the choice is remembered in this browser and the mic dictates
  in one tap; Settings, Voice, "Dictate with this browser's speech service"
  shows it and turns it off
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
unless you say no", naming the chat whose turn began it, or the schedule; the
most urgent first: a purchase window by the time it runs out, with a clock pill
"Goes ahead in 8 min" or "Waits until 14:05", a bar of the time spent and "Stop
it" on the row for one that goes ahead by itself, then what can't be undone
("Can't be undone", red edge), then what weakens a safety setting ("Weakens a
safety setting", amber edge), then the rest, newest first), Running now (each
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
switches between Active (the default), Waiting for you (only what waits, also
`?tab=waiting`) and Archive. Select a row to open its
detail beside the list (over the page on a phone); the browser's Back closes an
open detail first, and the next Back leaves the page (the same in Library and
Personal). A permission ask you answered is listed under "Your answers" in the
words it was asked in ("Run ls -la trays?") with what you said ("You said
yes", "You said no"). An ask opens as its card:
who asked and when, the question, what it acts on, what it will do, the
choices, and "Why am I asked?" and "Details" (the tool, its arguments, who
requested it, the session and the decision trail). "I'll handle this" marks an
ask as yours when more than one person can answer; "Withdraw this request",
after the answers on the card, is offered to the person who asked and takes
the request back (it is not an answer). On a purchase that goes ahead by
itself, the card says when and why in plain sight while its window runs. New offers Ask for work to be done, Run a
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

Choose New, Ask for work to be done, type what you want and press Send. Attach
files the way you do in a chat (Attach files, or drop them on the form), up to
8; past that the form says so and takes no more. The request's detail lists its
files. The
daemon decides whether it becomes work or a reply in a session and carries it
through; the message box stays open for the next message. Each message you sent
is a row with one status line. While the message is still moving it is read
again at once whenever the daemon reports a change to it (NATIVE_REQUEST_CHANGED)
or to its reply's session or its work's contract; nothing is read on a timer.
The line under it says when it was last read ("Updated 12 s ago") with
Refresh to read it again now. "Needs you" appears only when the daemon cannot go
on without you (an interrupted start, a reply that failed without changing
anything, a result that did not pass its final check), with the one button that
answers it; Cancel stops a message that is still in progress. Identifiers and
revisions are under Details. A message is kept in this browser only until the
daemon has finished with it.

Contract details show the original ask, criteria, recorded readings, checks,
attempts and terminal result. Inspection is read-only. Recorded confirmation or
escalation history does not create a new approval or owner-reply action.

Cost shows on a row only when the daemon priced it; an unpriced item shows no
cost rather than a fabricated zero. Changes arrive over a live subscription,
and a background poll keeps the list fresh while it is down.

### Sessions

Open sessions between turns sit behind their own line; the daemon sends them a
page at a time, and "Show older sessions" at the end of the list adds the next
older page below the ones already shown; once the oldest session is on screen
the line goes away. When a page cannot be read, the same line says why
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
- filter with the Filters button above the records (it shows how many are in
  force, "Filters · 2"), which opens the questions: "Applies where?" (scope),
  "What kind?", "Tagged with?", "Match how?" (by meaning, not exact words) and
  "Show which?" (only what the agent would recall); each filter in force is a
  chip beside the button that removes itself, with "Clear all"
- add records; each scope says where it applies (one conversation's work, this
  project, or how you work across projects) and that every app and device
  signed in to this daemon sees it. Scope does not hide a record or keep it out
  of answers
- read and set how sure each record is said to be: each row shows the rating
  as a small bar and its number ("82%") with "in answers", or "below floor"
  for a record the recall floor keeps out of answers, and its line says who
  rated it ("rated by you", "rated as saved"). One sentence above the records
  says what a rating is: given when it was saved or reviewed, not a
  measurement, and the floor below which records are not brought into answers
- see the store's point-in-time copies and restore one with "Copies and
  restore" beside Add memory
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

Calendar renders events from the daemon's calendar (a CalDAV server or the one
Google connection), with ICS import and export. Three refusal shapes render
distinctly: with no usable calendar the page reads "No calendar this daemon can
read" with the daemon's own words (which accounts exist, why none can be read,
and what connects one) and an Open settings button, a daemon build with no
calendar handler says the capability is missing, and a genuine error offers a
retry. None of the three is ever shown as a fake-empty calendar.

The agenda shows each event from its start to its end ("9:00 – 10:30 AM"; an
all-day event says so, with its number of days when it spans several), and the
header says once which time zone every time is in. The dates shown are picked
by name (Today, This week, Next two weeks, This month), with "Choose dates" for
two date fields; the calendar is picked by its name from the daemon's list.

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
Providers are listed in three bands: a sign-in that expired or is about to
first, then the configured ones, then those not set up. A subscription is
signed in to from this page, through the daemon: a provider whose
subscription sign-in expired (or is about to) says "Sign in again to keep
using the subscription." with a "Sign in again" button; one never signed in
has "Sign in" on its row and in its own page ("Subscription"). The button asks
the daemon to start the sign-in and shows "Open <provider>'s sign-in page";
sign in there. When the provider comes back to the daemon's own computer the
sign-in finishes by itself; otherwise paste the code, or the whole address the
page ended on, and press Finish. Either way the row updates by itself when the
daemon reports the sign-in done. A provider that takes an API key and is not set
up has "Add API key" on its row, and its own page has an "API key" section: type
the key and press Save. The daemon keeps it in its secret store and the row
turns signed in; the key is never shown again, and replacing it is the same
field. The model menu sends a provider that is not
connected here ("Sign in in Settings" for a subscription). "Status unavailable" says why and
what to do: the daemon did not say how the provider signs in (open it, or update
the daemon), or it reported a state this page does not read (reload the page).
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
- People and channels: "Who is who" lists every person, bot or service with
  their chat accounts, and adding, changing and removing each go through a
  confirm sheet (removing is permanent); channel profiles list every surface/channel binding
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
signed in as the owner (and in the Waiting to pair tab of Devices and network in
the terminal apps), with the device's name, platform, the capabilities it offers
and the node id it pairs as; the list updates as requests arrive. Approve or
Reject answers it (`a` and `x` there in the terminal). A request
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
