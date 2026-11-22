# GitHub Action: run-goodvibes

A composite action (`products/tui/action.yml`) that installs a pinned,
checksum-verified GoodVibes release and runs a non-interactive command or prompt
against a workspace in CI. It runs the suite installer `scripts/install.sh` from
the action's own checkout, so the installer is exactly the one at the ref the
workflow pinned (the same script `https://goodvibes.sh/install.sh` serves for
interactive installs, but never fetched from that URL). The installer resolves one release from `mgd34msu/goodvibes` and verifies its
compiled TUI, daemon, optional Agent and WebUI against that release's
`SHA256SUMS.txt`. A missing asset or checksum stops installation. The action
disables daemon service registration for the CI account.

## Usage

Select an available published suite tag for both the action reference and the
`version` input. The examples below use the 3.4.4 suite version; check the
[published releases](https://github.com/mgd34msu/goodvibes/releases) for available
downloads. A full commit SHA can pin the action code independently of the
release selected by `version`.

Install and print the version:

```yaml
- uses: mgd34msu/goodvibes/products/tui@v3.4.4
  with:
    version: v3.4.4
```

Run a health check:

```yaml
- uses: mgd34msu/goodvibes/products/tui@v3.4.4
  with:
    version: v3.4.4
    command: doctor
    args: --json
```

Run a non-interactive prompt (needs a provider credential in the job env) and
use its answer in a later step:

```yaml
- uses: mgd34msu/goodvibes/products/tui@v3.4.4
  id: goodvibes
  with:
    version: v3.4.4
    prompt: "summarize the changes in this workspace"
    output: json
    timeout: 15m
    max-turns: 30
    working-directory: .
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
- run: jq -r .response "${{ steps.goodvibes.outputs.result-file }}"
```

A prompt run is bounded by default: it is cancelled after 30 minutes (exit
`124`, `stopReason` `timeout`) and stops after 50 model answers that still ask
for tools (exit `1`, `stopReason` `max_turns`). Set `timeout` or `max-turns` to
change a limit, or to an empty string to remove it. A non-zero exit fails the
step; add `continue-on-error: true` to read `exit-code` and `stop-reason` in a
later step instead.

## Inputs

| input | default | description |
| --- | --- | --- |
| `version` | `latest` | Published suite release tag (for example `v3.4.4`) or `latest`. |
| `prompt` | `""` | Non-interactive prompt for `goodvibes run`. Needs a provider credential. |
| `command` | `""` | A subcommand to run instead (e.g. `doctor`, `status`). Ignored when `prompt` is set. |
| `args` | `""` | Extra arguments appended after the command. |
| `output` | `text` | Output format for `run`: `text` \| `json` \| `stream-json`. |
| `timeout` | `30m` | Cancel a prompt run after this long (`run --timeout`): seconds, or an `ms`, `s`, `m` or `h` suffix. Exit `124`, `stopReason` `timeout`. Empty removes the limit. |
| `max-turns` | `50` | Stop a prompt run after this many model answers that still ask for tools (`run --max-turns`). Exit `1`, `stopReason` `max_turns`. Empty removes the limit. |
| `working-directory` | `.` | Workspace directory to run in. |
| `install-dir` | `$HOME/.goodvibes-bin` | Where to install the binaries (added to `PATH`). |
| `install-agent` | `0` | Also install the same release's compiled `goodvibes-agent` when `1`. |

## Outputs

| output | description |
| --- | --- |
| `version` | The `goodvibes --version` string of the installed binary. |
| `result-file` | Path of a file under `$RUNNER_TEMP` with everything the prompt or command printed to stdout: with `output: json` the result object, with `stream-json` one frame per line (the last is the result). Empty when nothing ran. |
| `exit-code` | The run's exit code (`0` completed, `1` failed or `max-turns` reached, `2` invalid input, `3` outcome unknown, `124` timeout, `130` cancelled; see [Exit codes](../../../docs/exit-codes.md)). Empty when nothing ran. |
| `stop-reason` | The result's `stopReason` (for example `completed`, `max_turns`, `timeout`) for a prompt run with `output: json` or `stream-json`. Empty for `text`. |

## Notes

- Prompt execution uses `goodvibes --non-interactive --output <format> run
  --timeout <timeout> --max-turns <max-turns> <prompt> <args>`. The result
  frame is described under [Headless `run`](cli-flags.md#headless-run).
  Configure the answering provider and any decision models required by your
  selected policy. The `prompt` input takes precedence over `command`.
- The action installs published binaries. It does not build or qualify the
  repository checked out by the calling workflow.
- Publishing this action to the GitHub Marketplace is the repository owner's
  step and is out of scope here.
