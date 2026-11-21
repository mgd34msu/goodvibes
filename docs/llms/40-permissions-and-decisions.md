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
| working decision model | A decision model that is set (see "When a decision model counts as working") while `judgment.policy` is not `No Decision Model`, and is answering: from its first failed request until it answers again it does not count as working. Nothing is sent to test it; the gate's own requests show it. |
| stakes | The level the gate's reading gives a judgment call: `low`, `medium`, `high` or `critical`. Defined in "Stakes". Only a decision model's reading produces one. |
| held call | A call `just-vibes` did not run because it needed the owner; it is listed at the end of the run and answered with `/held`. |
| remembered rule | A saved answer ("always allow this command class in this project") that settles later calls. |
| working directory | The project directory the app was started in, or the directory given with `-C` / `--cd`. The gate calls this "the allowed directories". |

## How one tool call is decided

The gate applies these steps in order. The first step that settles the call decides it.

Before them, in every mode (`yolo` included), the owner's never-run rules are checked: a call that would hand a shell a command a never-run rule names is refused (see "Never-run rules"). And a call the owner's `Pre:tool` hook answered `ask`, or a call to an MCP server trusted `ask-on-risk` outside its scope, is put to the owner in every mode, `yolo` included (held for him in `just-vibes`), unless a step below refuses it.

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

The table gives the outcome for each kind of call in each mode, with and without a working decision model. "Asked" means the approval prompt appears (in a headless run, see "Headless runs and permissions"). "Held" means the call does not run and is listed for `/held`.

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

The gate treats the decision model as working when it is set, `judgment.policy` is not `No Decision Model`, and it is answering. The first request that fails (unreachable, refused key, no answer within `judgment.decisionDeadlineMs`, a malformed answer) starts a failure episode: from the next tool call, `jev-decides` runs as `ask-me`, the mode change is announced (`PRESET_CHANGED`, the mode chip, the web UI) and the conversation gets one notice naming the model, what failed and that permission decisions now ask you. The gate keeps reading calls with the model as before (no extra request is made to test it); the first answer ends the episode, `jev-decides` is in force again from the next call, and the conversation is told once. A call already being decided keeps the mode it started under. In `just-vibes` a failing model is still asked; a call it cannot decide is held.

One extra rule applies to `jev-decides` while it is only the shipped default (the owner never chose a mode): Jev decides only when every place a decision can be answered matches the shipped calibration record. That record measured the hosted endpoint `https://api.typesafe.ai` with the model `jev-latest`, answered by `jev-1.14.0`; a `judgment.model` of either `jev-latest` or `jev-1.14.0` on that endpoint counts as measured. A custom endpoint, a different model, or a fallback target with another endpoint or model is not what was measured, so the default `jev-decides` then behaves as `ask-me`. The rule does not apply once the owner has chosen the mode: saved in settings, chosen with Shift+Tab, chosen for a hosted session or set in a channel profile. A chosen `jev-decides` lets Jev decide on any working decision model.

What the reports show: every report shows the mode in force, read by the same rule the gate reads, and, when it is not the saved or chosen mode, which mode that is and why.

- `goodvibes status` and `goodvibes-agent status`: `permissions: Ask me (ask-me) in force; set: jev-decides` (the saved mode, or the one `-c` sets for this launch), then `not jev-decides, because <reason>`. The reasons: `no decision model is set, so every call Jev would decide asks you (to use one, choose a Decision model in /settings open)`; `you turned decision models off, so Jev cannot decide and every call it would decide asks you`; `Jev decides is only the shipped default here and its decisions were not measured on this decision model; choose Jev decides yourself (shift+tab, or /settings open) to use it`; `"Approve every tool request without asking" is on in your settings, which means YOLO; choosing how often it asks in /settings clears it`. With `--json` the same is under `auth.permissionModeInForce` (`chosen`, `mode`, `reason`). `status` runs without the app, so a model that is failing in a running app is reported by that app, not by `status`.
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
| `/plan on`, `/plan off`, `/plan status` | This session only | See "Plan mode". |
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
| `owner-act` | only you do this yourself, in your own app | Refused to the model in every mode (see step 1 of the order). |

In `yolo` the owner-only list is not consulted, with three exceptions: `channel-request` is still asked, `owner-act` is still refused, and purchases outside the payment limits (`spend-over-limit`, `payment-step`) still come to the owner through the purchase windows. `yolo` also keeps sign-in, workspace trust, the exec sandbox boundary, the secret store and spending limits.

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
| `loosen-security` | A settings write (the `goodvibes_settings` tool or the Agent's settings tool) whose key's own loosening rule says the new value is looser: a higher spending limit, `sandbox.enabled` off, a looser `permissions.mode`, any change to which decision model decides (`judgment.endpoint`, `judgment.model`, `judgment.backend`, `judgment.fallbacks`, `judgment.keySource`, `judgment.keyName`), and the like. The same rule holds for the operator API: such a write made by an admin who is not the owner (an admin sign-in of someone else, a token minted for automation; not a device the owner paired himself) is put to the owner as an approval only his own credential answers (see "A change only the owner makes" in "The operator HTTP API"). |
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

The terminal app's model has no mail tool of its own: the owner sends mail with `/mail send`, which is the owner's own command, not a tool call. In the Agent the model sends with the `google` tool (`mail.send`).

## The approval prompt

In the terminal app and the Agent, an ask appears as the same card. Its title is the question in a sentence (`Run this command?`, `Change a file outside this folder?`, `Turn <setting> off?`), with the folder it runs in on the right (`in ~/projects/sample-app`) and, when more asks wait behind it, `1 more waiting`. Under it: what the call acts on (every command in full, the paths, the address), for a write or edit the change itself, then one sentence saying what it will do (`Runs your tests.`, `Removes the folder dist and everything in it. GoodVibes keeps no copy.`). The question and that sentence are red, with `This can't be undone.`, only for a call the program knows cannot be undone: a delete code recognises (`rm -r`, `git clean -f`, an unrecoverable file operation), an operator action a tool declares irreversible, or a call the decision model read as irreversible with confidence. With no decision model nothing else is red, and the details say `Not checked: no decision model is set, so GoodVibes can't tell whether this can be undone.` There are no risk chips.

| Key | Action |
| --- | --- |
| `y` | Yes, once. |
| `a` | `Yes, and don't ask again…`: opens the remember choices (when the ask offers them). |
| Up, Down, `1` to `9`, Enter | In the remember choices: move, pick, and allow and remember with that choice. Esc goes back. |
| `n` | No. |
| `d` | Details: why you are asked, the tool, the folder, the sandbox, the decision, effects, review reasons, the checklist and the raw arguments. |
| Left, Right, Tab | Choose a button. |
| Enter | Press the chosen button. The card opens on `Yes, once`, or on `No` for what cannot be undone and for owner-only asks whose effect cannot be taken back (money spent, a payment step, a message sent as you), so Enter never allows those and never remembers anything. |
| Any other typing | Starts `Why not:`; Enter refuses with that reason, Esc goes back. |
| Space, `a`, Up, Down, PgUp, PgDn | In a multi-edit edit (`Apply selected`): keep or leave out a change, keep all, move, scroll. |
| Tab | When you were typing a draft, Tab answers the request and keeps your draft. |
| Ctrl+C | No, and stop the turn. |

A call that cannot be undone, and a request that offers no remembering (a channel request, a one-call boundary ask), offer only `Yes, once` and `No`, with `always asks · can't be remembered` beside them; to let such a call run without asking, add a permission rule with `/permissions`. A command waiting on its terminal for input shows its prompt and a masked answer field: Enter sends the answer, Esc clears it and then declines. A denial is the call's answer: the model is told the call was refused (with your reason) and the turn goes on. The same keys answer a turn that runs on the daemon.

A question an agent of this chat left for you (the `query` tool's `ask`) appears as `A question for you`, pinned above the composer on rows of its own (nothing of the conversation shows beside it), with the first option selected; an option may be a short phrase (`Hi there`), and `/questions answer <id> <option> [note]` matches the longest option the answer starts with. Up and Down choose an option, `1` to `9` pick one, Enter answers (the last option, `Something else…`, opens a one-line answer), and Esc answers later (it stays in `/questions` and the web UI). These keys reach the card while the composer is empty; typing goes to the composer. The answer goes through the owner inbox and the card shows `Answered: <option>` once.

The same asks appear in the web UI, in `/questions` (the owner inbox), on Telegram, and in the channel conversation the request came from, where that channel's owner can answer.

## Remembered rules

### Remember tiers

An approval can be remembered at one of these tiers. Which tiers are offered depends on the call.

<!-- generated: remember-tiers -->

The `command-class` tier is a command's first word. After three remembered exact answers for one class, that tier is offered first.

Every tier except `session` writes a durable rule. A durable rule is scoped to the project it was made in and matches only there. A remembered answer to an owner-only item is kept as an answer to that kind, so only it settles that item again.

A choice to remember is not saved when the owner edited the arguments, when the choice does not apply to those arguments, when no rule store is available, or when there is no working directory to scope it to. The answer then says: `Your choice to allow this command was not saved (<why>); it applies to this call only, and you will be asked again.`

### How a remembered rule comes to exist

No command, setting or operator method adds a rule directly. A rule exists only in these ways:

1. You answer an approval prompt with a remember tier other than session (in both terminal programs, `a` on the card, then the choice and Enter; the tiers offered are numbered in this order: exact, command-class, path, tool, session, with command-class moved first after three remembered exact answers for that class; only the tiers that apply to the call are offered). A stream-json headless run's `"remember": true` on a `PERMISSION_ANSWER` remembers for the session only, not as a rule.
2. You answer `/decisions never|always|ask <id>` on a call Jev decided. The rule is built at the first tier the call offers (for `exec`, `exact`; for `write` and `edit`, `path`; otherwise `tool`).
3. You add a record to the rules file by hand (format below). The file is re-read within two seconds; a malformed record is skipped.

Each rule records the project it was made in (the working directory's absolute path) and matches only there. A rule made with no working directory is not saved. What each tier matches:

| Tier | Rule | Matches |
| --- | --- | --- |
| `exact` | `allow exactly: <command>` | That command text exactly, and the same working directory, environment and file operations. `bun test` does not match `bun test foo`. |
| `command-class` | `allow the <word> command class` | The bare word, and any command starting with `<word> `. |
| `path` | `allow edits under <directory>` | `write` and `edit` under that directory. |
| `tool` | `allow every <tool> call in this project` | Every call of that tool. |

A deny rule reads `deny ...` and an "always ask me" rule `ask ...`.

Worked example: allow `bun test` in this project only.

1. Make the call reach you. With a working decision model in `jev-decides`, Jev may run it without asking; then use `/decisions always <id>` on that decision instead (it saves the same `exact` rule). Otherwise switch to `ask-me` for this session only (Shift+Tab in the terminal app) without a working decision model, or turn decision models off: `/settings set judgment.policy No Decision Model`. `judgment.policy` is a daemon-file key: that write changes it for every program and the daemon until you put it back. With `permissions.tools.exec` at its default `prompt` and no decision model, the `exec` call is asked.
2. Ask the model to run `bun test`. On the card, choose the tier "This exact command" and press Enter.
3. If you changed it, put the policy back: `/settings set judgment.policy Hybrid`.
4. `/permissions rules` lists `exec: allow exactly: bun test`.

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

`/permissions add` writes the rule to the same store as a remembered answer, in both programs, into the one file every program reads (see "Where rules are kept"). It answers `Added rule owner-<kind>-<tool>-<time>-<random>: <description> (in <project>). Remove it with /permissions revoke <id>.`; without a working directory, `There is no working directory to scope the rule to; run this from a project. A never-run rule needs none.`; with words it cannot read, the usage above. `/permissions` alone opens these actions to choose from (a model or script running it alone gets `show`); `add allow ...` and `revoke` are the owner's only, and `add allow ...` asks first.

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

## Decisions Jev made: `/decisions`

Every call Jev decided at the gate (in `jev-decides` and `just-vibes`) is posted to the owner inbox as a `decision` item. `/decisions` lists them and lets the owner reverse each one.

```text
/decisions list                       open decisions (newest first) and recently answered inbox items
/decisions list --count 50            up to 50 of each
/decisions list --when today          only what was decided today (local time); also yesterday
/decisions list --when 2026-11-19     only what was decided on that day
/decisions list --when "since 2h"     only what was decided since then: 30m, 2h, 3d, 1w, or a day (2026-11-18)
/decisions keep <decision>            Leave a decision as Jev made it
/decisions undo <decision>            Undo what a decision did (restores the files the call changed)
/decisions never <decision>           Never allow calls like a decision's (saves a deny rule)
/decisions always <decision>          Always allow calls like a decision's without asking (saves an allow rule; asks first)
/decisions ask <decision>             Ask me about calls like a decision's (saves an "always ask me" rule)
```

- An id may be given as a unique prefix.
- `undo` works only for a call Jev allowed whose tool recorded every change for undo (`write`, `edit`). Otherwise it is refused with the reason, for example `Jev refused this call, so it never ran and there is nothing to undo.`
- `never`, `always` and `ask` save the rule in the same rule store as a remembered answer. They are offered only when a rule can be made from that call.
- A decision item stays open for 24 hours. The app keeps the last 200 decisions. When the session that made a decision ends, its open items are withdrawn with the note that a standing rule can be set with `/permissions`.
- Only the owner typing at the terminal can choose. When the model runs the command, it is told `Only the owner changes what Jev decided.` `/decisions` alone opens these actions, with each open decision picked from a list.
- The web UI shows the same list with the same choices.

What you can see, and for which period:

| What | Where | Period |
| --- | --- | --- |
| Gate calls Jev decided in `jev-decides` and `just-vibes` (allowed or refused, with Jev's reason) | `/decisions` in either app, the web UI | Each item is open for 24 hours; the newest 200 per running app are kept; items of an app that exits are withdrawn. `/decisions list --when today`, `yesterday`, `<YYYY-MM-DD>` and `"since <day or 30m/2h/3d/1w>"` show only that period (an open item by when it was decided, an answered one by when it was answered), looking through the whole inbox; `--count <n>` shows the latest n, however many. |
| Answered owner-inbox items (permission asks, questions, claims, purchase windows), by whom and from where | `/decisions` (the "Decided" list), `/questions all`, the web UI's Work page ("Show older") | For good: an answered item is never dropped. |
| Calls `just-vibes` held | `/held` | Until answered; at most 64. |

What cannot be seen from any product command:

- Judgment calls Jev read in `ask-me` and let run (`ask-me` asks Jev to read, not to decide, so nothing is posted to `/decisions`).
- Decisions that are not about a tool call: reading a natural-language schedule, triaging mail, grading a merchant, reading a channel message.
- Jev's reason for a refusal after the fact, other than the refusal text the model received and the `/decisions` item.

Every reading the engine takes, answered or failed, is written to the decision log, the SQLite file `<project>/.goodvibes/<surface>/decisions.sqlite` (`<surface>` is `tui` for the terminal app and the daemon, `agent` for the Agent), but no product command shows it.

How to reverse a decision:

| Decision | Reverse it with |
| --- | --- |
| Jev allowed a `write` or `edit` | `/decisions undo <id>` restores the files (while the item is open). |
| Jev allowed anything else (an `exec` command, a `fetch`, a send) | It cannot be undone from here. `/decisions never <id>` or `ask <id>` stops calls like it. |
| Jev refused a call | There is no "allow once". `/decisions always <id>` saves an allow rule for calls like it; then ask the model to try again. Or switch to `ask-me` for the session (Shift+Tab) and approve it when asked. |

## Calls held by `just-vibes`: `/held`

```text
/held list                 list what is held (what /held alone gives a model or script)
/held approve h3 h4        approve those held calls for this session (asks first)
/held approve all
/held dismiss h2           set one aside; it is not run
/held dismiss all
```

- Each held call shows its id (`h1`, `h2`, ...), the tool, a summary and the reason. The reasons are: `held for you: <owner-only reason>` for an owner-only item; `held for you: this needs a decision and no decision model is set up` or `held for you: this needs a decision and decision models are off` (both mean the call was a judgment call and no working decision model was in use: none set, `No Decision Model` chosen, or `Hybrid` after the set model failed); `held for you: <Jev's summary>` when Jev would not run it.
- The end of each `just-vibes` run lists what it held.
- An approval is the owner's "allow for this session" answer for that exact call. The call does not run by itself: ask the agent to carry on, and the call runs when it is made again.
- The same exact call held again keeps its first id. At most 64 held calls are kept.
- Only the owner can approve or dismiss. When the model runs the command it is told to have the owner type it.

## The owner inbox: `/questions`

`/questions` lists everything waiting on the owner: permission asks, questions agents left, channel owner claims, purchase windows and queued actions.

```text
/questions list                open items (what /questions alone gives a model or script)
/questions all                 every item, newest first
/questions show <item>
/questions answer <item> <choice|text> [note]   asks first: an answer cannot be taken back
```

When the daemon does not answer, `/questions list`, `/questions all` and `/decisions list` show what this machine holds under one line naming it: `The daemon at <address> did not answer (<reason>); showing only what is held on this machine, so its approvals and questions are missing.`

For an item with options, the first word of the answer is the choice and the rest is its note. Only the owner can answer. A channel owner claim offers `accept` and `decline`: `/questions answer <id> accept`. A decision item offers `keep`, `undo`, `never`, `always` and `ask`; a held-call item `approve` and `dismiss`.

## Plan mode

Plan mode is a separate read-only posture. Reads run; every write, command, network call and other change is refused with the reason `plan mode is on and <tool> would change something` and the next step "present the plan of changes and wait for the owner to approve it".

```text
/plan          the list: see whether plan mode is on, turn it on, turn it off
/plan status   say whether plan mode is on
/plan on       enter plan mode
/plan off      leave plan mode and restore the mode you were in (asks first; a model cannot)
```

- `/plan on` sets plan mode for this session only, as Shift+Tab does, and remembers the mode you were in; `/plan off` restores that mode. Neither changes the saved `permissions.mode` in your settings file, and plan mode ends with the session.
- Leaving plan mode another way (Shift+Tab, which moves from `plan` to `ask-me`) forgets the remembered mode.
- Plan mode entered another way (for example `/settings set permissions.mode plan`, or a channel profile) has no remembered mode; `/plan off` then returns to `ask-me`.
- Outputs: `Plan mode is on: writes, commands and network calls are blocked until /plan off or Shift+Tab.` and `Plan mode is off; the mode is <mode>.`
- `/plan` is a terminal-app command. In the Agent and for channels, set `plan` through `permissions.mode` or a channel profile.
- A read outside the working directory is refused in plan mode.

## Explaining a decision: `goodvibes doctor explain`

```sh
goodvibes doctor explain "rm -rf build"
goodvibes doctor explain write ./src/app.ts
goodvibes doctor explain read ./notes.txt --json
```

A subject that is a tool name followed by a path is checked as that tool; any other text is checked as a shell command run through `exec`. The output shows the subject, the tool and category, the current mode, the platform analyzer's risk, and `Decision: ALLOW`, `ASK` or `DENY` with the layer that decided.

It runs the gate the app runs: the mode in force (with the reason when it is not the saved mode), the feature flags and managed policy from settings, the remembered rules and never-run rules (`~/.goodvibes/shared/permission-rules.json`), and the decision model with its decision log in your home. A judgment call is a real request to the decision model, bounded by `judgment.decisionDeadlineMs` as every permission decision is. Nothing runs and nothing is remembered: an ask is answered "no" without a prompt and reported as `ASK`. After the gate allows a call it applies the tool's own path containment: `read`, `find`, `inspect`, `repo_map` and `analyze` refuse a path outside the project root in every mode but `yolo`, and `write` and `edit` refuse one in every mode, reported as `DENY` decided by `<tool> tool path containment`. The `decision model:` line says `consulted`, `not needed: a rule, a setting or the mode settled this call`, or `not consulted: <why> The verdict is the one the gate gives without a decision model.` (none set, `No Decision Model`, or the set model failing). A remembered-rules file that cannot be read is named on the `rules:` line (the running app refuses every call until it loads). It does not use the workspace trust of the directory. Treat `ASK` as "this reaches an owner prompt". It exits `0`; with no subject it prints usage and exits `2`. With `--json` the fields include `mode`, `savedMode`, `modeReason`, `decisionModel`, `decisionModelConsulted`, `containment` and `verdict`.

## The decision model

The decision model answers judgment calls at the gate and many other decisions (reading a natural-language schedule, triaging mail, reading a channel message for card details, grading a merchant). Every decision has a stated fallback.

### Decision model policy

`judgment.policy` takes three values. It is independent of `permissions.mode`.

| Value | What it does |
| --- | --- |
| `Hybrid` (default) | Uses the set decision model. When it fails (unreachable, too slow, a refused or missing key, a malformed answer), work continues without it: each decision takes its fallback, and you are told once, naming the model, what failed and the next step. You are told again when it answers. |
| `Decision Model Only` | Uses the set decision model. When it fails, work that needs it stops and reports the model, what failed and the next step. At the gate, the call fails with the model's error instead of asking you. |
| `No Decision Model` | Makes no decision-model requests. |

With no decision model set, every policy runs without one: nothing is asked, nothing waits, and no error is shown.

All `judgment.*` settings are kept in the daemon's settings file (`~/.goodvibes/daemon/settings.json`): one value, shared by the terminal app, the Agent and the daemon. Changing `judgment.policy` from any app changes it for all of them until it is changed back; there is no per-session decision model policy.

Only a failure of the set model downgrades `Hybrid`. An answer, an abstention, a privacy refusal, a limit or a cancellation does not. A setting value outside the three is reported by name with the valid values, and the product runs on `Hybrid`.

```text
/settings set judgment.policy No Decision Model
/settings set judgment.policy Hybrid
```

### Setting up the hosted decision model (Jev)

Prerequisite: a TypeSafe API key for the hosted endpoint.

1. Put the key in the environment variable `TYPESAFE_API_KEY` for the process (or the daemon service), or store it in the secret store and point the settings at it:

   ```text
   /secrets set TYPESAFE_API_KEY <your-api-key> --scope user
   /settings set judgment.keySource secret
   /settings set judgment.keyName TYPESAFE_API_KEY
   ```

2. Leave `judgment.endpoint` and `judgment.model` empty to use `https://api.typesafe.ai` and `jev-latest`.
3. Check: `goodvibes status` prints under `Decision model:` either `A decision model is in use (Hybrid (default)).` or `No decision model is in use: none is set, so decisions take their fallbacks. To use one, choose a Decision model in /settings open.`

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
| `judgment.timeoutMs` | Timeout per target, default `30000`; `0` means the default. |
| `judgment.decisionDeadlineMs` | How long a decision that a person or a tool call waits on may take, default `1500`, range 1 to 120000, permission decisions at the gate included (one deadline for the whole decision). Past it the decision takes its stated fallback (see "Timeouts and the decision deadline"). A target that misses the deadline three times in a row is skipped for a minute. |

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
- `Decision Model Only` makes an outage stop work instead of falling back: a call that needs the model fails with the model's error (`System One could not be reached`, `System One answered HTTP <status>`), and the gate does not ask you instead. With `Hybrid` an outage would fall back silently after one notice.
- `permissions.mode jev-decides` is set explicitly: the unchosen default would behave as `ask-me` on a model the shipped calibration did not measure.
- With an authenticated server: `/secrets set KEV_API_KEY <your-api-key> --scope user`, `/settings set judgment.keySource secret`, `/settings set judgment.keyName KEV_API_KEY`.
- Check with `goodvibes status`. While the model answers, the `Decision model:` block reads `A decision model is in use (judgment.policy Decision Model Only).` After it has failed, the block and the one notice in the conversation read `The decision model <model> is unavailable (<what failed>); work that needs it stops (judgment.policy is Decision Model Only; Hybrid would continue without it). Next: <step>`. Under `Hybrid` the same line ends `continuing without it. Next: <step>`. Then ask for a change in the conversation: with the server stopped, the call fails with the error above.
- What stops and what does not: facts (reads and recoverable edits inside the project, matching rules, owner-only asks) never ask the model and keep working; only judgment calls and other work that needs the model fail.

#### Timeouts and the decision deadline

Two limits apply, to different requests:

- A permission decision (the reading of a judgment call, the boundary readings and Jev's decision in `jev-decides` and `just-vibes`) has one deadline for the whole decision: `judgment.decisionDeadlineMs` (default 1500). Each request it makes gets what is left of it, across retries and `judgment.fallbacks` targets (each attempt is still bounded by `judgment.timeoutMs`). When the model has not answered in time, the request fails as a missed deadline and the decision takes its fallback, as every other decision does: under `Hybrid` the gate's no-model rule decides (asks you, or holds the call in `just-vibes`) and the conversation gets the one failure notice; under `Decision Model Only` the tool call stops with `The decision model did not answer within <n> ms.` and nothing is asked. The missed deadline also starts a failure episode (see "When a decision model counts as working"). A target that misses the deadline three times in a row is skipped for a minute, so the next decisions take their fallback at once.
- `judgment.decisionDeadlineMs` (default 1500) bounds the other decisions a person or a tool call waits on (for example reading an inbound channel message). When one is not answered in time, it takes its own stated fallback in every policy, `Decision Model Only` included; the deadline is not a model failure and does not stop work. A target that misses the deadline three times in a row is skipped for a minute, and while every target is skipped those decisions take their fallback at once.
- Where the keys live: `judgment.*` is kept in the daemon's settings file (`~/.goodvibes/daemon/settings.json`), so one write from any app (or `goodvibes-daemon config set judgment.policy "Decision Model Only"`) sets it for every program and the daemon. `permissions.mode` is kept per program: the daemon has its own, so for daemon-run work (routines, triggers, channel turns) set it there too: `goodvibes-daemon config set permissions.mode jev-decides`.

### How you can tell no decision model is in use

- The conversation says so once when none is set or `No Decision Model` is chosen, once when a set model starts failing, and once when it answers again. A failure is not repeated every turn.
- `goodvibes status` and `goodvibes-agent status` print the policy and a `Decision model` line.
- A headless run prints the line on stderr and adds `diagnostics.decisionModel` to its JSON result without changing the exit code.
- The web UI's header chip names the permission mode in force: `Jev decides · asking you for now` while `jev-decides` is chosen and no decision model works (on a phone `Asking you for now`), otherwise the chosen mode (`Ask me`, `Just vibes`, `YOLO`). Opening it shows why in one sentence (for example `You chose Jev decides, but decision models are switched off, so GoodVibes asks you instead for now.`) and `Change`, which opens Settings, Permissions.
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

```text
/security policy-screen                   open the policy screen (terminal app)
/security policy                          the bundle in force, the candidate, the history
/security load-policy <bundle-file>       load a candidate bundle from a JSON file
/security simulate-policy                 rule diff and the recorded calls the candidate decides differently
/security compare-policy                  rule diff, current against candidate
/security lint-policy                     lint the active and candidate bundles
/security preflight                       review proactive policy and MCP risk state
/security enforce-policy                  enforce the candidate simulate-policy showed (asks first; only you; a candidate loaded or changed since is refused: simulate it first)
/security restore-policy                  restore the previous active bundle (asks first; only you)
```

### Bundle file format

A bundle is one JSON object:

| Field | Required | Meaning |
| --- | --- | --- |
| `bundleId` | yes | A non-empty string naming this bundle version. |
| `issuedAt` | no | ISO 8601 time the bundle was issued. Part of the signed content. |
| `issuer` | no | Who issued it, shown in `/security policy`. Part of the signed content. |
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
/security load-policy /home/me/policy/team.json
/security simulate-policy
/security enforce-policy
```

The managed evaluator's default for a call no rule matches is deny; that deny is reported as managed policy only when a rule decided it, so an unmatched call continues through the ordinary order. `/security load-policy` reports `[policy] Candidate loaded` and suggests `/security simulate-policy`; a refused bundle prints `[policy] Load failed: <reason>` and leaves the current and candidate bundles unchanged. A promoted bundle is recorded in `policy-activation.json` beside `permission-rules.json` and is enforced again at the next start while it is unchanged.

`policy.bundleSource` `file` with `policy.bundlePath` (absolute, or relative to the working directory) loads a bundle as a candidate at start; a bundle that cannot be read or is refused is logged and named in `/security policy`. `policy.requireSignedBundles` refuses every bundle without a valid signature made with the hex key in `GOODVIBES_POLICY_SIGNING_KEY` (at least 16 bytes, 32 hex characters; restart to apply). A bundle whose signature is present but does not verify is refused whatever this setting says. `permissions.simulation` (default on) runs the other evaluator beside the active one and records where they disagree, without changing what is enforced; `permissions.divergenceDashboard`, `permissions.divergenceThreshold` and `permissions.maxDivergenceRecords` control that record. The policy actions of `/security` work in both terminal programs; the policy screen is the terminal app's.

## Workspace trust

Every workspace (working directory) has a trust level: `trusted`, `restricted`, or undecided.

| Level | Effect |
| --- | --- |
| `trusted` | All tools may run, subject to the permission mode and rules. |
| `restricted` | Only reads run. Every write, command and delegation is refused, in every mode including `yolo`. |
| undecided | Reads run. Calls settled without asking run. The first call that would ask you raises the trust question instead: "New workspace: choose a trust level", with "Trust this workspace" and "Keep restricted (read-only)". Choosing trust forwards the original ask to you. Dismissing the question (Esc) records nothing: that call is refused, the workspace stays undecided, and the next call that would ask raises the question again. |

```text
/security folder                     show the level, whether it is decided, and the registration
/security trust-folder               trust this folder (loosens a protection: asks first, only you)
/security restrict-folder            restrict this folder
/security trust                      what is trusted: permission mode, secrets, services, plugins, MCP servers
/security save-trust <file> [--replace]
/security read-trust <file>
```

The permission mode `/security trust` and a saved trust bundle report is the mode in force for the conversation (in a hosted Agent session, the mode the host runs it under). When the mode chosen differs, both are shown with the reason: `permission mode: yolo (chosen ask-me: <reason>)`, and the bundle carries `permissionModeChosen` and `permissionModeReason` beside `permissionMode`.

- Decisions are kept in `~/.goodvibes/shared/workspace-registrations.json`, one row per directory by its real path, shared by every product. A `trust.json` inside a project is not honoured; `/security folder` says so when it finds one.
- When a decision cannot be saved, it applies to this session only and the app says it will ask again next time.
- With nobody to answer (a headless run without `--answer-permissions`), a call that needs the trust answer is refused: `Workspace trust for <dir> is undecided and the trust question was not answered here, so the workspace stays undecided.` Fix: run `/security trust-folder`, or answer the workspace-trust prompt of a run started with `--answer-permissions`.
- An unreadable trust record is treated as restricted for autonomous work until a level is chosen.
- `goodvibes status` shows `Workspace: trust: <level>` and the registration.

### Path containment

Two separate checks:

- The gate classes paths lexically against the working directory: a read or recoverable edit runs without asking only inside it (step 8). A path outside it makes the call a judgment call in every mode but `yolo`.
- The tools resolve symbolic links and refuse a path that lands outside the project root with `Path '<p>' is outside the project root`. The `write` and `edit` tools refuse it in every mode, `yolo` included (they also refuse the verification journal under `.goodvibes/verification` and any directory that contains it). The `analyze` tool refuses it in every mode. The `read`, `find` and `inspect` tools refuse it in every mode except `yolo`, where they read outside. That `yolo` exception follows the mode in the app's settings (saved, `--yolo`, `-c permissions.mode=yolo`, Shift+Tab, or a saved `behavior.autoApprove`), not a hosted session's own `yolo` set through `sessions.permissionMode.set`. Whatever the gate or the owner answered, these tools never write outside the project, and read outside it only in `yolo`; a shell command run through `exec` (for example `cat` or `cp`) is not stopped by this check, only by the gate and the exec sandbox.

## The exec sandbox

On Linux with bubblewrap (`bwrap`) installed, each shell command the `exec` tool runs is contained:

- the workspace is writable, and so are the paths in `sandbox.workspaceWritable`;
- the rest of the file system is read-only, `/tmp` is private, `$HOME` is masked;
- credential-bearing environment variables are removed;
- the network is off. It is opened only when both hold: the decision model reads the command as needing the network, and every command in the line is listed in `sandbox.egressAllowlist`. The allowlist alone never opens it: a listed command the model reads as not needing the network gets none, and with no decision model in use no command gets the network, listed or not (the command is put to you instead: `Without a decision model, this did not assess command host-access needs; owner approval is required inside the sandbox`, and approving runs it inside the boundary, still offline). A command read as needing the network and fully listed is put to you as `wants network (on egress allowlist, granted inside the boundary once approved)`; approving grants it for that run. Who answers that ask follows the mode: in `ask-me`, and in `jev-decides` without a working decision model, it is put to you on the approval card (annotated per `sandbox.judgment`); otherwise the call's own recorded admission (Jev's decision) answers it. One read as needing the network but not fully listed is told `denied inside the boundary and approval does not change that; add it to sandbox.egressAllowlist`.

Where bubblewrap is missing, on macOS, and on native Windows, the exec path runs on the host and the sandbox reports itself unavailable. On Windows, run GoodVibes in WSL 2 with bubblewrap installed to get the boundary.

| Setting | Default | Applies |
| --- | --- | --- |
| `sandbox.enabled` | `true` | Turning it on takes effect at the next start (the host is probed then). Turning it off applies from the next command. |
| `sandbox.workspaceWritable` | `[]` | Absolute paths only; a relative path is refused. From the next command. |
| `sandbox.egressAllowlist` | `[]` | Command names, for example `["git","npm"]`; `["*"]` counts every command as listed (the decision model must still read a need). From the next command. |
| `sandbox.judgment` | `annotate` | `off`: plain asks. `annotate`: a model verdict with reasons annotates a sandbox escalation ask; you still decide. `auto-approve`: also approves looks-safe verdicts. Never auto-denies. |
| `sandbox.mcpIsolation` | `disabled` | `disabled`: stdio MCP servers run as host processes. `contained`: each runs in its own bubblewrap boundary (workspace writable, system files and its own install read-only, `$HOME` and `/tmp` private, host network shared). Applies when a server next connects (`/mcp reload`). On a host without bubblewrap a contained server does not start. |

How the sandbox affects asks: in `ask-me`, a call asked about only because of where it could reach (for example a command that might send secrets out) runs without asking when it runs inside the sandbox; the decision records that the sandbox settled it, not you. A call asked for any other reason (owner-only, irreversible, security-weakening, obfuscated) is asked whether contained or not. An `exec` call carrying `file_ops`, a malformed `cmd_base64`, or a working directory other than the session's is always shown to you.

The `repl` tool is registered only where the sandbox is available; each evaluation runs as one sandboxed command.

```text
/security sandbox-screen                         open the sandbox screen (terminal app)
/security sandbox                                the current boundary
/security sandbox-advice                         what to set, and why
/security sandbox-profiles
/security sandbox-presets                        each preset, what it sets and its notes
/security sandbox-probe
/security contain-mcp                            MCP servers start inside their own boundary
/security host-mcp                               MCP servers start as host processes (loosens a protection: asks first, only you)
/health check sandbox                            the boundary on this host, checked
/security sandbox-sessions
/security start-sandbox <command|mcp-server> [--host] [name]
/security sandbox-session <session>
/security run-in-sandbox <session> <command line>
/security stop-sandbox <session>
/security save-sandbox <session> <file> [--replace]  an existing file is kept unless --replace (asks first); a model-run save stays inside the working directory
/security read-sandbox <file>
```

A sandbox session is contained or not started. On a host without bubblewrap, or for the `command` profile (network off) on a host whose bubblewrap cannot take the network away, `/security start-sandbox` refuses and names why, with the next step (install bubblewrap). `--host` starts a host session on purpose: no boundary and the host network, whatever the profile says; the session's backend is `host` and its detail line reads `asked for with --host`.

The sandbox actions of `/security` work in both terminal programs; sandbox sessions and the sandbox screen are the terminal app's. In the Agent, change `sandbox.enabled` and `sandbox.judgment` with `/settings set <key> <value>`, and the two list settings in the settings workspace (`/settings sandbox`). `goodvibes status` prints an `Exec sandbox:` block: `active`, `configEnabled`, `backend` (`bubblewrap`), `available`, `network: isolation confirmed`. The QEMU backend is retired. Old settings `sandbox.qemu*`, `sandbox.vmBackend`, `sandbox.replIsolation` and `sandbox.windowsMode` are removed from a settings file on load, and a VM `sandbox.mcpIsolation` value becomes `contained`.

`permissions.commandParser` (`ast` default, or `flat`) decides whether an `exec` command is parsed into segments first; `ast` refuses a command with a segment that runs nothing.

## Secrets

### Stores and read order

A secret is looked up in this order; the first that has it wins:

1. the process environment;
2. the daemon's store, `~/.goodvibes/daemon/secrets.enc` (moved by `GOODVIBES_DAEMON_HOME`);
3. your own store for the app, `~/.goodvibes/<surface>/secrets.enc`, then its plaintext file;
4. the store of the project you opened, `<project>/.goodvibes/<surface>/secrets.enc`.

`<surface>` is `tui` for the terminal app. Directories above the project are never read. The encrypted stores use AES-256-GCM under a random 32-byte key file `~/.goodvibes/secrets.key` (mode 0600). `GOODVIBES_HOME` moves the whole tree.

A key in a project's store is part of the checkout, so it is used only after you stored it there yourself or confirmed it once with `/secrets trust <KEY>`. Until then `/secrets list` marks it `not used until confirmed: /secrets trust <KEY>`. A confirmation lasts until the value changes.

`storage.secretPolicy`: `preferred_secure` (default: encrypted when available), `require_secure` (refuse to store unencrypted), or `plaintext_allowed`.

### Command line

```sh
goodvibes secrets list
goodvibes secrets providers
goodvibes secrets test goodvibes://secrets/env/OPENAI_API_KEY
goodvibes secrets set OPENAI_API_KEY <your-api-key> --user
printf '%s' '<your-api-key>' | goodvibes secrets set OPENAI_API_KEY --stdin --user
goodvibes secrets link OPENAI_API_KEY goodvibes://secrets/env/OPENAI_API_KEY --user
goodvibes secrets delete OPENAI_API_KEY --user
```

`goodvibes-agent secrets` takes the same forms.

- Without `--user`, `set` and `link` write to the project store. Use `--user` for your own store. The Agent files a credential the daemon reads (channel tokens, mail passwords and other daemon-owned keys) in the daemon store whatever scope you ask for, and says so.
- `--plaintext` stores the value unencrypted; `--secure` (default) encrypts it.
- `--stdin` reads the value from standard input without its trailing newline; use it for a value that starts with `--`.
- The value is exactly one argument. Several value words are refused: `Not stored: 2 values were given for <KEY>.`
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

### Slash commands

```text
/secrets                           the list of actions, "See your secrets" first
/secrets list
/secrets providers
/secrets storage                   how secrets are kept and where each store is
/secrets set <KEY> <value> [--scope project|user] [--storage secure|plaintext]
/secrets set <KEY>                 type the value on a hidden line
/secrets link <KEY> <secret-ref> [--scope project|user] [--storage secure|plaintext]
/secrets get <KEY>                 confirms it is stored; never prints it
/secrets test <secret-ref>
/secrets trust <KEY>               use a key in this project's store (asks once; never from a model)
/secrets delete <KEY> [--scope project|user] [--storage secure|plaintext]   (asks once)
/secrets use <NAME>                type a value on a hidden line; kept as an environment variable for this session only
```

`project` and `secure` are the defaults; `--storage plaintext` loosens a protection, so it asks first and a model cannot choose it.

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

A plain value in a settings file for such a key is refused with the command that stores it. Card numbers and card security codes are never settings: they go to the daemon's card store through `/payments add-card` or the web UI.

## Headless runs and permissions

In `goodvibes run` and `goodvibes-agent run`, a call that needs the owner is refused unless the run uses `--output stream-json --answer-permissions`; then each such call writes a `PERMISSION_PROMPT` frame and waits for a `{"type":"PERMISSION_ANSWER","callId":"<id>","approved":true}` line on standard input. An unanswered call is refused, never approved. `--just-vibes` and `--yolo` work in `run` as in the interactive apps. The frame formats are under "Headless runs" in "The terminal app (`goodvibes`)".

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every command asks even in `jev-decides`. | No working decision model, or the default `jev-decides` on an endpoint or model the calibration did not measure. | Check `goodvibes status`. Set `TYPESAFE_API_KEY`, or choose `jev-decides` explicitly: `/settings set permissions.mode jev-decides`. |
| A tool never runs, in any mode except `yolo`: "refused by the setting permissions.tools.<x> = deny". | A per-tool deny. | `/settings set permissions.tools.<x> prompt`. |
| "refused by the saved rule ..." | A remembered deny rule. | `/permissions rules`, then revoke it. |
| "plan mode is on and <tool> would change something". | Plan mode. | `/plan off` or Shift+Tab. |
| Writes refused in a new directory with "Workspace trust ... is undecided". | Trust question unanswered. | `/security trust-folder`. |
| Writes refused: "Explicit restricted workspace forbids this operation". | Workspace set to restricted. | `/security trust-folder`. |
| A request from Slack never runs in `yolo`. | A channel request always needs the owner's answer. | Answer it in the terminal app, the web UI or the conversation; or ask from the terminal. |
| A request from email, a webhook or ntfy is refused. | Those surfaces cannot direct changes. | Ask from the terminal, Telegram or another owned surface. |
| `just-vibes` finished without doing some steps. | They were held. | `/held`, `/held approve <id>`, then ask to carry on. |
| "Decision model ... failing" once, then work continues. | `Hybrid` fell back. | Fix the endpoint or key named in the notice; the app says when it answers again. |
| Work stops with a decision-model error. | `Decision Model Only` and the model failed. | Fix the model, or `/settings set judgment.policy Hybrid`. |
| Commands have no network. | The exec sandbox turns it off. | Add every command of the line to `sandbox.egressAllowlist`, and have a working decision model: without one the sandbox never opens the network. |
| A contained MCP server does not start. | `sandbox.mcpIsolation` is `contained` and bubblewrap is missing. | Install bubblewrap, or `/security host-mcp`. |

## Settings reference for this part

<!-- generated: settings:permissions -->

<!-- generated: settings:behavior.autoApprove -->

<!-- generated: settings:judgment -->

<!-- generated: settings:policy -->

<!-- generated: settings:sandbox -->

<!-- generated: settings:storage.secretPolicy -->

<!-- generated: settings:storage.secretProviders -->

<!-- generated: settings:telemetry.decisionOtlp -->
