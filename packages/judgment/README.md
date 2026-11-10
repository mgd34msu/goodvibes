# @goodvibes-jev/judgment

The level 0 Jev foundation for GoodVibes. Every decision the engine and the products hand to Jev goes through this package: the judgment port that talks to the TypeSafe System One models, the typed readings those models return, named batteries of questions with fixtures and accuracy floors, reusable patterns and compound patterns, the decision log, and live calibration.

## Install

```sh
npm install @goodvibes-jev/judgment
```

`@goodvibes-jev/engine` depends on this package and installs it with the engine.

## Entry points

- `@goodvibes-jev/judgment`: the full foundation. It loads under Node and Bun; the SQLite decision log (`SqliteDecisionLog`) opens its database with `bun:sqlite`, so logging to SQLite runs under Bun.
- `@goodvibes-jev/judgment/decisions`: the runtime-neutral part (batteries, readings, bands, port types and the autonomous `JevDecision` schema/validation) with no transport, decision log, Node or Bun module. Code that runs in browsers and Workers imports this subpath.
- `@goodvibes-jev/judgment/testing`: a fake port and answer builders for tests that must not call a model.

## Decision receipts and compatibility

The autonomous Jev decision contract
is the target for every semantic decision. Consumers use `act`, `revise`, `defer`
or `reject`, with no human runtime approval or escalation. Schema and binding
validation are implemented; they are not a semantic evaluator, authorization
service or atomic execution ledger. Historical band/log outcomes `confirm` and
`escalate` remain readable and must never be converted into `act`.

All configured decision chains use finite attempts and halt on exhaustion.
Targets may use different supported models or protocols. A valid semantic answer
ends the chain; cancellation, host authority and decision-log failures remain
terminal. Products consume that shared lifecycle without local recovery loops.
These interfaces do not establish live-provider behavior or model accuracy.

## A port and a battery

Answer validation checks probabilities before a result becomes a reading or a
successful log record. Choice requires unit probability mass and a maximum-
probability offered option; Score requires unit mass and a headline equal to the
probability-weighted rubric level within the API’s hundredth rounding intervals.
Fractional scores are valid. Standalone
yes/no, Choice and Score readers apply validation to injected answers as well.
Confidence remains separate from the selected option or score.

```ts
import { createSystemOnePort, judgmentConfigFromEnv } from '@goodvibes-jev/judgment';
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment/decisions';

const owner = new AbortController(); // Abort when this operation or service stops.
const port = createSystemOnePort(judgmentConfigFromEnv(process.env, { signal: owner.signal }));

const battery = defineBattery({
  name: 'example.reply',
  version: 1,
  description: 'Whether a reply answers the question it was asked.',
  accuracyFloor: 0.9,
  items: {
    answers: yesNo('Does this reply answer the question it was asked?', STAKES_BANDS.low.yesNo),
  },
  fixtures: [],
});

const run = await battery.run(port, 'Question: ...\nReply: ...', { site: 'example.reply' });
```

Each check is read for what it actually decides: a check whose answer is its own definition (arithmetic, dates, counting, id equality, a grammar a program produced, a value the owner configured) stays code, and a check that answers a question of meaning is asked of the model, whatever its category, security checks included. Every battery keeps its questions and thresholds in one place, and `bun run calibrate --registry <module>` runs its fixtures live against the configured model (by default `jev-latest`) and fails when a battery falls below its floor.

The decision log keeps every call with what the decision concluded (a `readings` note), what code did with it (an `action` note) and, once known, what was right (a `truth` note). Calibration records each fixture's expectations as truth on that fixture's call; an owner correction or an observed outcome is attached the same way. The engine's observe subsystem reads accuracy against confidence, threshold sweeps, drift and historical questions stuck in `confirm` or `escalate` from the log alone. Those log values do not prescribe human approval in the autonomous contract.

SQLite schema 4 appends notes in recording order. `readingsOf`, `actionOf` and
`truthOf` return the latest note of their kind; `entry.notes` retains the whole
sequence. Outcome queries match historical readings too. Existing schema 2/3
files migrate on open, preserving their last retained notes. Earlier overwritten
history and its original cross-kind ordering cannot be recovered. Older builds
refuse schema 4 files; retain a backup before upgrading if rollback is needed.

Decision IDs are opaque exact keys, not timestamps or a UUID-format contract.
New SQLite IDs preserve every UUIDv7 hex nibble through a one-to-one a–p
encoding, preventing generated decimal runs from resembling payment-card
material. Existing keys stay untouched and remain readable and attachable;
there is no schema change or privacy-screening exemption. Sort by the entry's
`at` field; equal timestamps have a deterministic ID tie-break, not a promised
cross-format chronology.

Calibration attributes truth only to newly observed, answered calibration rows
whose IDs were returned through that fixture execution's port and whose battery
name, version and fixture match the decision being checked. Final checks on a
composed result are not recorded as truth about a helper's different question;
the report retains those checks and reports zero truth rows when no matching
own call exists. It compares the same newest 100,000-ID window before and after.
SQLite's optional `queryIds` projection reads no unrelated question, answer or
note payloads; older/custom logs retain their full-query fallback. Only returned
IDs present in the current window and absent before are fetched. Custom logs
must retain append-only immutable entries and stable query ordering. Calls
outside the window or without a returned recorded ID receive no fixture truth;
concurrent calls and previously returned IDs are not a fallback source.

## License

MIT

## Decision backends and finite failover

The built-in profiles cover Jev, Clef, Clef-flash, DiffusionGemma Jev, Kev-9B
and Laya. Profiles describe protocols, not model accuracy. Other System One
models may be configured with their exact served names.

System One servers use `POST /v1/systemone`. Cloudflare Workers AI uses the
full account-specific `/ai/run/@cf/cloudflare/clef` or `clef-flash` URL and its
REST success envelope. These Cloudflare URLs select their adapter automatically.
Local Clef, Kev and DiffusionGemma deployments use the System One adapter.
Generic chat/completions endpoints are insufficient.

Laya has a separate adapter. Its native confidence is normalized entropy;
battery bands consume its explicit `x_jev_confidence`. Disable `LAYA_JEV_STRICT`
to retain confidence and truncation metadata. Declare `laya-rl-agent` as a
response alias while requesting the intended checkpoint, such as `english`.
The actual returned ID and each target's requested ID remain distinct in logs.
No adapter fabricates probabilities or confidence.

Every reading requires a request or port `AbortSignal`; either owner can cancel
when both are supplied. Each target gets one finite attempt (default 30 seconds;
legacy zero also selects that default). A Jev token-limit refusal can retry the
same complete input once in long-context mode. Host authority is rechecked before
every transmission. Redirects are refused.

The primary receives the request's model; each fallback receives its own model.
Connection errors, target authentication/billing/model errors, unsupported input
capabilities, malformed responses and timeouts can advance to the next configured
target. A valid semantic answer, including rejection, uncertainty or deferral,
ends the chain. Cancellation and host authorization refusals never advance it.
All configured chains, including single-target chains, run once. Exhaustion halts
the operation and directs the user to check API keys, endpoints, model names and
local services. Products must not invent answers or restart an endless loop.
A single target's terminal protocol/context error retains its precise kind so
callers can partition complete evidence when supported.

`Retry-After` cools the failed target for at most five minutes without delaying
independent backups. Health snapshots expose the remaining cooldown.
Progress reports a zero delay before the next target. Credential-free lineage
records each attempt's model, endpoint index/kind, outcome and safe request ID;
the logical result retains the original requested model and actual returned model.

Optional backend settings declare `adapter`, `maxInputBytes`, `maxQuestions` and
explicit `responseModels` aliases. Limits apply to complete serialized input.
Cloudflare can silently truncate state, so local admission uses a conservative
bytes-based budget with template headroom. Over-budget input is refused before
transmission. Reported truncation from any backend invalidates the answer.
Partition evidence or configure a larger target; never silently shorten it.
Set deployment limits to the actual server configuration.

Engine settings expose `judgment.backend` for the primary and an optional
`backend` object per `judgment.fallbacks` entry. Credentials remain references:
`keySource: "env" | "secret"` and `keyName`, or explicit `keySource: "none"` with
an empty `keyName` for an unauthenticated endpoint. Missing credentials disable
that target without substituting another target's key. Destinations, capabilities
and credential sources are captured before secret lookups yield. Credential
lookup deadlines are finite; an owning cancellation can stop them sooner.

```ts
const port = createSystemOnePort({
  signal: owner.signal,
  endpoint: { kind: 'hosted', baseURL: 'https://api.typesafe.ai', apiKey: jevKey },
  model: 'jev-latest', timeoutMs: 30_000, retry: {},
  fallbacks: [{
    endpoint: {
      kind: 'local', baseURL: 'http://127.0.0.1:8000', apiKey: '',
      authentication: 'none', adapter: 'laya',
      responseModels: ['laya-rl-agent'],
    },
    model: 'english',
  }],
});
```

Protocol references: [Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef/),
[local Clef](https://huggingface.co/Cloudflare/clef), [Kev](https://github.com/jaredpalmer/kev),
[DiffusionGemma Jev](https://github.com/mmastrac/djev), [Laya](https://github.com/NandhaKishorM/laya).

### Recorded-port failure and answer boundary

`withDecisionLog` also validates borrowed ports before recording or returning an
answer. Answers must match the requested question schemas; only documented
answer and metadata fields are retained. `requestedModel` must match the actual
request override or captured port default, while `model` remains the responding
provider's separately validated model identifier. Invalid answers fail with
`JudgmentError.kind === 'invalid-response'` rather than becoming usable readings.

Choice probabilities must admit a unit-mass distribution within their wire
rounding intervals, and the selected option must have the highest probability; ties are
valid. The same validation applies to standalone `readChoice`. This follows the
[TypeSafe Choice response contract](https://docs.typesafe.ai/primitives/choice).
[Confidence is a separate statistic](https://docs.typesafe.ai/confidence), so it
is preserved rather than equated with the selected probability or recomputed.
Malformed distributions are refused, never silently renormalized.

Recorded calls expose a fixed, value-free message for each `JudgmentError.kind`.
Upstream exception text, stack, cause and extra properties are not preserved in
the returned error or decision entry. Diagnose failures through the typed kind,
validated HTTP status/request ID/attempt lineage when available, and the log's
decision/site context; do not match provider error text. Inspect configuration
through the owning setup/settings surface when a provider is unconfigured.
Managed transport cancellation remains `aborted`; the recording wrapper keeps
`unavailable` attribution only for an explicitly timeout-typed owner signal.
Real transport targets have finite attempt deadlines. A decision-log write failure remains
`unrecorded`. Borrowed/injected ports own their own transport contract;
`withDecisionLog` validates and records them but does not install another retry
loop. Production native, browser and gateway judgment exposures all acquire the
managed System One port. Test doubles may intentionally return terminal failures.

Engine-managed runtimes also read the ordered `judgment.fallbacks` setting.
Each entry supplies an endpoint, pinned model and an environment or secret-store
key reference. The runtime captures the chain with the primary settings before
credential resolution. Direct callers pass the complete explicit chain to
`createSystemOnePort`.
