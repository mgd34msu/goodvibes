# Decision-model policies

The `judgment.policy` setting controls decision-model use independently of tool
permissions. In TUI or Agent, open `/settings`, choose **Judgment**, then
**Decision models**, and choose **Hybrid (default)**, **Decision Model Only** or
**No Decision Model** from the picker. WebUI shows the same choices in its
Judgment settings, and `goodvibes-daemon config set judgment.policy <value>`
sets the daemon's own copy. The stored values are `Hybrid`, `Decision Model Only`
and `No Decision Model`; "(default)" is only how the default is shown.

Choose **Decision provider** and **Decision model** in that category to configure
Jev, Clef, Clef-flash, DiffusionGemma Jev, Kev-9B, Laya, or a compatible custom
model. The terminal setup asks for the deployment endpoint and a credential
reference. Use an environment-variable name or secret-store entry name, never
the key value. Local deployments can explicitly select no authentication.

**Decision fallback chain** adds, edits, removes, and orders backup targets.
Each target can use its own model, protocol, endpoint, and credential reference.
WebUI provides editable fallback rows and an Advanced JSON view.

**Decision deadline (ms)** (`judgment.decisionDeadlineMs`, default 1500) bounds
a decision that you or a tool call wait on. When no answer arrives in time, that
decision takes its stated fallback, such as asking you; a target that misses the
deadline three times in a row is skipped for a minute. A target whose address
refuses the connection is not asked a second time for the same decision.

Execution permissions are in **Permissions → Execution permissions**, including
**YOLO**. Choose the decision policy and execution permissions independently.

| Policy | Behavior |
| --- | --- |
| Hybrid (default) | Use the set decision model. When it gives no usable answer, for any reason (unreachable, too slow, a request too large for it, an HTTP error, a refused or missing key, a malformed answer, a closed connection), the operation continues without it: each decision takes its fallback, and you are told once per outage, naming the model, what failed and the next step. |
| Decision Model Only | Use the set decision model and keep asking it. While it fails, a tool call it cannot decide is refused with its error and every other decision takes its fallback; the turn goes on. |
| No Decision Model | Make no decision-model requests. |

**With no decision model set** (no `judgment.endpoint`, `judgment.model`,
`judgment.fallbacks`, credential choice, `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`
or `TYPESAFE_DEFAULT_MODEL`), every policy works without one: no decision model
is asked, nothing waits and nothing reports an error.

## How much you are asked

The policy and the permission mode (`permissions.mode`, below) decide together
how often a person is in the loop. In every combination, code settles what it
already knows first: reads, edits inside the workspace, and calls a saved rule
or your `permissions.tools.*` setting allows run at once, and a deny rule
refuses. In every mode but `yolo`, the owner-only items (granting access, loosening a security, judgment or payment setting, a call your own "always ask me" rule covers, a change asked for from a channel, a deletion nothing keeps a copy of, sending to a new recipient, sending content derived from untrusted text, and changing what a contract requires) always come to you, whether or not a decision model is set:
asked, or held for the end of the run in `just-vibes`; Jev never answers one.
The program recognises deletions itself in shell commands, file operations and
operator methods that cannot be undone, and a new recipient as an address a
call chooses that is not one of your own destinations, wherever it can read
it: a tool's declared recipients, shell commands that mail or post to a
messaging service, `fetch` requests to one, and MCP or plugin tools naming a
mail address or phone number (the list is in the 3.3.0 release notes). A
recipient it cannot read, such as one sent from inside a script, is a judgment
call. Spending over your
limits and payment steps are put to you by the payment windows in every mode,
`yolo` included. What is left is a judgment
call, and the table says who answers it.

| Policy | `ask-me` | `jev-decides` | `just-vibes` | `yolo` |
| --- | --- | --- | --- | --- |
| Hybrid (default) | Jev reads each judgment call's risk and you are asked only about the ones it reads as critical, irreversible or security-weakening; with no model set, or while it fails, you are asked about every judgment call your tool settings do not allow. | Jev decides every judgment call; with no model set, while it fails, or (while `jev-decides` is only the default, not your choice) on a model the shipped calibration did not measure, you are asked as in `ask-me`. | You are never interrupted: Jev decides judgment calls, and what Jev would not run (with no working model, every judgment call your tool settings do not allow) is held and listed at the end of the run. | The permission gate asks you nothing except about a change asked for from a channel; purchases outside your limits still come to you, and an act only you perform (answering an approval, granting access) is refused to the model. No decision model is consulted for permission. |
| Decision Model Only | As Hybrid, except that while the set model fails, the call is refused with the model's error instead of asking you; the turn goes on. | As Hybrid, except that while the set model fails, the call is refused with the model's error instead of asking you; the turn goes on. | As Hybrid, except that while the set model fails, the call is refused with the model's error instead of being held; the run goes on. | Same as Hybrid. |
| No Decision Model | You are asked about every judgment call your tool settings do not allow. | You are asked about every judgment call your tool settings do not allow, exactly as in `ask-me`. | You are never interrupted: every judgment call your tool settings do not allow is held and listed at the end of the run. | Same as Hybrid. |

The shipped calibration record covers the hosted endpoint and `jev-latest`
(answered by `jev-1.14.0`). While `jev-decides` is only the default, Jev decides
only when the endpoint, the model and every fallback target that can answer
match that record. Choosing `jev-decides` yourself (in `/settings`,
with Shift+Tab, for a hosted session or in a channel profile)
lets Jev decide on any working decision model. `/held` lists, approves or sets aside what `just-vibes` held, and
`/decisions` lists what Jev decided for you with undo, never, always and ask.
`yolo` still keeps authentication, workspace containment, secret storage and
spending limits.

**You can always tell when no decision model is in use.** The conversation says
so once (none set, or No Decision Model chosen), says once when a set model
starts failing and once when it answers again, and never repeats a failure every
turn. `goodvibes status` and `goodvibes-agent status` show the policy and a
"Decision model" line; a headless run prints the line on stderr and adds
`diagnostics.decisionModel` to its JSON result without changing the exit code;
WebUI shows it in the mode chip in its header, and the terminal programs' status bar shows it after `Asks:`, in the same words: what is in force first, then the choice and when it takes effect (for example "you, for now · Jev decides once a decision model is set").

Without a decision model, conversation, tools, editing, command and test
execution, final responses and saved-session recovery work as usual; ordinary
conversation models are still required. The Decision Router uses its General
target without categorization. Tool permissions remain separate: `jev-decides`
asks you instead, and YOLO keeps its meaning. Authentication, workspace
boundaries, secret handling, spending limits, cancellation and
duplicate-execution protection stay in force, and results say no decision
model checked them rather than claiming model verification.

Link validation in every policy requires HTTPS, no embedded user credentials,
a named host on the standard HTTPS port, and a matching authorized registrable
domain. Redirect following applies these checks at every hop. Domain mismatches
refuse locally without a decision-model request. With a decision model, matching
hosts are also checked for lookalikes and shortening services; without one,
accepted links are marked as not checked for those, and internationalized
domain names are not refused solely because they use punycode.

Hybrid keeps conversation history and completed work without replaying actions.
An answer the model gave (including an abstention or a privacy rejection), a
cancellation or stale authority does not trigger the fallback. An action already
refused stays refused.

Local knowledge ingestion/search, explicit review and links, structural planning,
diagnostics, credential masking, speech and catalog browsing work without a
decision model. Autonomous contract execution, independent semantic knowledge
verification, merchant/checkout interpretation and semantic recommendations or
grading need a decision model and say so when none is in use.

Installation does not require a decision-model connection. A settings file that
holds a value this version does not know is reported by name with the three
valid values, and the product runs on Hybrid.

## Permission modes

`permissions.mode` chooses who answers a judgment call. The default is
`jev-decides`.

| Mode | Behavior |
| --- | --- |
| `ask-me` | Jev reads each judgment call's risk. Calls it reads as critical, irreversible or security-weakening ask you, with owner-only items; the rest run. With no working decision model, every judgment call your tool settings do not allow asks you. |
| `jev-decides` (default) | Jev decides judgment calls; owner-only items ask you. With no working decision model it behaves as `ask-me`. |
| `just-vibes` | Nothing interrupts you: Jev decides what it can, and anything that needs you is held and listed at the end of the run. |
| `yolo` | No approval prompts from the permission gate, except for a change asked for from a channel. Authentication, workspace containment, secret storage and spending limits still apply, and an act only you perform is refused to the model. |

- **`plan`** is a separate read-only posture: read-only tools run, and every
  mutating or exec call is refused. `/plan` toggles it.
- **For one session:** `Shift+Tab` in `goodvibes` or `goodvibes-agent` cycles the mode of the
  current session only and asks once before switching to `yolo`; the key is
  the rebindable `cycle-permission-mode`.
- **For one launch:** `--just-vibes` or `--yolo` on `goodvibes` or
  `goodvibes-agent` picks a mode without changing settings.
- **For good:** `/settings` (When GoodVibes asks) saves the default; a channel
  profile can set one per channel.
- **`/decisions`** lists what Jev decided for you, and for each one lets you
  undo it, turn it into a standing rule (never, always, or always ask me), or
  keep it.
- **`/held`** lists what `just-vibes` held, and approves or sets aside one
  item or all of them.
- **`/permissions`** shows the permission settings and where each came from,
  and `/permissions rules` lists and revokes remembered approval rules. An
  explicit `permissions.tools.<name>` set to `deny` blocks that tool.
- **Older saved values still load:** `safe-owner`, `prompt`, `normal`,
  `accept-edits` and `custom` as `ask-me`; `safe-jev` and `auto` as
  `jev-decides`; `allow-all` as `yolo`.

## Decision Router

Choose **Provider → Decision Router categories** in the terminal settings to
assign each category an answer provider, model and effort level. Set **General**
as the catch-all; unassigned categories use General. WebUI provides the same
category controls, custom categories and routing-context limits. Advanced
terminal configuration exposes custom categories and context limits as well.

Select **Decision Router / auto** in the ordinary model picker to enable this
routing for the conversation. Selecting other providers adds no categorization
calls. Classification uses bounded context; the chosen answer model receives
the conversation and tool history.

## Call-volume alerts

In **Settings → Judgment → Decision Call-volume Alerts**, edit
`judgment.volumeMonitor` to enable local alerts and set budgets. For example:

```json
{"enabled":true,"budgets":[{"name":"All decisions","maxLogicalDecisions":1000,"maxWireAttempts":2000}]}
```

The default window is one hour, checked once a minute. Optional `battery` or
`site` fields restrict a budget to that category; `windowMs`, `intervalMs` and
`limit` control the window, cadence and maximum log entries inspected. Alerts
appear in runtime logs and do not call a model or stop work. Native monitoring
reads attribution and dispatch counters without loading questions, answers or
notes into JavaScript. Settings apply to
the running monitor when changed. Disabled product monitoring still honors an
explicit `GOODVIBES_JUDGMENT_MONITOR` budget-file override.

Enabled monitoring requires 1–100 budgets. `intervalMs` accepts 1 second to 1 day,
`windowMs` accepts 1 second to 30 days, and `limit` accepts 1–100000 entries.
