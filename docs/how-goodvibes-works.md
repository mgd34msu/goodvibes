# How GoodVibes works

This page explains how the parts of GoodVibes fit together: which program runs
what, where your work happens, and why it is built the way it is. To install
it, see the [installation guide](installation.md); to start using it, the
[repository README](../README.md).

## Four programs and one platform

GoodVibes is a suite of four programs that share one version and one platform:

| Program | What it is | Where it runs |
| --- | --- | --- |
| `goodvibes` | The terminal app for working in a project. | In your terminal, while you use it. |
| `goodvibes-agent` | The personal assistant in the terminal. | In your terminal, while you use it. |
| `goodvibes-daemon` | The background service. | All the time, as a user service. |
| The web UI | The browser app. | In your browser, served by the daemon. |

All four are built on the same platform, the GoodVibes engine: sessions, model
providers and routing, tools, agents, the knowledge and memory stores, the
permission and decision rules, and the typed methods the programs use to talk
to each other. Each program adds only what is its own: the terminal app its
screen, keys and project work; the Agent its assistant workspace and personal
tools; the daemon its long-running services; the web UI its pages. That is why
a setting, a command or a rule behaves the same in every program.

The terminal app and the Agent are built on the same terminal screen and
workspace foundations; what differs is what each is for. The Agent hands coding
work to the terminal app with `/agents hand-off`: the work becomes a new shared
session on the daemon, and the terminal app asks before it changes anything.

## What the daemon holds

The daemon is the one long-running host on a machine. It keeps running when no
terminal or browser is open, and it holds what has to outlive them:

- the scheduled and triggered work, watchers and check-ins;
- the chat channels (Telegram, Slack, Discord, email and the others), reading
  incoming messages and sending replies;
- the knowledge, memory and owner-inbox stores;
- hosted sessions, and the sessions shared between your programs;
- paired devices, sign-in and the web UI, which it serves;
- the control plane: the HTTP, Server-Sent Events and WebSocket interface every
  other program and device uses;
- machine groups (clusters), when you set one up;
- its own updates, and the updates of the whole suite.

The terminal app and the Agent connect to the daemon on their own machine, or
to one on another machine you point them at. They never start a daemon inside
themselves: a terminal app finds the running daemon over loopback, and when the
daemon is installed as a service but stopped, it starts that service once and
waits for it. The HTTP listener and the web surface belong to the daemon; the
terminal app can change their settings and shows where they are bound, but does
not host them. The web UI runs entirely against the daemon.

## Where your conversation runs

A conversation in the terminal app or the Agent runs in that program's own
process: the model calls, the tools and the edits to your files happen there,
with your provider keys on that machine. The daemon supplies what is shared:
schedules, channels, memory, the sessions other programs can see, and the
answers to questions waiting for you. The Agent runs the assistant itself, its
workspace and the Agent Knowledge it keeps for you; the platform capabilities it
shows you are performed by the daemon it is connected to. A conversation in the
web UI runs on the daemon.

Helper agents run inside the same process as the conversation that started
them, not as separate programs. Each one has its own set of tools and its own
state, so they stay apart from each other without the cost of starting and
talking to another program.

## One interface for every client

The daemon offers typed methods over HTTP, Server-Sent Events and WebSocket, and
every client uses them: the terminal programs, the web UI (also when a phone
installs it as an app), the Home Assistant integration, and scripts. No client
reimplements what the platform does; each one calls the same method. A new
capability added to the daemon is therefore the same capability in every client
that shows it.

The programs also check each other's builds. A daemon accepts programs of its
own release line and newer, and each program refuses a daemon older than it
needs; what you see when that happens is in
[When a program is older than the daemon requires](installation.md#when-a-program-is-older-than-the-daemon-requires).

## Design decisions

- **Bun.** The terminal app, the Agent and the daemon run on the Bun runtime:
  TypeScript runs directly, they start quickly, and the released programs are
  compiled executables that need no Bun or Node on your machine. The web UI is
  a browser app built against the same platform methods.
- **One terminal renderer.** The terminal programs write the screen themselves,
  straight to the terminal's alternate screen, with control over every byte
  sent. The conversation, modals, overlays and the status bar all go through
  that one renderer. Render requests made in the same moment are drawn as one
  frame, and when the conversation grows only the new message is drawn, not the
  whole conversation again.
- **One runtime store.** A program's state lives in one typed store that the
  agents, tools, screen, hooks, channels and daemon connections all read and
  change the same way.
- **Code understanding built in.** Tree-sitter grammars give structural
  analysis, outlines and edits by syntax tree, several embedded so they are
  ready at start. Language servers for TypeScript, Python, Bash, CSS, HTML and
  JSON come with the program; `rust-analyzer` (checksum-verified) and `gopls`
  are downloaded only when you run `/intelligence install`. After an edit, the
  agent is told the type errors the running language server finds in the new
  text.
- **Crash recovery.** A snapshot of the session is written when a prompt is
  accepted and after each batch of tool calls, and offered at the next start.
- **Your machine holds your data.** Settings, sessions, secrets and memory are
  plain files under `~/.goodvibes` and the project's `.goodvibes/` folder. What
  leaves the machine is what you send to the models you choose, and the
  decision requests sent to the decision model when one is set
  ([what one request sends](decision-model-policy.md#what-one-decision-request-sends)).
- **Old links keep working.** Earlier web UI addresses still open the matching
  part of Chat, Work, Library, Personal or Settings, with their deep links.

## Read more

- [Permission modes and the decision model](decision-model-policy.md): how
  much you are asked and who decides the rest.
- [The daemon](../products/daemon/README.md) and its
  [configuration](../products/daemon/docs/configuration.md).
- [Remote access](../products/tui/docs/remote-access.md): an always-on daemon on
  a home server, reached from a browser or a terminal app elsewhere.
- [Pairing](../packages/engine/docs/pairing.md): how phones and other devices
  sign in to the daemon.
- [The engine](../packages/engine/README.md), for building your own client on
  the same methods.
