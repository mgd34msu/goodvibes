# /share: session export

Export the current session to a local file and optionally share it.

## Syntax

```
/share <html|json|md> [path] [--redact] [--upload] [--no-redact] [--copy] [--open]
```

## Formats

| Format | Description |
|--------|-------------|
| `html` | Self-contained HTML with syntax highlighting, best for sharing |
| `json` | Structured JSON (machine-readable), includes token/cost summary |
| `md`   | Markdown, portable plain-text format |

## Options

| Flag       | Description |
|------------|-------------|
| `--redact` | Redact API keys, tokens, and this account's home-directory path and login name from the output |
| `--upload` | Upload the export as a secret GitHub Gist and print the share link. An upload is always redacted, whether or not `--redact` is given |
| `--no-redact` | With `--upload` only: upload the transcript as stored. You are asked first, with a list of what it exposes (a secret gist is readable by anyone with the link); `--yes` answers in advance |
| `--copy`   | Copy the output file path to the clipboard (OSC 52; terminal must support it) |
| `--open`   | Open an HTML export in the default browser (`xdg-open` / `open` / `start`) |

Flags can be combined:

```
/share html --upload --copy
```

The result line says which happened: `(redacted before upload)`, `(uploaded unredacted, as stored)`, `(sensitive data redacted)` or `(not redacted)` for a local file.

## Cost summary

Every export includes a token-usage summary derived from the live session. Cost is
computed with the same pricing formula the Usage modal uses (USD per 1M
tokens), applied to the session's accumulated input, output, and cache token counts.

When the active model has no pricing data, cost is left out entirely rather than
shown as $0. The `/share` command prints an inline note (`Note: cost omitted from
export; no pricing data for model "<model>".`) and the export itself carries no cost
field: `metadata.costUsd` is absent from JSON, no cost row appears in the HTML usage
table, and no `## Cost` section is appended to Markdown.

When the model is priced, `metadata.costUsd` is always present in JSON exports. The
HTML cost row and the Markdown `## Cost` section only appear when the computed cost
is greater than $0.

## Redaction guarantees

With `--redact` the exporter applies server-side redaction patterns to every message
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
upload sessions containing secrets without first using `--redact`.

## Option checking

Any word that starts with `--` and is not one of the four options is refused before
anything is written or uploaded (a mistyped `--reddact` would otherwise become the
output file name and upload an unredacted export). To use a path that starts with `--`,
write it as `./--name`. More than one path is also refused.

## Upload receipt and unconfirmed uploads

After every upload the command writes a small receipt file next to the export,
named `<export path>.gist-<id>.json` (readable only by you), and prints
`Upload receipt: <path>`. It records whether GitHub accepted the gist and, if so, its
URL. If the receipt cannot be written, a warning is added to the notifications feed
instead.

If GitHub's answer is lost or not OK, the command prints
`Upload unconfirmed: ... GitHub may have received it; check before retrying.` The
gist may exist even though no link was returned. Check your gists at
`gist.github.com` before running `/share` again, otherwise you can create a duplicate
secret gist with the same content. The local export is kept either way.

## Token resolution for --upload

The uploader looks for a GitHub PAT in this order:

1. Service registry `github` entry (configured via `/services` or `.goodvibes/tui/services.json`
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
/share html                          # export to default path
/share html /tmp/session.html        # export to explicit path
/share json --redact                 # JSON with sensitive data removed
/share html --upload                 # export + redacted Gist link
/share html --upload --copy --open   # export + link + clipboard + open browser
/share md --upload --no-redact       # unredacted Markdown Gist (asks first)
```

## Related

- `/plugin`: manage plugins
- `/services`: configure external service credentials (including GitHub PAT for upload)
- [Deployment and services](deployment-and-services.md)
