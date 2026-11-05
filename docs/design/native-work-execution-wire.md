# Paired daemon native-work execution

Status: scoped contract and implementation record. Scope and validation limits are documented below; this record does not establish overall product or release readiness.

The daemon now registers an identity-only native execution path for an existing
complete `LedgerWork` with an active attempt claimed by that paired principal.
The native graph is acquired lazily after authentication and project validation.
It has its own agent manager and runner; ordinary conversational intake retains
its existing graph. Opening a ledger or requesting status never starts work.

## Client contract

`@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client`
exports `getOperatorWorkLedgerProject(client, options?)` and
`createOperatorNativeWorkExecutionClient(client, projectId)`. They reuse the
selected operator client's existing authenticated transport. No additional token,
permission setting, actor, source, project root or session is accepted.

`workLedger.project` (`GET /api/work-ledger/project`) accepts `{}` and returns the
native ledger owner's `{ projectId }`. It is independent of legacy planning.
Discovery requires current admin and `read:work-ledger`; it does not promise
execution eligibility.

Each of `workLedger.execution.start`, `.status`, `.cancel` and `.resume` has a
`POST /api/work-ledger/execution/<operation>` binding. The strict input is:

```ts
{
  projectId: string;
  workId: string;
  attemptId: string;
  expectedRevision: { work: number; criteria: number; attempt: number };
}
```

The existing attempt is the durable request identity. The server derives the
criteria key, source, original goal and ordered criteria, native action,
authority, scope and session. The client cannot substitute these fields.

All execution operations require a current admin principal authenticated by a
persisted per-pairing token, plus existing `read:work-ledger` and `write:fleet`
scopes. Admin matches the owner-only ledger surface; the dedicated read scope
permits the work identity/progress projection; fleet write matches the executor
being controlled. Even status resolves this owner's execution association and
therefore retains the same paired owner/scope checks. No scope or token is issued
by this path. Shared tokens and user sessions are explicitly unsupported.
Transport-captured scopes are a ceiling and are rechecked against live authority.

The bounded result is now a discriminated intent-or-execution union; see [admission intents](native-work-admission-intents.md). The execution branch contains identity, admitted `expectedRevision`, live
`currentRevision`, `currentAttempt`, `stale`, native association `state`,
`recovery`, the stable `receipt` IDs and typed `progress`. Progress carries only
contract status, session-mode flag, semantic state/stage, retry presence and
unit/criterion counts. It contains no raw source, tool output, authority binding,
execution path, decision context or credential. Execution progress does not
claim ledger verification.

## Revision and lifetime behavior

- Start checks the exact work/criteria/attempt revisions. Exact repeated delivery
  returns the same engine-owned contract and owner IDs.
- Status and cancel find the persisted association by host project and attempt.
  Later work/criteria edits do not strand them. Their result reports the original
  admitted revision and the current ledger revision separately.
- Cancel persists cancellation and waits for background runner and foreground
  session-turn drainage before reporting success.
- Resume is explicit, requires the original admission identity and fresh live
  owner checks, and records a fresh semantic decision for a prepared attempt.
  A lost live owner with a launch claim remains recovery-required; arbitrary
  external effects are never replayed.
  A passed terminal execution instead calls the host's verification/publication
  settlement path, without calling runner start or resume. An existing settlement
  receipt is reconciled through the same explicit action, including after a lost
  acknowledgment. Cancelled execution takes precedence; other terminal outcomes
  cannot restart. The request still uses the original admitted revisions and the
  response shows current ledger revisions separately.
- Status of a missing association/intent returns `NATIVE_EXECUTION_NOT_FOUND` (404). Target-aware cancellation can instead persist a prevention intent after validating the existing active ledger target. Semantic
  refusal `NATIVE_EXECUTION_REFUSED` (422), stale/conflict/recovery failures 409,
  unsupported authority 403, and unavailable/closed state 503.
- Aborting or disposing the client only detaches the local request. It does not
  prove server cancellation. Inspect the same attempt after a lost response.
  The client adds no retries, polling or automatic resume.

## Daemon ownership

The lazy native graph borrows the real daemon configuration, provider registry,
recorded judgment port/log and PermissionManager. The original read filter is
`permissionManager.readAccess(path) === 'allow'`; it is passed to the native
runner and session tools. Workspace incarnation eligibility remains prospective:
legacy registry rows are readable but cannot authorize native execution.

No-delegation execution uses the native contract's foreground session turn,
with a restricted nondelegating tool registry and real contract hooks. It never
spawns an extra unit agent. The existing read-only decomposition planner remains
part of engine planning. Native shutdown fences acquisition and drains owned
turns, agents and processes before borrowed daemon owners are disposed.

Ordinary and native managers share the existing fleet ceiling through a trusted
read-only ownership view. A cancelled or failed execution still occupies its slot
until actual cleanup settles. Final synchronous spawn and wake admission rechecks
that shared view under a reentrancy guard; stale elastic-pool probes cannot admit
both graphs past the cap. Current ACP ownership is counted once. Standalone
managers without this optional composition retain their existing behavior.

## Wire scope

This supports existing native work. These wire methods do not create or claim
intake, or convert the ordinary Agent/TUI conversation path. There is no general
external effect reconciler or automatic adoption of historical authority.
Wire fixtures do not establish engine-union security clearance. Focused fixtures
exercise actual paired storage, native
scope, durable runner, recorded admission and the production REST/WS dispatch.

A later attempt also works when the project has not ignored `.goodvibes/`:
Git's raw nested-worktree directory entry is excluded at the known runtime root
before file-path validation. Traversal, repeated separators, lookalike roots and
malformed ordinary inputs keep the existing strict refusal. Regression controls
must preserve both valid nested-worktree reuse and these refusal boundaries.

## Host implementation

This implementation supplies the daemon native-floor factory over the existing durable runner. The daemon activates a separate graph lazily for authenticated existing-work commands. Complete explicit sources can now be submitted through [native submission](native-work-submission.md) to create and claim work atomically. Submission never starts execution. Ordinary conversational intake remains separate. Startup alone never dispatches work, migrates an old approval into authority, or issues credentials.

### Supported owner and operation

The host implementation is isolated on the `@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution` subpath so ordinary ledger readers do not import the runner bridge. `createDaemonNativeWorkExecutionServices` composes the supplied native agent graph with both trusted owners. Its `execution` service starts an existing complete native `LedgerWork` with an active attempt claimed by the authenticated paired principal. The host, not wire input, selects the project root, project ID, session and original goal/ordered criteria. Stable work and criteria revisions come from that authoritative ledger; the criteria-set ID uses the existing engine helper.

Only a transport-created `nativeExecutionAuthority` qualifies. The transport resolves a real per-pairing credential, verifies the exact live and persisted pairing UUID, and retains the credential privately in a nonserialized capability. The UUID is the actual immutable authority incarnation. Decision bindings use canonical SHA-256 protocol encodings of that identity and the persisted workspace identity/generation; they do not invent new grant epochs. Raw identifier strings are kept out of semantic prose. Shared tokens, user sessions and legacy authenticators lack this supported identity and are refused. Current scopes are intersected with the transport's captured ceiling. The bridge requires existing `write:fleet` and `read:work-ledger` authority; it does not mint tokens or add grants.

All pairing writers reload under the same non-expiring owner lock, durably publish, then update memory. Native reads are strict and side-effect-free. Required publication confirms the file and complete canonical/alias directory ancestry; directory-sync failure is not silently accepted. A failed or ambiguous write fences native admission, preserves any already-visible post-rename bytes, and requires an explicit successful durable owner mutation to clear that live fence. Fresh native owners also confirm visible file durability before accepting authority. Interrupted ownership requires recovery rather than an age-based lock takeover. Ordinary atomic/JSON store callers keep their prior default behavior unless they opt into required durability.

### Prospective workspace identities

Workspace registry version 2 retains the existing coverage records and adds a random registry incarnation, a monotone scope generation, per-registration canonical directory incarnations and removal tombstones. New registration events can establish current scope identity. Existing version-1 registrations remain readable but native-ineligible; an idempotent add or provenance upgrade does not invent their history. Removing and registering again creates a new incarnation. A caller must intentionally establish a current registration; this patch does not perform that operation on a user's machine.

Native scope reads use the current primary file only, resolve actual canonical directories and pin the winning registration. Ordinary descendant coverage is supported. Linked-worktree-only coverage, missing/corrupt metadata and legacy fallback authority are refused. The legacy fold and Agent migration/backfill writers share the writer lock and refuse migrated stores rather than erase their history. Existing display/coverage semantics remain separate from native eligibility. The daemon checkpoint reader accepts both registry versions and still requires the original explicit checkpointEligible flag; native scope identity never creates a checkpoint grant.

### Durable association and launch

KnowledgeStore database schema 3 introduced `native_work_executions` alongside `work_ledgers`; schema 4 adds separate admission intents and cancellation tombstones, as described in [the intent contract](native-work-admission-intents.md). Ledger state and existing execution records remain version 1. Migration preserves existing work/history and creates no authority or execution record. Older database readers refuse schema 3. Current-schema table loss/corruption is not repaired into an empty authority; migration from schema 2 first validates its ledger table.

One execution record retains the complete source-bearing request, exact work/attempt target, captured scope ceiling, recorded Jev `act` and context, engine-owned receipt and native launch state. A work attempt cannot be rebound through a different criteria key. The bridge checks actual recorded successful call entries and matching decision/claim notes before launch; a copied structural receipt alone is insufficient.

The shared evaluator makes the start decision. A valid semantic refusal is distinct from unavailable transport or recording failure and creates no execution. No human confirmation loop or second transport retry loop is added.

Lock order is engine key ownership, paired authority ownership, workspace scope ownership, then the existing KnowledgeStore transaction. The transaction durably publishes the native association/launch claim before invoking the runner's synchronous live validator while ownership is still held. It releases ownership after invocation, not after the full executor lifetime. Observers never launch work. Existing PR56 input capture and original-owner read filtering are forwarded unchanged.

Exact start replay returns the same engine-owned IDs. Queued starts retain their association before acknowledgment and remain cancellable. Cancellation persists native cancellation, cancels the runner and joins its drainage. Host close fences admission and drains its runner work.

### Recovery boundary

`resumeAll` still does not launch native records. Explicit resume of an unclaimed prepared operation obtains a fresh recorded decision and current owner validation. An engine replay that reports a launch claim is retained as claimed even when the native acknowledgment was missing.

After losing the live owner, a `launch-claimed` record requires external-effect reconciliation and is refused by this bounded service. This implementation does not know whether arbitrary external effects ran, so it cannot authorize their replay. It supplies no pretend exactly-once delivery guarantee and no general effect reconciler. Terminal/replayed receipts remain inspectable through existing read paths.

### Product composition and validation

The native factory requires its real PermissionManager, original read filter, recorded judgment port/log and native agent graph; installing its owners in a legacy intake graph alone would break that graph's source-less start paths.

Focused tests use actual paired and scope owners, the real KnowledgeStore transaction and real durable runner/AgentManager/orchestration with a scripted offline model. They cover source preservation, recorded admission, idempotent/concurrent delivery, revocation, criteria changes, queued cancellation, drainage, captured inputs, actual prepared-process restart, refusal of unreconciled replay, the v1-to-v2 checkpoint-coverage transition, and file/directory durability-failure boundaries. Persistence fixtures prove observed calls and failure handling; they do not simulate a real power loss. Implementation regressions do not establish independent security clearance.
