# GoodVibes

GoodVibes includes a terminal UI, personal agent, daemon and browser UI, sharing
one platform and one release version. It works with hosted and local decision
models, and everything keeps working with none configured.

## Who decides

Code settles what the program already knows: a read, a search, an edit inside
the workspace and a command an existing rule covers start at once, with no
model request and no question. You are asked only what is yours to decide
(granting access, loosening a security, judgment or payment setting, a call your own "always ask me" rule covers, a change asked for from a channel, a deletion nothing keeps a copy of, sending to a new recipient, sending content derived from untrusted text, and changing what a contract requires), and the answer can be remembered. Spending over your limits is put
to you by the payment windows. The rest are judgment calls for Jev, the decision
model, with a deadline and a fallback so nothing hangs.

`permissions.mode` chooses how much you are asked:

| Mode | Behavior |
| --- | --- |
| `ask-me` | Jev reads each judgment call's risk. Calls it reads as critical, irreversible or security-weakening ask you, with owner-only items; the rest run. |
| `jev-decides` (default) | Jev decides judgment calls; owner-only items ask you. With no working decision model it behaves as `ask-me`. |
| `just-vibes` | Nothing interrupts you: Jev decides what it can, and anything that needs you is held and listed at the end of the run (`/held`). |
| `yolo` | No approval prompts from the permission gate, except for a change asked for from a channel. Authentication, workspace containment, secret storage and spending limits still apply, and an act only you perform is refused to the model. |

`plan` is a separate read-only posture. `Shift+Tab` changes the mode of the
current session only; `--just-vibes` and `--yolo` pick one for a single launch.
`/decisions` lists what Jev decided for you, with undo, never, always and ask.

## Decision model setting

`judgment.policy` chooses whether a decision model is used and what happens
when it fails:

| Policy | Behavior |
| --- | --- |
| **Hybrid** (default) | Use the set decision model. When it fails, the operation continues without it and you are told once, naming the model, what failed and the next step. |
| **Decision Model Only** | Use the set decision model. When it fails, work that needs it stops and reports the model, what failed and the next step. |
| **No Decision Model** | Make no decision-model requests. |

With no decision model set, every policy runs without one: nothing waits and
nothing reports an error. The conversation, `goodvibes status`,
`goodvibes-agent status`, headless JSON results and the web UI always say when
no decision model is in use.

How much a person is in the loop, for each policy and permission mode. Code
settles reads, workspace edits and calls your rules or `permissions.tools.*`
settings allow before any of this, and in every mode but `yolo` the owner-only
items always come to you:

| Policy | `ask-me` | `jev-decides` | `just-vibes` | `yolo` |
| --- | --- | --- | --- | --- |
| Hybrid (default) | Jev reads each judgment call and you are asked only about the ones it reads as critical, irreversible or security-weakening; with no model set or while it fails, you are asked about every judgment call your tool settings do not allow. | Jev decides every judgment call; with no model set, while it fails, or (as the unchosen default) on a model the shipped calibration did not measure, you are asked as in `ask-me`. | You are never interrupted: what Jev would not run, or with no working model every judgment call your tool settings do not allow, is held and listed at the end of the run. | The permission gate asks you nothing except about a change asked for from a channel; purchases outside your limits still come to you, and an act only you perform (answering an approval, granting access) is refused to the model. No decision model is consulted for permission. |
| Decision Model Only | As Hybrid, except that while the set model fails, the call fails with the model's error instead of asking you. | As Hybrid, except that while the set model fails, the call fails with the model's error instead of asking you. | As Hybrid, except that while the set model fails, the call fails with the model's error instead of being held. | Same as Hybrid. |
| No Decision Model | You are asked about every judgment call your tool settings do not allow. | You are asked about every judgment call your tool settings do not allow, exactly as in `ask-me`. | You are never interrupted: every judgment call your tool settings do not allow is held and listed at the end of the run. | Same as Hybrid. |

The shipped calibration record covers the hosted endpoint and `jev-latest`.
While `jev-decides` is only the default, Jev decides only when the endpoint,
the model and every fallback target match that record; choosing the mode
yourself (in Settings, `/permissions`, with Shift+Tab, for a hosted session or
in a channel profile) lets Jev decide on any working decision model. Details, the decision deadline, fallback chains and
the features that need a decision model are in the
[decision model policy guide](docs/decision-model-policy.md). The
[payment contract](packages/engine/docs/payments.md) keeps its spending limits,
merchant rules and approval and veto windows in every mode; a tool decision
cannot authorize spending outside it.

## Install the application

Install the latest released version of all four products from this monorepo:

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh
```

The installer downloads and verifies prebuilt release binaries, their required
runtime companions, the browser driver and the WebUI. It does not clone source,
install build dependencies or compile anything. One release version is used for
the complete suite. To select a release explicitly:

```sh
curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_VERSION=v3.3.1 sh
```

Commands install in `~/.local/bin` by default; existing `~/.goodvibes` data is
preserved. The installer handles upgrade and restart, has the daemon write
its own service definition, sets up PATH and uninstalls. Use `GOODVIBES_INSTALL_DIR` for a custom command path,
`GOODVIBES_DAEMON_SERVICE=0` to skip service setup, or
`GOODVIBES_UNINSTALL=1` to remove installed programs while keeping user data.
See [installation instructions](docs/installation.md).

Developers who deliberately want to build their checkout can run
`./scripts/install-from-checkout.sh`. The public installer never selects that path.

## Use GoodVibes

```sh
goodvibes                 # Terminal UI
goodvibes-agent           # Personal agent
goodvibes-daemon status   # Daemon status
```

Choose providers, models, effort levels and decision-model policy in the
application settings. See the product guides below for pairing, remote access,
voice, tools and other capabilities.

## Documentation

- [Installation, updates, services and uninstall](docs/installation.md)
- [Terminal UI](products/tui/README.md) and [CLI flags](products/tui/docs/cli-flags.md)
- [Agent](products/agent/README.md) and [first-start readiness](products/agent/docs/setup-explicit-pairing.md#native-intake-setup-readiness)
- [Daemon](products/daemon/README.md) and [configuration](products/daemon/docs/configuration.md)
- [WebUI](products/webui/README.md) and [operator guide](products/webui/docs/operator-guide.md)
- [Engine documentation](packages/engine/docs/README.md) and [judgment foundation](packages/judgment/README.md)
- [Security policy](SECURITY.md)

## License

MIT.
