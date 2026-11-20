# Exit codes across the programs

Four commands set exit codes a script is expected to branch on. They were
written separately, so the same number means different things in different
programs. Existing codes are not renumbered; use this table to read each one,
and never branch on a code without knowing which program produced it.

| Code | `goodvibes run`, `goodvibes-agent run` | `goodvibes-contract` | `goodvibes-daemon` |
| --- | --- | --- | --- |
| `0` | Completed, or admitted work was recorded. | The contract passed, or the command did what it says. `reply` follows the contract it answered, so its code is the contract's; `reply --no-follow` exits `0` once the reply is read. | The command did what it says. |
| `1` | Failed: model or provider error, empty response, `--max-turns` reached, or the host unavailable, blocked or refused the input. | Failed, was refused, or was cancelled. | It ran and failed; the reason is printed. |
| `2` | Invalid input: bad usage, a missing prompt, or a prompt given with a recovery flag. | Waiting on the owner with no terminal to ask on: answer with `goodvibes-contract reply <id> "<text>"`. | The command line was wrong: unknown command or flag, a flag this command does not take, a missing value. |
| `3` | Outcome unknown (`turn-unsettled`): the turn ended without a final event, including a turn refused before it started by a failed preflight check or a conversation too large for the model's context window. For admitted native input, the input may have taken effect: run `run --intake-status` before retrying. | not used | Service commands: installed but not running. |
| `4` | not used | not used | Service commands: not installed. |
| `5` | not used | not used | `install-service`, `refresh-service`, `uninstall-service`: the definition at the service's path was not written by GoodVibes; nothing was changed. |
| `64` | not used | Usage error. | not used |
| `124` | `--timeout` reached; the run was cancelled. | not used | not used |
| `130` | Cancelled: Ctrl-C, SIGTERM, or the saved input was cancelled. | Stopped following (Ctrl-C): nothing is cancelled; `goodvibes-contract resume` continues the contracts and `goodvibes-contract cancel <id>` cancels one. | not used |

The same number, different meaning:

- `2` is a usage error for `run` and the daemon, but "the owner has to answer"
  for `goodvibes-contract`, which reports usage as `64`.
- `3` is "the outcome is unknown" for `run` and "not running" for
  `goodvibes-daemon service-status`.
- `1` always means the command ran and did not succeed. For `run` it also
  covers a refusal, which is not an error to retry.

Branching rules that hold for every program:

- `0` means the requested effect happened. Anything else means it did not, or
  (`run` exit `3`) that it is not known.
- Do not retry on `3` from `run`; inspect first.
- Standard 128+signal codes are not used except `130`.
- `goodvibes-agent doctor` exits `1` for a must-fix (`risk`) finding and `0` otherwise; `--strict` makes any finding exit `1`.

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
| `preflight_failed`, `context_overflow` | `3` (as `turn-unsettled`) | A turn refused before it started carries one of these on its `PREFLIGHT_FAIL` event: `preflight_failed` when an equivalent turn is already in flight, `context_overflow` when the conversation is too large for the model's context window. A headless run does not settle on that event, so it reports `turn-unsettled` and exits `3`. Compact the conversation or choose a model with a larger window, then run again. |
| `provider_error` | `1` | The provider refused or failed the request, and no model of `provider.fallbackModels` was left to try; `error` says why. Check the provider's key or sign-in and the model, then run again. |
| `provider_exhausted` | `1` | Every provider serving the selected synthetic model is exhausted (rate limits). Wait and run again, or choose another model. |
| `hook_denied` | `1` | A hook on the model request denied it; `error` is the hook's reason. Change or remove the hook. |
| `tool_loop_circuit_breaker` | `1` | The turn was stopped by a turn limit or budget before the request was complete; `error` says which. Raise the limit or narrow the request. |
| `unexpected_error` | `1` | The turn failed with an error that is not a provider's (in the turn loop, or in this process after the host admitted the turn); `error` says why. The outcome is known: it failed. |
| `session-open-elsewhere` | `1` | `--resume`, `--continue` or `--session` named a session another running copy has open; nothing was sent. Close it there and run again, or run without the flag. `refusal` says which session. |
| `invalid-input` | `2` | Fix the command line. |
| `native-blocked`, `native-refused` | `1` | The host recorded the input and blocked or refused it; it will not run. |
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
