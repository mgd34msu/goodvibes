# GitHub Action: run-goodvibes

A composite action (`products/tui/action.yml`) that installs a pinned,
checksum-verified GoodVibes release and runs a non-interactive command or prompt
against a workspace in CI. It runs the published suite installer, fetched from
`https://goodvibes.sh/install.sh`, the same script used for interactive installs.
The installer resolves one release from `mgd34msu/goodvibes` and verifies its
compiled TUI, daemon, optional Agent and WebUI against that release's
`SHA256SUMS.txt`. A missing asset or checksum stops installation. The action
disables daemon service registration for the CI account.

## Usage

Select an available published suite tag for both the action reference and the
`version` input. The examples below use the 3.1.2 suite version; check the
[published releases](https://github.com/mgd34msu/goodvibes/releases) for available
downloads. A full commit SHA can pin the action code independently of the
release selected by `version`.

Install and print the version:

```yaml
- uses: mgd34msu/goodvibes/products/tui@v3.1.2
  with:
    version: v3.1.2
```

Run a health check:

```yaml
- uses: mgd34msu/goodvibes/products/tui@v3.1.2
  with:
    version: v3.1.2
    command: doctor
    args: --json
```

Run a non-interactive prompt (needs a provider credential in the job env):

```yaml
- uses: mgd34msu/goodvibes/products/tui@v3.1.2
  with:
    version: v3.1.2
    prompt: "summarize the changes in this workspace"
    output: json
    working-directory: .
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

## Inputs

| input | default | description |
| --- | --- | --- |
| `version` | `latest` | Published suite release tag (for example `v3.1.2`) or `latest`. |
| `prompt` | `""` | Non-interactive prompt for `goodvibes run`. Needs a provider credential. |
| `command` | `""` | A subcommand to run instead (e.g. `doctor`, `status`). Ignored when `prompt` is set. |
| `args` | `""` | Extra arguments appended after the command. |
| `output` | `text` | Output format for `run`: `text` \| `json` \| `stream-json`. |
| `working-directory` | `.` | Workspace directory to run in. |
| `install-dir` | `$HOME/.goodvibes-bin` | Where to install the binaries (added to `PATH`). |
| `install-agent` | `0` | Also install the same release's compiled `goodvibes-agent` when `1`. |

## Outputs

| output | description |
| --- | --- |
| `version` | The `goodvibes --version` string of the installed binary. |

## Notes

- Prompt execution uses `goodvibes --non-interactive --output <format> run`.
  Configure the answering provider and any decision models required by your
  selected policy. The `prompt` input takes precedence over `command`.
- The action installs published binaries. It does not build or qualify the
  repository checked out by the calling workflow.
- Publishing this action to the GitHub Marketplace is the repository owner's
  step and is out of scope here.
