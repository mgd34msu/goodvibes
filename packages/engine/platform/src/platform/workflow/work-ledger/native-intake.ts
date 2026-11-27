/** Durable original-input ownership before native work exists. Never starts execution. */
import { nativeSelectedDiffSelector, type NativeSelectedDiffSelector } from './native-diff-context.js';
import { decisionModelPolicyState } from '@goodvibes/engine/errors';
import { activateClassicFallback, isClassicOperation, takesDecisionFallback, withConfiguredDecisionModelPolicy } from '../../runtime/decision-policy.js';
import { captureNativeConversationContinuation, nativeConversationContinuationSchema, type NativeConversationContinuation } from './native-continuation-context.js';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJson, type DecisionLog, type EntryType, type JudgmentPort } from '@goodvibes/judgment';
import type { AutonomousDecision } from '../../gate/autonomous-decision.js';
import { holdsNativeOwnership, type NativeExecutionScope, type NativeExecutionScopeOwner, type NativePairedExecutionAuthority, type NativePairedExecutionSnapshot } from './native-execution.js';
import { createWorkLedger } from './service.js';
import type { WorkLedgerState, WorkLedgerSubmission } from './types.js';
import { readNativeIntakeRoute, decideNativeIntake, validateNativeRequirementProposal } from './native-intake-decisions.js';
import { NativeRequirementProposalUnreadable, type NativeRequirementProposer } from './native-intake-proposer.js';
import { nativeIntakeContinuationCatalog, nativeIntakeDecisionSite, recoverNativeIntakeDecision } from './native-intake-recovery.js';
export { createNativeRequirementProposer, NativeRequirementProposalUnreadable } from './native-intake-proposer.js';
export type { NativeRequirementProposer, NativeRequirementProposalRequest } from './native-intake-proposer.js';
import { NATIVE_CONVERSATION_MAX_PROPOSALS, NATIVE_CONVERSATION_MAX_DECISIONS, createNativeConversationCapture,
  nativeConversationProposalRevision, parseNativeConversationCapture, type NativeConversationCapture, type NativeConversationKey,
  nativeConversationDecisionBinding, type NativeConversationOwner, type NativeConversationStorage, type NativeConversationAttachment } from './native-intake-types.js';
import { resolveAttachments, type CompanionChatArtifactStore } from '../../companion/companion-chat-attachments.js';
import { MAX_ATTACHMENTS_PER_MESSAGE } from '../../companion/attachment-limits.js';
import { nativeConversationIntakeCaptureRequestSchema, nativeConversationIntakeLookupRequestSchema,
  nativeConversationIntakeTransitionRequestSchema, nativeConversationIntakeResultSchema, nativeConversationIntakeWorkReceiptSchema,
  type NativeConversationIntakeCaptureRequest, type NativeConversationIntakeLookupRequest, type NativeConversationIntakeTransitionRequest,
  type NativeConversationIntakeResult, type NativeConversationIntakeLookupResult, type NativeConversationIntakeWorkReceipt } from './native-intake-wire.js';
import { missingScopes } from '@goodvibes/engine/daemon-api/route-helpers';

type NativeConversationIntakeErrorCode = 'invalid' | 'unsupported-authority' | 'forbidden' | 'stale' | 'conflict' | 'request-conflict' | 'not-found' | 'recovery-required' | 'indeterminate' | 'unavailable' | 'closed';
const NEXT_STEP: Record<NativeConversationIntakeErrorCode, string> = {
  invalid: 'The request is malformed; correct it and send it again.',
  'unsupported-authority': 'Intake needs a native pairing token with read:work-ledger and write:work-ledger; pair with those scopes, then retry.',
  forbidden: 'This pairing may not use this input; pair with the scopes it needs (a continuation also needs write:sessions), then retry.',
  stale: 'Either the sourceRevision you sent is out of date (get the input and use its current sourceRevision), or the pairing or workspace registration the input was captured under has changed (restore it, or capture the content again under a new inputId).',
  conflict: 'A concurrent change won; get the input to read its state, then admit or resume it if it is still processing, or cancel it.',
  'request-conflict': 'This requestId or inputId already holds different content; replay the identical request, or capture the new content under new ids.',
  'not-found': 'No such input for this pairing; capture it first.',
  'recovery-required': 'An earlier attempt stopped mid-decision; resume the input, or cancel it and capture it again.',
  indeterminate: 'The result of publishing is unknown; get the input to read what was recorded before doing anything else, and do not resubmit blindly.',
  unavailable: 'A required owner is not available right now; retry shortly.',
  closed: 'The intake host is closing; retry once it is running again.',
};
const SETTLED_TURN = 'This input\'s turn was already dispatched and has finished, so it can never run again; capture a new input (new inputId) to ask again.';
export class NativeConversationIntakeError extends Error {
  constructor(readonly code: NativeConversationIntakeErrorCode, detail?: string) {
    super(`Native conversation intake: ${code}. ${detail ?? NEXT_STEP[code]}`); this.name = 'NativeConversationIntakeError';
  }
}
export interface NativeConversationContinuationOwner {
  capture(sessionId: string, principalId: string, selectedDiff?: NativeSelectedDiffSelector): Promise<NativeConversationContinuation>;
  /** Synchronous publication fence: same owner/workspace and exact captured transcript prefix. */
  assertCurrent(context: NativeConversationContinuation, principalId: string, source?: NativeConversationCapture): void;
}
export interface NativeConversationIntakeOptions {
  readonly signal?: AbortSignal;
  readonly isAuthorized?: () => boolean;
}
export interface NativeConversationIntakeHost {
  readonly projectId: string;
  capture(input: NativeConversationIntakeCaptureRequest, authority: NativePairedExecutionAuthority, options?: NativeConversationIntakeOptions): Promise<NativeConversationIntakeResult>;
  get(input: NativeConversationIntakeLookupRequest, authority: NativePairedExecutionAuthority, options?: NativeConversationIntakeOptions): Promise<NativeConversationIntakeLookupResult>;
  admit(input: NativeConversationIntakeTransitionRequest, authority: NativePairedExecutionAuthority, options?: NativeConversationIntakeOptions): Promise<NativeConversationIntakeResult>;
  resume(input: NativeConversationIntakeTransitionRequest, authority: NativePairedExecutionAuthority, options?: NativeConversationIntakeOptions): Promise<NativeConversationIntakeResult>;
  cancel(input: NativeConversationIntakeTransitionRequest, authority: NativePairedExecutionAuthority, options?: NativeConversationIntakeOptions): Promise<NativeConversationIntakeResult>;
  /**
   * Host-internal, never on the wire: record that the hosted turn of a `turn` input has ended. After this, admit and
   * resume refuse the input. Idempotent; refuses any input that is not a turn.
   */
  settle(input: NativeConversationIntakeTransitionRequest, authority: NativePairedExecutionAuthority, options?: NativeConversationIntakeOptions): Promise<void>;
  close(): Promise<void>;
}
const scopes = ['read:work-ledger', 'write:work-ledger'] as const;
function paired(authority: NativePairedExecutionAuthority): NativePairedExecutionSnapshot {
  const value = authority.current();
  if (!holdsNativeOwnership(value, scopes)) throw new NativeConversationIntakeError('unsupported-authority');
  return Object.freeze({ ...value, scopes: Object.freeze([...value.scopes].sort()) });
}
const contextReadScope = (selectedDiff: NativeSelectedDiffSelector | undefined) => selectedDiff ? selectedDiff.kind === 'session' ? 'read:sessions' : 'read:checkpoints' : undefined;
/** The scopes continuing a session needs: write:sessions, plus the read scope of the diff it carries. */
const continuationScopes = (selectedDiff: NativeSelectedDiffSelector | undefined): string[] => {
  const read = contextReadScope(selectedDiff);
  return read === undefined ? ['write:sessions'] : ['write:sessions', read];
};
/**
 * The owners one call established, once, when it started: the pairing it was
 * authorised under and the workspace scope. Every later write runs inside
 * `withOwners`, whose pairing and registry owners compare against these.
 */
interface Owners { readonly identity: NativePairedExecutionSnapshot; readonly scope: NativeExecutionScope; readonly facts: NativeConversationOwner }
const terminal = (record: NativeConversationCapture) => ['associated', 'turn', 'cancelled'].includes(record.state);

export function createNativeConversationIntakeHost(deps: {
  readonly projectId: string; readonly projectRoot: string; readonly sessionId: string;
  readonly continuation?: NativeConversationContinuationOwner;
  readonly storage: NativeConversationStorage; readonly scopes: NativeExecutionScopeOwner;
  readonly port: JudgmentPort; readonly decisionLog: Pick<DecisionLog, 'get' | 'query'>; readonly proposer: NativeRequirementProposer;
  /** The artifact store chat attachments live in (artifacts.create); a request's attachments are read from it, and nowhere else. */
  readonly artifacts?: Pick<CompanionChatArtifactStore, 'get'> | undefined;
}): NativeConversationIntakeHost {
  /** The attachments of a request, as the artifact store describes them now: the chat message's own check and limit. */
  const resolveRequestAttachments = (requested: NativeConversationIntakeCaptureRequest['attachments']): NativeConversationAttachment[] | undefined => {
    if (!requested) return undefined;
    if (!deps.artifacts) throw new NativeConversationIntakeError('unavailable', 'This daemon has no artifact store, so a request cannot carry files; send it without them.');
    let resolved: ReturnType<typeof resolveAttachments>;
    try { resolved = resolveAttachments(requested, { get: id => deps.artifacts!.get(id), readContent: () => Promise.reject(new Error('not read at capture')) }); }
    catch (error) { throw new NativeConversationIntakeError('invalid', `${error instanceof Error ? error.message : 'An attachment was refused'}; upload it with artifacts.create and send its artifactId.`); }
    return resolved.map(attachment => ({ artifactId: attachment.artifactId, ...(attachment.label ? { label: attachment.label } : {}),
      ...(attachment.filename ? { filename: attachment.filename } : {}), mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes }));
  };
  const root = realpathSync(deps.projectRoot);
  const lifetime = new AbortController(); const pending = new Set<Promise<unknown>>();
  const captures = new Map<string, Promise<NativeConversationCapture>>();
  const deliveries = new Map<string, { controller: AbortController; promise: Promise<NativeConversationIntakeResult>; generation?: number }>();
  let closed = false; let closing: Promise<void> | undefined;
  const assertOpen = () => { if (closed) throw new NativeConversationIntakeError('closed'); };
  const keyOf = (inputId: string, owners: Owners): NativeConversationKey => ({ principalId: owners.identity.principalId, inputId });
  const keyId = (key: NativeConversationKey) => JSON.stringify({ principalId: key.principalId, inputId: key.inputId });
  function track<T>(operation: () => Promise<T>): Promise<T> {
    assertOpen(); const promise = Promise.resolve().then(() => withConfiguredDecisionModelPolicy(operation)); pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
  }
  function owner(authority: NativePairedExecutionAuthority, options: NativeConversationIntakeOptions): Owners {
    assertOpen();
    if (options.isAuthorized && options.isAuthorized() !== true) throw new NativeConversationIntakeError('forbidden');
    const identity = paired(authority); const scope = deps.scopes.currentScope(root);
    if (scope.root !== root) throw new NativeConversationIntakeError('stale');
    return { identity, scope, facts: { authorityId: identity.authorityId, authorityRevision: identity.authorityRevision,
      authorityScopes: [...identity.scopes], scopeId: scope.scopeId, scopeRevision: scope.scopeRevision, projectRoot: root } };
  }
  /** The record belongs to these owners. Compares values the call already holds; reads nothing. */
  function inspect(record: NativeConversationCapture, current: Owners): void {
    if (record.projectId !== deps.projectId || record.principalId !== current.identity.principalId || record.sessionId !== deps.sessionId
      || !isDeepStrictEqual(record.owner, current.facts)) throw new NativeConversationIntakeError('stale');
    if (record.continuation) {
      if (missingScopes(current.identity.scopes, continuationScopes(record.continuation.selectedDiff)).length > 0) throw new NativeConversationIntakeError('forbidden');
    }
  }
  function assertContinuation(record: NativeConversationCapture): void {
    if (!record.continuation) return;
    if (!deps.continuation) throw new NativeConversationIntakeError('unavailable');
    deps.continuation.assertCurrent(record.continuation, record.principalId, record);
  }
  function load(key: NativeConversationKey, owners: Owners, revision?: string, original?: NativeConversationCapture): NativeConversationCapture {
    const value = deps.storage.current(original ?? key);
    const record = value === null ? null : parseNativeConversationCapture(value, original);
    if (!record) throw new NativeConversationIntakeError('not-found');
    inspect(record, owners);
    if (revision !== undefined && revision !== record.sourceRevision) throw new NativeConversationIntakeError('stale');
    return record;
  }
  /**
   * Runs one write holding the pairing and the workspace registration the call
   * started under: each owner compares its current state with `owners` once,
   * and the storage transaction compares the record's generation. That is the
   * only currency check a write needs.
   */
  async function withOwners<T>(owners: Owners, authority: NativePairedExecutionAuthority, options: NativeConversationIntakeOptions,
    operation: (assertCurrent: () => void) => Promise<T>): Promise<T> {
    return authority.withCurrent(owners.identity, assertAuthority => deps.scopes.withCurrentScope(owners.scope, assertScope => {
      const assertCurrent = () => {
        assertOpen();
        if (options.isAuthorized && options.isAuthorized() !== true) throw new NativeConversationIntakeError('forbidden');
        assertAuthority(); assertScope();
      };
      assertCurrent(); return operation(assertCurrent);
    }));
  }
  async function receipt(record: NativeConversationCapture): Promise<NativeConversationIntakeWorkReceipt> {
    if (!record.association) throw new NativeConversationIntakeError('unavailable');
    const storage = deps.storage.publicationStorage(record, () => { throw new NativeConversationIntakeError('invalid'); }, () => { throw new NativeConversationIntakeError('invalid'); });
    try {
      // The store validated this ledger where it read it; the association names the one event.
      const state = await storage.read() as WorkLedgerState;
      const event = state.history[record.association.ledgerRevision - 1];
      if (event?.actorId !== record.principalId || event.requestId !== record.requestId) throw new NativeConversationIntakeError('unavailable');
      if (!event || event.type !== 'submit_native' || event.work.source?.version !== 2 || !event.attemptId
        || event.workId !== record.association.workId || event.attemptId !== record.association.attemptId || event.sequence !== record.association.ledgerRevision) throw new NativeConversationIntakeError('unavailable');
      return projectReceipt(event as WorkLedgerSubmission);
    } finally { await storage.close(); }
  }
  function projectReceipt(event: WorkLedgerSubmission): NativeConversationIntakeWorkReceipt {
    const source = event.work.source;
    if (source.version !== 2) throw new NativeConversationIntakeError('unavailable');
    const attempt = event.attempts.find(item => item.id === event.attemptId);
    if (!attempt) throw new NativeConversationIntakeError('unavailable');
    return nativeConversationIntakeWorkReceiptSchema.parse({ projectId: deps.projectId, requestId: event.requestId,
      inputId: source.inputId, ledgerRevision: event.sequence, workId: event.workId, attemptId: event.attemptId,
      expectedRevision: { work: event.work.revision, criteria: event.work.criteriaRevision, attempt: attempt.revision },
      source: { version: 2, sourceId: source.sourceId, sourceRevision: source.sourceRevision, sessionId: source.sessionId,
        ...(source.continuation ? { continuation: source.continuation } : {}),
        ...(source.attachments ? { attachments: source.attachments } : {}),
        offsetEncoding: source.extraction.offsetEncoding, proposalRevision: source.extraction.proposalRevision, spans: source.extraction.spans,
        admissionDecisionId: source.extraction.admissionDecisionId, judgmentDecisionIds: source.extraction.judgmentDecisionIds },
      goal: event.work.goal, criteria: event.work.criteria });
  }
  async function projection(record: NativeConversationCapture): Promise<NativeConversationIntakeResult> {
    const common = { projectId: record.projectId, requestId: record.requestId,
      sourceRef: { version: 1 as const, inputId: record.inputId, sourceId: record.sourceId, sourceRevision: record.sourceRevision, sessionId: record.sessionId,
        ...(record.classic ? { classic: record.classic } : {}),
        ...(record.continuation ? { continuation: { ...(record.continuation.version === 2 ? { version: 2 as const } : {}), sessionId: record.continuation.sessionId, revision: record.continuation.revision, ...(record.continuation.selectedDiff ? { selectedDiff: nativeSelectedDiffSelector(record.continuation.selectedDiff) } : {}) } } : {}) } };
    switch (record.state) {
      case 'captured': return { kind: 'captured', ...common };
      case 'processing': return { kind: 'processing', ...common, stage: record.stage ?? 'routing', recovery: deliveries.get(keyId(record))?.generation === record.generation ? 'pending' : 'required' };
      case 'turn': if (record.route === 'converse' || record.route === 'answer') return { kind: 'turn', ...common, route: record.route, text: record.text, ...(record.continuation ? { continuation: nativeConversationContinuationSchema.parse(record.continuation) } : {}),
        ...(record.attachments ? { attachments: record.attachments.map(attachment => ({ ...attachment })) } : {}) }; break;
      case 'blocked': return { kind: 'blocked', ...common, reason: record.reason === 'unsupported-source' ? 'unsupported-source' : 'missing-context', recovery: 'required', next: 'cancel-and-resubmit' };
      case 'refused': return { kind: 'refused', ...common, reason: record.reason === 'exhausted' || record.reason === 'decision-model' ? record.reason : 'semantic' };
      case 'cancelled': return { kind: 'cancelled', ...common };
      case 'associated': return { kind: 'work', ...common, receipt: await receipt(record) };
    }
    throw new NativeConversationIntakeError('unavailable');
  }
  function assertRecorded(autonomous: AutonomousDecision): void {
    for (const id of autonomous.decision.judgmentDecisionIds) {
      const entry = deps.decisionLog.get(id);
      if (!entry || entry.status !== 'answered' || !entry.notes.some(note => note.kind === 'readings' && note.readings !== null
        && typeof note.readings === 'object' && !Array.isArray(note.readings)
        && canonicalJson(note.readings['autonomousDecision']) === canonicalJson(autonomous.decision as unknown as EntryType))) throw new NativeConversationIntakeError('unavailable');
    }
  }
  async function run(key: NativeConversationKey, revision: string, authority: NativePairedExecutionAuthority, options: NativeConversationIntakeOptions,
    controller: AbortController, resuming: boolean, original: NativeConversationCapture, owners: Owners): Promise<NativeConversationIntakeResult> {
    let record = original;
    if (record.settled) throw new NativeConversationIntakeError('conflict', SETTLED_TURN);
    if (terminal(record) || record.state === 'blocked' || record.state === 'refused' || (!resuming && record.state !== 'captured')) return projection(record);
    assertContinuation(record);
    const signal = AbortSignal.any([lifetime.signal, controller.signal, ...(options.signal ? [options.signal] : [])]);
    signal.throwIfAborted();
    record = await withOwners(owners, authority, options, assertOwners => deps.storage.transaction(record, original => {
      assertOwners(); signal.throwIfAborted(); assertContinuation(record);
      if (!original || original.generation !== record.generation || terminal(original)) throw new NativeConversationIntakeError('conflict');
      let current = original;
      if (resuming && current.state === 'processing' && current.stage === 'deciding') {
        // Reconcile and claim the next generation in the SAME owner transaction.
        // A previous async reader cannot publish between these two boundaries.
        const recovery = recoverNativeIntakeDecision(current, deps.decisionLog);
        if (recovery.kind === 'partial') throw new NativeConversationIntakeError('recovery-required');
        if (recovery.kind === 'recorded') {
          const { decision } = recovery.entry;
          const decisions = current.decisions.some(entry => entry.decision.decisionId === decision.decisionId)
            ? current.decisions : [...current.decisions, recovery.entry];
          const catalog = nativeIntakeContinuationCatalog(current);
          let change: Partial<NativeConversationCapture>;
          if (decision.outcome === 'reject') change = { state: current.unsupportedSources.length ? 'blocked' : 'refused', stage: null,
            reason: current.unsupportedSources.length ? 'unsupported-source' : current.proposalsSpent >= NATIVE_CONVERSATION_MAX_PROPOSALS ? 'exhausted' : 'semantic' };
          else if (decision.outcome === 'revise' && isDeepStrictEqual(decision.next, catalog.resolve.ref)) change = { state: 'blocked', stage: null,
            reason: current.unsupportedSources.length ? 'unsupported-source' : 'missing-context' };
          else if (decision.outcome === 'revise' && catalog.continuations.includes(catalog.repair) && isDeepStrictEqual(decision.next, catalog.repair.ref)) change = { stage: 'extracting', proposal: null };
          else if (decision.outcome === 'act') change = { stage: 'checking' }; // Resume freshly evaluates; never replay act.
          else throw new NativeConversationIntakeError('recovery-required');
          current = parseNativeConversationCapture({ ...current, ...change, decisions }, record);
        }
      }
      if (current.state === 'blocked' || current.state === 'refused') return { next: isDeepStrictEqual(current, original) ? null : current, value: current };
      const next = parseNativeConversationCapture({ ...current, generation: current.generation + 1, state: 'processing', stage: 'routing', reason: null }, record);
      return { next, value: next };
    }));
    if (record.state !== 'processing') return projection(record);
    const generation = record.generation; const delivery = deliveries.get(keyId(key)); if (delivery) delivery.generation = generation;
    // Between writes the owners are not re-read: "still wanted" is the abort
    // signal (cancel, close, the request ending or its credential revoked), and
    // each write below re-checks owners and generation in its own transaction.
    const assertCurrent = () => { decisionModelPolicyState(); signal.throwIfAborted(); };
    let terminalUpdate: NativeConversationCapture | undefined;
    /** One write of this generation. A terminal one also passes the continuation's publication fence. */
    async function update(change: Partial<NativeConversationCapture>) {
      record = await withOwners(owners, authority, options, assertOwners => deps.storage.transaction(record, current => {
        assertOwners(); assertCurrent();
        if (!current || current.generation !== generation || current.state !== 'processing') throw new NativeConversationIntakeError('stale');
        const next = parseNativeConversationCapture({ ...current, ...change }, record);
        if (next.state !== 'processing') { assertContinuation(next); terminalUpdate = next; }
        return { next, value: next };
      }));
    }
    async function classicConversation(): Promise<NativeConversationIntakeResult> {
      assertCurrent();
      const policy = decisionModelPolicyState();
      if (policy.operation !== 'no-decision-model' || (policy.policy === 'Decision Model Only' && policy.reason !== 'not-set') || policy.reason === null
        || record.association || record.decisions.some(entry => entry.decision.outcome === 'reject')) throw new NativeConversationIntakeError('forbidden');
      if (record.unsupportedSources.length) {
        await update({ state: 'blocked', stage: null, reason: 'unsupported-source' });
      } else {
        await update({ state: 'turn', stage: null, route: 'converse', reason: null,
          classic: { provenance: 'owner', policy: policy.policy, reason: policy.reason } });
      }
      return projection(record);
    }
    try {
      if (isClassicOperation()) return await classicConversation();
      // An input with a source the intake cannot carry can never act: settle it
      // now instead of spending a routing and a decision reading to learn that.
      if (record.unsupportedSources.length) {
        await update({ state: 'blocked', stage: null, reason: 'unsupported-source' });
        return projection(record);
      }
      const routeEvidence = await readNativeIntakeRoute({ text: record.text, sourceRevision: record.sourceRevision, ...(record.continuation ? { continuation: record.continuation } : {}), sourceIssues: record.unsupportedSources,
        port: deps.port, decisionLog: deps.decisionLog, binding: nativeConversationDecisionBinding(record, 'routing'), assertCurrent, signal });
      assertCurrent();
      // The route is written with the next stage: resume re-reads the route, so
      // it needs no write of its own.
      let pending: Partial<NativeConversationCapture> = { route: routeEvidence.route };
      let previous: unknown = null;
      for (;;) {
        assertCurrent();
        if (record.decisions.length >= NATIVE_CONVERSATION_MAX_DECISIONS) { await update({ ...pending, state: 'refused', stage: null, reason: 'exhausted' }); return projection(record); }
        let requirements: ReturnType<typeof validateNativeRequirementProposal> | undefined;
        if (routeEvidence.settled && routeEvidence.route === 'contract' && record.unsupportedSources.length === 0) {
          if (record.proposal) requirements = validateNativeRequirementProposal(record.text, record.sourceRevision, record.proposal);
          else if (record.proposalsSpent < NATIVE_CONVERSATION_MAX_PROPOSALS) {
            await update({ ...pending, stage: 'extracting' }); pending = {};
            // The attempt is charged only once the provider has answered: an outage
            // must not use up the budget and end the input as "exhausted". A reply
            // that holds no readable JSON is an answered attempt and goes back for repair.
            const attemptNumber = record.proposalsSpent + 1;
            let proposed: unknown;
            try { proposed = await deps.proposer.propose({ text: record.text, sourceRevision: record.sourceRevision,
              attempt: attemptNumber, previous, signal, assertCurrent }); }
            catch (error) {
              if (!(error instanceof NativeRequirementProposalUnreadable)) throw error;
              assertCurrent();
              await update({ proposalsSpent: attemptNumber });
              previous = { spans: null, problems: ['unreadable'] };
              continue;
            }
            assertCurrent();
            try { requirements = validateNativeRequirementProposal(record.text, record.sourceRevision, proposed); }
            catch { /* Invalid proposals remain evidence of a failed attempt, never new roots. */ }
            await update({ proposalsSpent: attemptNumber, ...(requirements?.proposal.spans.length ? { proposal: requirements.proposal } : {}) });
          }
        }
        // This durable stage precedes the final reading and owns its recovery lookup.
        await update({ ...pending, stage: 'deciding' }); pending = {};
        const { repair, resolve, continuations } = nativeIntakeContinuationCatalog(record);
        const result = await decideNativeIntake({ text: record.text, sourceRevision: record.sourceRevision, ...(record.continuation ? { continuation: record.continuation } : {}), routeEvidence,
          ...(requirements ? { requirements } : {}), port: deps.port, decisionLog: deps.decisionLog,
          binding: nativeConversationDecisionBinding(record, routeEvidence.route === 'contract' ? 'publish-work' : 'ordinary-turn'), continuations, conditions: [],
          decisionSite: nativeIntakeDecisionSite(record), allowAct: record.unsupportedSources.length === 0, sourceIssues: record.unsupportedSources, assertCurrent, signal });
        assertCurrent(); result.autonomous.assertCurrent(); assertRecorded(result.autonomous);
        const decision = result.autonomous.decision;
        const decisions = [...record.decisions, { decision, context: result.autonomous.context }];
        if (decision.outcome === 'revise' && decision.next.id === repair.ref.id && decision.next.revision === repair.ref.revision
          && continuations.includes(repair)) {
          previous = { spans: record.proposal?.spans ?? null, problems: result.problems };
          await update({ stage: 'extracting', decisions, proposal: null }); continue;
        }
        if (decision.outcome === 'revise' && decision.next.id === resolve.ref.id && decision.next.revision === resolve.ref.revision) {
          // This registered resolver has exactly one supported source: the captured text.
          // It cannot replace an absent attachment/context with generated prose.
          await update({ state: 'blocked', stage: null, decisions, reason: record.unsupportedSources.length ? 'unsupported-source' : 'missing-context' });
          return projection(record);
        }
        if (decision.outcome !== 'act') {
          await update({ state: record.unsupportedSources.length ? 'blocked' : 'refused', stage: null, decisions,
            reason: record.unsupportedSources.length ? 'unsupported-source' : record.proposalsSpent >= NATIVE_CONVERSATION_MAX_PROPOSALS ? 'exhausted' : 'semantic' });
          return projection(record);
        }
        if (record.unsupportedSources.length) throw new NativeConversationIntakeError('unavailable');
        if (routeEvidence.route !== 'contract') {
          record = await withOwners(owners, authority, options, assertOwners => deps.storage.transaction(record, current => {
            assertOwners(); assertCurrent(); result.autonomous.recordClaim(); assertRecorded(result.autonomous);
            if (!current || current.generation !== generation) throw new NativeConversationIntakeError('stale');
            const next = parseNativeConversationCapture({ ...current, state: 'turn', stage: null, decisions }, record);
            assertContinuation(next); terminalUpdate = next; return { next, value: next };
          }));
          return projection(record);
        }
        if (!requirements?.criteria.length || !record.proposal) throw new NativeConversationIntakeError('unavailable');
        // The act decision is written with the association, in the publishing transaction.
        record = await publish(record, decisions, result.autonomous, requirements.criteria, authority, options, owners, signal, assertCurrent,
          next => { terminalUpdate = next; });
        return projection(record);
      }
    } catch (error) {
      signal.throwIfAborted();
      if (terminalUpdate) {
        const current = load(key, owners, revision, record); assertContinuation(current);
        // A lost acknowledgement cannot turn our exact durable terminal record
        // into a stale processing attempt or a new Classic conversation.
        if (isDeepStrictEqual(current, terminalUpdate)) throw error;
      }
      assertCurrent();
      if (!terminalUpdate && !record.association && !record.decisions.some(entry => entry.decision.outcome === 'reject') && activateClassicFallback(error))
        return await classicConversation();
      // The decision model could not answer and "When the decision model is missing or fails" is Decision Model Only: the message is refused, said
      // as such, never left "still being taken" (an unknown outcome) for a person to settle.
      if (!terminalUpdate && !record.association && takesDecisionFallback(error)) {
        await update({ state: 'refused', stage: null, reason: 'decision-model' });
        return projection(record);
      }
      throw error;
    }
  }
  async function publish(record: NativeConversationCapture, decisions: NativeConversationCapture['decisions'], decision: AutonomousDecision, criteria: readonly string[],
    authority: NativePairedExecutionAuthority, options: NativeConversationIntakeOptions, owners: Owners, signal: AbortSignal, assertCurrent: () => void,
    prepareTerminalUpdate: (next: NativeConversationCapture) => void): Promise<NativeConversationCapture> {
    if (!record.proposal || decision.decision.outcome !== 'act') throw new NativeConversationIntakeError('invalid');
    const source = { version: 2 as const, sourceId: record.sourceId, sourceRevision: record.sourceRevision, inputId: record.inputId, sessionId: record.sessionId,
      ...(record.continuation ? { continuation: nativeConversationContinuationSchema.parse(record.continuation) } : {}),
      // The work carries the request's files by id, so whoever does it receives them (the same artifacts; no copy).
      ...(record.attachments ? { attachments: record.attachments.map(attachment => ({ ...attachment })) } : {}),
      extraction: { version: 1 as const, offsetEncoding: 'utf16' as const, spans: [...record.proposal.spans], proposalRevision: nativeConversationProposalRevision(record.proposal),
        admissionDecisionId: decision.decision.decisionId, judgmentDecisionIds: [...decision.decision.judgmentDecisionIds] } };
    let published: NativeConversationCapture | undefined;
    const storage = deps.storage.publicationStorage(record, current => {
      assertCurrent(); decision.assertCurrent(); assertRecorded(decision);
      if (current.generation !== record.generation || current.state !== 'processing' || !isDeepStrictEqual(current.proposal, record.proposal)) throw new NativeConversationIntakeError('stale');
    }, (current, event) => {
      decision.recordClaim(); assertCurrent(); assertRecorded(decision);
      const next = parseNativeConversationCapture({ ...current, state: 'associated', stage: null, decisions,
        association: { workId: event.workId, attemptId: event.attemptId, ledgerRevision: event.sequence } }, record);
      assertContinuation(next); prepareTerminalUpdate(next); published = next; return next;
    });
    const ledger = createWorkLedger({ projectId: deps.projectId, storage, clock: { now: Date.now, newId: kind => `${kind}-${randomUUID()}` } });
    const actor = ledger.authority.issueActor({ actorId: record.principalId, projectId: deps.projectId, role: 'coordinator' });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        assertCurrent(); const snapshot = await ledger.service.readSnapshot(actor); assertCurrent();
        const result = await withOwners(owners, authority, options, assertOwners => ledger.service.execute({ type: 'submit_native', requestId: record.requestId,
          expectedRevision: snapshot.revision, title: record.text.trim(), goal: record.text, criteria: [...criteria], source }, actor,
        { signal, isAuthorized: () => { assertOwners(); assertCurrent(); return true; } }));
        if (result.kind === 'accepted') {
          if (!published) throw new NativeConversationIntakeError('indeterminate');
          return published;
        }
        if (result.kind === 'indeterminate') throw new NativeConversationIntakeError('indeterminate');
        if (result.code !== 'conflict') throw new NativeConversationIntakeError(result.code === 'request_conflict' ? 'request-conflict' : 'unavailable');
      }
      throw new NativeConversationIntakeError('conflict');
    } finally { ledger.authority.revokeActor(actor); await ledger.service.close(); await storage.close(); }
  }
  async function deliver(input: NativeConversationIntakeTransitionRequest, authority: NativePairedExecutionAuthority, options: NativeConversationIntakeOptions, resuming: boolean): Promise<NativeConversationIntakeResult> {
    const parsed = nativeConversationIntakeTransitionRequestSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new NativeConversationIntakeError('invalid'));
    const owners = owner(authority, options);
    const key = keyOf(parsed.data.inputId, owners); const existing = deliveries.get(keyId(key));
    const original = load(key, owners, parsed.data.sourceRevision);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const promise = track(() => run(key, parsed.data.sourceRevision, authority, options, controller, resuming, original, owners))
      .then(result => nativeConversationIntakeResultSchema.parse(result));
    const delivery = { controller, promise }; deliveries.set(keyId(key), delivery);
    void promise.then(() => { if (deliveries.get(keyId(key)) === delivery) deliveries.delete(keyId(key)); }, () => { if (deliveries.get(keyId(key)) === delivery) deliveries.delete(keyId(key)); });
    return promise;
  }
  return {
    projectId: deps.projectId,
    capture(input, authority, options = {}) {
      // Said plainly before the schema check, which would only call the request malformed.
      const sent = input && typeof input === 'object' && Array.isArray((input as { attachments?: unknown }).attachments) ? (input as { attachments: unknown[] }).attachments.length : 0;
      if (sent > MAX_ATTACHMENTS_PER_MESSAGE) {
        return Promise.reject(new NativeConversationIntakeError('invalid', `A request can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} files, the same as a chat message; this one has ${sent}. Send it with ${MAX_ATTACHMENTS_PER_MESSAGE} or fewer.`));
      }
      const parsed = nativeConversationIntakeCaptureRequestSchema.safeParse(input);
      if (!parsed.success) return Promise.reject(new NativeConversationIntakeError('invalid'));
      return track(async () => {
        options.signal?.throwIfAborted(); const current = owner(authority, options); const { continuation: selection, attachments: requestedAttachments, ...original } = parsed.data;
        const sameAttachments = (existing: NativeConversationCapture) => isDeepStrictEqual(
          existing.attachments?.map(attachment => ({ artifactId: attachment.artifactId, ...(attachment.label ? { label: attachment.label } : {}) })),
          requestedAttachments?.map(attachment => ({ artifactId: attachment.artifactId, ...(attachment.label?.trim() ? { label: attachment.label.trim() } : {}) })));
        if (selection && missingScopes(current.identity.scopes, continuationScopes(selection.selectedDiff)).length > 0) throw new NativeConversationIntakeError('forbidden');
        const key = { principalId: current.identity.principalId, inputId: original.inputId };
        const matches = (existing: NativeConversationCapture) => existing.requestId === original.requestId && existing.text === original.text
          && isDeepStrictEqual(existing.unsupportedSources, original.unsupportedSources) && sameAttachments(existing) && existing.continuation?.sessionId === selection?.sessionId
          && isDeepStrictEqual(existing.continuation?.selectedDiff ? nativeSelectedDiffSelector(existing.continuation.selectedDiff) : undefined, selection?.selectedDiff);
        // Replayed capture retains its original checkpoint even when later turns appended.
        const priorValue = deps.storage.current(key), prior = priorValue === null ? null : parseNativeConversationCapture(priorValue);
        if (prior) { inspect(prior, current); if (!matches(prior)) throw new NativeConversationIntakeError('request-conflict'); return projection(prior); }
        const captureKey = keyId(key);
        const pending = captures.get(captureKey);
        if (pending) {
          const existing = await pending;
          options.signal?.throwIfAborted();
          inspect(existing, current);
          if (!matches(existing)) throw new NativeConversationIntakeError('request-conflict');
          return projection(existing);
        }
        const capture = (async () => {
          if (selection && !deps.continuation) throw new NativeConversationIntakeError('unavailable');
          const attachments = resolveRequestAttachments(requestedAttachments);
          const continuation = selection ? captureNativeConversationContinuation(await deps.continuation!.capture(selection.sessionId, current.identity.principalId, selection.selectedDiff)) : undefined;
          if (continuation && (continuation.sessionId !== selection?.sessionId || !isDeepStrictEqual(continuation.selectedDiff ? nativeSelectedDiffSelector(continuation.selectedDiff) : undefined, selection?.selectedDiff))) throw new NativeConversationIntakeError('stale');
          const record = createNativeConversationCapture({ projectId: deps.projectId, principalId: current.identity.principalId,
            ...original, ...(continuation ? { continuation } : {}), ...(attachments ? { attachments } : {}),
            sessionId: deps.sessionId, owner: current.facts, generation: 1, state: 'captured', stage: null, route: null, reason: null,
            proposalsSpent: 0, proposal: null, decisions: [], association: null });
          // Before initial publication another host may have captured this same
          // input. Adopt its already-persisted identity only after exact replay
          // matching; the unpublished candidate is not its original-source fence.
          return withOwners(current, authority, options, assertCurrent => deps.storage.transaction(key, existing => {
            assertCurrent();
            if (existing) {
              const capturedExisting = parseNativeConversationCapture(existing);
              inspect(capturedExisting, current);
              if (!matches(capturedExisting)) throw new NativeConversationIntakeError('request-conflict');
              return { next: null, value: capturedExisting };
            }
            assertContinuation(record); return { next: record, value: record };
          }));
        })();
        captures.set(captureKey, capture);
        let stored: NativeConversationCapture;
        try { stored = await capture; } finally { if (captures.get(captureKey) === capture) captures.delete(captureKey); }
        // The shared capture is not tied to any one caller's signal (a second
        // caller must not inherit the first one's abort); each caller honours its own here.
        options.signal?.throwIfAborted();
        inspect(stored, current); return projection(stored);
      });
    },
    get(input, authority, options = {}) {
      const parsed = nativeConversationIntakeLookupRequestSchema.safeParse(input);
      if (!parsed.success) return Promise.reject(new NativeConversationIntakeError('invalid'));
      return track(async () => {
        options.signal?.throwIfAborted(); const owners = owner(authority, options);
        const value = deps.storage.current(keyOf(parsed.data.inputId, owners)); if (value === null) return { kind: 'not-found' };
        const record = parseNativeConversationCapture(value);
        inspect(record, owners); return projection(record);
      });
    },
    admit(input, authority, options = {}) { return deliver(input, authority, options, false); },
    resume(input, authority, options = {}) { return deliver(input, authority, options, true); },
    settle(input, authority, options = {}) {
      const parsed = nativeConversationIntakeTransitionRequestSchema.safeParse(input);
      if (!parsed.success) return Promise.reject(new NativeConversationIntakeError('invalid'));
      return track(async () => {
        const owners = owner(authority, options);
        const key = keyOf(parsed.data.inputId, owners); const record = load(key, owners, parsed.data.sourceRevision);
        if (record.state !== 'turn') throw new NativeConversationIntakeError('conflict', `Only a dispatched turn can be settled; this input is ${record.state}.`);
        await withOwners(owners, authority, options, assertCurrent => deps.storage.transaction(record, current => {
          assertCurrent(); if (!current) throw new NativeConversationIntakeError('not-found'); inspect(current, owners);
          if (current.state !== 'turn' || current.generation !== record.generation) throw new NativeConversationIntakeError('stale');
          if (current.settled) return { next: null, value: undefined };
          return { next: parseNativeConversationCapture({ ...current, settled: true }, record), value: undefined };
        }));
      });
    },
    cancel(input, authority, options = {}) {
      const parsed = nativeConversationIntakeTransitionRequestSchema.safeParse(input);
      if (!parsed.success) return Promise.reject(new NativeConversationIntakeError('invalid'));
      return track(async () => {
        const owners = owner(authority, options);
        const key = keyOf(parsed.data.inputId, owners); const record = load(key, owners, parsed.data.sourceRevision);
        const delivery = deliveries.get(keyId(key)); let validated = false;
        try {
          const result = await withOwners(owners, authority, options, assertCurrent => deps.storage.transaction(record, current => {
            assertCurrent(); if (!current) throw new NativeConversationIntakeError('not-found'); inspect(current, owners); validated = true;
            if (terminal(current)) return { next: null, value: current };
            const next = parseNativeConversationCapture({ ...current, generation: current.generation + 1, state: 'cancelled', stage: null }, record);
            return { next, value: next };
          }));
          if (result.state === 'cancelled') { delivery?.controller.abort(); if (delivery) await Promise.allSettled([delivery.promise]); }
          return projection(result);
        } catch (error) {
          // After ambiguous durable publication, prevent local old-generation continuation too.
          if (validated) { delivery?.controller.abort(); if (delivery) await Promise.allSettled([delivery.promise]); }
          throw error;
        }
      });
    },
    close() {
      if (closing) return closing; closed = true; lifetime.abort();
      for (const delivery of deliveries.values()) delivery.controller.abort();
      closing = Promise.allSettled([...pending]).then(() => {}); return closing;
    },
  };
}
