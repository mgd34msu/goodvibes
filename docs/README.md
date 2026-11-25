# GoodVibes documentation

Every guide and reference page for GoodVibes, grouped by what you are trying to
do. The [repository README](../README.md) is the short introduction; this page
leads to everything deeper.

## Get started

- [Installation, updates and uninstall](installation.md): install the suite, the installer's options, automatic updates, rollback, and what to do when an install fails.
- [Windows](windows.md): running GoodVibes inside WSL2.
- [Terminal app: getting started](../products/tui/docs/getting-started.md): first run, providers and keys, and your first conversation in a project.
- [Agent: getting started](../products/agent/docs/getting-started.md): first run of the personal assistant and what it can do.
- [How GoodVibes works](how-goodvibes-works.md): how the four programs fit together, before you go further.

## Use the terminal app (`goodvibes`)

- [Terminal app overview](../products/tui/README.md): a tour of the app, its keys, settings and where it stores things.
- [The terminal app's own docs index](../products/tui/docs/README.md): its pages listed by topic.
- [Providers and routing](../products/tui/docs/providers-and-routing.md): model providers, local model servers, failover groups, per-job models and custom providers.
- [Configuration reference](../products/tui/docs/configuration.md): how settings are layered and what each key does.
- [Tools and commands](../products/tui/docs/tools-and-commands.md): the built-in tools, agents, hooks, plugins, MCP servers and the full key bindings.
- [Command-line flags](../products/tui/docs/cli-flags.md): starting, resuming and forking sessions, `run` for scripts, and output formats.
- [Work on the host](../products/tui/docs/native-work.md): `/work`, tasks the daemon keeps with what done means, and recovering a lost request.
- [The native work ledger](../products/tui/docs/native-work-ledger.md): choosing the daemon project `/work` acts on, and what its views show.
- [Planning and saved planning records](../products/tui/docs/project-planning.md): how planning works now and what happened to the older planning interview.
- [Knowledge, artifacts and multimodal](../products/tui/docs/knowledge-artifacts-and-multimodal.md): session memory, durable memory, the knowledge store, artifacts, images and documents.
- [Session durability](../products/tui/docs/session-durability.md): the saved session and the crash snapshot offered at the next start.
- [Saving and uploading a session](../products/tui/docs/share-command.md): saving this conversation as a file and uploading it for a link, formats and redaction.
- [Voice and live TTS](../products/tui/docs/voice-and-live-tts.md): spoken answers and the speech providers.
- [Sandbox](../products/tui/docs/sandbox.md): how shell commands are contained on Linux.
- [Accessibility](../products/tui/docs/accessibility.md): using the terminal app with a screen reader.

## Use the Agent (`goodvibes-agent`)

- [Agent overview](../products/agent/README.md): what the personal assistant is for and a short tour.
- [The Agent's own docs index](../products/agent/docs/README.md): its pages listed by topic.
- [Tools and commands](../products/agent/docs/tools-and-commands.md): the workspace, its slash commands and the CLI subcommands.
- [Personal operations and task routing](../products/agent/docs/personal-operations-and-routing.md): how a personal request (mail, calendar, reminders, notes) is routed to the right job.
- [Providers and routing](../products/agent/docs/providers-and-routing.md): which model answers and how to change it.
- [Model catalog search](../products/agent/docs/model-catalog-search.md): how the Agent finds and compares models.
- [Knowledge, artifacts and multimodal](../products/agent/docs/knowledge-artifacts-and-multimodal.md): Agent Knowledge, the Agent's own store, and files and images.
- [Voice and live TTS](../products/agent/docs/voice-and-live-tts.md): spoken turns in the Agent.
- [Connected host](../products/agent/docs/connected-host.md): the daemon the Agent works through and what it provides.
- [Pairing the Agent with a daemon](../products/agent/docs/setup-explicit-pairing.md): when pairing is needed and how to do it.
- [Channels, remote access and API](../products/agent/docs/channels-remote-and-api.md): reaching the Agent from other surfaces through its host.
- [Google scopes](../products/agent/docs/google-scope-strategy.md): which Google permissions GoodVibes asks for, and why.
- [Old planning records](../products/agent/docs/legacy-ledger-migration.md): work brought in from earlier versions' planning, kept as history in the Work place.
- [Accessibility](../products/agent/docs/accessibility.md): using the Agent with a screen reader.

## Use the web app

- [Web app overview](../products/webui/README.md): opening the web app and signing in from a phone.
- [Operator guide](../products/webui/docs/operator-guide.md): every part of the web app, from signing in to settings.
- [Screenshot tour](../products/webui/docs/screenshot-tour.md): the web app's views, in pictures.
- [Reaching it from another machine, and installing it](../products/webui/docs/deployment.md): serving to your network and installing it as an app.
- [Approval actions from a push notification](../products/webui/docs/push-approval-actions.md): answering an approval straight from a notification.
- [Security notes](../products/webui/docs/security.md): how the web app keeps your sign-in and data safe.
- [Known limitations](../products/webui/docs/known-limitations.md): what the web app does not do yet.
- [Troubleshooting](../products/webui/docs/troubleshooting.md): when the address does not answer or a view fails.

## Run the daemon and reach it from other devices

- [Daemon overview](../products/daemon/README.md): what the background service does and the commands you are likely to use.
- [Daemon command reference](../products/daemon/docs/commands-reference.md): every `goodvibes-daemon` command, flag and refusal.
- [Daemon configuration](../products/daemon/docs/configuration.md): where its settings live and how to change them.
- [Hosted sessions](../products/daemon/docs/hosted-sessions.md): conversations that run inside the daemon, and detaching, stopping and recovering them.
- [Daemon troubleshooting](../products/daemon/docs/troubleshooting.md): start-up, sign-in, binding and service problems.
- [Pairing](../packages/engine/docs/pairing.md): how phones and other devices sign in to the daemon, and what each address gives them.
- [Host pairing for the terminal app](../products/tui/docs/host-pairing.md): giving the terminal app its own credential for a daemon.
- [Remote access: a home server setup](../products/tui/docs/remote-access.md): an always-on daemon reached from a browser or a terminal app elsewhere.
- [Deployment and services](../products/tui/docs/deployment-and-services.md): the ways to run GoodVibes, the background service and inbound TLS.
- [The relay](../packages/engine/docs/relay-zero-knowledge.md): reaching your daemon from outside your network without trusting the relay.
- [Machine groups](../packages/engine/docs/cluster-operations.md): creating, joining and leaving a group of daemons, and what each outcome means.
- [Machine groups during upgrades](../packages/engine/docs/cluster-ranking.md): which machine handles incoming messages while a group upgrades.
- [Saved data across updates](../packages/engine/docs/native-reader-compatibility.md): how programs protect saved data from an older build after an update or rollback.
- [Channels, remote runtime and API](../products/tui/docs/channels-remote-and-api.md): Slack, Discord, Telegram and the other channels, remote peers, and the daemon's HTTP API.
- [Telegram](../packages/engine/docs/telegram-integration.md): setting up a Telegram bot as a way to reach GoodVibes.
- [Inbound email](../packages/engine/docs/inbound-email.md): how the daemon reads and screens your mail.
- [Connecting a calendar](../packages/engine/docs/calendar-oauth-setup.md): registering your own Google or Microsoft app so GoodVibes can read your calendar.
- [Home Assistant](../products/tui/docs/homeassistant-surface.md): setting up the Home Assistant surface, with the [integration details](../packages/engine/docs/homeassistant-integration.md).
- [Cloudflare batch](../products/tui/docs/cloudflare-batch.md): optional Cloudflare Workers and Queues for batch work.
- [Daemon batch processing](../packages/engine/docs/daemon-batch-processing.md): queuing requests for providers' batch APIs.
- [Local voice engines](../packages/engine/docs/voice-local.md): free, offline speech-to-text and text-to-speech.
- [The wake word](../packages/engine/docs/wake-word-model.md): the `hey goodvibes` model and how well it works.

## Permissions and the decision model

- [Permission modes and the decision model](decision-model-policy.md): how much you are asked, who decides the rest, and what a decision request sends.
- [Tool safety](../packages/engine/docs/tool-safety.md): what stops a tool call, and the access you configure yourself.
- [Purchases](../packages/engine/docs/payments.md): cards, spending limits and the windows in which you can stop a purchase.
- [Owner profile](../packages/engine/docs/owner-profile.md): what GoodVibes knows about you and how you change it.
- [The Jev decision layer](../packages/judgment/README.md): how decisions are asked, answered and recorded.
- [Security policy](../SECURITY.md): how to report a vulnerability.

## Automate and script it

- [Headless runs](../products/agent/docs/headless-run.md): running one request from a script, its output and limits.
- [Exit codes](exit-codes.md): the exit codes of every program, for scripts to branch on.
- [Automation and watchers](../packages/engine/docs/automation.md): schedules, triggers and watchers that run without a conversation.
- [Occasions and plans](../packages/engine/docs/occasions.md): birthdays and other dates the daemon keeps, and the plans made for them.
- [GitHub Action](../products/tui/docs/github-action.md): running GoodVibes in a GitHub workflow.
- [Editors over ACP](../packages/engine/docs/acp-agent.md): using GoodVibes from an editor that speaks the Agent Client Protocol.
- For a language model or an agent operating GoodVibes, the parts of the full reference:
  [overview](llms/00-overview.md), [installing and updating](llms/10-install.md),
  [the terminal app](llms/20-terminal-app.md), [the Agent](llms/30-agent.md),
  [permissions and decisions](llms/40-permissions-and-decisions.md),
  [automation and services](llms/50-automation-and-services.md),
  [the daemon and networking](llms/60-daemon-and-network.md),
  [the operator API](llms/70-api.md) and [reference lists](llms/90-reference.md).

## Understand how it works

- [How GoodVibes works](how-goodvibes-works.md): the four programs, what the daemon holds, where your conversation runs, and the design decisions.
- [Runtime orchestration](../packages/engine/docs/runtime-orchestration.md): how a request becomes model calls and tool calls, and how completion is checked.
- [Tool system](../packages/engine/docs/tools.md): how tools are registered and run for sessions and agents.
- [Providers](../packages/engine/docs/providers.md): how providers and models are registered, routed and failed over.
- [Knowledge system](../packages/engine/docs/knowledge.md): the persistent, structured memory behind GoodVibes.
- [Knowledge refinement](../packages/engine/docs/knowledge-refinement.md), [generated knowledge pages](../packages/engine/docs/knowledge-pages.md), [browser history](../packages/engine/docs/knowledge-browser-history.md) and [Home Graph](../packages/engine/docs/home-graph.md): how the knowledge store is kept useful and what feeds it.
- [Project planning](../packages/engine/docs/project-planning.md): the work plan a project keeps.
- [Contract criteria](../packages/engine/docs/contract-criteria.md): how a piece of work's acceptance criteria are traced and checked.
- [Channel surfaces](../packages/engine/docs/channel-surfaces.md): how messaging systems connect to the platform.
- [Companion message routing](../packages/engine/docs/companion-message-routing.md): where a message from a phone or another surface goes.
- [Media and web search](../packages/engine/docs/media-and-search.md): media, multimodal analysis, artifacts and web search.
- [Voice](../packages/engine/docs/voice.md): how voice providers and streaming speech work.
- [Capability bundles](../packages/engine/docs/plugin-bundles.md): how plugins declare what they can do and are pinned.
- [Feature settings](../packages/engine/docs/feature-settings.md): how every capability is turned on and off.
- [Cancelling one hosted turn](../packages/engine/docs/hosted-turn-cancellation.md): what stopping a turn stops, and what it leaves running.
- [Security](../packages/engine/docs/security.md): the platform's security model.
- [Observability](../packages/engine/docs/observability.md) and [performance](../packages/engine/docs/performance.md): logs, traces, metrics and tuning.

## Build your own client

- [The engine](../packages/engine/README.md): building a client on the same methods the programs use, and the engine's [own docs index](../packages/engine/docs/README.md).
- [Getting started with the platform](../packages/engine/docs/getting-started.md), [entry points](../packages/engine/docs/packages.md), [public surface](../packages/engine/docs/public-surface.md), [runtime surfaces](../packages/engine/docs/surfaces.md) and [exports](../packages/engine/docs/exports.md): what to import for each runtime.
- [Authentication](../packages/engine/docs/authentication.md), [secret references](../packages/engine/docs/secrets.md), [transports](../packages/engine/docs/transports.md), [realtime and telemetry](../packages/engine/docs/realtime-and-telemetry.md) and [retries and reconnect](../packages/engine/docs/retries-and-reconnect.md): signing in and staying connected.
- [Error handling](../packages/engine/docs/error-handling.md) and [error kinds](../packages/engine/docs/error-kinds.md): what can fail and how to tell.
- [Browser](../packages/engine/docs/browser-integration.md), [web UI](../packages/engine/docs/web-ui-integration.md), [React Native](../packages/engine/docs/react-native-integration.md), [Expo](../packages/engine/docs/expo-integration.md), [Android](../packages/engine/docs/android-integration.md) and [iOS](../packages/engine/docs/ios-integration.md) integration, with [companion app patterns](../packages/engine/docs/companion-app-patterns.md) and the [companion wire protocol](../packages/engine/docs/companion-wire-protocol.md).
- [Embedding the daemon](../packages/engine/docs/daemon-embedding.md) and the [embedding API](../packages/engine/docs/embedding-api.md): hosting the platform inside your own Bun program.
- [The operator OpenAPI contract](../packages/engine/docs/openapi-contract.md) and the [provider and model API](../packages/engine/docs/provider-model-api.md): the HTTP methods in detail.
- [Network defaults](../packages/engine/docs/defaults.md) and the [semver policy](../packages/engine/docs/semver-policy.md): timeouts and retries, and what counts as a breaking change.
- [Engine troubleshooting](../packages/engine/docs/troubleshooting.md): common client problems.

## Releases

- [3.5.0](releases/3.5.0.md), [3.4.8](releases/3.4.8.md), [3.4.6](releases/3.4.6.md), [3.4.5](releases/3.4.5.md), [3.4.4](releases/3.4.4.md), [3.4.3](releases/3.4.3.md), [3.4.2](releases/3.4.2.md), [3.4.1](releases/3.4.1.md), [3.4.0](releases/3.4.0.md): what changed in each 3.4 and 3.5 release.
- [3.3.4](releases/3.3.4.md), [3.3.3](releases/3.3.3.md), [3.3.2](releases/3.3.2.md), [3.3.1](releases/3.3.1.md), [3.3.0](releases/3.3.0.md), [3.2.0](releases/3.2.0.md): what changed in each 3.2 and 3.3 release.
- [3.1.6](releases/3.1.6.md), [3.1.5](releases/3.1.5.md), [3.1.4](releases/3.1.4.md), [3.1.3](releases/3.1.3.md), [3.1.2](releases/3.1.2.md), [3.1.1](releases/3.1.1.md), [3.1.0](releases/3.1.0.md), [3.0.0](releases/3.0.0.md): what changed in each 3.0 and 3.1 release.
- [2.0.25](releases/2.0.25.md) and its [rebuild](releases/2.0.25-rebuild.md): the last 2.x release.
- [Suite changelog](../packages/engine/CHANGELOG.md): every change, release by release.
