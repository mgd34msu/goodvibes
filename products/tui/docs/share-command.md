# Saving and uploading a session

"Save or export this conversation as a file", in This conversation (the menu, then "This
conversation"), writes the current session to a local file; "Upload this conversation and get a
link", `u` on this conversation in the Sessions place, also uploads it as a secret GitHub Gist and
prints the link. Both open a form; the model runs the same as `session.save-file` and
`session.upload`.

## The form

| Field | Choices |
|-------|---------|
| As | Markdown, Plain text (save only), A web page, JSON |
| File | save only: where to write it; blank is the default path below |
| Keys and paths | Hide them (the default), or keep them as stored |
| If the file exists | save only: keep it and stop (the default), or write over it |
| Then | Nothing more, Open it in the browser, Copy its path |

## Formats

| Format | Description |
|--------|-------------|
| `html` | Self-contained HTML with syntax highlighting, best for sharing |
| `json` | Structured JSON (machine-readable), includes token/cost summary |
| `markdown` (`md` for an upload) | Markdown, portable plain-text format |
| `text` | Plain text (save-file only; always redacted) |

Keeping keys and paths keeps API keys, tokens, and this account's home-directory path and login
name as stored; hidden is the default, in a local file and in an upload alike. Writing over a file
does not keep the old one. "Copy its path" uses OSC 52 (the terminal must support it); "Open it in
the browser" opens a web page with `xdg-open` / `open` / `start`.

The upload sends something outside this machine, so it is the owner's own act (a model cannot run it); pressed, it uploads at once and prints the link, and deleting the Gist on GitHub takes it down.

The result line says which happened: `(redacted before upload)` or `(uploaded unredacted, as stored)` when the upload returned a share link; otherwise `(sensitive data redacted)` or `(not redacted)` for the local file, after `(not uploaded)` or `(upload unconfirmed)` when an upload was asked for. "Copy its path" adds `(path copied to clipboard)`, or `(could not copy the path)` when the copy failed.

## Cost summary

Every export includes a token-usage summary derived from the live session. Cost is
computed with the same pricing formula Money, Spending uses (USD per 1M
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

Unless keys and paths are kept, the exporter applies server-side redaction patterns to every message
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
upload sessions containing secrets with keys and paths kept.

## Upload receipt and unconfirmed uploads

After every upload the command writes a small receipt file next to the export,
named `<export path>.gist-<id>.json` (readable only by you), and prints
`Upload receipt: <path>`. It records whether GitHub accepted the gist and, if so, its
URL. If the receipt cannot be written, a warning is added to the notifications feed
instead.

If GitHub's answer is lost or not OK, the command prints
`Upload unconfirmed: ... GitHub may have received it; check before retrying.` The
gist may exist even though no link was returned. Check your gists at
`gist.github.com` before uploading again, otherwise you can create a duplicate
secret gist with the same content. The local export is kept either way.

## Token resolution for an upload

The uploader looks for a GitHub PAT in this order:

1. Service registry `github` entry (seen and tested on the Services tab of Models and providers, written in `~/.goodvibes/tui/services.json`
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

| Form | Result |
|------|--------|
| Save, As: A web page | web page at the default path, keys and paths hidden |
| Save, As: A web page, File: /tmp/session.html | to an explicit path |
| Save, As: JSON, Keys and paths: kept | JSON as stored |
| Upload, As: A web page | redacted Gist link |
| Upload, As: A web page, Then: Open it in the browser | link, then open the local copy |
| Upload, As: Markdown, Keys and paths: kept | unredacted Markdown Gist |

## Related

- Tools and extensions (the menu): manage plugins, hooks, tool servers and the marketplace
- Models and providers, Services (the menu): your external services and their credentials (including the GitHub PAT for upload)
- [Deployment and services](deployment-and-services.md)
