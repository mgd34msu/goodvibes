# Native Herdr session reporting

The TUI and Agent share `createHerdrSessionReporter` from `@goodvibes-jev/engine/terminal-shell`. Each interactive process owns one reporter. No global hooks, launcher changes, or Herdr row settings are installed.

The reporter requires inherited `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`, and `HERDR_SOCKET_PATH`. It invokes that owning binary against the explicit pane and socket; it never falls back to the focused pane or another binary on `PATH`. Source and agent label are `goodvibes`. The former `herdr:goodvibes` source is released first for that exact pane and label.

Requests contain only state, sequence, session ID, session storage path, and valid resume arguments. Prompt text, answers, tool arguments, credentials, and model output are excluded. Delivery runs asynchronously, coalesces superseded state, and has bounded timeouts. Close prevents later reports and sends final release.

## State and lifecycle sources

`blocked` takes precedence over `working`; otherwise the reporter sends `idle`. Herdr owns the distinction between a seen idle pane and unseen finished work.

| Source | Native treatment |
| --- | --- |
| Foreground LLM, tools, queued or in-flight turn | Current orchestrator busy state; Agent also includes the thinking state driven by hosted activity. |
| Actual hook invocation, including startup and background hooks | Dispatcher active invocation count; subscription is installed during bootstrap before session-start hooks fire. Activity covers every runner type and dynamic event path, retaining underlying provider/process/response/agent work after an outward timeout. |
| Session-owned contracts and agents | Current-session contract state and explicitly attributed fleet/contract work contribute busy. Unrelated global daemon work does not claim this pane. |
| Permission card, including brokered approvals | Actual `pendingPermission` contributes blocked; no permission-hook heuristic is used. |
| Workspace trust, recovery, and awaited choices | Active selection with an outstanding callback contributes blocked. Agent also exposes recovery and daemon-repair questions directly. |
| Concealed or plain field entry | Explicit pending input request contributes blocked. Field values are excluded. |
| Pairing | Only the controller's confirmation phase contributes blocked. Reading a preview or applying credentials is not an owner question. |
| Surface confirmation and diff-preview question | Explicit modal owner-wait state contributes blocked. Ordinary modal browsing does not. |
| Settings trust/logout/reset and session/profile delete confirmations | The actual active confirmation contributes blocked; an open settings or picker screen alone does not. |
| Contract owner reply | Explicit `awaiting-owner` state on the current contract, group, or unit contributes blocked. No question text is sent. |
| Resume, fork, session switch | Reports reread `runtime.sessionId` and the product's session directory. Agent `--resume` invokes its existing session-resume command, including the latest pointer. |
| Cancellation, model/tool failure, hosted disconnect | Reports follow the settled owner state. Another live hook/job or real owner question can keep the pane working/blocked. |
| Normal quit, stdin close, SIGTERM, SIGHUP, crash, startup failure | Release is drained before process exit within the exit deadline. Terminal restoration remains independent of reporting failures. |
| Session save or late repaint after exit begins | Closed reporters cannot reclaim the pane. Save is not quit; changing sessions is not quit. |

## Complete hook inventory

The table accounts for every registered contract in `sdk/src/platform/hooks/contracts.ts`. All actual invocations contribute through the dispatcher's shared activity tracker, including hooks outside a turn. A hook event without a matching enabled handler contributes no work. Hook events themselves never establish an owner question; the UI owner does.

| Category | Current hook contracts | Additional interpretation |
| --- | --- | --- |
| Tool | `Pre:tool:*`, `Post:tool:*`, `Fail:tool:*` | Individual completions do not force idle between tools. |
| File | `Post:file:*`, `Fail:file:*`, `Change:file:*` | A file event alone is not an owner wait. |
| LLM | `Pre:llm:chat`, `Post:llm:chat`, `Fail:llm:chat` | A response is not necessarily the end of the turn. |
| MCP | `Pre:mcp:call`, `Post:mcp:call`, `Fail:mcp:call`, `Lifecycle:mcp:*` | Actual elicitation/trust UI supplies blocked. |
| Compaction | `Pre:compact:*`, `Post:compact:*`, `Fail:compact:*` | Hook work and foreground compaction retain their actual owners. |
| Session | `Lifecycle:session:*` | Runtime identity supplies metadata; process teardown owns final release, including end-then-save ordering. |
| Agent | `Lifecycle:agent:*` | Current-session work contributes separately; no extra Herdr row is created for each child. |
| Contract | `Lifecycle:contract:*`, `Change:contract:*` | Only explicit current-session owner-wait state supplies blocked. |
| Communication | `Lifecycle:communication:*`, `Change:communication:*` | Delivery/routing notification alone does not establish an owner question. |
| Permission | `Pre:permission:request`, `Post:permission:decision`, `Fail:permission:request` | Pre also runs for ordinary checks; it is not a dialog-open signal. |
| Transport | `Lifecycle:transport:*` | Connection notification alone does not establish completion or owner wait. |
| Configuration | `Change:config:*` | Configuration changes alone do not establish owner wait. |
| Budget | `Change:budget:*` | A budget notification alone does not establish owner wait. |
| Git | No registered contract; `git` is a declared hook category | Dynamic git hooks still use the same invocation tracker. |

The declared phases are `Pre`, `Post`, `Fail`, `Change`, and `Lifecycle`. The inventory test compares this reference with the live registry. Dispatcher tests exercise all phase/category combinations, overlapping invocations, cancellation, failure, and late observers.

## Resume protocol and explicit limits

The owning Herdr binary's version determines resume support. Herdr 0.9.2 and later receive the actual product command after `--` in the state report: `goodvibes` or `goodvibes-agent`, `--working-dir`, the workspace, `--resume`, and the current session. Older binaries retain state and release reporting. Unsupported resume argument characters are not transmitted. The [Herdr integration contract](https://github.com/herdrdev/herdr/blob/master/docs/versions/0.9.3/website/src/content/docs/add-herdr-support.mdx) defines the wire format.

Channel-only payment approval/veto inbox windows have no current-terminal projection. A brokered payment approval or local credential field is covered; a channel-only wait cannot safely mark an arbitrary pane blocked. An agent without a session/contract attribution likewise cannot safely claim an unrelated pane.

SIGKILL cannot run application cleanup. Transport failure or an expired exit deadline can also prevent delivery; Herdr's process detection handles those cases. Hook activity observation preserves existing timeout results and cancellation ownership while retaining each invocation until its underlying work settles.
