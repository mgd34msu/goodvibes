# GoodVibes

GoodVibes includes a terminal UI, personal agent, daemon and browser UI, sharing
one platform and one release version. It supports hosted and local decision
models, with Classic operation available when decision models are disabled.

## Decision models and permissions

`judgment.policy` controls decision-model use independently of execution permissions:

| Policy | Behavior |
| --- | --- |
| **Default - On** | Use the configured hosted/local decision chain and halt on exhaustion. This remains the default for existing installations. |
| **Preferred** | Use that chain; continue the current operation in Classic only when available targets are exhausted. |
| **Classic - Off** | Use Classic from startup, with zero decision-model requests. Ordinary answering models remain available. |

Classic supports chat, native tools, editing, commands, test results, final answers
and conversation recovery. Tools retain deterministic permission rules and owner
approvals. `safe-jev` uses owner approval handling during Classic; explicit YOLO
retains its meaning. Classic results identify their provenance and do not claim
independent semantic verification. The Decision Router uses its configured General
target without categorization. Inherently semantic features report their limitation.

A genuine refusal, malformed response, privacy rejection, cancellation or stale
authority cannot select Preferred fallback. Completed actions and conversation
history survive fallback; actions are not replayed. See the [policy and capability guide](docs/decision-model-policy.md).

Execution uses one of three modes across local, hosted and channel sessions:

| Mode | Behavior |
| --- | --- |
| `safe-owner` | Ordinary work runs automatically. Dangerous actions wait for the owner's reply, bound to the exact action. |
| `safe-jev` | Jev stands in for the owner, permitting ordinary work and justified risk while refusing genuinely harmful actions. |
| `yolo` | General execution safety adds no denial, approval prompt or Jev safety call. |

`plan` is a separate read-only planning posture. Selecting an execution mode
replaces the legacy automatic-approval override. Background work uses its
session's current mode. A mode change invalidates pending execution authority.

When decision models are enabled, they handle interpretation, planning, repair and task verification. Their
decision receipts carry actual
recorded decisions; owner approval and YOLO do not fabricate Jev receipts.
Authentication, supported input formats, cancellation, exact invocation identity
and duplicate-execution protection remain execution mechanics in every mode.
Host containment and workspace scope, explicit blocked destinations, and
secret-storage requirements remain binding. The separate
[payment contract](packages/engine/docs/payments.md) retains its spending limits,
merchant rules, owner authorization and distinct approval/veto windows in every
mode. A general tool decision cannot authorize spending outside that contract.

The shared judgment port owns transient availability handling. Primary-only
routes use finite attempts; explicit cross-model failover chains
return typed `unavailable` on exhaustion. Products consume that lifecycle
without adding retry loops or inventing semantic answers.

Provisioning, account login and user cancellation remain legitimate product
interactions. This runtime contract does not change development-tool permissions
or authorize live external actions by a developer.

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
curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_VERSION=v3.1.0 sh
```

Commands install in `~/.local/bin` by default; existing `~/.goodvibes` data is
preserved. The installer retains upgrade/restart handling, service migration,
PATH setup and uninstall. Use `GOODVIBES_INSTALL_DIR` for a custom command path,
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
