# Autonomous Jev decision contract

Status: shared semantic receipt contract. Execution mode selects who makes the safety decision; the schema does not itself authorize an effect.

## Execution modes

The current execution-mode requirement supersedes the earlier blanket removal
of runtime owner replies:

- `safe-owner` permits ordinary actions automatically and asks the owner about
  dangerous actions. An answer applies to the exact current operation. Edited
  arguments receive fresh preparation and binding before execution.
- `safe-jev` uses Jev in the owner's place. Elevated stakes, network access,
  state changes or irreversibility alone do not justify refusal; the decision
  considers the actual requested action and harmful consequences.
- `yolo` bypasses execution-safety decisions and denials, including downstream
  tool policies. It makes no Jev safety request and opens no approval prompt.

`plan` remains a separate non-executing posture. The same execution modes apply
to foreground, background, hosted and channel work. Modes belong to the actual
session owner, and changing a mode invalidates pending authority. Saved aliases
normalize to these modes; they do not create additional execution paths.

Semantic Jev decisions still use the receipts below. Owner and YOLO execution
use the existing authentic invocation and single-use claim without inventing
model decisions or call lineage. Cancellation, exact prepared-input identity,
external authentication and execution idempotency remain mechanical checks.

This product contract does not change development-tool permissions or authorize
live external actions by a developer.

## Shared consumer interface

Import from `@goodvibes-jev/judgment/decisions`, the runtime-neutral entry point:

```ts
import {
  JEV_DECISION_SCHEMA,
  parseJevDecision,
  validateJevDecision,
  type JevDecision,
  type JevDecisionBinding,
  type JevDecisionContext,
} from '@goodvibes-jev/judgment/decisions';
```

`JEV_DECISION_SCHEMA` is a closed draft-7 JSON Schema for persisted/wire receipts. `parseJevDecision(unknown)` performs strict runtime shape validation and returns a detached, deeply frozen receipt. Unknown fields, legacy outcome names, empty call lineage, duplicate references and malformed variants fail with a value-free `JevDecisionError`.

`validateJevDecision(unknown, currentHostContext)` additionally binds the receipt to host-owned current identities and offered references. Neither function is an authorization service. A receipt, a TypeScript type, or a model-generated copy of a host ID is not sufficient authority to execute.

### Semantic outcomes

| Outcome | Consumer behavior |
| --- | --- |
| `act` | Candidate to execute exactly the bound action after current deterministic boundaries and atomic ledger claim. Requires at least one captured evidence reference. |
| `revise` | Execute the selected host-offered `next` step: `reconsider`, `gather-evidence`, or `revise-action`. This never executes the original action. Any changed action/input requires a fresh decision and binding. |
| `defer` | Keep the current action unexecuted. Observe the host-registered `until` condition; when satisfied, obtain a fresh decision using current context. Deferral itself never authorizes later execution. |
| `reject` | Refuse the bound action. No continuation or execution is implied. New evidence or a changed request can start a new decision. |

Each receipt has `schemaVersion: 1`, `decisionId`, `binding`, nonempty `judgmentDecisionIds`, `evidence`, `summary`, and `outcome`. Only `revise` has `next`; only `defer` has `until`. The informational summary is never executable text or approval.

There is no `confirm`, `escalate`, `approved`, `allow-all` or terminal `unavailable` semantic outcome. Valid semantic uncertainty is not a transport error: Jev can select further evidence/reconsideration, a meaningful external-condition deferral, or refusal. Repeating an unchanged uncertain reading until it happens to cross a threshold is not evidence gathering. There is no deterministic fallback that guesses what Jev would have chosen.

### Binding and provenance

`JevDecisionBinding` contains:

| Fields | Host obligation |
| --- | --- |
| `sourceId`, `inputRevision` | Identify the immutable source input snapshot and change the revision for any relevant content/context change. |
| `actionId`, `actionRevision` | Identify the exact operation, arguments, destination and effect scope. A revised command, recipient or payload gets a new revision. |
| `authorityId`, `authorityRevision` | Identify the actual principal/capability context and current grant generation. Revocation or a changed grant invalidates old decisions. |
| `scopeId`, `scopeRevision` | Identify the actual tenant/workspace/resource scope and generation. Switching or shrinking scope invalidates old decisions. |

References are opaque host-owned, nonempty printable-ASCII strings of at most 256 characters, not display names or credentials. A revision can be a content digest or a monotonic immutable version. This module does not compute or authenticate it. The host registry must make an ID/revision pair immutable; reusing a revision after content changes breaks the contract.

Native contract criteria sets retain their `criteria:<sha256(workId)>` identity in
both the immutable source and durable admission. At the native decision boundary,
a matching durable checkpoint, work-derived criteria ID and criteria revision
allow that one evidence reference to use its bare SHA-256 protocol encoding.
Other references are unchanged. This is an owner-bound representation change,
not a prefix exemption: arbitrary metadata, original goals/criteria, operation
state and continuation input still pass the same protected-input checks. Existing
saved decisions stay historical records; a resumed operation obtains a fresh
current decision as before.

The host assigns `decisionId`, validates that `judgmentDecisionIds` name actual recorded successful Jev calls for this binding, and supplies the available evidence manifest. An evidence reference is `{ id, revision }`. The receipt may select only known versions from that manifest. Call records and evidence must belong to the exact decision snapshot; a global allowlist is insufficient.

The host also supplies exact versioned `continuations` and `resumeConditions`. Jev selects among these offered steps and conditions. An arbitrary string in the model response must never create a tool call, callback, subscription or condition. Each continuation's own capabilities and effect scope are checked deterministically before it runs. Host context must not be populated by echoing the untrusted receipt.

The parser guarantees detached receipt immutability. Binding validation cannot make execution atomic: immediately before a side effect the owner must rebuild current context, revalidate, run deterministic boundaries, and atomically claim `(decisionId, actionId, actionRevision)` against the execution ledger. Already claimed receipts cannot execute twice. Revocation and claim/execution must use the owner's existing synchronization mechanism. Do not retain a stale validated receipt as a durable permission grant.

## Retry and product progress

The judgment port is the only transport-retry owner. It tries the configured hosted/local decision targets with finite per-target deadlines. The first valid semantic answer is final, including a refusal. If all targets fail, report that no decision models are currently available, direct the user to check keys, endpoint/model configuration and local services, and halt the operation. An outage is never a semantic defer, a fabricated General route, or a reason to repeat the chain indefinitely. Daemon, TUI, Agent, Web UI and native bridges consume its lifecycle signal and waiting notifications. They must not wrap it in another retry loop, turn waiting into `reject`/`defer`, synthesize an answer, or display an approval prompt.

Operational progress is separate from `JevDecision`. While a logical reading is pending, the consumer has a pending task and the port's credential-free waiting/backoff data; it has no semantic receipt. Display “Waiting for Jev” or equivalent and keep cancellation responsive. User cancellation, supersession, shutdown and deterministic authority revocation stop that operation without manufacturing a semantic decision. Permanent request/authentication/format failures remain explicit operational failures; they do not grant execution authority.

Semantic reconsideration is a new Jev reading with new recorded lineage, not an HTTP retry of a failed request. Source, action, evidence or authority changes require a new snapshot. All such calls still go through the same central port transport implementation.

## Autonomous execution binding

A `safe-jev` execution composes these interfaces:

1. Capture a host-owned immutable action/input snapshot, current authority/scope revisions, actual evidence, and legal continuation/condition choices.
2. Ask the shared Jev port with lifecycle cancellation and live authority checks before each transport attempt. Relay its operational waiting notifications unchanged to product progress.
3. Have Jev select the semantic outcome and applicable offered reference. Construct the receipt using actual host IDs and actual recorded Jev call IDs; do not fabricate lineage or promote an uncertain legacy reading to `act`.
4. Validate the receipt against the captured snapshot. At the execution boundary, validate it again against live context and atomically claim the decision/action in the native execution ledger.
5. Route `revise` to the selected autonomous next step, `defer` to its registered condition and a fresh later reading, `reject` to a refusal receipt, and `act` to the exact gated action. Products render these typed states.

Acceptance fixtures for that slice must prove: invalid or unavailable Jev produces zero actions; eventual recovery produces one current action; cancellation/supersession/revocation during backoff produces zero actions; old input/action/scope/authority revisions are rejected; unknown or stale evidence/steps/conditions are rejected; repeated delivery cannot execute twice; `revise`/`defer` never execute the original action; no human approval UI or synthesized permission result is created.

The schema supplies structural and binding validation. The execution ledger, semantic evaluator and product composition supply the live ownership checks and effect boundary.

## Historical observations and current execution

The old `Outcome = act | confirm | escalate` remains readable in batteries,
logs and persisted data. It is not an execution-mode selection or an autonomous
receipt. Historical observations cannot authorize a new effect, and their
stored vocabulary must not be rewritten into `act`.

`permissions/manager.ts` selects the shared execution mode and binds its result
to the prepared invocation. Products render that owner's decisions and port
progress. They do not add a second approval or retry implementation.

General action admission does not replace domain authorization. Settings and
local profile effects retain secret-storage, provenance and derivation rules as
well as exact input, target, cancellation and currentness checks. Payments retain
their separate [spending contract](../../packages/engine/docs/payments.md),
including configured budgets, merchant rules and opposite approval/veto silence
rules in every mode. General Jev approval and YOLO cannot bypass those rules. Saved legacy mode aliases normalize at configuration
boundaries; selecting a current mode clears the old automatic-approval alias.

Task acceptance has its own evidence contract. A safe-mode approval or YOLO
selection does not establish that a task passed its required checks or fulfilled
the original request. See [contract runner evidence](../contracts/contract-runner-evidence.md).
