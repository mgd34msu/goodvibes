# Contract runtime ownership

The TUI obtains `contractRunner` from `createClientRuntimeServices` in
[`src/runtime/services.ts`](../src/runtime/services.ts). The same runner feeds
the public contract operator and intake and supplies terminal-inclusive
snapshots. There is no separate TUI persistence adapter or planned-fix callback.

The shared [client floor](../../../packages/engine/sdk/src/platform/runtime/client-services.ts)
composes the runner and invokes `resumeContracts`.
[Contract composition](../../../packages/engine/sdk/src/platform/runtime/contract-composition.ts)
binds `ContractStore`, `createContractRunner`, the actual agent manager, bus,
orchestration engine, and pricing/route dependencies.

## Persistence and agent-tool boundary

The public [ContractStore](../../../packages/engine/sdk/src/platform/contract/store.ts)
uses one versioned file per contract under `.goodvibes/contracts/`. It owns
atomic/debounced writes, snapshot validation and quarantine, terminal retention,
and import protection. Public
[runner resume](../../../packages/engine/sdk/src/platform/contract/resume.ts)
owns resumption and zombie handling. The old `wrfc-chains.json` snapshot format
is not compatible by implication: retiring the old adapter neither reads nor
deletes those user snapshots.

The public [agent tool](../../../packages/engine/sdk/src/platform/tools/agent/index.ts)
sends default spawn/batch work through the contract runner. A direct ordinary
agent requires `outsideContract: true`.
[AgentManager](../../../packages/engine/sdk/src/platform/tools/agent/manager.ts)
emits `AGENT_SPAWNING.taskContract`. Retired WRFC owner promotion, batch collapse,
role flags, English-keyword routing, `ORCHESTRATION_NODE_ADDED`, and the private
`wrfcController.fixWorkstreamRunner` API are not compatibility requirements for
this boundary. The [autonomous decision contract](../../../docs/design/autonomous-jev-decisions.md)
continues to govern execution authority.

## Fleet receipts and presentation

ACP and direct-wake acceptance leave delivery unknown; they are not native
message-bus queued receipts. A native-bus timeout or target end likewise cannot
prove non-delivery: the runner may already have consumed steering before its
acknowledgement arrives. Preserve exact identity as one receipt per tab until
replacement or tab retirement. Render unknown/consumed states honestly and retain
later errors rather than turning acceptance into a delivery claim.

Stop/discard hints must use the same eligibility helper as the actual list and
full-view controls, without changing execution or confirmation handlers. Unpriced
cost remains unknown rather than `$0.00`; known subtotals do not make a partial
total complete. Do not invent per-item isolation/integration or conflict-path
fields when the public `ContractUnitView` does not provide those facts.

## Meaningful verification

[`src/test/tools/agent.test.ts`](../src/test/tools/agent.test.ts) constructs the
public manager, tool, message bus, archetype loader, runtime event bus, contract
store and runner over a controlled pending executor. Its obligations include:

- Direct spawn/get preserve task, template, execution state and no contract binding;
  direct reviewer role and per-child batch restrictions remain intact.
- Child tools obey the parent's capability ceiling and preserve requirements.
- `AGENT_SPAWNING` carries the execution contract; list returns manager records
  and applies cohort filtering.
- Cancel aborts the manager signal and status/wait report cancellation; message
  reaches the actual bus and appears in message detail.
- Invalid spawn/get/cancel/message/mode requests create no agents.

Run focused checks from the repository root using installed prerequisites and
[the canonical owned runner](testing-and-validation.md):

```sh
bun packages/engine/scripts/test.ts --cwd ../../products/tui src/test/tools/agent.test.ts
bun packages/engine/scripts/test.ts test/contract/store.test.ts
bun packages/engine/scripts/test.ts test/contract/correction.test.ts
```

The store suite protects versioned round trips, invalid/future snapshot refusal
and quarantine, bounded retention, import protection, event-triggered writes,
and pending-write flush on detach. The correction suite exercises the shared
runner's fix creation, fix-group execution and completion re-check, exhausted
budgets and rejected fixes; it is not a private TUI callback-wiring test.
Retained legacy owner-escalation cases do not add an autonomous approval route.

These controlled fixtures do not verify live providers, a complete TUI session,
contract planning/provider execution, or migration of historical WRFC snapshots.
Historical retirement decisions and source-bound receipts are preserved in
[THE-62](https://linear.app/the-artificery/issue/TA-62/port-the-redesigned-tui-onto-jev-engine-contracts).

## Contract attempt picker ownership

The FleetActs flow lists the selected contract unit's recorded held attempts,
previews one candidate, and applies it only after the owner confirms.

### Behavior repaired

The candidate-list and preview awaits previously had no modal/request ownership.
Escape, F2 close, filter dismissal, and close/reopen could be followed by stale
picker or Changes-preview publication. Repeated Enter admitted concurrent reads
and previews. A retained confirmation callback could submit an apply twice.

`FleetActs` now gives each picker request a distinct identity. Cancellation clears
that identity before closing its preview. Superseded success and failure results
cannot publish UI. Reads and previews are coalesced while owned work is pending;
Escape and current preview failures leave a usable subsequent flow. The current
public contract unit, attempt group, candidate membership, and terminal state are
rechecked after awaits and before confirmation. Existing engine/daemon permission
and qualified-target boundaries remain authoritative.

`AgentsModal` revokes ownership on close, Escape, newer list selection, archive/search/follow/hosted navigation, competing
list interactions and deep links. Confirmation is one-shot. An already admitted apply still reports its real
success/refusal/error receipt after dismissal; its completion cannot close or
clear the newer picker. Dismissal is not represented as remote cancellation.

### Validation

`src/test/input/fleet-pick-ownership.test.ts` drives the public process registry,
real AgentsModal input/rendering, SurfaceModalHost and real ChangesModal
preview/confirmation with local synthetic gateway responses. Preserve deferred
success/failure, repeated input, stale contract state, retry, selection changes,
stale confirmation callbacks and late admitted apply completion. Include archive
navigation and opening search while the list read is pending. Controls must
expose missing ownership behavior rather than cover only happy paths. No provider
or live daemon calls are needed.

Run the guarded fleet suites and full test-program typecheck from `products/tui`:

- `bun scripts/run-tests.ts fleet- --jobs 2`
- `node --max-old-space-size=4096 ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json`

Do not weaken guard or runner-admission configuration to obtain a passing result.

### Acceptance boundaries

Full zero-exclusion product tests, current native binary/PTY and live-provider
parity, and exact-head CI have their own acceptance requirements. Focused synthetic
UI tests do not establish compiled-shell or live-provider acceptance, or PR56
filesystem/security behavior.
