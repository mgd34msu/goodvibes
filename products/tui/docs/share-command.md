# Saving and uploading a session

`/session save-file` writes the current session to a local file; `/session upload`
also uploads it as a secret GitHub Gist and prints the link.

## Syntax

```
/session save-file [markdown|text|html|json] [path] [--keep-secrets] [--replace] [--then open|copy]
/session upload [html|md|json] [--keep-secrets] [--then open|copy]
```

## Formats

| Format | Description |
|--------|-------------|
| `html` | Self-contained HTML with syntax highlighting, best for sharing |
| `json` | Structured JSON (machine-readable), includes token/cost summary |
| `markdown` (`md` for an upload) | Markdown, portable plain-text format |
| `text` | Plain text (save-file only; always redacted) |

## Options

| Option | Description |
|------------|-------------|
| `--keep-secrets` | Keep API keys, tokens, and this account's home-directory path and login name as stored. Without it they are hidden, in a local file and in an upload alike |
| `--replace` | save-file only: write over a file already at the path (asks first); without it an existing file is kept and nothing is written |
| `--then copy` | Copy the output file path to the clipboard (OSC 52; terminal must support it) |
| `--then open` | Open an HTML export in the default browser (`xdg-open` / `open` / `start`) |

`upload` sends something outside this machine, so it always asks first, and it only counts when you type it (a model cannot run it).

The result line says which happened: `(redacted before upload)` or `(uploaded unredacted, as stored)` when the upload returned a share link; otherwise `(sensitive data redacted)` or `(not redacted)` for the local file, after `(not uploaded)` or `(upload unconfirmed)` when an upload was asked for. `--then copy` adds `(path copied to clipboard)`, or `(could not copy the path)` when the copy failed.

## Cost summary

Every export includes a token-usage summary derived from the live session. Cost is
computed with the same pricing formula the Usage modal uses (USD per 1M
tokens), applied to the session's accumulated input, output, and cache token counts.

When the active model has no pricing data, cost is left out entirely rather than
shown as $0. The export prints an inline note (`Note: cost omitted from
export; no pricing data for model "<model>".`) and the export itself carries no cost
field: `metadata.costUsd` is absent from JSON, no cost row appears in the HTML usage
table, and no `## Cost` section is appended to Markdown.

When the model is priced, `metadata.costUsd` is always present in JSON exports. The
HTML cost row and the Markdown `## Cost` section only appear when the computed cost
is greater than $0.

## Redaction guarantees

Unless `--keep-secrets` is given, the exporter applies server-side redaction patterns to every message
before serialising. Each pattern class is replaced with its own typed placeholder, so
a redacted export still shows what kind of value was removed:

| Matches | Replaced with |
| --- | --- |
| `sk-` and `key-` prefixed API keys | `[REDACTED_API_KEY]` |
| `Bearer` tokens in Authorization headers | `[REDACTED_TOKEN]` (the `Bearer` prefix is kept) |
| `ghp_`, `gho_`, and `github_pat_` GitHub tokens | `[REDACTED_GITHUB_TOKEN]` |
| `glpat-` GitLab tokens | `[REDACTED_GITLAB_TOKEN]` |
| `xoxb-` and `xoxp-` Slack tokens | `[REDACTED_SLACK_TOKEN]` |
| `AKIA*` AWS access key ids | `[REDACTED_AWS_KEY]` |
| The running account's own home directory (for example `/home/<you>`) | The same path with the last segment as `[REDACTED]` |
| The running account's login name, anywhere in text | `[REDACTED]` |

Only the account that is running the session is matched. A path or user name from
someone else (a pasted colleague log, a transcript from another machine, another
user's `/home/<name>/...` or `C:\Users\<name>\...`) is not recognised and stays in
the export, so read a redacted export before you upload it. Home-path and login-name
redaction applies only when the account identity is registered, which the
interactive session does on start.

Tool-call arguments and reasoning content are also redacted. The original
conversation is never modified.

## Upload privacy

Gist upload creates a **secret** (unlisted) Gist. It is not indexed by GitHub search
and is not shown on your profile. However, **anyone with the URL can view it**. Do not
upload sessions containing secrets with `--keep-secrets`.

## Option checking

An option the command does not know is refused before anything is written or uploaded, and so is more than one path.

## Upload receipt and unconfirmed uploads

After every upload the command writes a small receipt file next to the export,
named `<export path>.gist-<id>.json` (readable only by you), and prints
`Upload receipt: <path>`. It records whether GitHub accepted the gist and, if so, its
URL. If the receipt cannot be written, a warning is added to the notifications feed
instead.

If GitHub's answer is lost or not OK, the command prints
`Upload unconfirmed: ... GitHub may have received it; check before retrying.` The
gist may exist even though no link was returned. Check your gists at
`gist.github.com` before running `/session upload` again, otherwise you can create a duplicate
secret gist with the same content. The local export is kept either way.

## Token resolution for an upload

The uploader looks for a GitHub PAT in this order:

1. Service registry `github` entry (configured via `/services` or `~/.goodvibes/tui/services.json`
   with `tokenKey: GITHUB_TOKEN` and `authType: bearer`).
2. `GITHUB_TOKEN` environment variable.

If neither is available the upload is skipped and guidance is printed. The token requires
`gist` scope only.

## Default path

When no path is given, exports go to:

```
~/goodvibes-exports/session-<YYYY-MM-DDTHH-MM-SS-mmm>.<ext>
```

The directory is created automatically.

## Examples

```
/session save-file html                          # web page at the default path, keys and paths hidden
/session save-file html /tmp/session.html        # to an explicit path
/session save-file json --keep-secrets           # JSON as stored
/session upload html                             # redacted Gist link (asks first)
/session upload html --then open                 # link, then open the local copy
/session upload md --keep-secrets                # unredacted Markdown Gist (asks first)
```

## Related

- `/plugin`: manage plugins
- `/services`: configure external service credentials (including GitHub PAT for upload)
- [Deployment and services](deployment-and-services.md)
