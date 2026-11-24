# Cloudflare batch and control plane

GoodVibes can optionally use Cloudflare Workers and Queues for batch-capable daemon work. This is opt-in. By default the TUI keeps immediate local daemon behavior:

| Key | Default | Meaning |
| --- | --- | --- |
| `batch.mode` | `off` | No work uses the batch path (the three modes are explained under Batch modes below) |
| `batch.queueBackend` | `local` | Queued work stays on the local backend |
| `cloudflare.enabled` | `false` | The Cloudflare integration is off entirely |

The TUI owns the user flow. The platform daemon owns all Cloudflare API calls, token creation, validation, discovery, provisioning, verification, repair paths, and secret persistence. The TUI never calls Cloudflare APIs directly.

## Setup

`/setup cloudflare` (Use Cloudflare) opens the Cloudflare form; `/cloudflare setup` opens the same guided setup. The form configures:

| Field | Choices / notes |
| --- | --- |
| Cloudflare enabled/disabled | The master switch |
| Batch mode | `off`, `explicit`, or `eligible-by-default` (explained under Batch modes below) |
| Components | Workers and Queues are the normal defaults; Tunnel, Access, DNS, KV, Durable Objects, Secrets Store, and R2 are advanced optional components (see What provisioning sets up) |
| Resource names/refs | Account, zone/domain, worker, queue, tunnel, Access, KV, DO, R2, and Secrets Store identifiers |
| Token setup path | One of the five paths in the next section |
| Provision on apply | Whether saving the form provisions resources immediately |

## Token setup

The setup form supports these paths:

- Save settings only: persist configuration and provision later.
- Paste temporary bootstrap token: the platform creates a narrower operational token, stores it in GoodVibes secrets, and does not persist the bootstrap token. The daemon keeps a record of the operational token it made (its id, never its value) and returns that token again for the same account, zone and components, across retries, the final apply and restarts; a new token, for a changed selection, revokes the one it replaces, and the result says whether that worked. Disable revokes it too when a bootstrap token is given (set in the wizard, or `/cloudflare disable --bootstrap-token <token>` / `--bootstrap-env <ENV_NAME>`); otherwise it says the token is still live. A token Cloudflare no longer has counts as revoked, and its record is cleared.
- Read bootstrap token from environment: same as pasted bootstrap token, but the TUI reads the value from an environment variable in the current process.
- Paste final operational token: the TUI stores it as `goodvibes://secrets/goodvibes/CLOUDFLARE_API_TOKEN`.
- Use final token from environment: the TUI writes a `goodvibes://secrets/env/<ENV_NAME>` reference, usually `CLOUDFLARE_API_TOKEN`.

Bootstrap tokens should be temporary and should be revoked or allowed to expire after GoodVibes creates and validates the operational token.

## Slash command

Use `/cloudflare` for runtime inspection and daemon actions:

```text
/cloudflare status
/cloudflare setup
/cloudflare requirements [--all|--component queues]
/cloudflare create-token --account <account-id> --bootstrap-env <ENV_NAME> [--new]
/cloudflare discover --token-env CLOUDFLARE_API_TOKEN
/cloudflare validate --token-env CLOUDFLARE_API_TOKEN
/cloudflare provision --account <account-id> --batch-mode explicit --tunnel-token-ref goodvibes://secrets/goodvibes/GOODVIBES_CLOUDFLARE_TUNNEL_TOKEN
/cloudflare verify [--worker-url <url>] [--worker-token <token> | --worker-token-ref <ref>]
/cloudflare disable [--keep-cron] [--keep-worker-subdomain] [--bootstrap-token <token> | --bootstrap-env <ENV_NAME>]
```

Bare `/cloudflare` opens its list of actions (from a model or script it runs `status`). `/cloudflare setup` opens the guided Cloudflare setup, the same form as `/setup cloudflare`. All other actions call platform-owned daemon routes under local daemon admin/auth. The Agent has the same `/cloudflare` command over its connected host (without the guided setup); the model may run its reads, while `create-token`, `provision` and `disable` count only when the owner types them.

`create-token` returns the token the daemon already made for the same account, zone and components while Cloudflare reports it active and unexpired (one check at Cloudflare); a token deleted in the dashboard, disabled or expired is replaced by a new one. `--new` always makes a new token and revokes the one it replaces.

Each action accepts only its own flags, and a line is refused before anything is sent when it has an unknown or misspelt flag (`--keepcron`), a flag that needs a value and has none (`--token-env` with no name), a word that names no component (`provision tunel`), a `--batch-mode` other than `off`, `explicit` or `eligible-by-default`, or a `--token-env`/`--bootstrap-env` naming a variable that is not set in the app's environment (the stored token would otherwise be used). The refusal names the accepted values.

`/cloudflare disable` turns the integration off and saves that in config. Typed, it runs at once; with a bootstrap token it revokes the operational token this daemon made, which cannot be undone; then `/cloudflare create-token` is needed before `/cloudflare provision` sets it up again, and the last line of its output says which applies. Without a bootstrap token, `/cloudflare provision` sets it up again (the resources provision deploys can be billed; `/cloudflare disable` turns them off). It removes the daemon credential from the Worker (so the Worker can no longer call the daemon), turns off the Worker cron (add `--keep-cron` to leave it running) and the Worker's workers.dev route (add `--keep-worker-subdomain` to keep it; `POST /api/cloudflare/disable` turns the route off unless `disableWorkerSubdomain` is `false`), stops the tunnel connector, and returns the batch queue backend to `local`. It deletes no deployed resource at Cloudflare: every resource still deployed (Worker script, queues, tunnel, Access application, DNS records, KV, R2, Secrets Store) is listed as a `still-deployed` step, to delete in the Cloudflare dashboard if it is no longer wanted. Provisioning again restores the credential.

`/cloudflare provision` also accepts `--no-verify` (skip the check after provisioning), `--no-store-token` (do not store the API token), `--no-workers-dev` (do not enable the workers.dev route), `--worker-cron`, `--daemon-url`, `--worker-url`, `--dlq`, and `--operator-token` and `--worker-client-token`. Every token typed on the line (`--token`, `--bootstrap-token`, `--operator-token`, `--worker-client-token`, `--worker-token`) is hidden as it is typed and kept out of the input history and the shown line.

`/cloudflare provision` accepts the same major platform daemon fields the setup form exposes, including `--tunnel-name`, `--tunnel-id`, `--tunnel-service-url`, `--tunnel-token-ref`, `--access-app-id`, `--access-service-token-id`, `--access-service-token-ref`, `--kv-namespace-name`, `--kv-namespace-id`, `--do-namespace-name`, `--r2-bucket-name`, `--secrets-store-name`, `--secrets-store-id`, `--operator-token-ref`, and `--worker-client-token-ref`.

## Daemon routes

The TUI integrates with these daemon routes, each backing the matching `/cloudflare` subcommand:

| Route | Does |
| --- | --- |
| `GET /api/cloudflare` | The integration descriptor |
| `GET /api/cloudflare/status` | Enabled/ready posture and configured resources |
| `POST /api/cloudflare/token/requirements` | List required API-token permissions |
| `POST /api/cloudflare/token/create` | Create the scoped operational token from a bootstrap token |
| `POST /api/cloudflare/discover` | Discover existing account resources |
| `POST /api/cloudflare/validate` | Validate the token and configuration |
| `POST /api/cloudflare/provision` | Provision the configured resources |
| `POST /api/cloudflare/verify` | Verify the provisioned resources |
| `POST /api/cloudflare/disable` | Turn the integration off |

Errors return JSON with `error`; failures raised by the Cloudflare integration also carry a `code`. Sign-in and request-body failures (401, 403, 400) carry only `error`. The TUI displays route failures as actionable setup-form or command output and does not block normal local daemon usage unless the user explicitly depends on Cloudflare provisioning.

## What provisioning sets up

`/cloudflare provision` reports `ok: true` only when what was asked for works: the Worker check (`/batch/health` and the Worker's proxy to the daemon) passed, or was turned off with `--no-verify`, and Access, when selected, protects the daemon hostname. Only then does it turn `cloudflare.enabled` on and move `batch.queueBackend` to `cloudflare`; otherwise the result is `ok: false`, the integration stays off, and the `switch-on` step says why.

`/cloudflare status` lists a resource component (Worker, queues, Tunnel, Access, KV, Durable Objects, R2, Secrets Store) as configured only after a provision created or confirmed it. The record of what provisioning created is kept in the daemon's control-plane directory as `cloudflare-resources.json`.

| Component | What it does in the batch path |
| --- | --- |
| Workers | The Worker proxies `/batch/*` to the daemon, queues tick and job signals, and runs the cron tick. |
| Queues | Carries tick and job signals to the Worker's queue consumer, with a dead-letter queue. |
| Zero Trust Tunnel | The daemon runs `cloudflared tunnel run` for the provisioned tunnel while `cloudflare.enabled` is on (from start, and whenever that or the tunnel settings change), restarts it when it exits, and stops it when the daemon stops; a provisioned tunnel reads `ready` only while its connector is connected; status shows the connector as `not-installed`, `starting`, `connected`, `failed` or `stopped`. Install `cloudflared` first. The token is stored as `goodvibes://secrets/goodvibes/GOODVIBES_CLOUDFLARE_TUNNEL_TOKEN` (or read from `--tunnel-token-ref`) and given to `cloudflared` in its environment. With a tunnel, the Worker reaches the daemon at `https://<daemonHostname>`. |
| Zero Trust Access | Creates the Access application before the daemon hostname is published; the Worker presents the Access service token (`CF-Access-Client-Id`, `CF-Access-Client-Secret`), and so do both terminal apps on every request to the daemon hostname, using the token stored as `goodvibes://secrets/goodvibes/GOODVIBES_CLOUDFLARE_ACCESS_SERVICE_TOKEN` (or `cloudflare.accessServiceTokenRef`); a machine other than the daemon's needs that secret stored too. If Access was selected and could not be applied, the daemon hostname is not published. |
| DNS | Publishes the daemon and Worker hostnames in the selected zone. |
| KV | Records each queued job's delivery state; `GET /batch/queue/jobs/<jobId>` on the Worker returns it, including the daemon's job id once delivered. A redelivered message that was already delivered is acknowledged without a second daemon call. |
| Durable Objects | The Worker's coordinator counts queue operations and messages per UTC day. It is added automatically when a queue budget is set, unless Durable Objects are turned off explicitly. |
| R2 | Holds queued job bodies so queue messages carry only their key; the body is deleted once the daemon has the job. |
| Secrets Store | Holds the Worker's daemon credential and Access secret; the Worker reads them from the store instead of from script secrets. |

### Free tier and the daily queue budget

`cloudflare.freeTierMode` (default on) keeps job bodies out of Cloudflare Queues: `POST /batch/jobs/enqueue` puts the body in R2 and queues only its key, and without R2 it is refused (`409 QUEUE_PAYLOADS_NEED_R2`). With free-tier mode off, a body up to `batch.maxQueuePayloadBytes` travels in the queue message and a larger one goes to R2 (or is refused with `413` without R2).

`cloudflare.maxQueueOpsPerDay` and `batch.maxQueueMessagesPerDay` are enforced by the Worker before it sends anything to the queue. Past either limit the Worker answers `429 QUEUE_BUDGET_EXHAUSTED` with the use so far, when the budget resets (midnight UTC), and what to do instead (post `/batch/jobs` to reach the daemon directly). When a limit is set and the coordinator Durable Object that counts the budget cannot be reached, the Worker refuses the enqueue with `503 BUDGET_COORDINATOR_UNAVAILABLE` and queues nothing, so spend is never uncounted; post `/batch/jobs` or `/batch/tick` to reach the daemon directly, or send the request again. `GET /batch/queue/budget` returns today's use (or the same `503` when the coordinator cannot be read). `0` means no limit. Changing these settings takes effect at the next provision.

## Batch modes

`off` keeps all work on the immediate local path.

`explicit` uses Cloudflare only for requests explicitly marked for batch execution.

`eligible-by-default` also queues every non-streaming chat completion sent to the daemon's OpenAI-compatible route whose provider has a Batch API, unless the request sends `x-goodvibes-execution: live` (one whose provider cannot batch runs live as usual, and `batch.fallback` applies only to a request that asked for a batch); `explicit` queues one only when it sends `x-goodvibes-execution: batch`. Terminal, companion and web chat stays live in every mode.

For most users, keep `off` or `explicit`.

## Secrets

Raw Cloudflare tokens are transient form or command input only. Persistent references use GoodVibes secret URIs:

```text
goodvibes://secrets/goodvibes/CLOUDFLARE_API_TOKEN
goodvibes://secrets/env/CLOUDFLARE_API_TOKEN
goodvibes://secrets/goodvibes/GOODVIBES_CLOUDFLARE_TUNNEL_TOKEN
goodvibes://secrets/goodvibes/GOODVIBES_CLOUDFLARE_ACCESS_SERVICE_TOKEN
```

The platform may also store generated Worker client, Tunnel, Access service, and daemon/operator token material as GoodVibes secret references when provisioning needs them.
