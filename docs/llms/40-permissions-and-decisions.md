# Permissions, decisions and safety

This part explains who decides whether a tool call runs, what always comes to the owner, how answers are remembered and reversed, how the decision model is set up, and the safety layers that stay in force in every mode: workspace trust, the exec sandbox and the secret store.

## Terms used in this part

How settings are written in this part: the examples use the terminal app's `/settings set <key> <value>`, where the value is read as JSON when it parses (`true`, `5`, `["a","b"]`, `"text"`) and as text otherwise. In the Agent `/settings set <key> <value>` takes text, numbers, `true`/`false` and the allowed words of an enum, but not a JSON list or object: set a list or object setting in the Agent's settings workspace (`/settings <key>`).

| Term | Meaning |
| --- | --- |
| tool call | One request by the model to run one tool (`exec`, `write`, `edit`, `fetch`, an MCP tool, and so on) with one set of arguments. |
| the gate | The permission gate. Every tool call passes through it before it runs. |
| fact | A call the gate settles by code alone, without a model and without asking anyone. |
| owner-only item | A call only the owner may decide. Jev never answers one. The full list is in "What always comes to the owner". |
| judgment call | A call that is neither a fact nor an owner-only item. Only judgment calls are put to the decision model. |
| decision model | The model that reads judgment calls and other decisions. Jev is the hosted decision model. |
| working decision model | A decision model that is set (see "When a decision model counts as working") and is answering: from its first failed request until it answers again it does not count as working. Nothing is sent to test it; the gate's own requests show it. |
| stakes | The level the gate's reading gives a judgment call: `low`, `medium`, `high` or `critical`. Defined in "Stakes". Only a decision model's reading produces one. |
| held call | A call `just-vibes` did not run because it needed the owner; it is listed at the end of the run and answered in Waiting for you, under Held calls. |
| remembered rule | A saved answer ("always allow this command class in this project") that settles later calls. |
| working directory | The project directory the app was started in, or the directory given with `-C` / `--cd`. The gate calls this "the allowed directories". |

## How one tool call is decided

The gate applies these steps in order. The first step that settles the call decides it.

Before them, in every mode (`yolo` included), the owner's never-run rules are checked: a call that would hand a shell a command a never-run rule names is refused (see "Never-run rules"). And a call the owner's `Pre:tool` hook answered `ask`, or a call to an MCP server trusted `ask-on-risk` outside its scope, is put to the owner in every mode, `yolo` included (held for him in `just-vibes`), unless a step below refuses it. This holds for the terminal app's and the Agent's MCP calls alike, and the decision model never answers it. A call to an `ask-on-risk` server inside its scope (its `allowedPaths` and `allowedHosts`) is not asked about for that reason: it is decided like any other call under the mode in force. Where nobody can be asked, an out-of-scope call is refused and never sent: from code with no originating request or no permission surface the tool result reads `MCP call '<qualified tool name>' denied: request exceeds configured scope for server '<server>' (ask-on-risk), so the owner decides it: <what is outside>. Nobody can be asked from here, so it was not sent.`, and a host with no person to show the question to refuses it (`MCP call '<qualified tool name>' was not allowed: ...`).

1. An act only the owner performs himself is refused to the model in every mode, `yolo` included. These are: answering an approval or a purchase window, and granting or withdrawing access through an operator method the catalog declares owner-only. The refusal tells the model to tell the owner what is waiting.
2. Where the instruction came from. A call that is not a read, asked for in a conversation on a chat channel the owner set up (Slack, Discord, Matrix and the other chat surfaces except Telegram), becomes the owner-only item `channel-request`. A call that is not a read, asked for on email, a generic webhook or ntfy, is refused outright: anyone can write to those, so no approval is raised. Telegram and the terminal carry command authority, so the owner's request there is decided like one typed in the terminal app. Authority belongs to the person, not the surface: a turn started by anyone else a channel admits (a guest) carries no authority on any surface, Telegram included. Its plain reads (files inside the allowed directories) run; every other call, a read that reaches the network or the app's own state or leaves the allowed directories included, becomes `channel-request`, put to the owner in every mode, `yolo` included, with or without a decision model (held for him in `just-vibes`). See "Who may talk to the assistant" in "Automation and services" for who is admitted.
3. Plan mode. In `plan`, every call that is not a read is refused with "plan mode is on and <tool> would change something".
4. `yolo`. In `yolo`, every call that passed steps 1 to 3 runs.
5. A matching deny rule refuses the call. A matching "always ask me" rule makes it the owner-only item `standing-ask`.
6. The owner-only list. A call code recognises as owner-only goes to the owner (or is held in `just-vibes`), unless the owner's own remembered answer to that exact kind covers it.
7. A matching allow rule runs the call. Exception: when the current turn has read untrusted text (a web page, an email, a channel message from someone else), an allow rule still runs a call that stays on this machine, but a call that can reach outside becomes a judgment call.
8. Declared-effect defaults run the call without asking:
   - a read of files inside the working directory;
   - a read of the app's own state;
   - a call whose tool declared it read-only and that runs no command;
   - a write or edit inside the working directory that the undo history records (the `write` and `edit` tools, unless the call uses `files[].encoding`, `validate.before[]` or `validate.after[]`).
9. Everything else is a judgment call. Only now is a model asked, and only in the modes that ask one.

A rule in steps 5 and 7 comes from, in this order of strength: a per-tool setting `permissions.tools.<name> = deny`, managed policy, the owner's answer earlier in this session, the owner's remembered rules for this project, and a managed-policy allow. A deny always wins over an ask or an allow. A path argument whose symbolic link lands on a path a rule denies is denied too.

### Tool categories

Every tool call has a category. The category decides which `permissions.tools.*` setting applies and what plan mode refuses.

| Category | Examples | Refused in plan mode |
| --- | --- | --- |
| `read` | `read`, `find`, `analyze`, `inspect`, `state` reads, `registry` | No |
| `write` | `write`, `edit`, settings writes through `goodvibes_settings` | Yes |
| `execute` and the other non-read categories | `exec`, `fetch`, `agent`, `workflow`, `mcp`, unknown tools | Yes |

The per-tool settings map tool names to keys as follows: `read`, `write`, `edit`, `exec`, `find`, `fetch`, `analyze`, `inspect`, `agent`, `state`, `workflow`, `registry` and `mcp` each have their own key; `goodvibes_context` uses `permissions.tools.state`; `goodvibes_settings` uses `permissions.tools.write`; every other tool uses `permissions.tools.delegate`.

## Permission modes

`permissions.mode` chooses who answers judgment calls. The default is `jev-decides`.

<!-- generated: permission-modes -->

The one-line summaries above are the program's own; the table below gives the exact outcome for each kind of call. In `ask-me` without a working decision model, every judgment call whose `permissions.tools.*` setting is not `allow` is asked (an `exec` call with the default `prompt` is asked), and judgment calls of category `read` run unless their setting is `prompt`. The stakes columns of the reference table describe only `ask-me` and `yolo`: in `jev-decides` and `just-vibes` Jev decides a critical call (it is not asked), and `plan` refuses every call that is not a read before any stakes are read.

### Stakes

A judgment call is read by the decision model as seven yes/no facts: does it change something (`mutates`), does it reach outside the machine (`outward`), does it touch secrets (`secrets`), is it hard to undo (`irreversible`), does it reach beyond the project (`beyondProject`), does it loosen a security boundary (`weakensSecurity`), and, for a call carrying a shell command, is the command written to hide what it does (`obfuscated`). A fact the model is not confident about counts as yes. Code then sets the stakes:

| Stakes | When |
| --- | --- |
| `critical` | Loosens security; or is obfuscated; or might be catastrophic (the boundary could not rule out wholesale destruction); or is hard to undo and reaches beyond the project or outside the machine; or sends secrets outside the machine. |
| `high` | Hard to undo, touches secrets, reaches beyond the project, or goes outside the machine. |
| `medium` | Changes something. |
| `low` | Changes nothing. |

Stakes enter only at step 9 of the order (judgment calls) and only with a working decision model. In `ask-me` a call runs unless its stakes are `critical`, or it is read as irreversible or security-weakening, or the boundary checks fail; then you are asked. In `jev-decides` and `just-vibes` the reading, stakes included, is the evidence Jev decides on. Without a decision model no reading is taken and no stakes exist; the no-model rule in the table below applies instead.

### What happens to each kind of call

The table gives the outcome for each kind of call in each mode, with and without a working decision model. "Asked" means the approval prompt appears (in a headless run, see "Headless runs and permissions"). "Held" means the call does not run and waits in Waiting for you, under Held calls.

| Kind of call | `ask-me` | `jev-decides` | `just-vibes` | `yolo` | `plan` |
| --- | --- | --- | --- | --- | --- |
| Owner act (answer an approval, grant access by operator method) | Refused | Refused | Refused | Refused | Refused |
| Change asked for on a chat channel other than Telegram | Asked, one call at a time | Asked, one call at a time | Held | Asked, one call at a time | Refused |
| Change asked for on email, webhook or ntfy | Refused | Refused | Refused | Refused | Refused |
| Not a read, in plan mode | n/a | n/a | n/a | n/a | Refused |
| Matching deny rule | Refused | Refused | Refused | Runs (rules are not read in `yolo`) | Refused |
| Matching "always ask me" rule | Asked | Asked | Held | Runs | Asked for a read; refused otherwise |
| Other owner-only item | Asked | Asked | Held | Runs | Asked for a read; refused otherwise |
| Matching allow rule | Runs | Runs | Runs | Runs | Refused if not a read |
| Declared-effect default (step 8) | Runs | Runs | Runs | Runs | Runs for reads; refused for writes |
| Judgment call, working decision model | Jev reads the call; it runs unless Jev reads it as critical, irreversible or weakening security, or the boundary checks fail, in which case you are asked | Jev decides: runs or is refused with Jev's reason | Jev decides: runs, or is held instead of refused | Runs | A read outside the working directory: refused |
| Judgment call, no working decision model | Runs when its category is `read` and its `permissions.tools.*` setting is not `prompt`, or its setting is `allow`; otherwise asked | Same as `ask-me` | Runs on the same condition; otherwise held | Runs | A read outside the working directory: refused |
| `read`, `find` or `inspect` of a path outside the working directory | The gate passes it as a judgment call (above); then the tool itself refuses it: `Path '<p>' is outside the project root`. Nothing is read. | Same | Same | The tool reads it | Refused by the gate |
| `analyze` of a path outside the working directory | Refused by the tool | Refused by the tool | Refused by the tool | Refused by the tool | Refused by the gate |
| `write` or `edit` of a path outside the working directory | The gate passes it as a judgment call (step 8 covers only paths inside); then the tool refuses it: `Path '<p>' is outside the project root`. Nothing is written. | Same | Same | The gate runs it; the tool still refuses it | Refused by the gate |

Three further rules apply with a working decision model, before Jev is asked to decide:

- When Jev's reading of a call says confidently that it loosens a security boundary, the call becomes the owner-only item `loosen-security`. When the reading says confidently that it destroys something that cannot be brought back, it becomes `unrecoverable-delete`. Both are asked (held in `just-vibes`), never decided by Jev.
- A shell command the reading cannot tell apart from wholesale destruction of the machine or its data is asked for that one call, with nothing offered to remember (held in `just-vibes`).
- The outward-effect boundary checks a call that would send content read from untrusted text. A call it refuses outright stays refused. A call it marks approvable (for example card details it is unsure of, or content that may repeat untrusted text) is asked for that one call (held in `just-vibes`); this is the owner-only item `untrusted-derived-send`.

With no working decision model, these three readings do not happen. An allow rule still does not settle a call that can reach outside after the turn read untrusted text: that call is asked (or held).

A refusal by Jev is remembered for the rest of the operation. If the decision model then stops answering, the fallback does not run the refused call.

### When a decision model counts as working

A decision model is set when any of these is true: `judgment.endpoint` is not empty, `TYPESAFE_BASE_URL` is set, `judgment.fallbacks` has a target, `judgment.keySource` is `secret` or `none`, the environment variable named by `judgment.keyName` (default `TYPESAFE_API_KEY`) holds a value, `judgment.model` is not empty, or `TYPESAFE_DEFAULT_MODEL` is set.

The gate treats the decision model as working when it is set and it is answering. The first request that fails (unreachable, refused key, no answer within `judgment.timeoutMs`, a malformed answer) starts a failure episode: from the next tool call, `jev-decides` runs as `ask-me`, the mode change is announced (`PRESET_CHANGED`, the mode chip, the web UI) and the conversation gets one notice, one sentence naming the model, what failed and the next step: `[Decision model] The decision model <model> is not answering (<what failed>), so work continues without it until it answers again; to fix it, <next step>.` It counts on the status bar until the episode ends. The gate keeps reading calls with the model as before (no extra request is made to test it); the first answer ends the episode, `jev-decides` is in force again from the next call, and the notice is withdrawn (nothing new is said). With no decision model set, nothing is said at all. A call already being decided keeps the mode it started under. In `just-vibes` a failing model is still asked; a call it cannot decide is held.

One extra rule applies to `jev-decides` while it is only the shipped default (the owner never chose a mode): Jev decides only when every place a decision can be answered matches the shipped calibration record. That record measured the hosted endpoint `https://api.typesafe.ai` with the model `jev-latest`, answered by `jev-1.14.0`; a `judgment.model` of either `jev-latest` or `jev-1.14.0` on that endpoint counts as measured. A custom endpoint, a different model, or a fallback target with another endpoint or model is not what was measured, so the default `jev-decides` then behaves as `ask-me`. The rule does not apply once the owner has chosen the mode: saved in settings, chosen with Shift+Tab, chosen for a hosted session or set in a channel profile. A chosen `jev-decides` lets Jev decide on any working decision model.

What the reports show: every report shows the mode in force, read by the same rule the gate reads, and, when it is not the saved or chosen mode, which mode that is and why.

- `goodvibes status` and `goodvibes-agent status`: `permissions: Ask me (ask-me) in force; set: jev-decides` (the saved mode, or the one `-c` sets for this launch), then `not jev-decides, because <reason>`. The reasons: `no decision model is set, so every call Jev would decide asks you (to use one, choose a Decision model in /settings open)`; `you turned decision models off, so Jev cannot decide and every call it would decide asks you`; `Jev decides is only the shipped default here and its decisions were not measured on this decision model; choose Jev decides yourself (shift+tab, or /settings open) to use it`; `"Approve every tool request without asking" is on in your settings, which means YOLO; choosing your setting for when GoodVibes asks in /settings clears it`. With `--json` the same is under `auth.permissionModeInForce` (`chosen`, `mode`, `reason`). `status` runs without the app, so a model that is failing in a running app is reported by that app, not by `status`.
- `/permissions`: `mode in force: <mode> (<label>)`, then `not <mode>, because <reason>` when it differs, then `saved mode: <mode>`, or `chosen for this session: <mode>; saved default: <mode> (set in /settings)` after Shift+Tab. A running app also gives the reason `the decision model <model> is not answering (<what failed>, since <time>); calls Jev would decide ask you until it answers again`. In the Agent bound to a hosted session, the session's mode and reason come from the daemon.
- The mode chip in either app shows the mode in force.
- The web UI and the operator method `sessions.permissionMode.get`: `mode` is the mode in force; `chosenMode` is the session's chosen (or saved) mode and `reason` says why they differ. The session page shows `(in force; <chosen> chosen, but <reason>)`.

### Choosing the mode

| How | Scope | Example |
| --- | --- | --- |
| `/settings permissions.mode` in either terminal app | Saved default | Opens the settings workspace at the key; choose the value. |
| `/settings set permissions.mode <mode>` | Saved default | `/settings set permissions.mode ask-me` |
| `-c permissions.mode=<mode>` on the command line | This launch only | `goodvibes -c permissions.mode=ask-me` |
| `--just-vibes` | This launch only | `goodvibes --just-vibes` |
| `--yolo` (alias `--no-worries-just-vibes`) | This launch only | `goodvibes-agent --yolo` |
| Shift+Tab in the terminal app | This session only | Cycles `ask-me` → `jev-decides` → `just-vibes` → `yolo` → `ask-me`. |
| Plan mode, on This conversation in Permissions and safety (`p`), or the capabilities `plan.on`, `plan.off`, `plan.status` | This session only | See "Plan mode". |
| Channel profile `--permission-mode` | Sessions started from that channel | See "Per-channel and per-session modes". |

Shift+Tab details (terminal app `goodvibes` only; the Agent has no mode cycle key):

- The key is the rebindable action `cycle-permission-mode`.
- The change is a runtime override for the current session. It is not saved and ends with the session.
- Before entering `yolo`, a dialog asks "Switch this session to YOLO?" with the default No. Declining skips `yolo` and moves to the next mode.
- From `plan` (or an unknown value), Shift+Tab enters `ask-me`.
- When a managed setting locks `permissions.mode`, the key prints `[Permissions] Mode stays <mode>: <reason>` and changes nothing.
- The confirmation line reads `[Permissions] Mode for this session: <label> (the saved default is set in /settings; /permissions shows it)`, where `<label>` is `Ask me`, `Jev decides`, `Just vibes` or `YOLO`. When the YOLO dialog was declined, the line starts `[Permissions] YOLO skipped. Mode for this session: ...`. The saved default is changed in `/settings` or with `/settings set`; `/permissions` only displays it.

Older saved values still load: `safe-owner`, `prompt`, `normal`, `accept-edits` and `custom` load as `ask-me`; `safe-jev` and `auto` as `jev-decides`; `just-work` as `just-vibes`; `allow-all` as `yolo`. For a saved `prompt`, `normal`, `accept-edits` or `custom` the app says: `permissions.mode "<value>" is retired and now runs as ask-me: with a working decision model ordinary actions run without asking and only critical actions ask; without one, every action asks except a read inside the workspace and a change to files inside it that can be undone. To be asked less, choose jev-decides, just-vibes or yolo; for read-only planning choose plan; to block one tool, set permissions.tools.<tool> to deny.` An unknown value runs as `ask-me`.

`behavior.autoApprove` set to `true` is an older saved switch that selects `yolo`. Saving any `permissions.mode` value sets `behavior.autoApprove` back to `false`. `/permissions` lists it as "Saved YOLO alias" while it is on.

### Per-channel and per-session modes

A channel profile gives every session a channel starts its own model, provider and permission mode.

```text
/channels set-profile slack --permission-mode plan
/channels set-profile slack C0123456 --model openai:gpt-5.4 --permission-mode ask-me
/channels profile slack
/channels remove-profile slack C0123456
```

```sh
goodvibes-agent channel-profiles set slack --model openai:gpt-5.4 --permission-mode plan --yes
goodvibes-agent channel-profiles get slack --channel-id C0123456
goodvibes-agent channel-profiles delete slack --yes
```

The accepted modes are `ask-me`, `jev-decides`, `just-vibes`, `yolo` and `plan`. A profile without a channel id is the surface-wide default; a profile with one applies to that channel only. A mode set by a channel profile counts as the owner's choice for the calibration rule above. The operator method `sessions.permissionMode.set` sets the mode of one hosted session.

## What always comes to the owner

In every mode except `yolo`, the items below are decided only by the owner: asked in `ask-me` and `jev-decides`, held in `just-vibes`. Jev never answers one. Code recognises each of them; a model's reading cannot move an item off the list.

| Kind | Reason shown to the owner | How it is recognised |
| --- | --- | --- |
| `spend-over-limit` | it spends more than a limit you set | The payment layer, once it has read the checkout total. Put to the owner by the purchase window in every mode, `yolo` included. |
| `payment-step` | it is a payment step only you can complete | A card security code request, 3-D Secure or a CAPTCHA inside a purchase. Completed by the owner in every mode. |
| `unrecoverable-delete` | it deletes work that cannot be brought back | A shell command the exec rules recognise as deleting or overwriting what no undo record keeps, an `exec` file operation that deletes or overwrites, or a confident reading that a call destroys something that cannot be brought back. |
| `new-recipient` | it sends as you to a recipient not yet allowed | A call that sends as the owner to an address that is not one of his own destinations and that he has not allowed this session (see "New recipients"). |
| `untrusted-derived-send` | what it sends may come from untrusted text read this turn | The outward-effect boundary, with a working decision model. |
| `grant-access` | it changes who or what can reach or act for you | A tool declared dangerous (pairing, peer approval, channel login or allowlist), an `mcp` call with mode `set-trust`, `set-role` or `approve-quarantine`, and every hook change requested by the model. |
| `loosen-security` | it loosens a security, judgment or payment setting | A settings write that loosens its key by the key's own rule (raising a spending limit, turning the sandbox off, a looser permission mode), or a confident reading that a call loosens a security boundary. |
| `change-contract` | it changes what a contract requires | An operator method the catalog declares as changing a contract. |
| `irreversible-operator` | it is an operator action that cannot be undone | An operator method the catalog declares irreversible, such as killing a session or deleting a record nothing restores. |
| `standing-ask` | your rule says to ask you about this | The owner's own "always ask me" rule matched. |
| `channel-request` | it was asked for in a channel conversation, where a message cannot direct a change by itself | A change asked for on a chat channel other than Telegram. Asked every time; no remember option is offered. Applies in `yolo` too. |
| `owner-act` | it is an act that is yours alone; it runs only on your yes | A capability that is the owner's own act (paying, a card, a commit of the whole tree, trusting a folder, marking something reviewed, a managed bundle, Cloudflare writes, answering what was put to you, ...), called by a model through `capability_run` or by an outside caller through `capabilities.run` (one who is not you too: an admin's sign-in, a paired device, a member; the question names who asks, and on your yes it runs with your authority for that one call): put to you in every mode, `yolo` included, opening on No, worded as the capability with its inputs on labelled lines (secret ones hidden), and run on your yes; his yes also stands for the person's request its nested method needs. A daemon method named directly through an operator tool (answering an approval, minting a token) is still refused to the model, never asked. Plan mode still refuses a change. |

A model's `capability_run` call is read in the daemon's order before anyone decides it: its id, its inputs and, for an action with a preview, the preview (a described time with no decision model, a target that is not there). A call that would fail for a reason known then is answered at once and nobody is asked; the preview's reading is the body the call later sends. `capability_run` never runs `capabilities.run` or `capabilities.find` named as a method id: a capability is run by its own id, and a capability call cannot be wrapped in a method call to be judged another way (refused in one line, before the gate). A capability the daemon runs acts on what the daemon holds, in no project folder: the folder's trust neither refuses nor asks about its call (a model's `permissions.add` with allow in a restricted folder is asked once, opening on No, and runs on your yes; so is `security.trust-folder`); folder trust holds a turn's own work in the folder, its file writes and commands. A daemon capability that writes or runs in the project folder is held by the folder like a file write (a restricted folder refuses it, unasked): `worktree.setup`, `worktree.discard`, `hosted.new`, `agents.host`, `remote.dispatch`, `remote.dispatch-pool`, `remote.rerun-local`, `media.make`, `media.collect`, `startup.support-bundle`, `update.save-review`, `services.trust`, `services.import`, `plugin.publish-local`, `plugin.unpublish`, every change of `hooks.*`, `mcp.*` and `secrets.*` (they write the project's own `.goodvibes` files), and every export (it writes a file at a path in the project). A question that was waiting when a setting was written (another call you approved, a change made anywhere) is decided by your recorded answer, never failed for it by itself, and what you asked to be remembered is kept: on your yes the call is judged again against the mode and the deny rules as they are then, so plan mode switched on while it waited, or a deny or never-run rule that now matches, refuses it with that reason; a check that fails for any other reason refuses it. A call the daemon held for you runs on your yes only while the caller it was held for is still allowed (its operator token not replaced, its device still paired, its sign-in user and its sign-in still there); otherwise nothing runs and what came of it says so, naming the caller. What tells this after a daemon restart is kept with the question without keeping the credential (the operator token's fingerprint, the sign-in's id, the device's id); a caller for whom it cannot be told (the Agent's own credential, a peer) gets `CAPABILITY_ASK_AGAIN`: nothing ran, and it must be asked again. A held call also never runs when the daemon could not write on its question that it started (a restart could otherwise run it twice): it says so and can be asked again.

Only a question the daemon's own capability gate raised is ever run on your yes. Any surface may raise an ask (`approvals.raise`), but such an ask carries nothing the daemon later reads as authority, wording, routing or identity: the daemon keeps what is being asked (the tool, its arguments, its category and the project folder it names) and drops the raiser's metadata, its `attribution`, its remember options and their words, its `ownerOnly`, its analysis' own words and any channel route; it names the session only when the raiser registered that session itself. The card is worded by the daemon from the tool and its arguments, names who really asked (the principal the daemon authenticated: a paired device by its name, a sign-in by its user, "a program on this machine using your operator token"), offers nothing to remember and opens on No. Its answer settles that one record only: no rule is saved from it, no other open question or held call is approved by it, and no remembered answer on another question settles it. The daemon tells its own held calls by what it keeps beside the record, never by what the record says: an ask worded "Read README.md?" that names a held capability call does nothing on your yes.

A file a capability is given by path is, for anyone but you (the model, a paired device, a script, another agent), inside the caller's project, as the file really is (a link, `..`, `~` followed to what it names): one outside is refused before anyone is asked, at every door (`capabilities.run`, `capability_run`, the daemon's own turns). You may name any file yourself. A path named by a caller on another machine names a file on that machine: the daemon acts on a path only for a caller on its own machine, and says which machine the file is on; the program on that machine reads or writes the file itself and sends or receives its content where the capability takes it (`knowledge.*`, the support bundle and the moved setup, `calendar.import`, `calendar.export`). The hooks capabilities read and write only in the project and its hooks folder (`hooks.inspect` says a file that is not a hooks file could not be read as one, never quoting it); `hooks.export` writes elsewhere only for you. Installing what runs by itself later loosens a protection and is asked of you (opening on No) when the model or an outside caller does it, and asked once when you press it: `hooks.import`, `hooks.scaffold`, `hooks.enable`, `hooks.chain`, `mcp.add`, `plugin.enable`, `plugin.trust-key`, `marketplace.install`, `marketplace.update`, `schedule.add`, `schedule.change`, `schedule.resume`, `routines.promote`, `triggers.watch`, `triggers.restart`, `intelligence.install`, `agents.host`. Finishing a subscription sign-in (`provider.finish`) is your own act; `secrets.link` writes the secret store, as storing a secret does.

A held call approved after a daemon restart runs with exactly the authority the same call has live, for its caller's kind: its nested methods are dispatched as the caller it was held for (its scopes and effects), never with the daemon's own credential. Before it starts it is judged again against plan mode and the deny and never-run rules as they are then, by the same judgement as a live yes. A call held with the operator token runs only while that token is the one the daemon serves, however it changed (revoked and replaced, a regenerated token file, a value set through `GOODVIBES_DAEMON_TOKEN` and a restart).

A model's capability call goes through one gate, `capability_run`'s, judged by the capability's own risk and effects, wherever the model makes it: a tool that runs a daemon capability or method for it (`agent_local_registry`'s note, persona, skill, bundle and routine writes, `agent_documents`' writes, the `remote` tool, `agent_knowledge` and `agent_knowledge_ingest` (the daemon's `knowledge.*` capabilities), `agent_operator_action` and `agent_operator_briefing` (the daemon's methods), the `google` tool's calendar while the daemon's calendar is there, the Agent's `connected_calendar` (the daemon's `calendar.calendars.list` and `calendar.events.create`), an artifact a tool saves) runs it as a nested `capability_run` call of that tool call, so deleting a skill through `agent_local_registry` is asked as `capability_run` asks it (cannot be undone, opening on No). The tool's own call only routes it there and is classed a read, in every mode (in plan mode its reads answer; only its writes are refused): one question, the capability's (or the method's), never a second one about the tool. A daemon method is asked in words made from the method and its inputs ("Add "Dentist" to your calendar?", each input on its own line), the same words whether the model reaches it through a tool or names it in `capability_run`. One act, one question: the record a tool writes of an act you already decided, inside that act's own tool call (the receipt a calendar event or a sent mail leaves for the Personal Ops lanes), is part of that act and is never asked about on its own, but a deny or never-run rule on saves, or plan mode, still keeps it unsaved: the act is reported as done, followed by "Its record was not saved because ..."; a save that is its own act (the model's own `artifacts.save`) is still asked. Answering an approval or a question put to you is your own answer, never an act asked of you: a model's call of it, through `agent_operator_action` or `capability_run`, is refused with no question. Only that gate's run tells the daemon the call was decided; a call made with the Agent's credential without it is decided by the daemon under your mode, as any outside caller's. An artifact your own typed line or press saves is saved as part of what you asked; one a turn saves outside a tool call is decided under your mode as that turn's own act.

A command a model runs that reaches past the gate through GoodVibes itself is `loosen-security` (asked, opening on No, in every mode but `yolo`). It is judged by what the command resolves to, not by its words: every path-like word is expanded as the shell would (`~`, `~user`, `$HOME`, `${HOME}`, quotes joined, a relative path after an earlier `cd`) and then read where it really is (a link, `/proc/self/root`), and so is the program it runs (a link named `gv` to `goodvibes` is `goodvibes`). It reaches past the gate when it runs `goodvibes`, `goodvibes-agent` or `goodvibes-daemon` with anything but its help or version, or reads or writes a file under the GoodVibes home or the daemon's home (a glob over one included), or clears the model's mark (`env -u`, `unset`); what `xargs`, `find -exec`, `sh -c`/`bash -c`, `script -c`, a launcher (`nohup`, `setsid`, `timeout`, ...), `source` or a shell script file runs is read in turn, a few levels deep. A command whose reach cannot be resolved is asked about too (when in doubt, it is asked): a variable or command substitution in command position, `eval`, a shell reading its script from standard input, `at`, `batch`, `crontab`, `systemd-run`, inline interpreter code (`python -c`, `node -e`), a script file that cannot be read; a script in another language counts when it starts a product program, names the GoodVibes home or its variables. A file the model writes that runs by itself later is classed the same way, as installing something: a git hook (`.git/hooks/*`, `.husky/*`), a folder's `.envrc`, a package's `package.json`, a `Makefile`, `justfile` or `Taskfile.yml`, a shell start-up file (`.bashrc`, `.zshrc`, `.profile`, ...), the project's `hooks.json` or tool-server file (`mcp.json`, `.mcp.json`), editor tasks (`tasks.json`), a file under an autostart or systemd folder, and anything under a folder on the program search path. A yes to a command that reaches past the gate is answered each time: nothing is offered to remember, and no remembered answer (an earlier "always" included) settles the next one.

`goodvibes do` (and `goodvibes-agent do`, `goodvibes-daemon do`) says a person asked only when a person is at a terminal: its process has a controlling terminal and it was not started by a model's command tool (every command that tool runs carries `GOODVIBES_COMMAND_FROM_MODEL=1`). At a terminal, a capability that weakens a protection, cannot be undone, spends money, writes a secret or is your own act is asked once first, at the terminal device itself, never on standard input (`echo y | goodvibes do ...` is not an answer): "Add a permission rule: always allow, ask or refuse? It loosens a protection. [y/N]", and anything but y is No (`do` exits `1`, nothing ran). There is no flag that skips it, so a script, a hook, an `.envrc` or a package script someone else left behind cannot do such an act unseen when your shell runs it. Every other capability runs at once. With no controlling terminal (cron, a service) or from a model's command it is an outside caller's call, decided by the daemon under your mode: a read runs, under Ask me a change is put to you (`do` prints the approval's id and exits `3`; `goodvibes do <approval id>` reads what came of it), and under the modes that decide it is decided.

In `yolo` the owner-only list is not consulted, with three exceptions: `channel-request` is still asked, a capability that is the owner's own act is still asked (an operator method's owner act is still refused), and purchases outside the payment limits (`spend-over-limit`, `payment-step`) still come to the owner through the purchase windows. `yolo` also keeps sign-in, workspace trust, the exec sandbox boundary, the secret store and spending limits.

### Commands recognised as unrecoverable deletes

Code reads every shell command an `exec` call runs (and the command text of any tool that declares commands) and marks these as `unrecoverable-delete`, with or without a decision model:

| Program | Recognised when |
| --- | --- |
| `rm`, `unlink`, `shred`, `srm`, `wipe`, `wipefs`, `mkswap`, `blkdiscard` | Always. |
| `mkfs`, `mkfs.*` | Always. |
| `dd` | With an `of=` argument. |
| `truncate` | Always. |
| `find` | With `-delete`. |
| `git clean` | Unless `-n` or `--dry-run`. |
| `git reset` | With `--hard`, `--merge` or `--keep`. |
| `git checkout` | With `--`, `.`, `-f` or `--force`. |
| `git restore` | With paths, unless only `--staged`/`-S` without `--worktree`/`-W`. |
| `git push` | With `--force`, `-f` (or any short-flag group containing `f`), `--force-with-lease`, `--mirror`, `--delete`, `-d`, `--prune`, or a refspec starting with `+` or `:`. |
| `git branch` | With `-D`, or `--delete`/`-d` together with `--force`/`-f`. |
| `git stash` | `drop` or `clear`. |
| `git worktree remove` | With `--force` or `-f`. |
| `docker` / `podman` | `volume rm`, `volume prune`, or `system prune --volumes`. |
| `psql`, `mysql`, `mariadb`, `sqlite3`, `sqlcmd`, `clickhouse-client`, `cockroach`, `mongo`, `mongosh`, `redis-cli`, `duckdb` | An argument containing `drop table/database/schema/collection/index/view`, `truncate`, `flushall`, `flushdb`, `dropDatabase(` or `.drop(`. |

The command is read the way the never-run rules read it (one reading for both): through the wrappers `sudo`, `doas`, `env` (and its `-S` string), `nice`, `nohup`, `time`, `timeout`, `stdbuf`, `ionice`, `command`, `builtin`, `exec`, `xargs`, `chronic`, `unbuffer`, `setsid`, `flock` (and its `-c` string), `watch`, `caffeinate`, `systemd-run`, `script -c`, `parallel` and `busybox`; inside `sh -c`, `bash -c`, `zsh -c`, `dash -c`, `ksh -c`, `fish -c`, `ash -c` and `eval` strings, `$(...)` and backticks, `find -exec`, an `alias` definition and the shell's grouping and keywords (`( ... )`, `{ ...; }`, `if`, `then`, `do`); and into a shell script the command runs (`bash tidy.sh`, `bash -o pipefail tidy.sh`, `./tidy.sh`, `source x.sh`, `bash < tidy.sh`), read from disk relative to the directory the command runs in (an `exec` entry's own `cwd`, else the call's working directory) as the command's own `cd` left it, up to six levels deep. Command text built when the command runs is read as written, a variable as one word: `sh -c "cd $DIR && make"` reads `make`, while text whose program is a variable (`bash -c "$CMD"`, `eval "$X"`) and a script path built that way (`sh "$F"`) cannot be known when the call is judged. git's global options with a value (`git --work-tree /repo reset --hard`, `--git-dir`, `-C`, `-c`) are read past to the subcommand. A deeper nesting, a script over 256 KB, a script that cannot be read when the call is judged (missing, or written by the same command), commands a shell reads from its standard input (`curl ... | sh`), a relative script after a `cd` the gate cannot follow, and text or a script path built when the command runs (the ask says so: "it runs a command whose text is built when the command runs") are themselves treated as a deletion. An `exec` call's `file_ops` entry with `op: "delete"` (not `dry_run`), or `move`/`copy` with `overwrite: true`, is a deletion too. So `git push --force` and `rm -rf build` are owner-only in every mode except `yolo`, and are asked every time: what code recognises here, an operator act a tool declares irreversible, and a call a decision model reads confidently as hard to undo offer no remembering (the card reads "always asks · can't be remembered" and opens on No), as does the "might be wholesale destruction" ask from a model's reading. An answer that asks to remember anything the ask did not offer is taken for that one call. To let such a command run without asking, add a rule with `/permissions add`. Anything not listed is a judgment call, where a confident reading can still make it `unrecoverable-delete`.

### Other code-recognised owner-only calls

| Kind | Calls code recognises |
| --- | --- |
| `grant-access` | `mcp` with mode `set-trust`, `set-role` or `approve-quarantine`; every hook change the model requests; a tool its registration declares dangerous (the channel provider actions `runtime-start`, `runtime-stop`, `register-command` and `poll`). |
| `owner-act` | An operator method the catalog declares owner-only, called through `agent_operator_method` (answering an approval or purchase window, typing a card code, approving a purchase in advance, adding a standing authorisation, granting or withdrawing access) or an operator action declared owner-only. Refused, never asked. |
| `change-contract`, `irreversible-operator` | Operator methods the catalog declares as changing a contract or irreversible, called through the operator-method and operator-action tools. |
| `loosen-security` | A settings write (the `goodvibes_settings` tool or the Agent's settings tool) whose key's own loosening rule says the new value is looser: a higher spending limit, `sandbox.enabled` off, a looser `permissions.mode`, any change to which decision model decides (`judgment.endpoint`, `judgment.model`, `judgment.backend`, `judgment.fallbacks`, `judgment.keySource`, `judgment.keyName`), and the like. The same rule holds for the operator API: such a write made by an admin who is not the owner (an admin sign-in of someone else, a token minted for automation; not a device the owner paired himself) is put to the owner as an approval only his own credential answers (see "A change only the owner makes" in "The operator HTTP API"). Also a command (`exec`, or any tool that runs or installs commands) that runs `goodvibes`, `goodvibes-agent` or `goodvibes-daemon` with anything but its help or version, or that names a file under the GoodVibes home: through either it could loosen a protection without your yes. |
| `new-recipient` | See "New recipients". |

### New recipients

A recipient is "known" when it is one of these:

- an address in the owner-profile address settings;
- an entry of `notifications.webhookUrls`;
- `surfaces.googleChat.webhookUrl`;
- `surfaces.signal.defaultRecipient`, `surfaces.whatsapp.defaultRecipient` or `surfaces.telephony.defaultRecipient`;
- a recipient the owner allowed earlier in the same session.

Where code reads recipients:

- A tool's declared recipient arguments: the Agent's `google` tool `mail.send` reads `to`; the Agent's channel-send and review-packet share tools read `webhook`; the Agent's schedule, reminder and autonomy-schedule tools read `deliveryWebhook`; the Agent harness's `channel_draft_save` reads its webhook.
- Shell commands run through `exec` (read through the same wrappers and nesting as deletions): `mail`, `mailx`, `s-nail`, `bsd-mailx`, `heirloom-mailx`, `nail`, `sendmail`, `sendmail.postfix`, `msmtp`, `ssmtp`, `exim`, `exim4`, `esmtp`, `mutt`, `neomutt`, `swaks`, and `twilio ... messages:create` or `calls:create`.
- HTTP requests made with `fetch`, `curl`, `wget` or HTTPie to a send endpoint: Slack, Discord, Google Chat and Microsoft Teams incoming webhooks and `ntfy.sh` topics (the URL is the recipient); `api.telegram.org` send methods (`chat_id`); Twilio messages and calls (`to`); SendGrid, Mailgun, Postmark and Resend (`to`, `cc`, `bcc`); Slack `chat.postMessage`, `chat.scheduleMessage`, `chat.postEphemeral` (`channel`); Microsoft Graph `sendMail` (`toRecipients`, `ccRecipients`, `bccRecipients`); Gmail `messages/send` (the `To`, `Cc` and `Bcc` headers of the raw message).
- MCP and plugin tools not declared read-only: arguments `to`, `cc`, `bcc`, `recipient`, `recipients`, `attendees` or `invitees` holding mail addresses or phone numbers. A tool that only saves a draft sends nothing.

A recognised send whose recipients cannot be read (`sendmail -t`, `mail -t`, an SMTP session on standard input with `sendmail -bs`, a body read from a file), and a command whose script cannot be read (missing, read by a shell from its standard input, or a script path or `-c` / `eval` program built when the command runs), is treated as a new recipient. A service's host is matched with or without a trailing dot (`api.telegram.org.`). A send no rule names (an address held in a shell variable, a script that sends from inside a program, a page the browser types into) is not recognised; that call is a judgment call. When the owner allows a new recipient and chooses any remember option, that recipient is known for the rest of the session.

Mail is the daemon's capability `mail.send`. The owner sends from the Inbox of Mail, calendar and channels (a submitted form is his own request and goes at once); a model in either program sends through `capability_run` with `mail.send`, which is put to the owner first because it sends something outside this machine. In the Agent the model can also send with the `google` tool (`mail.send`).

## The approval prompt

In the terminal app and the Agent, an ask appears as the same card. Its title is the question in a sentence (`Run this command?`, `Change a file outside this folder?`, `Turn <setting> off?`), with the folder it runs in on the right (`in ~/projects/sample-app`) and, when more asks wait behind it, `1 more waiting`. Under it: what the call acts on (every command in full, the paths, the address), for a write or edit the change itself, then one sentence saying what it will do (`Runs your tests.`, `Removes the folder dist and everything in it. GoodVibes keeps no copy.`). The question and that sentence are red, with `This can't be undone.`, only for a call the program knows cannot be undone: a delete code recognises (`rm -r`, `git clean -f`, an unrecoverable file operation), an operator action a tool declares irreversible, or a call the decision model read as irreversible with confidence. With no decision model nothing else is red, and the details say `Not checked: no decision model is set, so GoodVibes can't tell whether this can be undone.` There are no risk chips.

| Key | Action |
| --- | --- |
| `y` | Yes: `Yes, once` for a call that acts once, or the button that says what a lasting change does (below). |
| `a` | `Yes, and remember (choose what)`: opens the remember choices (when the ask offers them); the web UI's ask card has the same button. Enter never remembers. |
| Up, Down, Enter | In the remember choices: move, and allow and remember with the highlighted choice. Esc goes back. |
| `1` to `9` | In the remember choices: allow and remember with that numbered choice at once. |
| `n` | No. |
| `w` | Say why (`w say why` on the card): opens `Why not:`; from then on every key is text until Enter refuses with that reason or Esc goes back. While it is open `No` is the highlighted button and the key row reads `⏎ no, with this reason`. |
| `d` | Details: why you are asked, the tool, the folder, the sandbox, the decision, effects, review reasons, the checklist and the raw arguments. |
| Left, Right, Tab | Choose a button. |
| Enter | Press the chosen button. The card opens on the yes, or on `No` for what cannot be undone, for owner-only asks whose effect cannot be taken back (money spent, a payment step, a message sent as you, a delete nothing restores, an irreversible operator action), and for asks that weaken a protection (a security, judgment or payment setting loosened; access granted to a person, device, tool server or hook), so Enter never allows those and never remembers anything. The web UI's card makes the same button its main one, and a call `just-vibes` held for one of those reasons opens on `No` in Waiting for you and the web UI. |
| Any other letter | Nothing; a paste is never an answer. |
| Space, `1` to `9`, `a`, Up, Down, PgUp, PgDn | In a multi-edit edit (`Apply selected`): keep or leave out the change under the cursor or the numbered change, keep all, move, scroll. |
| Tab | When you were typing a draft, Tab answers the request and keeps your draft. |
| Ctrl+C | No, and stop the turn. |

`Yes, once` approves this one call; the next one asks again. A yes whose effect lasts after the call never says "once": the button says what it does and the sentence under the question says how long it lasts. A settings change is saved to your settings file: `Turn off "Run commands in a sandbox"?` reads `This weakens a safety setting. Saved to your settings: it stays off until you turn it back on.` with the buttons `Yes, switch it off until I turn it back on`, `Yes, and remember (choose what)` and `No` (selected); turning a setting on reads `Yes, switch it on until I turn it off`, another value `Yes, change it until I change it back`, a reset `Yes, reset it to its default`. A tool server's trust or role reads `Yes, change its trust until I change it back` (or `its role`), letting a held server work again `Yes, let it work again`, a hook `Yes, add the hook until I remove it` (or turn it on, off, remove it), an automation the `workflow` tool adds `Yes, keep it running until I remove it`, a loosened setting put to you from another sign-in `Yes, make this change until I change it back`, and a contract change `Yes, change what it requires`. Once answered, the web UI's card folds to the choice's own line (`You said yes once`, `You switched it off; it stays off until you turn it back on`), and a chat channel says `Approved by <who>.` for a lasting change (`Approved once by <who>.` for a single call).

A call that cannot be undone, and a request that offers no remembering (a channel request, a one-call boundary ask), offer only the yes and `No`, with `always asks · can't be remembered` beside them; to let such a call run without asking, add a permission rule with `/permissions`. A command waiting on its terminal for input shows its prompt and a masked answer field: Enter sends the answer, Esc clears it and then declines. A denial is the call's answer: the model is told the call was refused (with your reason) and the turn goes on. The same keys answer a turn that runs on the daemon.

A question an agent of this chat left for you (the `query` tool's `ask`) appears as `A question for you`, pinned above the composer on rows of its own (nothing of the conversation shows beside it), with the first option selected; an option may be a short phrase (`Hi there`), and a written answer (`questions.answer`) matches the longest option it starts with. Up and Down choose an option, `1` to `9` pick one, Enter answers (the last option, `Something else…`, opens a one-line answer), and Esc answers later (it stays in Waiting for you and the web UI). The card's hint row names the keys as bound: a key rebound to choose, move up or down, or go back shows there. These keys reach the card while the composer is empty; typing goes to the composer. The answer goes through the owner inbox and the card shows `Answered: <option>` once.

The same asks appear in the web UI, in Waiting for you (the owner inbox), on Telegram, and in the channel conversation the request came from, where that channel's owner can answer.

## Remembered rules

### Remember tiers

An approval can be remembered at one of these tiers. Which tiers are offered depends on the call.

<!-- generated: remember-tiers -->

The card lists the choices narrowest first: the exact command, then the same scope for this session only, then the command's class or the folder, and last the broadest, `Any <call> in this project` (`tool`), which says what it covers on a line of its own under its name (`Broadest: whatever it names, until you remove the rule`). The `command-class` tier is a command's first word. After three remembered exact answers for one class, that tier is offered first.

A call that runs a capability (`capability_run` from a model, `capabilities.run` from an outside agent, MCP or `do`) is remembered for that one capability, named by its label, never for every capability call: the choices are `Any call to Keep this computer awake, this session only` and `Any call to Keep this computer awake in this project` (`tool`, with the line `this capability only, whatever its inputs, until you remove the rule`). The rule is keyed by the capability's id, so one answer to an outside caller's call never lets every other capability run unasked. An answer to an outside caller's call is also kept for that caller only (the device, sign-in or program credential that asked, and how it came in): the choices name the caller as the question does (`Any call to Keep this computer awake from the paired device "build bot", this session only` and `... from the paired device "build bot" in this project`), Rules lists the kept rule by that name (`allow every call to Keep this computer awake from the paired device "build bot" in this project`), never by the key it is matched on, and the rule never settles another caller's call, nor does a rule you gave your own model's calls settle an outside caller's (your deny and never-run rules still refuse every caller's). For an act of your own asked by someone who is not you (a paired device's payment, a member's folder trust), nothing is offered to remember: each such call is asked.

Every tier except `session` writes a durable rule. A durable rule is scoped to the project it was made in and matches only there. A remembered answer to an owner-only item is kept as an answer to that kind, so only it settles that item again.

A choice to remember is not saved when the owner edited the arguments, when the choice does not apply to those arguments, when no rule store is available, or when there is no working directory to scope it to. The answer then says: `Your choice to allow this command was not saved (<why>); it applies to this call only, and you will be asked again.`

### How a remembered rule comes to exist

No command, setting or operator method adds a rule directly. A rule exists only in these ways:

1. You answer an approval prompt with a remember tier other than session (in both terminal programs, `a` on the card, then the choice and Enter; the tiers offered are numbered in this order: exact, command-class, path, tool, session, with command-class moved first after three remembered exact answers for that class; only the tiers that apply to the call are offered). A stream-json headless run's `"remember": true` on a `PERMISSION_ANSWER` remembers for the session only, not as a rule.
2. You choose never, always or ask me on a call Jev decided (Waiting for you, Decisions). The rule is built at the first tier the call offers (for `exec`, `exact`; for `write` and `edit`, `path`; otherwise `tool`).
3. You add a record to the rules file by hand (format below). The file is re-read within two seconds; a malformed record is skipped.

Each rule records the project it was made in (the working directory's absolute path) and matches only there. A rule made with no working directory is not saved. What each tier matches:

| Tier | Rule | Matches |
| --- | --- | --- |
| `exact` | `allow exactly: <command>` | That command text exactly, and the same working directory, environment and file operations. `bun test` does not match `bun test foo`. |
| `command-class` | `allow the <word> command class` | The bare word, and any command starting with `<word> `. |
| `path` | `allow edits under <directory>` | `write` and `edit` under that directory. |
| `tool` | `allow every <tool> call in this project` | Every call of that tool. |

A deny rule reads `deny ...` and an "always ask me" rule `ask ...`.

"This project" is the project of the work that asked, wherever it runs: a runner, a schedule's run, an agent or a session the daemon runs in a project, and an outside caller that names its folder, are decided with that project's rules and that folder's trust, and an answer "in this project" is kept for it, never for the folder the daemon was started in. A rule kept for one project never allows or refuses a call in another. Each runner and each agent the daemon starts is a session of its own, so "this session only" covers that one runner or agent, and two identical questions from two sessions or two projects are two questions, each answered on its own. Every question names the folder it was asked in. Rules, in Permissions and safety, lists the rules in force where it is opened (that project's and those of every project), each with the project by name. A rule made from a runner's or a chat's answer says which, by its title ("remembered from an answer to Runner: run the tests"). A daemon before this version kept every rule from work it ran in any project for its own folder; at the first start each is moved to the project its answer was given in when the kept approval records show it. One that cannot be placed and refuses or asks keeps applying in every project, as it did, listed under "Every project (carried from 3.5.0)" with `k` (keep it for this project only, from the project's Rules) and `x` (remove); one that allows stays the daemon folder's. You are told once, with the counts.

Worked example: allow `bun test` in this project only.

1. Make the call reach you. With a working decision model in `jev-decides`, Jev may run it without asking; then choose `a` always on that decision in Waiting for you, Decisions, instead (it saves the same `exact` rule). Otherwise switch to `ask-me` for this session only (Shift+Tab in the terminal app); without a working decision model, with `permissions.tools.exec` at its default `prompt`, the `exec` call is asked.
2. Ask the model to run `bun test`. On the card, choose the tier "This exact command" and press Enter.
3. `/permissions rules` lists `exec: allow exactly: bun test`.

### Where rules are kept

The owner's rules are one file, `~/.goodvibes/shared/permission-rules.json`, read and written by the terminal app, the Agent and the daemon (its hosted sessions, routines, channel turns and the web UI). `GOODVIBES_HOME` moves it. A rule added, remembered or revoked in any of them holds in the others at once, without a restart: each program notices the other's write before its next decision (a watch on the directory, or one look at the file at most every two seconds where the directory cannot be watched), and `/permissions rules` and the web UI list show the same set. A rule remembered in a project keeps that project and matches only there; a never-run rule, and a rule written by hand without `project`, applies in every project. Writes take a lock on the file, so two programs never lose each other's change. Format:

```json
{
  "version": 1,
  "rules": [
    {
      "rule": { "type": "prefix", "id": "user-exact-exec-handmade-1", "origin": "user", "effect": "allow",
                "toolPattern": "exec", "exactCommands": ["bun test"], "description": "allow exactly: bun test" },
      "tier": "exact",
      "tool": "exec",
      "createdAt": 1795000000000,
      "project": "/home/me/work/app"
    }
  ]
}
```

A record without `project` applies in every project. Rule types and fields are those of a policy bundle rule (see "Bundle file format" under "Managed policy bundles"), with `origin` `user` and `effect` `allow`, `deny` or `ask`.

### Listing and revoking rules

```text
/permissions show       show the mode in force and every permission setting in effect and where each value came from
/permissions rules      list the rules; in the terminal app a picker opens: Del revokes the selected rule
/permissions revoke <rule>
/permissions never <command>                         never run commands matching, e.g. git push (every tool, every mode, every project)
/permissions add <allow|deny|ask> command <command>  this exact exec command, in this project
/permissions add <allow|deny|ask> class <word>       every exec command starting with <word>, in this project
/permissions add <allow|deny|ask> path <directory>   write and edit under a directory, in this project
/permissions add <allow|deny|ask> tool <tool>        every call of a tool, in this project
```

`/permissions add` writes the rule to the same store as a remembered answer, in both programs, into the one file every program reads (see "Where rules are kept"). It answers `Added rule owner-<kind>-<tool>-<time>-<random>: <description> (in <project>). Remove it with /permissions revoke <id>.`; without a working directory, `There is no working directory to scope the rule to; run this from a project. A never-run rule needs none.`; with words it cannot read, the usage above. `/permissions` alone opens these actions to choose from (a model or script running it alone gets `show`); `add allow ...` and `revoke` are the owner's only, and `add allow ...` saves the rule at once (`revoke` takes it back).

Each listed rule shows the tool (`any tool` for a never-run rule), what it covers, `allow`, `deny` or `ask`, `remembered <tier>` for an answer, `added <tier>` for a rule added with `/permissions add`, or `never run, every mode`, the project (or `every project`) and when it was made. The web UI lists and revokes the same rules under Settings, Permissions (operator methods `permissions.rules.list` and `permissions.rules.delete`, tier `never-run` for a never-run rule); it does not add one.

The shape of `/permissions rules` on a surface without a picker (rule ids are generated, `user-<tier>-<tool>-<time>-<random>`):

```text
Permission rules:
  user-exact-exec-mi4k2x1c-k3j9a2  exec: allow exactly: bun test  (allow · remembered exact · in /home/me/work/app · 11/18/2026, 10:02:11 AM)
  owner-never-run-git-mi4k3a0d-q7w2e1  any tool: never run: git push  (deny · never run, every mode · every project · 11/18/2026, 10:05:40 AM)

Revoke one with: /permissions revoke <rule-id>
```

Outcomes: `Revoked remembered rule: <id>`; `No remembered rule with id: <id>`; `No permission rules. Approving an ask with a remember tier stores one here; /permissions add writes one directly.`; in the picker, `Revoked remembered rule: <label>` or `Rule already gone: <label>`; a failed delete, `Could not revoke the rule: <reason>`; `/permissions revoke` with no id, `Usage: /permissions revoke <rule-id>  (see /permissions rules for ids)`; on a surface without a rule store, `Remembered permission rules are not available on this surface.`

### Never-run rules

A never-run rule is a guarantee, not a hook: the gate itself refuses, in every permission mode including `yolo`, every call that would run a command the rule names, whatever tool carries it.

```text
/permissions never git push
/permissions never rm -rf /
```

A rule is a program followed by the words it must carry, in that order (`git push` matches `git push`, `git -C repo push origin main`, not `git status` or `git commit -m "push fix"`). What the gate reads:

- every shell command a call carries: `exec` `commands[].cmd`, the decoded `cmd_base64`, a flat `command` or `cmd` (the Agent's `terminal`, `process` `start`, `agent_harness` processes), the same fields nested in a call's input (an `agent_operator_method` call that runs a command on a peer or backend), a `workflow` schedule's command and hook action, a `state` command hook (and a command hook a model asks to register), and a `trigger`'s `spec.command` with its `args`;
- a tool run inside another tool, which goes through the gate too;
- each command through `sudo`, `env`, `xargs`, `timeout`, `setsid`, `flock` and the other wrappers listed for the owner-only deletions above, into `sh -c`, `bash -c` and `eval` strings, `$(...)` and backticks, `find -exec`, an `alias` definition, the shell's grouping and keywords (`( ... )`, `{ ...; }`, `if ...; then ...; fi`, `while ...; do ...; done`), and a shell script it runs (`sh publish.sh`, `bash -o pipefail publish.sh`, `./publish.sh`, `source x.sh`, `bash < publish.sh`), read from disk from the directory the command runs in (an `exec` entry's own `cwd`, so `{ "cmd": "./publish.sh", "cwd": "scripts" }` reads `scripts/publish.sh`) as the command's own `cd` left it (`cd scripts && ./publish.sh` reads `scripts/publish.sh`). Refused unread: a script over 256 KB, a command nested more than six levels deep, a script that cannot be read when the call is judged (one the same command writes first, a missing file), commands a shell reads from its standard input (`echo 'git push' | sh`, a here-document), a relative script after a `cd` the gate cannot follow (`cd "$DIR"`, `cd -`, `popd`), and command text whose program, or a script path, is built when the command runs (`bash -c "$CMD"`, `eval "$X"`, `sh "$F"`; the refusal says "it runs a command whose text is built when the command runs"); a variable that is only a `cd` target or an argument inside such text is read like any word (`sh -c "cd $DIR && make"` runs `make`);
- quoting the way the shell removes it (`g''it push`, `"git" push`).

Refused as well, because code cannot rule out that they run the command: a command whose program is built when it runs (`$(printf git) push`), the rule's program with an argument built when it runs (`git $X`, a variable set in `exec`'s `env`), and the program fed arguments by `xargs` (`echo push | xargs git`); text a call writes to a running process (`process` `write`) that carries any word of the rule, since a shell can receive a command in pieces; code for an interpreter (`repl`, a script in another language) that names the program and then the words within twelve words.

Not seen: what a program does on its own once started (a git alias defined earlier, a compiled program, a script in another language that builds the words), tools of MCP servers, and commands you type yourself (`!git push`).

The refusal the model receives: `Your never-run rule "<rule>" refuses this call: <why> (<command>). It applies in every permission mode, yolo included; only you can remove it, with /permissions rules.` In the rules file a never-run rule is `{ "rule": { "type": "never-run", "id": "...", "origin": "user", "effect": "deny", "toolPattern": "*", "commands": ["git push"], "description": "never run: git push" }, "tier": "never-run", "tool": "*", "createdAt": ... }` with no `project` (it applies in every project). The rules file is read in every mode; while it cannot be read, every call is refused.

### Per-tool settings

`permissions.tools.<name>` takes `allow`, `prompt` or `deny`.

- `deny` blocks the tool in every mode except `yolo`. `permissions.tools.write = deny` also blocks every call in the `write` category.
- `allow` and `prompt` matter only when a judgment call is decided without a working decision model: `allow` runs it, `prompt` asks. Reads run unless their setting is `prompt`.
- They do not change facts: a recoverable edit inside the working directory runs whatever `permissions.tools.edit` says, unless it says `deny`.

```text
/settings set permissions.tools.fetch deny
```

### `/permissions` output

`/permissions` prints `mode in force` (with `not <mode>, because <reason>` when it is not the chosen mode), then `saved mode`, or `chosen for this session` with the saved default, then each permission setting with its value and origin (`built-in default`, `global config file (<path>)`, `project config file (<path>)`, `shared config file (<path>)`, or `runtime override`), then the number of remembered rules. A value marked `*` was changed at runtime (for example with `-c`) and is not saved on disk. The `Permission evaluator` row shows `in force: <value> until restart` when `permissions.engine` was changed and the process has not restarted.

## Decisions Jev made: Waiting for you, Decisions

Every call Jev decided at the gate (in `jev-decides` and `just-vibes`) is posted to the owner inbox as a `decision` item. Waiting for you (the menu, Ctrl+G then m) lists them on its Decisions tab, read by itself and read again when one is posted, answered or expires, and lets the owner change each one with a key on the selected decision:

| Key | What it does | Shown when |
| --- | --- | --- |
| `k` keep | Leave a decision as Jev made it | always |
| `n` never | Never allow calls like a decision's (saves a deny rule) | a rule can be made from the call |
| `a` always | Always allow calls like a decision's without asking (saves an allow rule; `/permissions revoke` takes it back) | a rule can be made from the call |
| `s` ask me | Ask me every time about calls like a decision's (saves an "always ask me" rule) | a rule can be made from the call |

- A choice is the answer to the decision: it runs on the press, and the line under the list says what was done.
- A decision is carried out by the program whose gate made it (its detail names it: the terminal app, the Agent or the daemon), while that session is open. Chosen elsewhere, it is refused with `Jev made this decision in <program>, and only that app can apply a choice on it.`
- A decision is not undone from this list: it is posted when the gate makes it, before its call runs, and a change the program records for undo (`write`, `edit` inside the project) is allowed by code, never put to Jev. A change a turn made is taken back with `/undo`.
- Each decision reads as one sentence in the words its ask would have used ("Jev allowed this for you: change notes.md"), the same in the list, its detail and the web UI; its rule line says where a standing rule would apply ("Edits under /home/sam/notes, while you work in this project").
- `never`, `always` and `ask` save the rule in the same rule store as a remembered answer.
- A decision item stays open for 24 hours. The app keeps the last 200 decisions. When the session that made a decision ends, its open items are withdrawn with the note that a standing rule can be set with `/permissions`.
- Only the owner chooses. The model and scripts reach the same choices as the capabilities `decisions.keep`, `decisions.never`, `decisions.always` and `decisions.ask` (each takes `decision`, an item id or a unique prefix); a model's call of one is refused as the owner's own act. `decisions.list` (inputs `when`: `today`, `yesterday`, a day such as `2026-11-19`, or `since <day | 30m | 2h | 3d | 1w>`; `count`) lists the open decisions and what was decided, through the daemon.
- The web UI shows the same list with the same choices.

What you can see, and for which period:

| What | Where | Period |
| --- | --- | --- |
| Gate calls Jev decided in `jev-decides` and `just-vibes` (allowed or refused, with Jev's reason) | Waiting for you, Decisions, in either app; the web UI | Each item is open for 24 hours; the newest 200 per running app are kept; items of an app that exits are withdrawn. `decisions.list` with `when` set to `today`, `yesterday`, `<YYYY-MM-DD>` or `since <day or 30m/2h/3d/1w>` shows only that period (an open item by when it was decided, an answered one by when it was answered), looking through the whole inbox; `count` shows the latest n, however many. |
| Answered owner-inbox items (permission asks, questions, claims, purchase windows), by whom and from where | Waiting for you, Answered; `questions.all`; the web UI's Waiting for you and Work page ("Show older") | For good: an answered item is never dropped. |
| Calls `just-vibes` held | Waiting for you, Held calls | Until answered; at most 64. |

What cannot be seen from any product command:

- Judgment calls Jev read in `ask-me` and let run (`ask-me` asks Jev to read, not to decide, so nothing is posted to Decisions).
- Decisions that are not about a tool call: reading a natural-language schedule, triaging mail, grading a merchant, reading a channel message.
- Jev's reason for a refusal after the fact, other than the refusal text the model received and the decision item.

Every reading the engine takes, answered or failed, is written to the decision log, the SQLite file `<project>/.goodvibes/<surface>/decisions.sqlite` (`<surface>` is `tui` for the terminal app and the daemon, `agent` for the Agent), but no product command shows it.
Each reading is one row with its context, answers, timing, model and lineage, written in one synced commit; its questions (a battery's instructions and criteria, the same on every call) are stored once per distinct set and named by their SHA-256, so a row is under a kilobyte on average (it was 3.5 KB, up to 49 KB). Readings older than `atRest.retentionMaxAgeDays` (30 days by default) are removed, and at most the newest 100,000 kept, a batch at a time ten seconds after start and once a day; the space they free goes back to the disk a few megabytes at a time. A log written by 3.4.2 or earlier is carried forward by the same pass, 500 rows at a time, and rewritten once into the new form when its live data is under 32 MB; then one line says how much space came back (`[Decision log] The decision log was carried forward to its smaller form: ...`). After a rollback to 3.4.2 the log cannot be read by that build: it is set aside as `decisions.sqlite.unrecognized-1` and a new one is started.

How to reverse a decision:

| Decision | Reverse it with |
| --- | --- |
| Jev allowed a `write` or `edit` | `u` undo on it in Decisions restores the files (while the item is open). |
| Jev allowed anything else (an `exec` command, a `fetch`, a send) | It cannot be undone from here. `n` never or `s` ask me on it stops calls like it. |
| Jev refused a call | There is no "allow once". `a` always on it saves an allow rule for calls like it; then ask the model to try again. Or switch to `ask-me` for the session (Shift+Tab) and approve it when asked. |

## Calls held by `just-vibes`: Waiting for you, Held calls

Waiting for you's Held calls tab lists every call a gate held for the owner, the daemon's and each terminal program's, with the answers `y` (let it run) and `n` (set it aside) on the selected call; an answer runs on the press. The model and scripts reach the program's own held calls as the capabilities `held.list`, `held.approve` and `held.dismiss` (`calls`: ids separated by spaces, or `all`); they run in the program holding the session, and a model's approve or dismiss is refused as the owner's own act.

- Each held call shows its id (`h1`, `h2`, ...), the tool, a summary and the reason. The reasons are: `held for you: <owner-only reason>` for an owner-only item; `held for you: this needs a decision and no decision model is set up` or `held for you: this needs a decision and decision models are off` (both mean the call was a judgment call and no working decision model was in use: none set, `No Decision Model` chosen, or `Hybrid` after the set model failed); `held for you: <Jev's summary>` when Jev would not run it.
- The end of each `just-vibes` run lists what it held.
- An approval is the owner's "allow for this session" answer for that exact call. The call does not run by itself: ask the agent to carry on, and the call runs when it is made again.
- The same exact call held again keeps its first id. At most 64 held calls are kept.
- Only the owner can approve or dismiss.
- Every held call is in the owner inbox, as a queued action (`Let it run: ...?`, `y` lets it run, `n` sets it aside): the daemon posts the calls its own gate holds, and each terminal program posts the calls its gate holds while it is connected to the daemon (one held while the daemon is down is posted when it is back). So Waiting for you, the web UI and a phone list them with everything else and answer them; an answer there approves or sets aside the call in the program that held it, and `held.approve` or `held.dismiss` there withdraws the inbox item. A held call that loosens a protection opens on No.

## The owner inbox: Waiting for you

Waiting for you (the menu, Ctrl+G then m; the same place in the Agent and a view in the web UI) shows everything waiting on the owner, read by itself and read again when anything in it changes anywhere: Questions (questions agents left, channel owner claims, purchase windows, reports), Approvals, Held calls, Decisions, Telegram (messages held for the owner), Sends (the Agent only: sends its content check refused), Answered (everything already answered, withdrawn or expired, with who answered, from where, and whether the answer reached the asker) and Kinds (what each kind of approval asks about and what to check before answering). The selected item's detail says who asked, when, until when it waits, what answering does and why you are asked; a session is named by its title (`the session "Garden planner"`), never by its id.

An item's answers are its own keys on the hint row (the daemon's keys for its choices: `y`/`n` for approve and deny, digits otherwise); an answer runs on the press, and the line under the list names it as pressed (`Answered "Run bun test?": No.`). Enter lists the answers, starting on No for an ask that loosens a protection. `w` answers a question in your own words. `x` withdraws a request for approval you raised (it asks first: it cannot be undone).

The model and scripts reach the same inbox through the daemon as capabilities: `questions.list` (everything open), `questions.all` (everything, newest first), `questions.show` (`item`), `questions.answer` (`item`, `answer`: one of its answers, then a note if you like, or your own words) and `questions.withdraw` (`request`, `note`). A model's answer or withdrawal is refused as the owner's own act; a purchase window is answered only with the authority `payments.purchase.approve` takes.

For an item with options, the longest option the answer starts with is the choice and the rest is its note. A channel owner claim offers `accept` and `decline`; a held-call item `approve` and `dismiss`. A decision item's choices are the Decisions tab's keys.

## Plan mode

Plan mode is a separate read-only posture for the model and for every caller that is not you. Reads run; every write, command, network call and other change is refused with the reason `plan mode is on and <tool> would change something` and the next step "present the plan of changes and wait for the owner to approve it"; a change a tool makes for the model inside its own call is refused as `Plan mode is on, so nothing was changed: <what was asked>.` Plan mode restricts the model, not you: your own press, form or typed line (a draft made from its place, "Write a new draft") runs in plan mode, while a deny or never-run rule still refuses it.

Plan mode is the "Plan mode" row of This conversation in Permissions and safety (Ctrl+G m): `p` turns it on, and on again `p` turns it off (asked first: it loosens a protection). The same acts are the capabilities `plan.status`, `plan.on` and `plan.off` (the model's `capability_run`); no slash command carries them.

- Turning it on sets plan mode for this session only, as Shift+Tab does, and remembers the mode you were in; turning it off restores that mode. Neither changes the saved `permissions.mode` in your settings file, and plan mode ends with the session.
- Turning it on only tightens a protection, so a model's `capability_run` of `plan.on` is never asked about or refused, in any mode and in a restricted folder. Turning it off is the owner's own act: refused to a model.
- Leaving plan mode another way (Shift+Tab, which moves from `plan` to `ask-me`) forgets the remembered mode.
- Plan mode entered another way (for example `/settings set permissions.mode plan`, or a channel profile) has no remembered mode; turning it off then returns to `ask-me`.
- Outputs: `Plan mode is on: writes, commands and network calls are blocked until you turn it off (or press Shift+Tab).` and `Plan mode is off; the mode is <mode>.`
- Plan mode is the terminal app's. In the Agent and for channels, set `plan` through `permissions.mode` or a channel profile.
- A read outside the working directory is refused in plan mode.

## Explaining a decision: `goodvibes doctor explain`

```sh
goodvibes doctor explain "rm -rf build"
goodvibes doctor explain write ./src/app.ts
goodvibes doctor explain read ./notes.txt --json
```

A subject that is a tool name followed by a path is checked as that tool; any other text is checked as a shell command run through `exec`. The output shows the subject, the tool and category, the current mode, the platform analyzer's risk, and `Decision: ALLOW`, `ASK` or `DENY` with the layer that decided.

It runs the gate the app runs: the mode in force (with the reason when it is not the saved mode), the feature flags and managed policy from settings, the remembered rules and never-run rules (`~/.goodvibes/shared/permission-rules.json`), and the decision model with its decision log in your home. A judgment call is a real request to the decision model; like every permission decision it ends when the model answers or fails. Nothing runs and nothing is remembered: an ask is answered "no" without a prompt and reported as `ASK`. After the gate allows a call it applies the tool's own path containment: `read`, `find`, `inspect`, `repo_map` and `analyze` refuse a path outside the project root in every mode but `yolo`, and `write` and `edit` refuse one in every mode, reported as `DENY` decided by `<tool> tool path containment`. The `decision model:` line says `consulted`, `not needed: a rule, a setting or the mode settled this call`, or `not consulted: <why> The verdict is the one the gate gives without a decision model.` (none set, or the set model failing). A remembered-rules file that cannot be read is named on the `rules:` line (the running app refuses every call until it loads). It does not use the workspace trust of the directory. Treat `ASK` as "this reaches an owner prompt". It exits `0`; with no subject it prints usage and exits `2`. With `--json` the fields include `mode`, `savedMode`, `modeReason`, `decisionModel`, `decisionModelConsulted`, `containment` and `verdict`.

## The decision model

The decision model answers judgment calls at the gate and many other decisions (reading a natural-language schedule, triaging mail, reading a channel message for card details, grading a merchant). Every decision has a stated fallback.

### When the decision model gives no answer

When the set decision model gives no usable answer, for any reason (unreachable, too slow, a request too large for it, an HTTP error of any status, a refused or missing key, a malformed answer, a closed connection), each decision takes its stated fallback and the work goes on; you are told once per outage, naming the model, what failed and the next step, and the notice is withdrawn when it answers again. Nothing the decision model fails ends a turn, a tool call batch or a contract; a contract's checks are recorded as not judged and its work is kept. An answer (a refusal by the model included) or a cancellation is not a failure. The reason is kept in the decision log. With no decision model set, nothing is asked, nothing waits, and no error is shown.

In `jev-decides` and `just-vibes`, the setting "If Jev can't answer" (`judgment.policy`, in the decision model settings) says what happens to a tool call Jev would decide while the decision model fails: `Hybrid`, shown as Ask me (the default), brings it to you (held to the end of the run in `just-vibes`); `Decision Model Only`, shown as Refuse the action, refuses it with the model's error and the turn goes on. It is kept in the daemon's settings file (`~/.goodvibes/daemon/settings.json`), one value for the terminal app, the Agent and the daemon. Releases up to 3.5.0 had a third value, No Decision Model; a home that holds it is carried once to the mode Ask me with no decision model set, so nothing is sent to a decision model: the decision model's own settings (`judgment.endpoint`, `judgment.model`, `judgment.keySource`, `judgment.keyName`, `judgment.backend`, `judgment.fallbacks`) are moved, as they were, to `judgment.setAside`, and the owner is told once. Choosing a decision model in Settings then offers them back first ("Use the decision model you had before"), which sets them again and empties `judgment.setAside`. The carry also stores the choice itself, "No decision model" (`judgment.noDecisionModel` on): while it is on, no decision model is asked whatever the environment holds (`TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`, or a key source), and nothing is sent to one. Choosing "No decision model" in the decision model picker (both terminal programs) or switching "No decision model" on in the web settings stores the same choice and leaves the decision model settings as they are; choosing a decision model, or "Use the decision model you had before", turns it off. On a fresh home it is off, so a key found in the environment is used as before. A 3.5.0 program reading the home after a rollback starts and leaves the two keys it does not know (`judgment.setAside`, `judgment.noDecisionModel`) in the file; it does not honour the choice, so with a key or server address in its environment it asks the decision model there (3.5.0 has no setting that wins over the environment).

### Setting up the hosted decision model (Jev)

Prerequisite: a TypeSafe API key for the hosted endpoint.

1. Put the key in the environment variable `TYPESAFE_API_KEY` for the process (or the daemon service), or store it in the secret store and point the settings at it:

   Store it with "Store a secret" in Permissions and safety, Secrets (name `TYPESAFE_API_KEY`, all your projects), or `goodvibes do secrets.set --input key=TYPESAFE_API_KEY --input scope=user` (the value is typed on a hidden line), then:

   ```text
   /settings set judgment.keySource secret
   /settings set judgment.keyName TYPESAFE_API_KEY
   ```

2. Leave `judgment.endpoint` and `judgment.model` empty to use `https://api.typesafe.ai` and `jev-latest`.
3. Check: `goodvibes status` prints under `Decision model:` either `A decision model is in use.` or `No decision model is in use: none is set, so decisions take their fallbacks. To use one, choose a Decision model in /settings open.`

`judgment.keySource` takes `env` (read the environment variable named by `judgment.keyName`), `secret` (read the secret-store entry named by `judgment.keyName`) or `none` (no authentication, for a local deployment). `judgment.keyName` is a name, never a key value.

### Setting up another decision model

| Setting | Meaning |
| --- | --- |
| `judgment.endpoint` | The decision endpoint's base URL (`http` or `https`). Empty uses `TYPESAFE_BASE_URL`, then the hosted endpoint `https://api.typesafe.ai`. A loopback address (`localhost`, `127.x.x.x`, `::1`) marks a local model. Embedded credentials, query strings and fragments are refused. While `judgment.keySource` is not `none`, the endpoint is changed or reset only in the same update as `judgment.keySource` or `judgment.keyName` (keep it by sending its current value, or clear it with `none`); alone it is refused with `CREDENTIAL_DESTINATION_UNBOUND` and nothing is saved, so a key is never sent to an address nobody chose it for. The settings screens do this for you: the terminal's decision-model picker asks for the credential with the endpoint, and the web UI's edit and Reset set authentication to none. |
| `judgment.model` | The model name sent in each request. Empty uses `TYPESAFE_DEFAULT_MODEL`, then `jev-latest`. |
| `judgment.keySource` | `env`, `secret` or `none`. |
| `judgment.keyName` | The environment variable (`env`) or secret-store entry (`secret`) holding the key. It must be a non-empty name (letters, digits, `_ . / : -`); with `keySource` `none` it is ignored, so leave it as it is. |
| `judgment.backend` | Optional `{ "adapter", "maxInputBytes", "maxQuestions", "responseModels" }` for the primary target. |
| `judgment.fallbacks` | Ordered backup targets, each `{ "endpoint", "model", "keySource", "keyName" }` plus optional `"backend"`. In a fallback, `keySource` may be `env`, `secret` or `none`, and `none` requires `"keyName": ""`. The default is `[]` (no backups). |
| `judgment.timeoutMs` | How long one attempt at one target may go without its answer before that target counts as not answering, default `30000`; `0` means the default. It is there for a server that took the request and never answered, or a connection lost without a reset: the decision API sends its whole answer at once, so nothing else tells such an attempt from a slow one. Raise it for a slow local model. |

#### The wire protocol ("System One")

Every adapter except `cloudflare-workers-ai` speaks the System One protocol of `@typesafe-ai/sdk`:

- `POST <endpoint>/v1/systemone` with headers `Content-Type: application/json`, `Accept: application/json`, and `Authorization: Bearer <key>` unless `keySource` is `none`. Redirects are refused.
- Request body: `{ "model": "<judgment.model>", "state": <text, JSON object or array, or null>, "questions": { "<name>": <question>, ... } }`. A question is one of:
  - `{ "type": "noul", "instructions": ..., "criteria": { "true": ..., "false": ... } }` (yes or no);
  - `{ "type": "choice", "instructions": ..., "criteria": { "<label>": <description>, ... } }`;
  - `{ "type": "score", "instructions": ..., "criteria": [<description for 0>, <for 1>, ...] }`.
- Response body (HTTP 200): `{ "model": "<model that answered>", "answers": { "<name>": <answer>, ... }, "usage": { "input_tokens": <n>, "output_tokens": <n> } }`, with one answer per question name:
  - `{ "type": "noul", "noul": <probability of yes, 0 to 1> }`;
  - `{ "type": "choice", "choice": "<label>", "confidence": <0 to 1>, "probabilities": { "<label>": <p>, ... } }`;
  - `{ "type": "score", "score": <expected score>, "confidence": <0 to 1>, "legend": {...}, "probabilities": { "0": <p>, ... } }`.
- `usage` is required. A response that reports cut-off input (`truncated: true`, `usage.truncated` true or above 0, `usage.state_tokens_dropped` above 0, a non-empty `usage.truncated_questions`, or `usage.state_tokens_used` below `usage.state_tokens`) is refused as incomplete evidence.
- The answering `model` must equal the requested one. For a request of `jev-latest` or `jev-preview`, a pinned `jev-<x>.<y>.<z>` answer is accepted; any other alias the server answers with must be listed in `backend.responseModels`.
- An HTTP 400 with `detail.error_type` `max_tokens_exceeded` means the input is too long. Other HTTP errors: 408, 429 and 5xx count as the model being unavailable (retried once, then the next target); any other status as a refusal.
- `GET <endpoint>/v1/models` lists models (`{ "data": [{ "id": ... }] }` or `{ "models": [{ "name": ... }] }`); it is used only by model pickers.

The adapters:

| `backend.adapter` | Protocol | Notes |
| --- | --- | --- |
| `system-one` (default) | As above. | TypeSafe's hosted Jev and every local server on the same protocol. |
| `cloudflare-workers-ai` | `POST` to the endpoint URL itself (a Workers AI run URL, `https://api.cloudflare.com/client/v4/accounts/<account-id>/ai/run/@cf/cloudflare/clef` or `.../clef-flash`) with the same body; the answer comes wrapped as `{ "success": true, "result": { ...the response above... } }`. | Chosen automatically for such a URL. The model must be `clef` or `clef-flash` and match the URL's last segment. At most 64 questions with names of letters, digits, `_ . -`, and a bounded input size. The key is a Cloudflare API token (for example `keyName` `CLOUDFLARE_API_TOKEN`). |
| `laya` | `POST /v1/systemone`. | The server must keep truncation and Jev confidence metadata (`x_jev_confidence`; do not run it with `LAYA_JEV_STRICT`). An answer marked `abstain`, `unbound` or routed to review stops the decision. |

The named models (starting configurations, not a closed list):

| Name | `judgment.model` | Adapter | Where it comes from |
| --- | --- | --- | --- |
| Jev | `jev-latest` | `system-one` | TypeSafe, hosted at `https://api.typesafe.ai` (docs.typesafe.ai/api). |
| Clef | `clef` | `cloudflare-workers-ai` | Cloudflare Workers AI. |
| Clef-flash | `clef-flash` | `cloudflare-workers-ai` | Cloudflare Workers AI. |
| DiffusionGemma Jev | `dgemma` | `system-one` | Self-hosted; github.com/mmastrac/djev. |
| Kev-9B | `kev-latest` | `system-one` | Self-hosted; github.com/jaredpalmer/kev. |
| Laya | `english` (answers as `laya-rl-agent`; put that in `backend.responseModels`) | `laya` | Self-hosted; github.com/NandhaKishorM/laya. |

#### A self-hosted decision model that stops the product when it is down

Prerequisite: a server speaking the protocol above, for example Kev-9B listening on `http://127.0.0.1:8080`.

```text
/settings set judgment.keySource none
/settings set judgment.endpoint http://127.0.0.1:8080
/settings set judgment.model kev-latest
/settings set judgment.backend {"adapter":"system-one"}
/settings set judgment.fallbacks []
/settings set judgment.policy Decision Model Only
/settings set permissions.mode jev-decides
```

- `judgment.fallbacks []` makes sure no hosted model answers in its place.
- `judgment.keySource none` comes first: while a credential is configured, `judgment.endpoint` changes only together with it (see below).
- `Decision Model Only` (Refuse the action) keeps asking the model through an outage instead of setting it aside: a tool call it cannot decide is refused with the model's error (`Not run: the decision model could not decide this call (<error>), and "If Jev can't answer" is set to Refuse the action. ...`), and the gate does not ask you instead; the turn goes on. With `Hybrid` (Ask me) an outage falls back after one notice.
- `permissions.mode jev-decides` is set explicitly: the unchosen default would behave as `ask-me` on a model the shipped calibration did not measure.
- With an authenticated server: store `KEV_API_KEY` with "Store a secret" (Permissions and safety, Secrets, all your projects), then `/settings set judgment.keySource secret`, `/settings set judgment.keyName KEV_API_KEY`.
- Check with `goodvibes status`. While the model answers, the `Decision model:` block reads `if Jev can't answer: Refuse the action` and `A decision model is in use.` After it has failed, the block and the one notice in the conversation read `The decision model <model> is not answering (<what failed>), so a tool call it cannot decide is refused and every other decision takes its fallback until it answers again (you chose Refuse the action for "If Jev can't answer"; Ask me would bring such calls to you); to fix it, <step>.` Under Ask me the middle reads `so work continues without it until it answers again`. The notice is withdrawn when the model answers again. Then ask for a change in the conversation: with the server stopped, the call is refused with the error above and the turn goes on.
- What is refused and what is not: facts (reads and recoverable edits inside the project, matching rules, owner-only asks) never ask the model and keep working; only tool calls that need the model's judgment are refused.

#### How long a decision waits

A decision waits for the decision model: its request ends when the server answers, answers with an error, or the connection fails. There is no deadline of its own. (Releases up to 3.4.2 had `judgment.decisionDeadlineMs`, default 1500 ms; real decisions on the hosted Jev take about 0.3 s on average and up to about 4 s, so that guess cut off decisions that would have answered and reported the model as failing. A settings file that still holds the key has it removed once, with a notice.)

- A permission decision (the reading of a judgment call, the boundary readings and Jev's decision in `jev-decides` and `just-vibes`) waits for the model, across retries and `judgment.fallbacks` targets; an attempt at one target that has had no answer for `judgment.timeoutMs` (30 s, far above what a decision takes) counts as that target not answering, which is how a server that stalled or a connection lost without a reset is noticed. When the model fails, the decision takes its fallback, as every other decision does: under Ask me (`Hybrid`) the gate's no-model rule decides (asks you, or holds the call in `just-vibes`) and the conversation gets the one failure notice; under Refuse the action (`Decision Model Only`) that one tool call is refused with the model's error, nothing is asked, and the turn goes on. The failure also starts a failure episode (see "When a decision model counts as working"). A target whose attempts time out three times in a row is skipped for a minute, so the next decisions take their fallback at once.
- The other decisions a person or a tool call waits on (for example reading an inbound channel message) wait the same way; when the model fails, each takes its own stated fallback.
- Readings the turn can proceed without (whether interim text overstates results, whether repeated calls look stuck, which injected memories an answer used, whether an answer after delegated work claims work that was not done) run beside the work, never ahead of it, so the turn never waits on them.
- Where the keys live: `judgment.*` is kept in the daemon's settings file (`~/.goodvibes/daemon/settings.json`), so one write from any app's settings sets it for every program and the daemon. `permissions.mode` is kept per program: the daemon has its own, so for daemon-run work (routines, triggers, channel turns) set it there too: `goodvibes-daemon config set permissions.mode jev-decides`.

### How you can tell no decision model is in use

- With none set the conversation says nothing; the status lines below show it. A set model that starts failing is said once per outage, and that notice is withdrawn when it answers again. A failure is not repeated every turn.
- `goodvibes status` and `goodvibes-agent status` print a `Decision model` block (with the "If Jev can't answer" choice).
- A headless run prints the line on stderr and adds `diagnostics.decisionModel` to its JSON result without changing the exit code.
- The web UI's header chip ("When GoodVibes asks") shows the mode in force in the status bar's words, from the daemon's `words`: `Permissions: Jev decides` (or `Ask me`, `Just vibes`, `YOLO`) when the chosen mode is in force; otherwise what is in force first and the choice second, a failure last (`Permissions: asking you, for now · <chosenWhen>`; on a phone `Permissions: asking you, for now`, with the whole line at the top of the sheet it opens). Opening it shows why in one sentence (for example `GoodVibes asks you for now: you chose Jev decides, but no decision model is set up. ...`) and `Change`, which opens Settings, Permissions.
- Results that no decision model checked say so instead of claiming model verification.

Without a decision model, conversation, tools, editing, commands, tests and session recovery work as usual. Work that needs one says so when none is in use: autonomous contract execution, independent semantic knowledge verification, merchant and checkout interpretation, and semantic recommendations or grading.

### Call-volume alerts

`judgment.volumeMonitor` raises local alerts when decision traffic passes a budget. Alerts go to the runtime log; they never call a model or stop work.

```text
/settings set judgment.volumeMonitor {"enabled":true,"budgets":[{"name":"All decisions","maxLogicalDecisions":1000,"maxWireAttempts":2000}]}
```

Enabled monitoring needs 1 to 100 budgets. Optional per budget: `battery` or `site` to restrict it. Optional: `windowMs` (default one hour, 1 second to 30 days), `intervalMs` (default one minute, 1 second to 1 day), `limit` (default 10000 log entries, 1 to 100000). The environment variable `GOODVIBES_JUDGMENT_MONITOR` names a budget file that applies even when the setting is disabled.

### Exporting gate decisions

`telemetry.decisionOtlpEnabled`, `telemetry.decisionOtlpEndpoint` and `telemetry.decisionOtlpSignal` (`span`, `log` or `both`) export each permission decision to an OTLP/HTTP JSON collector: spans to `<endpoint>/v1/traces`, logs to `<endpoint>/v1/logs`. Off by default.

## Managed policy bundles

A managed policy is a versioned bundle of rules the gate reads before the owner's remembered rules. It is used only when `permissions.engine` is `policy-engine` (restart to apply) and `policy.registryEnabled` is `true`.

The bundles are the daemon's: one activation record (`~/.goodvibes/tui/policy-activation.json`) that every program on the machine follows. The daemon loads, reviews, enforces and restores them; it announces each change, and each program reads the record again and keeps its own copy of the bundle in force, which the gate of a running turn reads (a turn never asks the daemon). The controls are the Policy tab of Permissions and safety (Ctrl+G m); the same acts are capabilities a model, an outside agent and a script run:

| Control (key) | Capability | What it does |
| --- | --- | --- |
| Enter on a row | `security.policy` | The bundle in force, the candidate, the history, and what carrying at the upgrade did. |
| Load a candidate (`n`) | `security.load-policy` | Loads a bundle file (read against the asking program's folder) as the candidate. |
| See what it changes (`s`, on the candidate) | `security.simulate-policy` | The rule diff and the recorded calls the candidate decides differently (the daemon's recorded calls). |
| Compare with the one in force (`d`) | `security.compare-policy` | The rule diff, current against candidate. |
| Check for mistakes (`l`) | `security.lint-policy` | Lints the bundle in force and the candidate. |
| Review with MCP risk (`f`) | `security.preflight` | The policy, the settings and the MCP servers' trust together. |
| Enforce it (`e`, on a reviewed candidate) | `security.enforce-policy` | Enforces the candidate the review showed, in every program (asked first: it may loosen; a model is refused; a candidate loaded or changed since is refused). |
| Go back to the previous one (`b`) | `security.restore-policy` | Enforces the previous bundle again, in every program (asked first; a model is refused). |

Until 3.5.0 the Agent kept its own record (`~/.goodvibes/agent/policy-activation.json`). At the first start of this version it is carried into the one record once: where only the Agent enforced a bundle, that one is kept; where the terminal app and the Agent enforced different bundles, the one with more refusing rules (then more asking rules) is kept, and you are told once which. The Agent's file is left as it was, so a 3.5.0 Agent after a rollback still enforces what it did.

### Bundle file format

A bundle is one JSON object:

| Field | Required | Meaning |
| --- | --- | --- |
| `bundleId` | yes | A non-empty string naming this bundle version. |
| `issuedAt` | no | ISO 8601 time the bundle was issued. Part of the signed content. |
| `issuer` | no | Who issued it, shown by "See the policy in force". Part of the signed content. |
| `payload` | yes | `{ "version": <number>, "rules": [ ... ], "description": "<text>" }`. `rules` must be an array. |
| `signature` | no | Hex HMAC-SHA256 of the canonical JSON of `{ bundleId, issuedAt, issuer, payload }` (keys sorted at every level, undefined fields left out). |

Every rule has `id` (string), `type`, `effect` (`allow` or `deny` only; `ask` is refused in a bundle), an optional `description`, and an optional `origin`, which may only be `managed` (the loader marks every bundle rule managed). The types:

| `type` | Fields | Matches |
| --- | --- | --- |
| `prefix` | `toolPattern`; optional `commandPrefixes` (list), `exactCommands` (list) | Calls of the tools whose command starts with a prefix, or equals an exact command. With neither list, every call of the tools. |
| `arg-shape` | `toolPattern`, `argMatchers` (a non-empty object) | Calls whose arguments hold every listed key with that value; a value starting with `/` is a regular expression. |
| `path-scope` | `toolPattern`, `pathPatterns` (non-empty list) | Calls whose path arguments fall under a pattern. Relative patterns are read from the project root; a pattern that is `~` or starts with `~/` names the home directory and is expanded when the bundle loads. A pattern with no wildcard covers that path and everything below it; `*` matches within one segment, `**` across segments, `?` one character; `dir/**` covers `dir` too. Braces and negation are not supported. |
| `network-scope` | `toolPattern`, `hostPatterns` (non-empty list of host globs); optional `ports` (0 to 65535; `0` means any) | Calls to those hosts. |
| `mode-constraint` | `toolPattern`, `activeModes` (non-empty list of `default`, `plan`, `allow-all`); optional `classifications` (`read`, `write`, `escalation`) | Calls made in those modes. `default` is `ask-me`, `jev-decides` and `just-vibes`; `allow-all` is `yolo`. |

`toolPattern` is a tool name, `"*"` for any tool, or a list of names. A bundle with a malformed rule is refused whole, naming the rule, for example `Not a policy bundle: rule 2 (path-scope) needs pathPatterns: a non-empty list of path globs.`

Example (`/home/me/policy/team.json`):

```json
{
  "bundleId": "team-2026-11",
  "issuedAt": "2026-11-18T09:00:00Z",
  "issuer": "platform team",
  "payload": {
    "version": 1,
    "description": "No force pushes, no writes outside src, fetch only from our hosts",
    "rules": [
      { "id": "no-force-push", "type": "prefix", "effect": "deny", "toolPattern": "exec", "commandPrefixes": ["git push --force", "git push -f"] },
      { "id": "src-only-writes", "type": "path-scope", "effect": "allow", "toolPattern": ["write", "edit"], "pathPatterns": ["src/**"] },
      { "id": "our-hosts", "type": "network-scope", "effect": "allow", "toolPattern": "fetch", "hostPatterns": ["*.example.com"] }
    ]
  }
}
```

Loading and promoting it:

```text
/settings set permissions.engine policy-engine
/settings set policy.registryEnabled true
(restart the app)
```

Then, on the Policy tab of Permissions and safety: `n` with the file `/home/me/policy/team.json`, `s` on the candidate, `e` to enforce it. A script does the same with `goodvibes do security.load-policy --input path=/home/me/policy/team.json`, `goodvibes do security.simulate-policy` and `goodvibes do security.enforce-policy`.

The managed evaluator's default for a call no rule matches is deny; that deny is reported as managed policy only when a rule decided it, so an unmatched call continues through the ordinary order. Loading reports `Candidate loaded: <bundle> ...` and names the review as the next step; a refused bundle says `Load failed: <reason>` and leaves the current and candidate bundles unchanged. An enforced bundle is recorded in the one activation record and is enforced again at the next start, in every program, while its file is unchanged.

`policy.bundleSource` `file` with `policy.bundlePath` (absolute, or relative to the working directory) loads a bundle as a candidate at start; a bundle that cannot be read or is refused is logged and named by "See the policy in force". `policy.requireSignedBundles` refuses every bundle without a valid signature made with the hex key in `GOODVIBES_POLICY_SIGNING_KEY` (at least 16 bytes, 32 hex characters; restart to apply). A bundle whose signature is present but does not verify is refused whatever this setting says. `permissions.simulation` (default on) runs the other evaluator beside the active one and records where they disagree, without changing what is enforced; `permissions.divergenceDashboard`, `permissions.divergenceThreshold` and `permissions.maxDivergenceRecords` control that record. The Policy tab is the same in both terminal programs.

## Workspace trust

Every workspace (working directory) has a trust level: `trusted`, `restricted`, or undecided.

| Level | Effect |
| --- | --- |
| `trusted` | All tools may run, subject to the permission mode and rules. |
| `restricted` | Only reads run. Every write, command and delegation is refused, in every mode including `yolo`. The model is told so as that call's result (`This folder is restricted: no file can be changed and no command run until it is trusted.`) and the turn goes on; you read one row beside the call, `Not run: this folder is restricted ("Trust this folder" in Permissions and safety, This folder, trusts it).` |
| undecided | Reads run, and calls are decided as in a trusted folder (an undoable edit inside the folder runs without asking); a call that would ask you raises the trust question instead. In the terminal app a folder is never left undecided once it is open. When it has no hooks file and no MCP servers of its own, trusting it would let nothing run that the permission mode does not already govern, so nothing is asked: it is recorded as trusted for having nothing of its own to run, in `~/.goodvibes/shared/workspace-trust-nothing-to-run.json` beside the workspace register (never as a row of the register, so an earlier release reads the folder as undecided), and you are told nothing. `goodvibes run` and `goodvibes-agent run` apply the same rule before the turn and record it the same way; a folder with no decision that brings a hooks file or MCP servers of its own is not trusted in a headless run: every write, command or delegation is refused at once, whoever would have decided it, with a sentence naming the folder, what it brings and how to trust it (`<folder> brings a hooks file (hooks.json) of its own and has no trust decision, so this run does not trust it: no file is changed and no command runs there; reads still work. To trust it, open it in goodvibes and choose "Trust this workspace", or "Trust this folder" in Permissions and safety, This folder, then run again.`); the refusal goes back to the model as the call's result and the turn goes on, so the run ends as the turn does (`completed`, exit `0`, when the model then answers). Nothing is saved: the folder stays undecided. When it has them, the trust question is asked as the program opens, before any prompt is acted on (first run, when it is needed, follows it), titled with the folder (`Trust ~/projects/garden-planner?`), with the cursor on "Keep restricted (read-only)", so Enter pressed at once trusts nothing (the folder is restricted: a write or command the model asks for is refused, the refusal goes back to the model and the turn carries on). The two choices are "Trust this workspace", which says what trusting lets run (`Trusting it lets the hooks in hooks.json run and the tool servers (MCP) in .goodvibes/mcp.json start, and lets GoodVibes change files and run commands here. It approves nothing: each action still follows your setting for when GoodVibes asks.`), and "Keep restricted (read-only)" ("GoodVibes reads this folder and changes nothing in it: no file is changed and no command runs, and the folder's own hooks and MCP servers stay off, until you trust it."); both end "Change it later in Permissions and safety, This folder." Dismissing it (Esc) records nothing: the folder stays undecided, and the first call that would ask you raises the question again; choosing trust there forwards that ask to you. A folder trusted for having nothing of its own that later gains a hooks file or an MCP file is asked about then, naming the files, before any of them runs: when its hooks are about to fire or its servers to start, or as the program opens. Until you answer they stay off; "Trust this workspace" turns them on. A trust question that opens by itself while you type is kept apart from your typing as the approval card is: keys typed as it appears, or in the same burst, go to the composer, and while the composer holds a draft every key stays there until Tab moves to the question (its key row then reads `tab answer this question (your draft stays)`); the draft is left as it was. The Agent and the daemon read the same record and keep such files off until the folder is trusted ("Trust this folder" in Permissions and safety, This folder). |
| undecided, a headless run | `goodvibes run` and the daemon's runs (the web UI, channels, schedules) ask nothing on opening and behave as 3.4.8 did. Reads run; an undoable edit inside the folder runs without asking, as in a trusted folder; a command, delegation or other write is decided as the mode in force decides it (`jev-decides`: the decision model; `yolo`: it runs), and one that would ask you raises the trust question, refused when nobody can answer it (below). Only a folder you restricted refuses writes. |

The This folder tab of Permissions and safety shows the level and what it means here, the same words in the terminal app and the Agent; `t` trusts it (asked first: it loosens a protection; a model is refused) and `x` restricts it. The capabilities are `security.folder`, `security.trust-folder` and `security.restrict-folder`; the daemon writes the shared register and announces it, and each program reads the decision again at once. Restricting only tightens, so a model's `capability_run` of it is never asked about or refused. What is trusted (the permission mode, secrets, services, plugins and MCP servers) is on the Policy tab: `t` shows it (`security.trust`), `w` saves it to a file (`security.save-trust`; an existing file is kept unless "Write over it" is chosen) and `o` reads a saved one (`security.read-trust`).

The permission mode "What is trusted" and a saved trust summary report is the daemon's, the mode every program starts from. When the mode chosen differs, both are shown with the reason: `permission mode: yolo (chosen ask-me: <reason>)`, and the bundle carries `permissionModeChosen` and `permissionModeReason` beside `permissionMode`.

- Decisions are kept in `~/.goodvibes/shared/workspace-registrations.json`, one row per directory by its real path, shared by every product; a folder trusted for having nothing of its own to run is kept in `workspace-trust-nothing-to-run.json` beside it, and a row in the register replaces it. A `trust.json` inside a project is not honoured; This folder says so when it finds one.
- When a decision cannot be saved, it applies to this session only and the app says it will ask again next time.
- With nobody to answer (a headless run without `--answer-permissions`), a call that needs the trust answer is refused: `Workspace trust for <dir> is undecided and the trust question was not answered here, so the workspace stays undecided.` Fix: "Trust this folder" in Permissions and safety, This folder, or answer the workspace-trust prompt of a run started with `--answer-permissions`.
- An unreadable trust record is treated as restricted for autonomous work until a level is chosen.
- `goodvibes status` shows `Workspace: trust: <level>` and the registration.

### Path containment

Two separate checks:

- The gate classes paths lexically against the working directory: a read or recoverable edit runs without asking only inside it (step 8). A path outside it makes the call a judgment call in every mode but `yolo`.
- The tools resolve symbolic links and refuse a path that lands outside the project root with `Path '<p>' is outside the project root`. The `write` and `edit` tools refuse it in every mode, `yolo` included (they also refuse the verification journal under `.goodvibes/verification` and any directory that contains it). The `analyze` tool refuses it in every mode. The `read`, `find` and `inspect` tools refuse it in every mode except `yolo`, where they read outside. That `yolo` exception follows the mode in the app's settings (saved, `--yolo`, `-c permissions.mode=yolo`, Shift+Tab, or a saved `behavior.autoApprove`), not a hosted session's own `yolo` set through `sessions.permissionMode.set`. Whatever the gate or the owner answered, these tools never write outside the project, and read outside it only in `yolo`; a shell command run through `exec` (for example `cat` or `cp`) is not stopped by this check, only by the gate and the exec sandbox.

## The exec sandbox

On Linux with bubblewrap (`bwrap`) installed, each shell command the `exec` tool runs is contained:

- the workspace is writable, and so are the paths in `sandbox.workspaceWritable`;
- only the system folders are shown (read-only), `/tmp` is private, `$HOME` is masked, and the GoodVibes home and the daemon's home are covered wherever they are (also when `GOODVIBES_HOME` or `GOODVIBES_DAEMON_HOME` puts them outside `$HOME` or inside the workspace), keeping only a workspace that lies inside one;
- credential-bearing environment variables are removed;
- the network is off. It is opened only when both hold: the decision model reads the command as needing the network, and every command in the line is listed in `sandbox.egressAllowlist`. The allowlist alone never opens it: a listed command the model reads as not needing the network gets none, and with no decision model in use no command gets the network, listed or not (the command is put to you instead: `Without a decision model, this did not assess command host-access needs; owner approval is required inside the sandbox`, and approving runs it inside the boundary, still offline). A command read as needing the network and fully listed is put to you as `wants network (on egress allowlist, granted inside the boundary once approved)`; approving grants it for that run. Who answers that ask follows the mode: in `ask-me`, and in `jev-decides` without a working decision model, it is put to you on the approval card (annotated per `sandbox.judgment`); otherwise the call's own recorded admission (Jev's decision) answers it. One read as needing the network but not fully listed is told `denied inside the boundary and approval does not change that; add it to sandbox.egressAllowlist`.

What stays true with no sandbox (it is off, unavailable, or a command was let out of it): a command that runs arbitrary code can always reach whatever your own account can reach. A model allowed to run such commands on the host can read your GoodVibes home (the operator token, the settings, a plain-text secret store) and every other file your account can read, and can do with it whatever your account can do. The gate resolves what each command reaches and asks about the ways it can tell (running a GoodVibes program, a GoodVibes home path in any spelling, a link to one, indirection it cannot follow, a file that runs by itself later), opening on No, and `goodvibes do` run by such a command never says a person asked; but no reading of a command can see everything a compiled program or a script it builds at run time will do, so a command it reads as harmless can still reach your account. With the sandbox on, the GoodVibes and daemon homes are hidden from commands and the network is off; without it, letting a model run commands unasked (`yolo`, an allow rule for every command) gives it your account.

Where bubblewrap is missing, on macOS, and on native Windows, the exec path runs on the host and the sandbox reports itself unavailable. The same holds inside a container or a pid namespace whose `/proc` shows another namespace's processes (for example `unshare --pid` without a `/proc` of its own): bubblewrap reaches the processes it starts through `/proc`, so it fails there, sometimes half-way with a process left holding the command's output, and the sandbox reports itself unavailable with that reason instead of letting a command wait forever. On Windows, run GoodVibes in WSL 2 with bubblewrap installed to get the boundary.

An `exec` command is finished when its own process exits. Its result holds everything it wrote up to then (all of a large output too: its overflow file has every line) and is returned at once, even when a process it started keeps running with its output (`server &`). Then the result carries `left_running`, one sentence naming that process ("A process this command started is still running and still holds its output (pid 4711); it was left running, and what it writes from now on is not read."); the process is not stopped. Inside the sandbox a process the command started ends with the boundary, as every process in it does. The same holds for a command run under a terminal (`interactive`) and one run `until` a pattern, and for the jobs an `until` run hands to the background.

| Setting | Default | Applies |
| --- | --- | --- |
| `sandbox.enabled` | `true` | Turning it on takes effect at the next start (the host is probed then). Turning it off applies from the next command. One value for every program on this machine, kept in the daemon's settings: "Run commands inside the sandbox" and "Run commands on the host, with no sandbox" (which asks first, opening on No) on the Sandbox setting tab of Permissions and safety set it, and each program follows it. Where the terminal app and the Agent kept different values until 3.5.0, the stricter (on) is kept and you are told once; each program's own value stays in its file for a rollback. |
| `sandbox.workspaceWritable` | `[]` | Absolute paths only; a relative path is refused. From the next command. |
| `sandbox.egressAllowlist` | `[]` | Command names, for example `["git","npm"]`; `["*"]` counts every command as listed (the decision model must still read a need). From the next command. |
| `sandbox.judgment` | `annotate` | `off`: plain asks. `annotate`: a model verdict with reasons annotates a sandbox escalation ask; you still decide. `auto-approve`: also approves looks-safe verdicts. Never auto-denies. |
| `sandbox.mcpIsolation` | `disabled` | `disabled`: stdio MCP servers run as host processes. `contained`: each runs in its own bubblewrap boundary (workspace writable, system files and its own install read-only, `$HOME` and `/tmp` private, host network shared). One value for every program on this machine, kept in the daemon's settings: the daemon writes it ("Run MCP servers inside the sandbox" and "Run MCP servers as host processes" on the Sandbox setting tab of Permissions and safety), and each program follows it, restarting its running stdio servers under it: at once when idle, and a server in the middle of a call as soon as that call ends. The values the programs kept in their own settings until 3.5.0 are carried into the daemon's once as the stricter of them (`contained` when either program had it), you are told once when they differed, and each program's own value is left in its file for a rollback. On a host without bubblewrap a contained server does not start. |

How the sandbox affects asks: in `ask-me`, a call asked about only because of where it could reach (for example a command that might send secrets out) runs without asking when it runs inside the sandbox; the decision records that the sandbox settled it, not you. A call asked for any other reason (owner-only, irreversible, security-weakening, obfuscated) is asked whether contained or not. An `exec` call carrying `file_ops`, a malformed `cmd_base64`, or a working directory other than the session's is always shown to you.

The `repl` tool is registered only where the sandbox is available; each evaluation runs as one sandboxed command.

The Sandbox setting tab of Permissions and safety (both terminal programs) shows how commands and MCP servers are contained (Enter: `security.sandbox`, the one "See the sandbox"); `c` runs MCP servers inside the sandbox (`security.contain-mcp`, only tightens: never asked about), `h` as host processes (`security.host-mcp`, asked first; a model is refused), `a` says what it should be (`security.sandbox-advice`), `p` lists the profiles (`security.sandbox-profiles`), `s` the presets (`security.sandbox-presets`), and `b` probes this terminal's machine (`security.sandbox-probe`, run by the program).

The Sandbox sessions tab (the terminal app's) lists the sessions it started (`security.sandbox-sessions`); `n` starts one (`security.start-sandbox`; the form opens on the most restrictive profile, Contained commands, network off), Enter shows one (`security.sandbox-session`), `e` runs a command in it (`security.run-in-sandbox`), `w` saves its record (`security.save-sandbox`; an existing file is kept unless "Write over it" is chosen; a model's save stays inside the working directory), `x` stops it (`security.stop-sandbox`) and `o` reads a saved record (`security.read-sandbox`).

A sandbox session is contained or not started. On a host without bubblewrap, or for the `command` profile (network off) on a host whose bubblewrap cannot take the network away, starting one is refused with the reason and the next step (install bubblewrap). Boundary "On this machine, with no boundary" starts a host session on purpose: no boundary and the host network, whatever the profile says; the session's backend is `host`.

Sandbox sessions are the terminal app's. In the Agent, change `sandbox.enabled` on the Sandbox setting tab as in the terminal app, `sandbox.judgment` with `/settings set <key> <value>`, and the two list settings in the settings workspace (`/settings sandbox`). `goodvibes status` prints an `Exec sandbox:` block: `active`, `configEnabled`, `backend` (`bubblewrap`), `available`, `network: isolation confirmed`. The QEMU backend is retired. Old settings `sandbox.qemu*`, `sandbox.vmBackend`, `sandbox.replIsolation` and `sandbox.windowsMode` are removed from a settings file on load, and a VM `sandbox.mcpIsolation` value becomes `contained`.

`permissions.commandParser` (`ast` default, or `flat`) decides whether an `exec` command is parsed into segments first; `ast` refuses a command with a segment that runs nothing.

## Secrets

### Stores and read order

A secret is looked up in this order; the first that has it wins:

1. the process environment;
2. the daemon's store, `~/.goodvibes/daemon/secrets.enc` (moved by `GOODVIBES_DAEMON_HOME`);
3. your own store for the app, `~/.goodvibes/<surface>/secrets.enc`, then its plaintext file;
4. the store of the project you opened, `<project>/.goodvibes/<surface>/secrets.enc`.

`<surface>` is `tui` for the terminal app. Directories above the project are never read. The encrypted stores use AES-256-GCM under a random 32-byte key file `~/.goodvibes/secrets.key` (mode 0600). `GOODVIBES_HOME` moves the whole tree.

A key in a project's store is part of the checkout, so it is used only after you stored it there yourself or confirmed it once with "Use a secret from this project's store" (`t` on it, Secrets tab of Permissions and safety). Until then the Secrets tab marks it `waits for you`. A confirmation lasts until the value changes.

`storage.secretPolicy`: `preferred_secure` (default: encrypted when available), `require_secure` (refuse to store unencrypted), or `plaintext_allowed`.

### Command line

```sh
goodvibes secrets list
goodvibes secrets providers
goodvibes secrets test goodvibes://secrets/env/OPENAI_API_KEY
goodvibes secrets set OPENAI_API_KEY --user            # asks for the value; nothing typed is shown
printf '%s' "$OPENAI_API_KEY" | goodvibes secrets set OPENAI_API_KEY --user   # piped: read from standard input
goodvibes secrets set OPENAI_API_KEY <your-api-key> --user   # also works; the value stays in shell history
goodvibes secrets link OPENAI_API_KEY goodvibes://secrets/env/OPENAI_API_KEY --user
goodvibes secrets delete OPENAI_API_KEY --user
```

`goodvibes-agent secrets` takes the same forms.

- Without `--user`, `set` and `link` write to the project store. Use `--user` for your own store. The Agent files a credential the daemon reads (channel tokens, mail passwords and other daemon-owned keys) in the daemon store whatever scope you ask for, and says so.
- `--plaintext` stores the value unencrypted; `--secure` (default) encrypts it.
- `set <KEY>` with no value asks `Value for <KEY> (typing is not shown):` at a terminal, echoing nothing, or reads standard input without its trailing newline when it is piped. The value then never reaches the command line, the shell history or the process list. Nothing entered is refused: `Not stored: no value was given for <KEY>.`; Ctrl+C stops with exit `130` and stores nothing.
- `--stdin` reads the value from standard input even at a terminal; a value that starts with `--` is given this way or typed when asked.
- A value on the command line is exactly one argument. Several value words are refused: `Not stored: 2 values were given for <KEY>.`
- `delete` without a scope flag removes the key from every store that has it and lists where it was removed from. A key not stored exits non-zero: `No stored secret named <KEY>. Nothing was deleted.`
- `test` exits `0` when the reference resolves and `1` when it does not. It prints `resolved <redacted>` or `missing`, never the value.
- An unknown verb prints usage and exits non-zero.

Example:

```text
$ goodvibes secrets list
GoodVibes secrets
  policy: preferred_secure
  secure available: yes
  stored keys: 0
```

### In the terminal programs

The Secrets tab of Permissions and safety (the menu, `Ctrl+G` then `m`) lists every stored secret by name and where it is kept. Its controls, each a daemon capability a model and a script run too (no slash command carries them):

| Key | Control | Capability |
| --- | --- | --- |
| (the tab) | See your secrets | `secrets.list` |
| `n` | Store a secret (the value on a hidden line) | `secrets.set` |
| `l` | Point a secret at a password manager | `secrets.link` |
| `c` | Check a secret is stored (never prints it) | `secrets.get` |
| `e` | Test a secret reference | `secrets.test` |
| `h` | See where secrets can come from | `secrets.providers` |
| `k` | See how secrets are kept | `secrets.storage` |
| `t` | Use a secret from this project's store (asks once; never from a model) | `secrets.trust` |
| `x` | Delete a secret (asks once) | `secrets.delete` |
| `u` on This conversation | Use a secret for this session only (an environment variable) | `secrets.use` |

"This project" and "encrypted" are the defaults; plain text loosens a protection, so a model's call of it is put to you (store it again encrypted to put it back).

A value with spaces goes inside quotes. A value that starts with `--` goes after a bare `--`.

### Secret references

A reference names where a secret is, never the value: `goodvibes://secrets/<source>/<id-or-path>?key=value`.

| Source | Example |
| --- | --- |
| `env` | `goodvibes://secrets/env/OPENAI_API_KEY` |
| `goodvibes` | `goodvibes://secrets/goodvibes/SLACK_BOT_TOKEN` (a key in your store) |
| `file` | `goodvibes://secrets/file/%2Fhome%2Fme%2F.token` |
| `exec` | runs a command and uses its standard output |
| `1password` | `goodvibes://secrets/1password?vault=Private&item=OpenAI&field=password`, or `op://Private/OpenAI/password` |
| `bitwarden` | `goodvibes://secrets/bitwarden?item=GoodVibes%20Slack&field=password`, or `bw://<item>/<field>` |
| `vaultwarden` | `goodvibes://secrets/vaultwarden?item=GoodVibes%20Slack&field=password&server=https%3A%2F%2Fvault.example.test` |
| `bitwarden-secrets-manager` (alias `bws`) | `goodvibes://secrets/bws/00000000-0000-0000-0000-000000000000?field=value`, or `bws://<id>/<field>` |

Which program runs a password-manager reference, and which token variables it gets, are this machine's settings (`storage.secretProviders.*`), never part of a reference. A project settings file may carry only `goodvibes://secrets/goodvibes/<KEY>` references; any other reference in it is skipped with a notice. The old `secret://` scheme is not supported.

### Credential settings

A setting that holds a credential (channel tokens, `surfaces.email.password`, `cluster.secret`, webhook URLs and the rest of the declared list) takes only a `goodvibes://secrets/` reference. `/settings set <credential-key> <value>` and the settings workspace store the value in the secret store and write the reference for you:

```text
/settings set surfaces.slack.botToken <your-bot-token>
Set surfaces.slack.botToken: stored in the daemon secret tier as GOODVIBES_SURFACES_SLACK_BOT_TOKEN (value hidden).
```

A plain value in a settings file for such a key is refused with the command that stores it. Card numbers and card security codes are never settings: they go to the daemon's card store through "Add a card" in Money (its Cards tab) or the web UI.

## Headless runs and permissions

In `goodvibes run` and `goodvibes-agent run` with `--output stream-json --answer-permissions`, each call that needs the owner writes a `PERMISSION_PROMPT` frame and waits for a `{"type":"PERMISSION_ANSWER","callId":"<id>","approved":true}` line on standard input (a capability is asked in its own words: `summary` is its question, "Keep this computer awake?", and `lines` its sentence and each input on a labelled line, a secret one hidden); the script is the one place it is asked (it is not put in the daemon's approvals too), for every question the run's calls raise: a method the daemon would otherwise decide itself when it arrives (a schedule, a channel route or draft, a profile fact) is put to the script by the run and sent saying so, and the daemon asks nobody again (plan mode and your deny rules still refuse it). No time limit decides a permission question: a call whose question waits for you in Waiting for you waits until you answer or the run ends. An unanswered call is refused, never approved. Without `--answer-permissions` nobody in the run can answer, so such a call is held for the owner: a `capability_run` of a capability the daemon runs is handed to the daemon, which asks him once in Waiting for you (worded as the capability) and runs it when he approves; anything else is not run, and the run goes on without it. The `PERMISSION_DECIDED` frame says so (`reasonCode` `mode_queued_for_owner`). `--just-vibes` and `--yolo` work in `run` as in the interactive apps. The frame formats are under "Headless runs" in "The terminal app (`goodvibes`)".

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every command asks even in `jev-decides`. | No working decision model, or the default `jev-decides` on an endpoint or model the calibration did not measure. | Check `goodvibes status`. Set `TYPESAFE_API_KEY`, or choose `jev-decides` explicitly: `/settings set permissions.mode jev-decides`. |
| A tool never runs, in any mode except `yolo`: "refused by the setting permissions.tools.<x> = deny". | A per-tool deny. | `/settings set permissions.tools.<x> prompt`. |
| "refused by the saved rule ..." | A remembered deny rule. | `/permissions rules`, then revoke it. |
| "plan mode is on and <tool> would change something". | Plan mode. | Turn plan mode off (This conversation in Permissions and safety) or Shift+Tab. |
| Writes refused in a new directory with "Workspace trust ... is undecided". | Trust question unanswered. | "Trust this folder" in Permissions and safety, This folder. |
| Writes refused: "Not run: this folder is restricted ("Trust this folder" in Permissions and safety, This folder, trusts it)." | Workspace set to restricted. | "Trust this folder" in Permissions and safety, This folder. |
| A request from Slack never runs in `yolo`. | A channel request always needs the owner's answer. | Answer it in the terminal app, the web UI or the conversation; or ask from the terminal. |
| A request from email, a webhook or ntfy is refused. | Those surfaces cannot direct changes. | Ask from the terminal, Telegram or another owned surface. |
| `just-vibes` finished without doing some steps. | They were held. | Approve them in Waiting for you, Held calls (`y`), then ask to carry on. |
| "Decision model ... failing" once, then work continues. | The decision model failed and each decision took its fallback. | Fix the endpoint or key named in the notice; the app says when it answers again. |
| Tool calls are refused with a decision-model error. | "If Jev can't answer" is Refuse the action and the model failed. | Fix the model, or set "If Jev can't answer" to Ask me in the decision model settings. |
| Commands have no network. | The exec sandbox turns it off. | Add every command of the line to `sandbox.egressAllowlist`, and have a working decision model: without one the sandbox never opens the network. |
| A contained MCP server does not start. | `sandbox.mcpIsolation` is `contained` and bubblewrap is missing. | Install bubblewrap, or "Run MCP servers as host processes" in Permissions and safety, Sandbox setting. |

## Settings reference for this part

<!-- generated: settings:permissions -->

<!-- generated: settings:behavior.autoApprove -->

<!-- generated: settings:judgment -->

<!-- generated: settings:policy -->

<!-- generated: settings:sandbox -->

<!-- generated: settings:storage.secretPolicy -->

<!-- generated: settings:storage.secretProviders -->

<!-- generated: settings:telemetry.decisionOtlp -->
