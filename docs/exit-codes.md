# Exit codes across the programs

Five commands set exit codes a script is expected to branch on. They were
written separately, so the same number means different things in different
programs. Existing codes are not renumbered; use this table to read each one,
and never branch on a code without knowing which program produced it.

| Code | `goodvibes run`, `goodvibes-agent run` | `goodvibes-contract` | `goodvibes-daemon` | `install.sh` (the release installer) |
| --- | --- | --- | --- | --- |
| `0` | Completed, or admitted work was recorded. | The contract passed, or the command did what it says. `reply` follows the contract it answered, so its code is the contract's; `reply --no-follow` exits `0` once the reply is read. | The command did what it says. | Installed, and the daemon and web UI run as asked (`Done.`). |
| `1` | Failed: model or provider error, empty response, `--max-turns` reached, a turn refused before it started (a failed preflight check, or a conversation too large for the model's context window), or the host unavailable, blocked or refused the input. | Failed, was refused, or was cancelled. | It ran and failed; the reason is printed, or with `--json` one `{ok:false, code, error, fix}` document is printed on stdout. | Failed or refused with an `INSTALL_E<n>` code; the previous programs were put back when any had been replaced. |
| `2` | Invalid input: bad usage, a missing prompt, or a prompt given with a recovery flag. Bad usage prints the error and the command's one usage line; with `--output json` or `stream-json`, the run's final frame (`stopReason` `invalid-input`) on stdout instead. | Waiting on the owner with no terminal to ask on: answer with `goodvibes-contract reply <id> "<text>"`. | The command line was wrong: unknown command or flag, a flag this command does not take, a missing value. It prints the error and the command's one usage line; with `--json`, a `{ok:false, code, error, fix}` document (`code` `PARSE_ERROR` or `COMMAND_REFUSED`) on stdout instead. | not used |
| `3` | Outcome unknown (`turn-unsettled`): the turn ended without a final event. For admitted native input, the input may have taken effect: run `run --intake-status` before retrying. | not used | Service commands: installed but not running (`service-status`; `install-service`, `start-service` and `restart-service` when the service is not running afterwards). | Installed, but another copy earlier on `PATH` still answers a command name. |
| `4` | not used | not used | Service commands: not installed. | Installed, but the daemon or the web UI is not running as asked (a service not set up or not running, a failed restart, an unconfigured web UI, an unsaved `--no-service`); `Installed, with the problems above.` |
| `5` | not used | not used | `install-service`, `refresh-service`, `uninstall-service`: the definition at the service's path was not written by GoodVibes; nothing was changed. | not used |
| `64` | not used | Usage error. | not used | not used |
| `124` | `--timeout` reached; the run was cancelled. | not used | not used | not used |
| `130` | Cancelled: Ctrl-C, SIGTERM, or the saved input was cancelled. | Stopped following (Ctrl-C): nothing is cancelled; `goodvibes-contract resume` continues the contracts and `goodvibes-contract cancel <id>` cancels one. | not used | Interrupted (Ctrl-C); `143` and `129` for SIGTERM and a hang-up. The previous programs were put back when any had been replaced. |

`goodvibes` and `goodvibes-agent` started for their full-screen view without a terminal (standard input or output a pipe or a file, as in `goodvibes config get provider.model </dev/null`) exit `2` with one line: `goodvibes needs an interactive terminal (stdin is not a terminal); to run a prompt without one: goodvibes run "config get provider.model"`.

The same number, different meaning:

- `2` is a usage error for `run` and the daemon, but "the owner has to answer"
  for `goodvibes-contract`, which reports usage as `64`.
- `3` is "the outcome is unknown" for `run`, "not running" for
  `goodvibes-daemon service-status`, `install-service`, `start-service` and `restart-service`, and "installed but shadowed on `PATH`" for `install.sh`.
- `4` is "not installed" for `goodvibes-daemon service-status` and "installed,
  with problems" for `install.sh`.
- `1` always means the command ran and did not succeed. For `run` it also
  covers a refusal, which is not an error to retry.

`do` and `find` (`goodvibes`, `goodvibes-agent`, `goodvibes-daemon`) run and find a GoodVibes capability through the
daemon: `0` it was done (or found), `1` it was refused or failed (a capability that acts on a conversation is refused
in one line, since it needs the terminal app or the Agent), `2` the command line was wrong. A `do` that weakens a
protection (installing something that runs by itself included, such as a file named by path that a program runs by
itself later), cannot be undone, spends money, writes a secret or is the owner's own act is decided by the daemon under
the owner's permission mode, whoever typed it and wherever: a command line never carries a person's word, and nothing
is asked at the terminal. YOLO runs it, Just vibes holds it, and under Ask me and Jev decides the owner's one approval card asks it and
the `do` waits on that answer (`0` once it ran, `1` on the owner's No). Only a read runs at once. With `--output json` (`--json`
for the daemon) the answer or the `{ok:false, code, error, fix}` refusal is one document on stdout; without it a refusal
or failure (exit `1`) is printed on stderr, the same in all three programs. A refusal's code is the capability's own
(`NOT_FOUND`, `INVALID_ARGUMENT`, `UNAVAILABLE`, `CAPABILITY_NOT_APPROVED`, ...); the exit code is `1` for every
refusal, whatever its HTTP status.

`goodvibes-daemon pair` (and `goodvibes pair`, `goodvibes-agent pair`), in a terminal, asks once when the daemon is
reachable only from this computer: "Phones on your network cannot reach GoodVibes yet. Serve it to your network?
[y/N]"; Enter or `n` changes nothing and exits `0` with the link for this computer. `goodvibes-daemon pair --lan` and a
mint on another daemon (`--host`) print their plan and exit `0` without `-y`, changing nothing.

Branching rules that hold for every program:

- `0` means the requested effect happened. Anything else means it did not, or
  (`run` exit `3`) that it is not known.
- Do not retry on `3` from `run`; inspect first.
- Standard 128+signal codes are not used except `130`, and `129` and `143` from `install.sh`.
- `goodvibes-agent doctor` exits `1` for a must-fix (`risk`) finding and `0` otherwise; `--strict` makes any finding exit `1`.
- A batch command (`goodvibes-agent knowledge import-urls`, `import-bookmarks`, `import-browser-history`, `ingest-connector`) exits `0` only when every item was done (or there was nothing to import). A partial batch exits `1`, as does one where nothing was done; each failed item is listed with its reason, and `--output json` carries them under `outcome` (`state` `partial` or `none-done`). It is not a new code: `1` still means the command ran and did not fully succeed.

`run --output json|stream-json` also names why it stopped in `stopReason`:

| `stopReason` | Exit | Next step |
| --- | --- | --- |
| `completed` | `0` | None. |
| `empty_response` | `1` | The model answered with nothing; run again or change the model. |
| `max_turns` | `1` | Raise `--max-turns`, or narrow the prompt. |
| `timeout` | `124` | Raise `--timeout`; work the run delegated was cancelled with it. |
| `cancelled` | `130` | The run was cancelled (Ctrl-C, SIGTERM), including work it delegated. |
| `contract-failed`, `agent-failed` | `1` | Delegated work ended without a result; `error` says why. |
| `awaiting-owner` | `1` | Delegated work stopped for an owner decision: open the session interactively, answer it, and the work continues. |
| `turn-unsettled` | `3` | The turn ended without a final event, so its outcome is unknown; inspect the session before running again. |
| `preflight_failed`, `context_overflow` | `1` | The turn was refused before it started, so nothing ran; `error` says why. `preflight_failed`: an equivalent turn is already in flight; wait for it. `context_overflow`: the conversation is too large for the model's context window; compact it or choose a model with a larger window, then run again. |
| `provider_error` | `1` | The provider refused or failed the request, and no model of `provider.fallbackModels` was left to try; `error` says why. Check the provider's key or sign-in and the model, then run again. |
| `provider_exhausted` | `1` | Every provider serving the selected synthetic model is exhausted (rate limits). Wait and run again, or choose another model. |
| `hook_denied` | `1` | A hook on the model request denied it; `error` is the hook's reason. Change or remove the hook. |
| `tool_loop_circuit_breaker` | `1` | The turn was stopped by a turn limit or budget before the request was complete; `error` says which. Raise the limit or narrow the request. |
| `unexpected_error` | `1` | The turn failed with an error that is not a provider's (in the turn loop, or in this process after the host admitted the turn); `error` says why. The outcome is known: it failed. |
| `session-open-elsewhere` | `1` | `--resume`, `--continue` or `--session` named a session another running copy has open; nothing was sent. Close it there and run again, or run without the flag. `refusal` says which session. |
| `session-not-found` | `1` | `--resume <id>` or `--session <id>` named a session that does not exist, or `--continue`/`--resume` found none to continue; nothing was sent and no input was recorded. `refusal` says which. |
| `invalid-input` | `2` | Fix the command line. |
| `native-blocked`, `native-refused` | `1` | The host recorded the input and blocked or refused it; it will not run. A refusal because the decision model could not answer while "When the decision model is missing or fails" (`judgment.policy`) is Decision Model Only says so in `response`, naming that setting; nothing ran. |
| `native-cancelled` | `130` | The recorded input was cancelled. |
| `native-work` | `0` when the work's execution is reported, otherwise `3` | The input became work on the host. Without an execution report its outcome is not known yet: run `run --intake-status`. |
| `native-turn` | `3` | The input was recorded as a turn on the host, which this run does not follow to its end: run `run --intake-status` for the outcome. |
| `native-pending`, `native-recorded`, `native-unknown`, `native-detached` | `3` | The intake is still pending, was recorded with no result yet, could not be confirmed, or the run ended before any intake state arrived. The input may have taken effect: run `run --intake-status` before retrying. |
| `native-invalid` | `2` | The saved input or flags were refused as invalid; nothing was sent. |
| `native-unavailable` | `1` | Nothing was sent; `cause` says why (`principal`: pair this terminal with the host). |

With `run --intake-status`, a recorded intake exits `0` whatever its outcome; `stopReason` names the outcome.

Details: [headless `run` (TUI)](../products/tui/docs/cli-flags.md#headless-run),
[headless `run` (Agent)](../products/agent/docs/headless-run.md#exit-codes),
[daemon commands](../products/daemon/docs/commands-reference.md#exit-codes).
