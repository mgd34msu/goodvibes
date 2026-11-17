# Configuration reference

Settings are layered, not stored in a single working-directory file. Four layers apply in order, and each later layer wins over the ones before it:

| Layer | Source |
| --- | --- |
| 1. Defaults | Built into the platform config schema |
| 2. Global TUI settings | `~/.goodvibes/tui/settings.json` |
| 3. Project settings | `.goodvibes/tui/settings.json` in the working directory |
| 4. CLI/runtime overrides | Flags at launch and live changes made during the session | The shared file `~/.goodvibes/goodvibes.json` is reserved for future
cross-app state; TUI settings do not live there.

A project settings file travels with a repository, so whoever wrote the
repository wrote it. It can set only what is safe to take from a repository:
`display.*`, `ui.*`, `behavior.*`, `contract.*` (except `contract.gates`, which
runs commands), `worktree.setup.carryOverGlobs`, the checkpoint settings other
than `checkpoints.allowBroadRoot`, `agents.passiveInjection.*` and the context
window settings, and `permissions.mode`, `permissions.tools.*`,
`behavior.autoApprove` and `sandbox.enabled` only in the stricter direction.
Every other key in a project file, including `statusline.*`, provider and model
choices, judgment settings, destinations and the update feed, is skipped with a
notice naming it; set those in your own `~/.goodvibes/tui/settings.json`.

Most settings live under the schema owned by the platform config system and
are editable live from the fullscreen `/config` workspace or `/settings`. See
[Key settings](#key-settings) below for a curated reference table of the most
commonly used ones. This page also documents the additional TUI-owned
namespaces you can add by hand to your settings file (further down). Those are
read directly from the settings file, and a missing or malformed value falls
back to the built-in default rather than erroring.

Settings sit next to several other stores that follow the same global-versus-project split:

| Path | What it holds |
| --- | --- |
| `~/.goodvibes/tui/secrets.enc` and the project's `.goodvibes/tui/secrets.enc` | Secure encrypted secrets; a key in the project's store is used once you stored it there or confirmed it with `/secrets trust <KEY> --yes` |
| `~/.goodvibes/goodvibes.secrets.json` and the project's `.goodvibes/goodvibes.secrets.json` | Plaintext compatibility secrets, with the same confirmation rule for the project's file |
| `~/.goodvibes/tui/services.json` | The service registry, backing auth/account surfaces in the TUI and daemon; a project's `.goodvibes/tui/services.json` adds only services whose credentials are keys in your store. A service's credential is sent by name only to its own `baseUrl` origin |
| `~/.goodvibes/tui/providers/*.json` | Custom provider JSON |
| `~/.goodvibes/tui/keybindings.json` | Keybinding overrides |
| `.goodvibes/tui/repl-history.json` | REPL history |
| `.goodvibes/tui/automation-jobs.json` | Scheduled and automation jobs |

## Key settings

These settings live in the platform-owned config schema, not in the
TUI-extension namespaces documented further down this page. Edit them from the
fullscreen `/config` workspace or `/settings`; the table below is listed here
for reference.

| Key | Default | Description |
|-----|---------|-------------|
| `display.stream` | `true` | Stream responses token by token |
| `display.lineNumbers` | `off` | Line-number mode: `off`, `code`, or `all` |
| `display.collapseThreshold` | `30` | Lines before a block auto-collapses |
| `display.theme` | `goodvibes` | Terminal palette: `goodvibes`, `goodvibes-neon`, `catppuccin`, `tokyonight`, `dracula`, `nord`, `gruvbox`, `one-dark`, `rosepine`, `solarized`, `github`, `system`, or the retained `vaporwave` alias for `goodvibes-neon` |
| `display.themeMode` | `auto` | Light/dark appearance: `auto` probes the terminal background once at startup, `dark`/`light` force a fixed appearance. Independent of `display.theme` |
| `display.showThinking` | `false` | Show model thinking traces |
| `display.showTokenSpeed` | `false` | Show tokens/sec in status bar |
| `provider.model` | `openrouter:openrouter/free` | Active model ID, provider-qualified as `<provider>:<model>` |
| `provider.reasoningEffort` | `medium` | Reasoning depth for supported models |
| `provider.systemPromptFile` | `` | Path to a custom system prompt file |
| `behavior.autoApprove` | `false` | Deprecated alias for the `yolo` execution mode |
| `behavior.autoCompactThreshold` | `80` | Context % before auto-compact triggers |
| `behavior.saveHistory` | `true` | Persist conversation history |
| `behavior.returnContextMode` | `off` | Session return-context mode: `off`, `local`, `assisted` |
| `behavior.notifyOnComplete` | `true` | Emit terminal bell and desktop notification when a long turn completes or fails (not when you cancel it) |
| `behavior.guidanceMode` | `minimal` | Operational guidance mode: `off`, `minimal`, `guided` |
| `storage.secretPolicy` | `preferred_secure` | Secret storage policy: prefer secure backing store, fall back when allowed |
| `permissions.mode` | `safe-owner` | Execution mode: `safe-owner`, `safe-jev`, `yolo`, or `plan` |
| `ui.systemMessages` | `panel` | Routing target for general system messages (`panel`, `conversation`, or `both`); every value shows them inline in the transcript |
| `ui.operationalMessages` | `panel` | Routing target for operational runtime notices (`panel`, `conversation`, or `both`); every value shows them inline in the transcript |
| `ui.contractMessages` | `both` | Routing target for contract lifecycle updates: status, checks, corrections, owner questions and the outcome (`panel`, `conversation`, or `both`); every value shows them inline in the transcript |
| `service.enabled` | `true` | Enable service-install and daemon-management verbs, including the standalone daemon's self-promotion to a supervised service at its first idle moment |
| `service.autostart` | `false` | Install/enable or disable/remove the OS autostart service |
| `service.restartOnFailure` | `true` | Restart managed daemon services after failure |
| `controlPlane.hostMode` | `local` | Control-plane bind mode: `local`, `network`, or `custom` |
| `controlPlane.port` | `3421` | Control-plane daemon/API port |
| `httpListener.port` | `3422` | Webhook/event listener port |
| `web.enabled` | `true` | Enable the browser operator surface (bound to loopback until `web.hostMode` is widened) |
| `web.hostMode` | `local` | Web surface bind mode: `local`, `network`, or `custom` |
| `web.port` | `3423` | Web/browser surface port |
| `orchestration.recursionEnabled` | `false` | Allow recursive agent orchestration under bounded policy controls |
| `orchestration.maxDepth` | `0` | Maximum recursive orchestration depth: `0` disables, higher values (up to `5`) allow deeper bounded recursion |
| `daemon.enabled` | `true` | Whether this client adopts a running daemon at all. It does not start one itself; see [deployment-and-services.md](deployment-and-services.md) |
| `danger.httpListener` | `false` | Enable HTTP webhook listener |
| `tools.autoHeal` | `false` | Auto-fix syntax errors on write/edit |
| `tools.hooksFile` | `hooks.json` | Hook configuration file name, relative to the project working directory (the default is `<project>/hooks.json`) |
| `cache.enabled` | `true` | Enable provider-aware prompt caching |
| `cache.stableTtl` | `1h` | TTL for stable content (system prompt + tools) |
| `cache.monitorHitRate` | `true` | Track and warn on low cache hit rates |
| `helper.enabled` | `false` | Route grunt work to a cheaper helper model |
| `helper.globalProvider` | `` | Helper model provider (e.g., `ollama`) |
| `helper.globalModel` | `` | Helper model ID (e.g., `llama3.2:3b`) |

## Permission modes

`permissions.mode` takes four values:

| Value | Behavior |
| --- | --- |
| `safe-owner` (default) | Ordinary work (reads, writes, edits, ordinary commands) runs without asking; dangerous actions wait for the owner's reply, bound to the exact action |
| `safe-jev` | Jev stands in for the owner: it permits ordinary work and justified risk and refuses genuinely harmful actions |
| `yolo` | Runs authorized actions without general safety decisions or prompts; host containment, secret storage and payment rules still apply |
| `plan` | Allows read-only tools and refuses every mutating or exec tool with a structured plan-mode denial |

Older settings files keep working: `prompt`, `normal`, `accept-edits` and
`custom` load as `safe-owner`, `auto` loads as `safe-jev`, and `allow-all`
loads as `yolo`. `behavior.autoApprove` is a deprecated alias for `yolo`;
selecting an execution mode clears it. Per-tool overrides are the separate
`permissions.tools.<name>` keys, each `allow`, `prompt` or `deny`; an explicit
`deny` blocks that tool in the safe modes.

`Shift+Tab` cycles the execution modes of the current session in this order:
`safe-owner` → `safe-jev` → `yolo` → `safe-owner`. The change lasts for the session and
asks before entering `yolo`; the saved `permissions.mode` changes only through
`/permissions` or Settings. The key is `cycle-permission-mode` in the keybindings file. `/plan` toggles plan mode directly and `/plan off`
returns to the mode you were in when you ran `/plan on` (it does nothing when plan
mode is not on); `plan` is outside the cycle, and cycling from it, or leaving a plan mode that
`/plan` did not enter, starts again at `safe-owner`.

Background and subagent tool calls follow the mode of the session that
started them, and their asks reach the owner through the same approval prompt
with the subagent named. A saved `permissions.backgroundAgents` is removed from
the settings file at load with a receipt.

Changing `service.autostart` or `service.enabled` from `/config` reconciles
the OS service where supported. On Linux this installs/enables, disables, or
rewrites the user `systemd` service so the daemon state matches the setting
instead of only changing JSON.

## Policy, permissions, and trust

The permission system is more than a prompt toggle. Policy evaluation is layered, matching prefix rules, arg-shape rules, path scope, network scope, and mode constraints, and every decision lands in a log for audit and review. Policy changes travel as bundles: a preflight review runs before a bundle applies, candidate bundles can be simulated with a divergence report before promotion, bundles are signed and their signatures verified, and the policy runtime tracks bundle lifecycle with promote, rollback, and diff support. The system can also generate rule suggestions from your actual approval decisions.

An adjacent trust layer grades plugins into trust tiers, can quarantine a plugin or degrade its posture, subjects marketplace entries and MCP servers to trust review, and exposes security and policy control-room surfaces for review and remediation. The result is that approvals, policy rollout, trust posture, and plugin degradation are inspectable product behavior.

## `checkpoints.*`: workspace checkpoint root guard

The workspace checkpoint manager takes whole-workspace snapshots at turn and
agent boundaries so a session can rewind. These keys tune the root guard that
decides where and how much it snapshots. All keys are optional; an omitted key
uses the manager's own default. They are listed in Settings under Storage. A
value of the wrong type or out of range is reported at start and the default
applies.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `checkpoints.preferGitRoot` | boolean | `true` | Prefer the enclosing git repository's top level over the raw workspace root when the working directory is inside one. Keeps a session started in a subdirectory snapshotting the whole repo. Set `false` to snapshot exactly the working directory. |
| `checkpoints.allowBroadRoot` | boolean | `false` | Opt in to snapshotting a broad root (the filesystem root, your home directory, or `~/.goodvibes`). Such roots are refused by default to avoid an unbounded store. Set `true` only when a broad root is genuinely intended. |
| `checkpoints.allowLargeFirstSnapshot` | boolean | `false` | Opt in to a first snapshot whose full file sweep exceeds `maxFirstSnapshotFiles`. Refused by default with a message stating the count. |
| `checkpoints.maxFirstSnapshotFiles` | number | `50000` | Ceiling for the first-ever snapshot's file sweep, a whole number from 1 to 10000000. |
| `checkpoints.autoRetention` | boolean | `true` | Run a retention sweep automatically after each snapshot and once at startup. Set `false` to drive retention only via manual garbage collection. |

Example (`.goodvibes/tui/settings.json`; `checkpoints.allowBroadRoot` is taken only from your own settings file):

```json
{
  "checkpoints": {
    "preferGitRoot": true,
    "maxFirstSnapshotFiles": 20000
  }
}
```

## `statusline.*`: scriptable status line

Point `statusline.command` at any command and its output renders as a dim line
in the status area (just above the prompt). The command runs as a POSIX shell
command (`/bin/sh -c <command>`) in your working directory at each turn
boundary, when a turn completes, errors, or is cancelled, and once at
startup. Both keys are listed in Settings under UI and can be set with
`/config set statusline.command <command>`.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `statusline.command` | string | *(empty)* | Shell command to run. Its first stdout line is shown. Empty disables the feature. |
| `statusline.timeoutMs` | number | `2000` | Per-run timeout in milliseconds, a whole number from 100 to 15000; a value outside that range is reported at start and the default applies. A command that exceeds it is killed and the line is cleared. |

Behavior notes:

- Only the **first line** of stdout is used. ANSI colors and control characters
  are stripped; the result is trimmed and capped at 512 characters.
- Each run is bounded by the timeout, and runs never overlap. Refreshes that
  arrive while a run is in flight coalesce into a single trailing run, so a slow
  command cannot stall the UI or pile up.
- If the command exits non-zero, times out, or fails to start, the line is
  cleared rather than left showing stale text.

The status line runs a command, so it is read only from your own settings file
(`~/.goodvibes/tui/settings.json`); a project settings file cannot set it.

Example (`~/.goodvibes/tui/settings.json`):

```json
{
  "statusline": {
    "command": "git rev-parse --abbrev-ref HEAD 2>/dev/null | sed 's/^/branch: /'",
    "timeoutMs": 1500
  }
}
```

## `behavior.*`: TUI-local notification keys

These keys are read directly by the TUI's notifier modules rather than by
the platform schema, so they do not appear in the Key Settings table above.
They are still editable from `/config behavior`, which injects them into the
behavior group alongside the schema-owned keys.

`behavior.notifyAfterSeconds` gates the long-running-turn notification, and
four separate boolean keys gate point-in-time alert classes covering a budget
breach, an agent failure, a contract failure or cancellation, and a tool call blocked on
your approval. `behavior.notifyOnlyWhenUnfocused` is the master gate over all
of them.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `behavior.notifyAfterSeconds` | number | `60` | Seconds a turn must run before a push notification fires; `0` turns it off. Delivers to the desktop (`notify-send` / `osascript`) and to any configured ntfy/webhook URLs. Notification text is metadata only: task kind, elapsed time, ok/fail, session id. Never conversation content. |
| `behavior.notifyOnBudgetBreach` | boolean | `true` | Alert when session cost crosses the configured budget (set via the Usage modal's `b` key). `GOODVIBES_COST_BUDGET_USD=<usd>` seeds the budget on first run when no budget has been set yet; it never overrides one you set. |
| `behavior.notifyOnAgentFailure` | boolean | `true` | Alert when a delegated or background agent fails. |
| `behavior.notifyOnChainFailure` | boolean | `true` | Alert when a contract fails or is cancelled. |
| `behavior.notifyOnApprovalPending` | boolean | `true` | Alert the moment a tool call becomes a real, user-blocking permission prompt. Message text is tool name and permission category only, never the call's arguments. |
| `behavior.notifyOnlyWhenUnfocused` | boolean | `true` | Master gate over the four alert-class keys above and over `notifyAfterSeconds`: alerts fire only when the terminal is unfocused, or when focus state was never observed. Set `false` to fire regardless of focus. |

## `session.*`: session behavior

Listed in Settings under Behavior.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `session.autoTitle` | boolean | `false` | Auto-title an untitled session using the configured tool/helper (weak/fast) model after the first turn completes. Off by default because it spends a small model call. Only ever sets a system title (a title you set yourself is never overwritten), and it runs at most once per session. Requires the tool LLM to be configured (`/config` → tools). |

```json
{
  "session": { "autoTitle": true }
}
```

## `update.*`: launch-time self-update

Binary installs (the `curl … | sh` installer) check for a newer release at
every TUI launch and, when one exists, install it through the same
checksum-verified download/verify/swap path as `/update apply`, then restart
onto the new binary with a receipt line naming both versions. When the check
cannot complete quickly (offline, slow network) the current version starts
with a single line reading `update check skipped: offline`. Every swap keeps the outgoing
file at `<path>.previous`; `/update rollback` restores it in one command.
Package-manager and from-source runs never self-update at launch.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `update.autoUpdateAtLaunch` | boolean | `true` | Check for and install a newer release at TUI launch. Set `false` to only update when you run `/update apply` yourself. |
| `update.launchCheckTimeoutMs` | number | `2500` | Budget for the launch-time version check, a whole number from 250 to 30000; a value outside that range is reported at start and the default applies. A check that outlives it is skipped and the current version starts. |
| `update.applyTimeoutMs` | number | `45000` | Budget for the launch-time download, verify, and swap, a whole number from 5000 to 300000; a value outside that range is reported at start and the default applies. An apply that outlives it is deferred to the next launch. |

```json
{
  "update": { "autoUpdateAtLaunch": false }
}
```
