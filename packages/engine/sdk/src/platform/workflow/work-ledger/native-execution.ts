import { isDeepStrictEqual } from 'node:util';
import type { NativeContinuationGrant } from '../../pairing/pairing-token-store.js';
import type { CiWatchSubscription } from '../../ci-watch/types.js';
import type { ExternalOperationSource } from '../../permissions/external-request.js';
import { createNativeCiContinuationHost, type NativeCiGrantOwner, type NativeCiContinuationPolicy } from './native-ci-continuation.js';
import { assertNativeRecordedDecision } from './native-recorded-decision.js';
import { nativeSelectedDiffEvidence } from './native-diff-evidence.js';
import { verifyNativeWorkExecution } from './native-execution-verifier.js';
import type { NativeWorkSettlementReceipt } from './native-settlement-types.js';
import type { CheckSettings } from '../../contract/check.js';
import type { ReadAccessFilter } from '../../tools/shared/read-access.js';
/** Native work -> durable runner bridge. No product payload can provide its authority owners. */
import { randomBytes } from 'node:crypto';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { realpathSync } from 'node:fs';
import type { DecisionLog, EntryType, JudgmentPort } from '@goodvibes-jev/judgment';
import { decideAutonomous } from '../../gate/autonomous-decision.js';
import { durableKeyIdentity, durablePayloadRevision, sameDurableRequest, type DurableContractAdmission, type DurableContractKey, type DurableContractRequest, type DurableStartedContract } from '../../contract/durable-admission.js';
import { captureNativeContractSource } from '../../contract/native-source.js';
import type { ContractRunner } from '../../contract/runner.js';
import type { ContractIntegrationInspection } from '../../contract/integration-inspection-wire.js';
import { isTerminalContractStatus, type ContractView, type StartContractInput } from '../../contract/types.js';
import type { NativeContractCompositionOwner } from '../../runtime/contract-composition.js';
import { NativeWorkExecutionError, parseNativeWorkExecutionRecord, parseNativeWorkExecutionIntent, nativeExecutionOwnerMatches, nativeExecutionTargetRevision, bindNativeExecutionRequest, type NativeExecutionOwnerFacts, type NativeWorkExecutionIntent, type NativeWorkExecutionRecord, type NativeWorkExecutionStorage, type NativeWorkExecutionTarget, type NativeWorkExecutionTransaction } from './native-execution-types.js';

export interface NativePairedExecutionSnapshot {
  readonly kind: 'pairing-token'; readonly tokenId: string; readonly principalId: string;
  readonly authorityId: string; readonly authorityRevision: string; readonly scopes: readonly string[];
}
/** Nonserialized transport-created capability. Keep the credential inside its authenticated owner. */
export interface NativePairedExecutionAuthority {
  /** Authenticated transport-only issuance. No wire payload can install this owner. */
  issueContinuation?(binding: string, assertCurrent: () => void, sourceBinding?: string): NativeContinuationGrant;
  /** Only an actual claimed CI successor supplies its preallocated source
   * token; ordinary paired authorities omit this. No authority is inferred. */
  continuationSourceAction?(target: NativeWorkExecutionTarget): string;
  current(): NativePairedExecutionSnapshot | null;
  withCurrent<T>(expected: NativePairedExecutionSnapshot, callback: (assertCurrent: () => NativePairedExecutionSnapshot) => T | Promise<T>): Promise<T>;
}
export interface NativeExecutionScope { readonly root: string; readonly scopeId: string; readonly scopeRevision: string; }
export interface NativeExecutionScopeOwner {
  currentScope(root: string): NativeExecutionScope;
  withCurrentScope<T>(expected: NativeExecutionScope, callback: (assertCurrent: () => void) => T | Promise<T>): Promise<T>;
}
type NativeRunner = Pick<ContractRunner, 'startDurable' | 'resumeDurable' | 'get' | 'list' | 'cancel' | 'join' | 'inspectDurable' | 'joinDurable' | 'inspectIntegration'>;
export interface NativeWorkExecutionStatus {
  readonly kind: 'execution';
  readonly execution: NativeWorkExecutionRecord;
  readonly contract: ContractView | null;
  readonly currentTarget: NativeWorkExecutionTarget | null;
  readonly currentAttempt: boolean;
  readonly recovery: 'available' | 'required' | 'terminal' | 'cancelled';
  readonly integration: ContractIntegrationInspection;
  readonly settlement?: { readonly state: 'pending' | 'required' | 'failed' | 'published'; readonly evidenceId?: string; readonly reportSequence?: number; readonly evidenceSequence?: number };
}
export interface NativeWorkExecutionIntentStatus {
  readonly kind: 'intent';
  readonly intent: NativeWorkExecutionIntent;
  readonly currentTarget: NativeWorkExecutionTarget | null;
  readonly currentAttempt: boolean;
  readonly recovery: 'pending' | 'required' | 'cancelled';
}
export type NativeWorkExecutionObservation = NativeWorkExecutionStatus | NativeWorkExecutionIntentStatus;
export interface NativeWorkExecutionHost {
  readonly nativeOwner: NativeContractCompositionOwner;
  recoverCiWatchOwner(watch: CiWatchSubscription): ExternalOperationSource | undefined;
  revokeCiWatch(watch: CiWatchSubscription): Promise<void>;
  attachRunner(runner: NativeRunner): void;
  start(target: NativeWorkExecutionTarget, authority: NativePairedExecutionAuthority, options?: { readonly signal?: AbortSignal; readonly taskEvidence?: string }): Promise<DurableStartedContract>;
  status(key: DurableContractKey, authority: NativePairedExecutionAuthority): NativeWorkExecutionStatus;
  statusByAttempt(workId: string, attemptId: string, authority: NativePairedExecutionAuthority): NativeWorkExecutionObservation;
  cancelTarget(target: NativeWorkExecutionTarget, authority: NativePairedExecutionAuthority, reason: string): Promise<void>;
  cancel(key: DurableContractKey, authority: NativePairedExecutionAuthority, reason: string): Promise<void>;
  resume(key: DurableContractKey, authority: NativePairedExecutionAuthority, options?: { readonly signal?: AbortSignal }): Promise<DurableStartedContract>;
  /** Explicit proof/publication recovery; never calls runner start or resume. */
  settle(key: DurableContractKey, authority: NativePairedExecutionAuthority, options?: { readonly signal?: AbortSignal }): Promise<NativeWorkSettlementReceipt>;
  close(): Promise<void>;
}
const REQUIRED_SCOPES = ['write:fleet', 'read:work-ledger'] as const;
const deliveryIdentity = (target: Pick<NativeWorkExecutionTarget, 'workId' | 'attemptId'>) => JSON.stringify([target.workId, target.attemptId]);
const ownerFacts = (paired: NativePairedExecutionSnapshot, scope: NativeExecutionScope): NativeExecutionOwnerFacts => ({ principalId: paired.principalId, authorityRevision: paired.authorityRevision, scopeId: scope.scopeId, scopeRevision: scope.scopeRevision });
const equalTarget = (a: NativeWorkExecutionTarget, b: NativeWorkExecutionTarget) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key as keyof NativeWorkExecutionTarget] === b[key as keyof NativeWorkExecutionTarget]);
const equalScopes = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((scope, index) => scope === [...b].sort()[index]);
function paired(owner: NativePairedExecutionAuthority): NativePairedExecutionSnapshot {
  const value = owner.current();
  if (!value || value.kind !== 'pairing-token' || value.principalId !== value.authorityId || value.authorityRevision !== value.tokenId
    || !REQUIRED_SCOPES.every(scope => value.scopes.includes('*') || value.scopes.includes(scope))) throw new NativeWorkExecutionError('unsupported-authority');
  return Object.freeze({ ...value, scopes: Object.freeze([...value.scopes].sort()) });
}
function captureTarget(value: NativeWorkExecutionTarget): NativeWorkExecutionTarget {
  const target = Object.freeze({ workId: value.workId, workRevision: value.workRevision, criteriaRevision: value.criteriaRevision, attemptId: value.attemptId, attemptRevision: value.attemptRevision });
  if (Object.keys(value).length !== 5 || ![target.workId, target.attemptId].every(id => typeof id === 'string' && id.length > 0)
    || ![target.workRevision, target.criteriaRevision, target.attemptRevision].every(revision => Number.isSafeInteger(revision) && revision >= 0)) throw new NativeWorkExecutionError('invalid');
  return target;
}
function captureKey(value: DurableContractKey): DurableContractKey { const key = Object.freeze({ ...value }); durableKeyIdentity(key); return key; }
function workFor(current: NativeWorkExecutionTransaction, target: NativeWorkExecutionTarget, principal: string) {
  const work = current.ledger.works.find(item => item.id === target.workId);
  const attempt = current.ledger.attempts.find(item => item.id === target.attemptId);
  if (!work || !attempt || work.revision !== target.workRevision || work.criteriaRevision !== target.criteriaRevision
    || work.currentAttemptId !== target.attemptId || attempt.workId !== target.workId || attempt.revision !== target.attemptRevision
    || attempt.ownerId !== principal || attempt.state !== 'active' || work.reportedState === 'cancelled' || work.reportedState === 'complete') throw new NativeWorkExecutionError('stale');
  return work;
}
interface ActiveOwner { readonly authority: NativePairedExecutionAuthority; readonly expected: NativePairedExecutionSnapshot; readonly scope: NativeExecutionScope; record: NativeWorkExecutionRecord | undefined; payloadRevision: string | undefined; claimed: boolean; contractId?: string; }

export function createNativeWorkExecutionHost(deps: {
  readonly projectId: string; readonly projectRoot: string; readonly sessionId: string;
  readonly storage: NativeWorkExecutionStorage; readonly scopes: NativeExecutionScopeOwner; readonly port: JudgmentPort;
  readonly continuationGrants?: NativeCiGrantOwner; readonly continuationPolicy?: NativeCiContinuationPolicy;
  readonly decisionLog: Pick<DecisionLog, 'get'>;
  readonly getSelectedModel?: () => StartContractInput['selectedModel'];
  readonly verification?: { readonly settings: () => CheckSettings; readonly readAccessFilter: ReadAccessFilter; readonly automatic?: boolean };
  /** Trusted host lifetime, invoked only for this owner's actual admitted receipt. */
  readonly cancelForeground?: (contractId: string) => Promise<void>;
  readonly joinForeground?: (contractId: string) => Promise<void>;
}): NativeWorkExecutionHost {
  const projectRoot = realpathSync(deps.projectRoot);
  let runner: NativeRunner | undefined; let closed = false; let closing: Promise<void> | undefined;
  interface Delivery { target: NativeWorkExecutionTarget; identity: NativePairedExecutionSnapshot; controller: AbortController; generation?: number; promise: Promise<DurableStartedContract>; }
  const deliveries = new Map<string, Delivery>();
  interface Settlement { readonly authority: NativePairedExecutionSnapshot; readonly controller: AbortController; readonly promise: Promise<NativeWorkSettlementReceipt>; }
  const settlements = new Map<string, Settlement>(); const settlementFailures = new Set<string>();
  const active = new Map<string, ActiveOwner>(); const pending = new Set<Promise<unknown>>(); const lifetime = new AbortController();
  const recordRetirements = new Map<string, Promise<void>>();
  const requireRunner = () => { if (!runner) throw new NativeWorkExecutionError('unavailable'); return runner; };
  const assertOpen = () => { if (closed) throw new NativeWorkExecutionError('closed'); };
  function currentContract(record: NativeWorkExecutionRecord): ContractView | null {
    const currentRunner = requireRunner();
    return record.receipt ? currentRunner.get(record.receipt.contractId) ?? currentRunner.inspectDurable?.(record.request.key)?.contract ?? null : null;
  }
  function status(current: NativeWorkExecutionTransaction, authority: NativePairedExecutionAuthority): NativeWorkExecutionStatus {
    assertOpen(); const execution = current.record; if (!execution) throw new NativeWorkExecutionError('not-found');
    const retained = active.get(execution.target.attemptId)?.payloadRevision;
    if (retained !== undefined && durablePayloadRevision(execution.request) !== retained) throw new NativeWorkExecutionError('stale');
    const authenticated = inspectAuthority(execution, authority);
    const contract = execution.receipt ? currentContract(execution) : null;
    const work = current.ledger.works.find(item => item.id === execution.target.workId);
    const attempt = current.ledger.attempts.find(item => item.id === execution.target.attemptId && item.workId === execution.target.workId);
    const currentTarget = work && attempt ? { workId: work.id, workRevision: work.revision, criteriaRevision: work.criteriaRevision, attemptId: attempt.id, attemptRevision: attempt.revision } : null;
    const recovery = execution.state === 'cancelled' ? 'cancelled' : contract && isTerminalContractStatus(contract.status) ? 'terminal'
      : execution.state === 'launch-claimed' && !active.get(execution.target.attemptId)?.claimed ? 'required' : 'available';
    const key = durableKeyIdentity(execution.request.key);
    const settlement: NativeWorkExecutionStatus['settlement'] = current.settlement ? { state: 'published', evidenceId: current.settlement.evidenceId, reportSequence: current.settlement.reportSequence, evidenceSequence: current.settlement.evidenceSequence }
      : settlements.has(key) ? { state: 'pending' } : settlementFailures.has(key) ? { state: 'failed' } : { state: 'required' };
    const currentAttempt = !!work && !!attempt && work.currentAttemptId === attempt.id && attempt.state === 'active';
    const integration: ContractIntegrationInspection = !execution.receipt ? { state: 'unavailable', reason: 'no-receipt' }
      : !currentAttempt || !currentTarget || !equalTarget(execution.target, currentTarget) || attempt?.ownerId !== authenticated.current.principalId
        || work?.reportedState === 'complete' || work?.reportedState === 'cancelled' ? { state: 'unavailable', reason: 'stale-attempt' }
      : recovery === 'required' ? { state: 'unavailable', reason: 'recovery-required' }
      : recovery === 'terminal' || recovery === 'cancelled' || execution.state !== 'launch-claimed' ? { state: 'unavailable', reason: 'not-live' }
      : requireRunner().inspectIntegration?.(execution.receipt.contractId) ?? { state: 'unavailable', reason: 'unsupported-runner' };
    // The narrow reader cannot select another receipt, including a stale attempt's live run.
    if (integration.state !== 'unavailable' && integration.contractId !== execution.receipt?.contractId) throw new NativeWorkExecutionError('unavailable');
    inspectAuthority(execution, authority);
    return { kind: 'execution', execution, contract, currentTarget, currentAttempt, recovery, settlement, integration };
  }
  function track<T>(run: () => Promise<T>): Promise<T> {
    assertOpen(); const promise = Promise.resolve().then(run); pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
  }
  function scope() { const current = deps.scopes.currentScope(projectRoot); if (current.root !== projectRoot || realpathSync(deps.projectRoot) !== projectRoot) throw new NativeWorkExecutionError('stale'); return current; }
  function inspectAuthority(record: NativeWorkExecutionRecord | NativeWorkExecutionIntent, owner: NativePairedExecutionAuthority) {
    const current = paired(owner); const currentScope = scope();
    if (record.projectId !== deps.projectId || record.request.input.projectRoot !== projectRoot || !nativeExecutionOwnerMatches(record, ownerFacts(current, currentScope)) || !equalScopes(current.scopes, record.authorityScopes)) throw new NativeWorkExecutionError('stale');
    return { current, currentScope };
  }
  function assertRecorded(record: NativeWorkExecutionRecord) { assertNativeRecordedDecision(record, deps.decisionLog); }

  function assertRecord(current: NativeWorkExecutionTransaction, record: NativeWorkExecutionRecord, owner: ActiveOwner) {
    assertOpen(); assertRecorded(record);
    if (owner.payloadRevision !== undefined && durablePayloadRevision(record.request) !== owner.payloadRevision) throw new NativeWorkExecutionError('stale');
    if (current.intent && (current.intent.state !== 'associated' || !sameDurableRequest(current.intent.request, record.request))) throw new NativeWorkExecutionError('stale'); const auth = inspectAuthority(record, owner.authority);
    if (auth.currentScope.scopeId !== owner.scope.scopeId || auth.currentScope.scopeRevision !== owner.scope.scopeRevision) throw new NativeWorkExecutionError('stale');
    const work = workFor(current, record.target, owner.expected.principalId);
    if (record.state === 'cancelled' || current.record?.state === 'cancelled' || !current.record
      || !sameDurableRequest(current.record.request, record.request)
      || work.title !== record.request.input.ask || work.goal !== record.request.input.nativeSource?.goal || !isDeepStrictEqual(work.criteria, record.request.input.nativeSource.criteria)
      || (work.source !== null && (work.source.sourceId !== record.request.input.nativeSource.sourceId || work.source.sourceRevision !== record.request.input.nativeSource.sourceRevision
        || !isDeepStrictEqual(work.source.version === 2 ? work.source.continuation : undefined, record.request.input.nativeSource.continuation)))) throw new NativeWorkExecutionError('stale');
  }
  function claimOwner(record: NativeWorkExecutionRecord, authority: NativePairedExecutionAuthority): ActiveOwner {
    const { current, currentScope } = inspectAuthority(record, authority); const key = record.target.attemptId;
    const prior = active.get(key);
    if (prior) {
      parseNativeWorkExecutionRecord(record, prior.record); inspectAuthority(record, prior.authority);
      if (prior.payloadRevision !== undefined && durablePayloadRevision(record.request) !== prior.payloadRevision) throw new NativeWorkExecutionError('stale');
      prior.record = record; return prior;
    }
    const owner = { authority, expected: current, scope: currentScope, record, payloadRevision: record.receipt?.payloadRevision, claimed: false }; active.set(key, owner); return owner;
  }
  async function withCurrent(admission: DurableContractAdmission, launch: (assertCurrent: () => void) => void) {
    const owner = active.get(admission.key.attemptId);
    if (!owner) throw new NativeWorkExecutionError('recovery-required');
    await owner.authority.withCurrent(owner.expected, async assertAuthority => {
      await deps.scopes.withCurrentScope(owner.scope, async assertScope => {
        await deps.storage.transaction(admission.key, current => {
          const record = current.record;
          if (!record || !sameDurableRequest(record.request, admission)) throw new NativeWorkExecutionError('conflict');
          assertRecord(current, record, owner);
          if (record.state === 'launch-claimed' && !owner.claimed) throw new NativeWorkExecutionError('recovery-required');
          const { input: _input, ...receipt } = admission;
          if (record.receipt && (record.receipt.contractId !== receipt.contractId || record.receipt.ownerAgentId !== receipt.ownerAgentId || record.receipt.payloadRevision !== receipt.payloadRevision)) throw new NativeWorkExecutionError('conflict');
          const next: NativeWorkExecutionRecord = { ...record, receipt, state: 'launch-claimed' };
          return { next: record.state === 'launch-claimed' ? null : next, value: next };
        }, (record, readCurrent) => {
          owner.record = record;
          launch(() => { assertAuthority(); assertScope(); assertRecord(readCurrent(), record, owner); owner.claimed = true; owner.contractId = admission.contractId; });
        }, owner.record);
      });
    });
  }
  function requestFor(current: NativeWorkExecutionTransaction, target: NativeWorkExecutionTarget, expected: NativePairedExecutionSnapshot, expectedScope: NativeExecutionScope, taskEvidence?: string, sourceActionId?: string): DurableContractRequest {
    const work = workFor(current, target, expected.principalId), selectedModel = deps.getSelectedModel?.();
    const model = selectedModel === undefined ? undefined : { id: selectedModel.id, provider: selectedModel.provider, registryKey: selectedModel.registryKey, displayName: selectedModel.displayName };
    const previous = current.record ?? current.intent;
    if (previous) {
      const request = previous.request, source = request.input.nativeSource!;
      if (!equalTarget(previous.target, target) || !nativeExecutionOwnerMatches(previous, ownerFacts(expected, expectedScope)) || !equalScopes(previous.authorityScopes, expected.scopes)
        || request.input.projectRoot !== projectRoot || request.input.sessionId !== deps.sessionId || request.input.ask !== work.title
        || !isDeepStrictEqual(request.input.selectedModel, model) || source.goal !== work.goal || !isDeepStrictEqual(source.criteria, work.criteria)
        || (work.source !== null && (source.sourceId !== work.source.sourceId || source.sourceRevision !== work.source.sourceRevision
          || !isDeepStrictEqual(source.continuation, work.source.version === 2 ? work.source.continuation : undefined)))) throw new NativeWorkExecutionError('stale');
      return request;
    }
    // Every descriptive protocol label is issued once in the persisted intent.
    // The existing durable payload commitment binds the complete actual request;
    // live source/owner/target comparisons do not need additional hashes.
    const key = { workId: target.workId, criteriaId: 'criteria-v2:' + opaqueUuid(), criteriaRevision: String(target.criteriaRevision), attemptId: target.attemptId };
    const source = captureNativeContractSource({ sourceId: work.source?.sourceId ?? opaqueUuid(), sourceRevision: work.source?.sourceRevision ?? opaqueUuid(), inputRevision: opaqueUuid(),
      criteriaId: key.criteriaId, criteriaRevision: key.criteriaRevision, goal: work.goal, criteria: work.criteria,
      ...(work.source?.version === 2 && work.source.continuation ? { continuation: work.source.continuation } : {}) });
    if (sourceActionId !== undefined && !/^[0-9a-f]{64}$/.test(sourceActionId)) throw new NativeWorkExecutionError('invalid');
    const binding = { sourceId: source.sourceId, inputRevision: source.inputRevision, actionId: sourceActionId ?? randomBytes(32).toString('hex'), actionRevision: opaqueUuid(),
      authorityId: opaqueUuid(), authorityRevision: 'owner-commitment-pending', scopeId: opaqueUuid(), scopeRevision: opaqueUuid() };
    return bindNativeExecutionRequest({ key, binding, input: { ask: work.title, nativeSource: source, projectRoot, sessionId: deps.sessionId, origin: 'external', isolation: 'auto',
      ...(model === undefined ? {} : { selectedModel: model }), ...(taskEvidence ? { taskEvidence } : {}) } }, deps.projectId, ownerFacts(expected, expectedScope), expected.scopes);
  }
  function assertIntent(current: NativeWorkExecutionTransaction, intent: NativeWorkExecutionIntent): void {
    if (current.intent?.state === 'cancelled') throw new NativeWorkExecutionError('prevented-before-admission');
    if (current.record || !current.intent || current.intent.state !== 'admitting' || current.intent.generation !== intent.generation
      || !equalTarget(current.intent.target, intent.target) || !sameDurableRequest(current.intent.request, intent.request)) throw new NativeWorkExecutionError('stale');
  }
  async function prepareIntent(target: NativeWorkExecutionTarget, authority: NativePairedExecutionAuthority, delivery: Delivery, resume: boolean, signal: AbortSignal, taskEvidence?: string): Promise<NativeWorkExecutionIntent> {
    const expected = paired(authority); const expectedScope = scope();
    return authority.withCurrent(expected, async assertAuthority => deps.scopes.withCurrentScope(expectedScope, async assertScope =>
      deps.storage.transactionByAttempt(target.attemptId, current => {
        assertOpen(); signal.throwIfAborted(); assertAuthority(); assertScope();
        if (current.record) throw new NativeWorkExecutionError('conflict');
        const prior = current.intent;
        if (prior) {
          inspectAuthority(prior, authority);
          if (!equalTarget(prior.target, target)) throw new NativeWorkExecutionError('conflict');
          if (prior.state === 'cancelled') throw new NativeWorkExecutionError('prevented-before-admission');
          if (prior.state === 'associated') throw new NativeWorkExecutionError('recovery-required');
          if (!resume) throw new NativeWorkExecutionError(prior.state === 'refused' ? 'refused' : 'pending-intent');
        } else if (resume) throw new NativeWorkExecutionError('not-found');
        const request = requestFor(current, target, expected, expectedScope, prior?.request.input.taskEvidence ?? taskEvidence, prior ? undefined : authority.continuationSourceAction?.(target));
        if (prior && !sameDurableRequest(prior.request, request)) throw new NativeWorkExecutionError('stale');
        const intent = parseNativeWorkExecutionIntent({ version: prior?.version ?? 2, ...(prior ? (prior.owner ? { owner: prior.owner } : {}) : { owner: ownerFacts(expected, expectedScope) }), projectId: deps.projectId, target, authorityScopes: expected.scopes,
          request, generation: (prior?.generation ?? 0) + 1, state: 'admitting' }, prior);
        signal.throwIfAborted(); assertAuthority(); assertScope();
        return { next: null, nextIntent: intent, value: intent };
      }, intent => { delivery.generation = intent.generation; })));
  }
  async function decide(target: NativeWorkExecutionTarget, authority: NativePairedExecutionAuthority, signal: AbortSignal, refreshDecision = false, intent?: NativeWorkExecutionIntent): Promise<NativeWorkExecutionRecord> {
    const expected = paired(authority); const expectedScope = scope();
    const original = deps.storage.currentByAttempt(target.attemptId, intent); const previous = original.record ?? intent ?? original.intent; const work = workFor(original, target, expected.principalId);
    const request = intent?.request ?? requestFor(original, target, expected, expectedScope, original.record?.request.input.taskEvidence);
    const source = request.input.nativeSource!; const binding = request.binding; const key = request.key;
    const assertCurrent = () => {
      assertOpen(); const current = deps.storage.current(key, previous);
      if (intent) assertIntent(current, intent);
      else if (current.record?.state === 'cancelled' || current.intent?.state === 'cancelled') throw new NativeWorkExecutionError('stale');
      signal.throwIfAborted(); const latest = paired(authority); const currentScope = scope();
      if (latest.authorityId !== expected.authorityId || latest.authorityRevision !== expected.authorityRevision || !equalScopes(latest.scopes, expected.scopes)
        || currentScope.scopeId !== expectedScope.scopeId || currentScope.scopeRevision !== expectedScope.scopeRevision) throw new NativeWorkExecutionError('stale');
      const latestWork = workFor(current, target, latest.principalId);
      if (latestWork.title !== work.title || latestWork.goal !== work.goal || !isDeepStrictEqual(latestWork.criteria, work.criteria)
        || !isDeepStrictEqual(latestWork.source, work.source)) throw new NativeWorkExecutionError('stale');
    };
    // No authority, workspace or database lock is held while Jev or its backoff waits.
    const read = await decideAutonomous({ port: deps.port, site: 'work-ledger.native-start',
      instructions: 'Decide whether to start exactly this native work attempt from its complete original goal and ordered criteria. Authentication and scope are fixed host constraints. Do not ask for human approval or invent missing requirements.',
      actionDescription: 'Start the exact bound native work attempt through the durable contract runner.', binding,
      state: { originalSource: { goal: source.goal, criteria: source.criteria, ...(source.continuation ? { conversationContext: source.continuation.messages, ...(source.continuation.selectedDiff ? { selectedDiffContext: nativeSelectedDiffEvidence(source.continuation.selectedDiff) } : {}) } : {}) }, revisions: { work: target.workRevision, criteria: target.criteriaRevision, attempt: target.attemptRevision }, operation: { kind: 'start-native-work', projectRoot }, ...(request.input.taskEvidence ? { untrustedTaskEvidence: request.input.taskEvidence } : {}), deterministicConstraints: { existingActiveClaim: true } } as unknown as EntryType,
      evidence: [{ id: 'native-work-source', revision: source.inputRevision }, { id: 'native-work-attempt', revision: nativeExecutionTargetRevision(target) }, ...(intent ? [{ id: 'native-intent-evaluation', revision: String(intent.generation) }] : [])],
      continuations: [], conditions: [], allowAct: true, assertCurrent, signal });
    assertCurrent();
    if (read.decision.outcome !== 'act') {
      if (intent) await authority.withCurrent(expected, async assertAuthority => deps.scopes.withCurrentScope(expectedScope, async assertScope =>
        deps.storage.transaction(key, current => { assertAuthority(); assertScope(); assertCurrent(); assertIntent(current, intent);
          return { next: null, nextIntent: { ...intent, state: 'refused' }, value: undefined }; })));
      throw new NativeWorkExecutionError('refused', read.decision);
    }
    const record = parseNativeWorkExecutionRecord({ version: previous?.version ?? 2, ...(previous?.owner ? { owner: previous.owner } : previous ? {} : { owner: ownerFacts(expected, expectedScope) }), projectId: deps.projectId, target, authorityScopes: expected.scopes, request, decision: read.decision, decisionContext: read.context, receipt: null, state: 'prepared' }, previous);
    await authority.withCurrent(expected, async assertAuthority => deps.scopes.withCurrentScope(expectedScope, async assertScope =>
      deps.storage.transaction(key, current => {
        assertAuthority(); assertScope(); assertCurrent(); workFor(current, target, expected.principalId);
        if (current.record) {
          if (!sameDurableRequest(current.record.request, request)) throw new NativeWorkExecutionError('conflict');
          if (!refreshDecision) return { next: null, value: undefined };
          if (current.record.state !== 'prepared') throw new NativeWorkExecutionError('recovery-required');
          read.recordClaim(); assertAuthority(); assertScope(); assertCurrent();
          return { next: { ...record, receipt: current.record.receipt }, value: undefined };
        }
        if (!intent) throw new NativeWorkExecutionError('invalid');
        assertIntent(current, intent);
        read.recordClaim(); assertAuthority(); assertScope(); assertCurrent();
        return { next: record, nextIntent: { ...intent, state: 'associated' }, value: undefined };
      })));
    return deps.storage.current(key, record).record!;
  }
  function ownedDelivery(target: NativeWorkExecutionTarget, authority: NativePairedExecutionAuthority, signal: AbortSignal | undefined,
    run: (delivery: Delivery, signal: AbortSignal) => Promise<DurableStartedContract>): Promise<DurableStartedContract> {
    assertOpen(); const identity = paired(authority); const key = deliveryIdentity(target); const prior = deliveries.get(key);
    if (prior) {
      if (!equalTarget(prior.target, target) || prior.identity.authorityId !== identity.authorityId || prior.identity.authorityRevision !== identity.authorityRevision || !equalScopes(prior.identity.scopes, identity.scopes)) return Promise.reject(new NativeWorkExecutionError('conflict'));
      return prior.promise;
    }
    const controller = new AbortController(); const combined = AbortSignal.any([lifetime.signal, controller.signal, ...(signal ? [signal] : [])]);
    let delivery!: Delivery;
    const promise = track(async () => {
      try { combined.throwIfAborted(); return await run(delivery, combined); }
      catch (error) {
        if (!closed) {
          const current = deps.storage.currentByAttempt(target.attemptId);
          if (!current.record && current.intent?.state === 'cancelled') { inspectAuthority(current.intent, authority); throw new NativeWorkExecutionError('prevented-before-admission'); }
        }
        throw error;
      }
    });
    delivery = { target, identity, controller, promise }; deliveries.set(key, delivery);
    const release = () => { if (deliveries.get(key) === delivery) deliveries.delete(key); };
    void promise.then(release, release); return promise;
  }
  function settle(input: DurableContractKey, authority: NativePairedExecutionAuthority, options: { readonly signal?: AbortSignal } = {}): Promise<NativeWorkSettlementReceipt> {
    assertOpen(); const key = captureKey(input); const identity = paired(authority); const id = durableKeyIdentity(key);
    const current = deps.storage.current(key, active.get(key.attemptId)?.record); const record = current.record;
    if (!record) return Promise.reject(new NativeWorkExecutionError('not-found'));
    const ownerFacts = inspectAuthority(record, authority);
    const reconcile = () => authority.withCurrent(ownerFacts.current, async assertAuthority => deps.scopes.withCurrentScope(ownerFacts.currentScope, async assertScope => {
      if (!deps.storage.settle) throw new NativeWorkExecutionError('unavailable');
      return deps.storage.settle(key, latest => { assertAuthority(); assertScope(); inspectAuthority(record, authority);
        if (!latest.settlement || !latest.record || !sameDurableRequest(latest.record.request, record.request) || !isDeepStrictEqual(latest.record.receipt, record.receipt)) throw new NativeWorkExecutionError('conflict'); return null; }, () => {}, record);
    }));
    // Durable replay reconfirms directory durability, without reading Jev, artifacts or runner effects.
    if (current.settlement) return track(reconcile);
    const prior = settlements.get(id);
    if (prior) {
      if (prior.authority.authorityId !== identity.authorityId || prior.authority.authorityRevision !== identity.authorityRevision || !equalScopes(prior.authority.scopes, identity.scopes)) return Promise.reject(new NativeWorkExecutionError('conflict'));
      return prior.promise;
    }
    if (!deps.verification || !deps.storage.settle) return Promise.reject(new NativeWorkExecutionError('unavailable'));
    const verification = deps.verification; const publish = deps.storage.settle.bind(deps.storage);
    // This verification owner is explicitly captured even after restart. It grants no execution continuation.
    const owner: ActiveOwner = { authority, expected: ownerFacts.current, scope: ownerFacts.currentScope, record, payloadRevision: record.receipt?.payloadRevision, claimed: false };
    const controller = new AbortController(); const signal = AbortSignal.any([lifetime.signal, controller.signal, ...(options.signal ? [options.signal] : [])]);
    const expectedRecord = structuredClone(record);
    const assertCurrent = () => {
      signal.throwIfAborted(); const latest = deps.storage.current(key, record);
      if (!latest.record || !isDeepStrictEqual(latest.record, expectedRecord)) throw new NativeWorkExecutionError('stale');
      assertRecord(latest, record, owner); signal.throwIfAborted();
    };
    const promise = track(async () => {
      assertCurrent();
      let proof: Awaited<ReturnType<typeof verifyNativeWorkExecution>>;
      try { proof = await verifyNativeWorkExecution({ execution: record, runner: { get: id => id === record.receipt?.contractId ? currentContract(record) : null, join: async id => { await requireRunner().join(id); await deps.joinForeground?.(id); await requireRunner().joinDurable?.(record.request.key); } }, port: deps.port, decisionLog: deps.decisionLog,
        settings: verification.settings(), readAccessFilter: verification.readAccessFilter, signal, assertCurrent }); } catch (error) {
        // Another authenticated host may have published while these reads were in flight.
        if (!closed && deps.storage.current(key).settlement) return reconcile();
        throw error;
      }
      await continuations.beforeSettlement(record.request.key);
      return authority.withCurrent(owner.expected, async assertAuthority => deps.scopes.withCurrentScope(owner.scope, async assertScope => {
        // A concurrent settlement is reconciled under the same owner lock before any stale-target guard.
        return publish(key, latest => {
          assertAuthority(); assertScope(); inspectAuthority(record, authority);
          if (latest.settlement) return null;
          assertRecord(latest, record, owner); proof.assertCurrent();
          return { version: 2, report: proof.report, attestation: proof.attestation, receipt: record.receipt!, actorId: owner.expected.principalId };
        }, () => { assertAuthority(); assertScope(); proof.assertCurrent(); signal.throwIfAborted(); }, record);
      }));
    });
    const owned = { authority: identity, controller, promise }; settlements.set(id, owned); settlementFailures.delete(id);
    void promise.then(() => { if (settlements.get(id) === owned) settlements.delete(id); }, () => { if (settlements.get(id) === owned) settlements.delete(id); settlementFailures.add(id); });
    return promise;
  }
  function settleAfterCompletion(result: DurableStartedContract, authority: NativePairedExecutionAuthority): void {
    if (!deps.verification || deps.verification.automatic === false || closed) return;
    // Register lifetime now, before join/check await, and drain it during cancellation and close.
    void settle(result.admission.key, authority).catch(() => {});
  }
  async function cancelAndJoin(contractId: string, reason: string): Promise<void> {
    // The persisted receipt is already owner-validated. Cleanup cannot depend on
    // another protected status lookup: revocation may occur during cancellation.
    const foreground = Promise.resolve().then(() => deps.cancelForeground?.(contractId));
    const background = Promise.resolve().then(async () => { requireRunner().cancel(contractId, reason); await requireRunner().join(contractId); });
    const results = await Promise.allSettled([foreground, background]);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  async function cancelAttempt(workId: string, attemptId: string, suppliedTarget: NativeWorkExecutionTarget | undefined, authority: NativePairedExecutionAuthority, reason: string): Promise<void> {
    if (!reason.trim()) throw new NativeWorkExecutionError('invalid');
    const expected = paired(authority); const expectedScope = scope(); let validated = false;
    let validatedKey: string | undefined; let privateRevocationCommitted = false; const contractIds = new Set<string>();
    const drain = async () => {
      const operations = [...deliveries.values()].filter(delivery => delivery.target.workId === workId && delivery.target.attemptId === attemptId && delivery.identity.authorityId === expected.authorityId);
      for (const operation of operations) operation.controller.abort();
      for (const [id, settlement] of settlements) if (id === validatedKey) settlement.controller.abort();
      // Verification may be waiting for runner/foreground drainage. Cancel effects
      // before joining verification, otherwise each lifetime can wait on the other.
      const cleanup = new Map<string, Promise<void>>();
      const stopKnown = () => {
        const localContract = validatedKey ? active.get(attemptId)?.contractId : undefined;
        if (localContract) contractIds.add(localContract);
        for (const id of contractIds) if (!cleanup.has(id)) { const stopping = cancelAndJoin(id, reason); void stopping.catch(() => {}); cleanup.set(id, stopping); }
      };
      stopKnown(); await Promise.allSettled(operations.map(operation => operation.promise)); stopKnown();
      // Preserve the already validated cleanup identity through a later revocation
      // or an association acknowledgement that arrives after cancellation.
      await Promise.allSettled([...settlements].filter(([id]) => id === validatedKey).map(([, settlement]) => settlement.promise));
      const results = await Promise.allSettled([...cleanup.values()]);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    };
    try {
      const before = deps.storage.currentByAttempt(attemptId, active.get(attemptId)?.record);
      let source = before.record ?? before.intent, preventedHere = false;
      if (!source) {
        if (!suppliedTarget) throw new NativeWorkExecutionError('not-found');
        // A fresh opaque identity must exist before it can be revoked. Reserve
        // only a cancelled intent: no ledger claim, semantic act or runner effect.
        const reservation = await authority.withCurrent(expected, async assertAuthority => deps.scopes.withCurrentScope(expectedScope, async assertScope =>
          deps.storage.transactionByAttempt(attemptId, current => {
            assertOpen(); assertAuthority(); assertScope();
            const existing = current.record ?? current.intent;
            if (existing) return { next: null, value: { source: existing, prevented: false } };
            const request = requestFor(current, suppliedTarget, expected, expectedScope, undefined, authority.continuationSourceAction?.(suppliedTarget));
            const intent = parseNativeWorkExecutionIntent({ version: 2, owner: ownerFacts(expected, expectedScope), projectId: deps.projectId,
              target: suppliedTarget, authorityScopes: expected.scopes, request, generation: 1, state: 'cancelled' });
            assertAuthority(); assertScope();
            return { next: null, nextIntent: intent, value: { source: intent, prevented: true } };
          })));
        source = reservation.source; preventedHere = reservation.prevented;
      }
      if (source.target.workId !== workId) throw new NativeWorkExecutionError('not-found');
      if (!preventedHere) inspectAuthority(source, authority);
      else if (!nativeExecutionOwnerMatches(source, ownerFacts(expected, expectedScope)) || !equalScopes(source.authorityScopes, expected.scopes)) throw new NativeWorkExecutionError('stale');
      const original = source, request = original.request;
      // Existing live source grants are retired before changing execution state.
      // The private owner rechecks this actual saved source under its own lock.
      const assertCancellation = () => {
        assertOpen(); const latest = deps.storage.currentByAttempt(attemptId, original), live = latest.record ?? latest.intent;
        if (!live || !sameDurableRequest(live.request, request)) throw new NativeWorkExecutionError('stale');
        // Publishing this exact unused-attempt prevention can retire its own CI
        // authority. Only its saved cancelled source may finish restrictive
        // bookkeeping; this never authorizes a new execution or another source.
        if (preventedHere) { if (live.state !== 'cancelled') throw new NativeWorkExecutionError('stale'); }
        else inspectAuthority(live, authority);
      };
      assertCancellation(); validated = true; validatedKey = durableKeyIdentity(request.key);
      if ('receipt' in original && original.receipt) contractIds.add(original.receipt.contractId);
      continuations.revokeSource(request, assertCancellation); privateRevocationCommitted = deps.continuationGrants !== undefined;
      if (!preventedHere) await authority.withCurrent(expected, async assertAuthority => deps.scopes.withCurrentScope(expectedScope, async assertScope =>
        deps.storage.transactionByAttempt(attemptId, current => {
          assertOpen(); assertAuthority(); assertScope();
          const existing = current.record ?? current.intent;
          if (existing) {
            if (existing.target.workId !== workId) throw new NativeWorkExecutionError('not-found');
            if (!sameDurableRequest(existing.request, request)) throw new NativeWorkExecutionError('stale');
            inspectAuthority(existing, authority); validated = true; validatedKey = durableKeyIdentity(existing.request.key);
            if (current.record?.receipt) contractIds.add(current.record.receipt.contractId);
            if (current.intent?.state === 'associated' && !current.record) throw new NativeWorkExecutionError('recovery-required');
            return { next: current.record && current.record.state !== 'cancelled' ? { ...current.record, state: 'cancelled' } : null,
              nextIntent: current.intent && current.intent.state !== 'cancelled' ? { ...current.intent, state: 'cancelled' } : null, value: undefined };
          }
          throw new NativeWorkExecutionError('stale');
        }, undefined, original)));
      else assertCancellation();
    } catch (error) {
      if (validated) { await Promise.allSettled([drain()]);
        // Revocation is durable, but do not acknowledge an unconfirmed native
        // cancellation write after this authority intentionally retired itself.
        if (privateRevocationCommitted) throw new NativeWorkExecutionError('recovery-required');
        if (!(error instanceof NativeWorkExecutionError)) throw new NativeWorkExecutionError('unavailable'); }
      throw error;
    }
    // Persist first, release locks, then abort and join real evaluation settlement.
    await drain();
  }
  async function retainReceipt(result: DurableStartedContract): Promise<DurableStartedContract> {
    const original = active.get(result.admission.key.attemptId)?.record;
    const cancelled = await deps.storage.transaction(result.admission.key, current => {
      const record = current.record;
      if (!record || durablePayloadRevision(record.request) !== result.admission.payloadRevision || !sameDurableRequest(record.request, result.admission)) throw new NativeWorkExecutionError('conflict');
      if (record.receipt && (record.receipt.contractId !== result.admission.contractId || record.receipt.ownerAgentId !== result.admission.ownerAgentId)) throw new NativeWorkExecutionError('conflict');
      // The engine may remember a launch whose native acknowledgement was lost.
      // Never turn that replay into a fresh prepared operation or permission to resume.
      const state = record.state === 'prepared' && result.state !== 'prepared' ? 'launch-claimed' as const : record.state;
      const { input: _input, ...receipt } = result.admission;
      return { next: record.receipt && state === record.state ? null : { ...record, receipt, state }, value: record.state === 'cancelled' };
    }, undefined, original);
    if (cancelled || closed) await cancelAndJoin(result.admission.contractId, 'Native work was cancelled during admission');
    if (!closed) {
      const key = durableKeyIdentity(result.admission.key), owner = active.get(result.admission.key.attemptId);
      if (owner) owner.payloadRevision = result.admission.payloadRevision;
      if (owner && !recordRetirements.has(key)) {
        const retirement = track(async () => {
          await requireRunner().join(result.admission.contractId); await deps.joinForeground?.(result.admission.contractId);
          await requireRunner().joinDurable?.(result.admission.key);
          if (active.get(result.admission.key.attemptId) === owner) owner.record = undefined;
        });
        recordRetirements.set(key, retirement);
        const release = () => { if (recordRetirements.get(key) === retirement) recordRetirements.delete(key); };
        void retirement.then(release, release);
      }
    }
    return result;
  }
  const continuations = createNativeCiContinuationHost({ projectId: deps.projectId, projectRoot, storage: deps.storage,
    scopes: deps.scopes, ...(deps.continuationGrants ? { grants: deps.continuationGrants } : {}),
    ...(deps.continuationPolicy ? { policy: deps.continuationPolicy } : {}), signal: lifetime.signal,
    execution: () => host,
    sourceOwner(contract) {
      const key = contract.durableAdmission?.key; if (!key) throw new NativeWorkExecutionError('invalid');
      const owner = active.get(key.attemptId); const current = deps.storage.current(key, owner?.record);
      if (!owner || !current.record || current.record.receipt?.contractId !== contract.id
        || !sameDurableRequest(current.record.request, contract.durableAdmission!)) throw new NativeWorkExecutionError('recovery-required');
      const record = current.record;
      const assertCurrent = () => assertRecord(deps.storage.current(key, record), record, owner);
      assertCurrent(); return { record, authority: owner.authority, assertCurrent };
    },
    async joinOriginal(record) {
      if (!record.receipt) throw new NativeWorkExecutionError('unavailable');
      await requireRunner().join(record.receipt.contractId); await deps.joinForeground?.(record.receipt.contractId);
      await requireRunner().joinDurable?.(record.request.key);
    },
  });
  const host: NativeWorkExecutionHost = {
    recoverCiWatchOwner: watch => continuations.recover(watch),
    revokeCiWatch: watch => continuations.revokeWatch(watch),
    nativeOwner: { admission: { withCurrent }, decisions: { reserveCiContinuation: (contract, operation) => continuations.reserve(contract, operation), authorityOf(contract) {
      const key = contract.durableAdmission?.key; if (!key) throw new NativeWorkExecutionError('invalid');
      const owner = active.get(key.attemptId); const current = deps.storage.current(key, owner?.record);
      if (!owner || !current.record) throw new NativeWorkExecutionError('recovery-required');
      if ((!contract.durableAdmission || !sameDurableRequest(current.record.request, contract.durableAdmission))
        || (current.record.receipt && current.record.receipt.contractId !== contract.id)) throw new NativeWorkExecutionError('conflict');
      assertRecord(current, current.record, owner);
      const binding = current.record.request.binding;
      return { authorityId: binding.authorityId, authorityRevision: binding.authorityRevision, scopeId: binding.scopeId, scopeRevision: binding.scopeRevision };
    } } },
    attachRunner(value) { assertOpen(); if (runner) throw new NativeWorkExecutionError('conflict'); runner = value; },
    start(input, authority, options = {}) {
      const target = captureTarget(input);
      return ownedDelivery(target, authority, options.signal, async (delivery, signal) => {
        requireRunner(); let record = deps.storage.currentByAttempt(target.attemptId, active.get(target.attemptId)?.record).record;
        if (record) {
          if (!equalTarget(record.target, target) || record.state === 'cancelled') throw new NativeWorkExecutionError('conflict');
          inspectAuthority(record, authority);
        } else {
          const intent = await prepareIntent(target, authority, delivery, false, signal, options.taskEvidence);
          record = await decide(target, authority, signal, false, intent);
        }
        claimOwner(record, authority);
        const result = await requireRunner().startDurable(record.request);
        try { const retained = await retainReceipt(result); settleAfterCompletion(retained, authority); return retained; }
        catch (error) { await cancelAndJoin(result.admission.contractId, 'Native association could not be retained'); throw error; }
      });
    },
    status(key, authority) { assertOpen(); return status(deps.storage.current(key, active.get(key.attemptId)?.record), authority); },
    statusByAttempt(workId, attemptId, authority) {
      assertOpen(); const current = deps.storage.currentByAttempt(attemptId, active.get(attemptId)?.record);
      const stored = current.record ?? current.intent;
      if (!stored || stored.target.workId !== workId) throw new NativeWorkExecutionError('not-found');
      const retained = active.get(attemptId)?.payloadRevision;
      if (retained !== undefined && durablePayloadRevision(stored.request) !== retained) throw new NativeWorkExecutionError('stale');
      if (current.record) return status(current, authority);
      const intent = current.intent!; inspectAuthority(intent, authority);
      if (intent.state === 'associated') throw new NativeWorkExecutionError('recovery-required');
      const work = current.ledger.works.find(item => item.id === workId);
      const attempt = current.ledger.attempts.find(item => item.id === attemptId && item.workId === workId);
      const delivery = deliveries.get(deliveryIdentity(intent.target));
      return { kind: 'intent', intent, currentTarget: work && attempt ? { workId, attemptId, workRevision: work.revision, criteriaRevision: work.criteriaRevision, attemptRevision: attempt.revision } : null,
        currentAttempt: !!work && !!attempt && work.currentAttemptId === attemptId && attempt.state === 'active',
        recovery: intent.state === 'cancelled' ? 'cancelled' : intent.state === 'admitting' && delivery?.generation === intent.generation ? 'pending' : 'required' };
    },
    cancel(input, authority, reason) { const key = captureKey(input); return track(() => cancelAttempt(key.workId, key.attemptId, undefined, authority, reason)); },
    cancelTarget(input, authority, reason) { const target = captureTarget(input); return track(() => cancelAttempt(target.workId, target.attemptId, target, authority, reason)); },
    resume(input, authority, options = {}) {
      const key = captureKey(input); const current = deps.storage.currentByAttempt(key.attemptId, active.get(key.attemptId)?.record); const stored = current.record ?? current.intent;
      if (!stored) return Promise.reject(new NativeWorkExecutionError('not-found'));
      const retained = active.get(key.attemptId)?.payloadRevision;
      if (retained !== undefined && durablePayloadRevision(stored.request) !== retained) return Promise.reject(new NativeWorkExecutionError('stale'));
      if (durableKeyIdentity(stored.request.key) !== durableKeyIdentity(key)) return Promise.reject(new NativeWorkExecutionError('conflict'));
      return ownedDelivery(stored.target, authority, options.signal, async (delivery, signal) => {
        const latest = deps.storage.currentByAttempt(key.attemptId, stored);
        if (!latest.record) {
          const intent = await prepareIntent(stored.target, authority, delivery, true, signal);
          const record = await decide(stored.target, authority, signal, false, intent);
          claimOwner(record, authority); const retained = await retainReceipt(await requireRunner().startDurable(record.request)); settleAfterCompletion(retained, authority); return retained;
        }
        const existing = latest.record; inspectAuthority(existing, authority);
        if (existing.state === 'cancelled') throw new NativeWorkExecutionError('stale');
        if (existing.state === 'launch-claimed' && !active.get(key.attemptId)?.claimed) throw new NativeWorkExecutionError('recovery-required');
        signal.throwIfAborted();
        if (existing.state === 'prepared') await decide(existing.target, authority, signal, true);
        claimOwner(existing, authority);
        const retained = await retainReceipt(await requireRunner().resumeDurable(key)); settleAfterCompletion(retained, authority); return retained;
      });
    },
    settle,
    close() {
      if (closing) return closing; closed = true; const continuationDrain = continuations.close(); lifetime.abort();
      const contracts = runner?.list({ includeTerminal: false }) ?? [];
      for (const contract of contracts) if (contract.durableAdmission && active.has(contract.durableAdmission.key.attemptId)) runner?.cancel(contract.id, 'Native work host closed');
      closing = Promise.allSettled([continuationDrain, ...pending, ...contracts.map(contract => runner?.join(contract.id))]).then(() => { active.clear(); }); return closing;
    },
  };
  return host;
}

export { NativeWorkExecutionError };
export type { NativeWorkExecutionTarget, NativeWorkExecutionRecord, NativeWorkExecutionStorage, NativeWorkExecutionIntent };

export type { NativeWorkSettlementReceipt } from './native-settlement-types.js';
