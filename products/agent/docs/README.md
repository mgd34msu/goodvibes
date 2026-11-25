# GoodVibes Agent docs

These are the package-facing docs for the GoodVibes Agent `3.3.x` release line.

## Current docs

- [Docs index](README.md)
- [Getting started](getting-started.md)
- [Connected host](connected-host.md)
- [Knowledge, artifacts, and multimodal](knowledge-artifacts-and-multimodal.md)
- [Tools and commands](tools-and-commands.md)
- [Headless run](headless-run.md)
- [Screen readers and accessibility](accessibility.md)
- [Channels, remote access, and API](channels-remote-and-api.md)
- [Providers and routing](providers-and-routing.md)
- [Voice and live TTS](voice-and-live-tts.md)
- [Google setup runbook](../../../packages/engine/docs/google-setup-runbook.md) (also printed by `/google runbook`)
- [Google scope strategy](google-scope-strategy.md)
- [Model catalog search](model-catalog-search.md)
- [Personal operations and routing](personal-operations-and-routing.md)
- [Explicit Agent pairing](setup-explicit-pairing.md)
- [Native legacy import and recovery](legacy-ledger-migration.md)

## Baseline

- Package executable: `goodvibes-agent`.
- Install: the [suite installer](../../../docs/installation.md); the installed program needs no Bun or Node.
- Version: `goodvibes-agent --version`; the suite shares one version.
- Connected-host compatibility: public Agent routes report readiness through the `compat` and `status` CLI commands plus `host action:"status"`.
- Connected host: owned outside Agent; Agent reports and uses it and does not manage its lifecycle, with two exceptions: the boot-time start of an installed but stopped host, and the daemon repair the person chooses in a question at start (see [Connected host](connected-host.md)).
- Agent Knowledge: only `/api/goodvibes-agent/knowledge/*`; no default knowledge fallback.
- Local state: VIBE.md personality, project context files, memory, notes, personas, skills, routines, sessions, setup, and profiles live under the Agent home or current project.
- Computer work: local read/edit/exec routes are allowed when the current Agent workspace and permissions are sufficient; process monitor/live tail/tool inspector supervision and local file edit/write recovery are inspectable and confirmation-gated; delegation is for isolation, parallelism, remote execution, separate worktrees, or user-requested delegated review.

## Model access baseline

The main Agent model reaches Agent-controlled product surfaces through Agent-owned tools. The full tool catalog, action values, and confirmation rules live in [Tools and commands](tools-and-commands.md); this baseline names the families so a reader knows what exists before opening that page.

- `setup` walks the first-run path, covering status, single-item lookup, checkpoint inspect/save/clear, connected-host token repair, setup smoke checklist and evidence, onboarding finish, and GoodVibes settings import, all through the existing setup gates.
- `models` reads provider/model route readiness, provider and subscription posture, and the hardware-scored local model cookbook, and runs confirmed local server smoke checks.
- `settings` lists, gets, sets, and resets Agent settings, and previews or applies shared GoodVibes settings import behind redacted confirmation gates.
- `agent_harness` is the deep inspection surface. It serves the same assistant cockpit shown in TUI Home, searchable mode discovery, the workspace/command/keybinding/tool catalogs, channel and setup posture, the visible autonomy queue with live records and log tails, execution and delegation posture, service and connected-host posture, and operator/audit release artifacts.
- `computer` and `device` cover browser/PWA readiness, browser/screenshot/desktop-control route planning, companion/mobile pairing posture, and voice/TTS provider routes, with confirmation-gated handoffs for anything that opens a visible surface.
- `agent_knowledge` reads isolated Agent Knowledge, and `agent_knowledge_ingest` writes to it after confirmation.
- `vibe` inspects VIBE.md personality state and, with confirmation, initializes a project or global VIBE.md or imports one as an Agent-local persona.
- `personal_ops` serves the daily briefing, readiness status, saved review queue, request intake, lane inspection, and one confirmed read-only inbox/calendar connector read.
- `memory`, `agent_local_registry`, and `agent_learning_consolidation` manage Agent-local memory, notes, personas, skills, bundles, and routines, including the learning curator's review queues and confirmed duplicate-consolidation phases with receipts.
- `agent_work_plan` is the Agent's todo list for the project: it records work and its status and does not run it; the owner starts work with `/work`.
- `agent_operator_briefing`, `agent_operator_action`, and `agent_operator_method` read connected operator state and run exact confirmed approval/automation/schedule actions or daemon methods.
- `agent_documents`, `agent_review_packet_presets`, `agent_review_packet_share`, `agent_artifacts`, `research`, and `agent_model_compare` cover versioned document drafts with review comments and AI suggestions, reusable review packets with freshness checks, saved artifact browse/export/package/archive, visible research runs with source queues and sourced report artifacts, and confirmed blind model comparison with route-decision receipts.
- `agent_channel_send`, `agent_notify`, `schedule`, and `agent_media_generate` perform explicit confirmed effects, returning channel-send receipt ids, webhook notifications, connected schedules and reminders with lifecycle controls, and generated media artifacts.

Catalog modes are compact by default. `agent_harness mode:"modes"` searches all harness modes; `mode:"mode"` inspects one mode contract. Plural catalog rows keep summaries short and expose effect class, `modelRoute`, or `modelAccess` hints where the model needs an immediate route decision. Detailed schemas, route hints, redacted log tail, release artifact data, and editor fields require `includeParameters:true` or a singular inspect mode.

The slash-command and CLI catalogs mirror every registered built-in command with policy and preferred model route metadata available to the model. Keybinding and fixed-shortcut rows identify direct model routes versus direct-user-only controls. Registered tool definitions use short top-level descriptions, omit nested parameter descriptions from the default model catalog, and carry direct harness inspection routes. Mutations, external delivery, UI routing, keybinding changes, setting writes, local destructive actions, media generation, reminders, and connected-host operator actions remain confirmation-gated and refuse ambiguous lookup.
