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
| `3` | Outcome unknown: the input may have taken effect. Run `run --intake-status` before retrying. | not used | `service-status` only: installed but not running. |
| `4` | not used | not used | `service-status` only: not installed. |
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
| `turn-unsettled` | `1` | The turn ended without a final event; inspect the session before running again. |
| `invalid-input` | `2` | Fix the command line. |
| `native-<kind>` | by kind | The recorded intake outcome (`native-turn`, `native-work`, `native-blocked`, `native-refused`, `native-cancelled`). |
| `native-unknown` | `3` | Run `run --intake-status` before retrying. |
| `native-unavailable` | `1` | Nothing was sent; `cause` says why (`principal`: pair this terminal with the host). |

Details: [headless `run` (TUI)](../products/tui/docs/cli-flags.md#headless-run),
[headless `run` (Agent)](../products/agent/docs/headless-run.md#exit-codes),
[daemon commands](../products/daemon/docs/commands-reference.md#exit-codes).
