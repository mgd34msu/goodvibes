/** Current native source + strict dispatch journal + actual hosted turn ownership. */
import { createHash, randomUUID } from 'node:crypto';
import { canonicalNativeConversationContinuation, captureNativeConversationContinuation } from '../workflow/work-ledger/native-continuation-context.js';
import { captureNativeSelectedDiffContext, selectNativeDiffHunk, NativeSelectedDiffError } from '../workflow/work-ledger/native-diff-context.js';
import type { WorkspaceCheckpointManager } from '../workspace/checkpoint/manager.js';
import { readlinkSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { redactDiagnosticText } from '../utils/redaction.js';
import { readNativeConversationTurnStatus } from '../core/native-turn-admission.js';
import type { OperatorRemoteClient } from '@goodvibes-jev/engine/operator-client';
import { createOperatorNativeConversationIntakeClient, type NativeConversationTurnPermit, type NativeConversationTurnSource } from '../workflow/work-ledger/native-intake-client.js';
import type { NativeConversationIntakeHost, NativeConversationContinuationOwner } from '../workflow/work-ledger/native-intake.js';
import type { NativePairedExecutionAuthority, NativePairedExecutionSnapshot } from '../workflow/work-ledger/native-execution.js';
import type { SharedSessionBroker } from '../control-plane/session-broker.js';
import type { HostedSessionManager } from './manager.js';
import { NativeHostedTurnJournal, NativeHostedTurnJournalError, isTerminalNativeHostedTurnState, type NativeHostedTurnFailure, type NativeHostedTurnIdentity, type NativeHostedTurnDispatch, type NativeHostedTurnOriginSurface } from './native-turn-journal.js';
import { nativeHostedTurnRequestSchema, nativeHostedTurnStartRequestSchema, type NativeHostedTurnRequest, type NativeHostedTurnStartRequest, type NativeHostedTurnLookup, type NativeHostedTurnSnapshot, type NativeHostedSessionLookup } from './native-turn-wire.js';
import type { GatePresetName } from '../gate/presets.js';

import { NATIVE_HOSTED_TURN_SCOPES } from '../control-plane/method-catalog-native-hosted-turn.js';
export { NATIVE_HOSTED_TURN_SCOPES };
type NativeHostedTurnErrorCode = 'invalid' | 'forbidden' | 'unavailable' | 'not-turn' | 'stale' | 'closed' | 'recovery-required';
const NEXT_STEP: Record<NativeHostedTurnErrorCode, string> = {
  invalid: 'The request is malformed; correct it and send it again.',
  forbidden: `This pairing lacks the authority for native hosted turns (${NATIVE_HOSTED_TURN_SCOPES.join(', ')}); pair with those scopes, then retry.`,
  unavailable: 'The host could not read this turn\'s dispatch record; read its status again.',
  'not-turn': 'This input is not an admitted conversation turn; inspect its intake state before starting it.',
  stale: 'The source, session or pairing changed since it was read; read the current status and start from the current source.',
  closed: 'The host is closing or this turn was cancelled; start a new turn once the host is available.',
  'recovery-required': 'A turn on this session has no live owner on this host; cancel that turn, then continue the session.',
};
export class NativeHostedTurnError extends Error {
  constructor(readonly code: NativeHostedTurnErrorCode, detail?: string) {
    super(`Native hosted turn: ${code}. ${NEXT_STEP[code]}${detail ? ` ${detail}` : ''}`); this.name = 'NativeHostedTurnError';
  }
}

/** Random per process: with the pid, it proves a claim's owner process has exited. */
const PROCESS_INSTANCE = randomUUID();
const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};
/** Machine and pid namespace of this process: a pid in another container or host means nothing here. */
export const NATIVE_HOST_IDENTITY = (() => {
  let namespace = '';
  try { namespace = readlinkSync('/proc/self/ns/pid'); } catch { /* not Linux, or not readable: the hostname alone */ }
  return `${hostname()}|${namespace}`;
})();
const BROKER_TERMINAL = new Set(['completed', 'failed', 'cancelled']);
export interface NativeHostedTurnOptions {
  readonly signal?: AbortSignal;
  readonly isAuthorized: () => boolean;
}
export interface NativeHostedTurnDependencies {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly intake: Pick<NativeConversationIntakeHost, 'get' | 'admit'> & Partial<Pick<NativeConversationIntakeHost, 'settle'>>;
  readonly journalPath: string;
  readonly checkpoints?: Pick<WorkspaceCheckpointManager, 'init' | 'workspaceRoot' | 'sessionChanges' | 'diff'>;
  readonly installContinuationOwner?: (owner: NativeConversationContinuationOwner) => void;
}
interface NativeTurnOwnership {
  cancelled: boolean;
  /** Set only when the runtime confirmed it aborted this turn while it was still running; a turn that already finished is not interrupted. */
  interrupted: boolean;
  controller: AbortController;
  sessionId: string | null;
  brokerInputId: string | null;
  permit: NativeConversationTurnPermit | null;
  done: Promise<void>;
  /** Set when the turn's runtime ran and ended in an error. */
  failure?: NativeHostedTurnFailure;
}
export function createNativeHostedTurnHost(deps: NativeHostedTurnDependencies & {
  readonly manager: Pick<HostedSessionManager, 'create' | 'deliverNative' | 'cancelNative' | 'kill' | 'get' | 'captureNativeContinuation' | 'assertNativeContinuation' | 'waitForNativeAvailability'> & Partial<Pick<HostedSessionManager, 'withNativeContinuationDiff'>>;
  readonly broker: Pick<SharedSessionBroker, 'reserveNativeTurnInput' | 'getInputsSince' | 'settleNativeTurnInput'>;
  readonly journal?: NativeHostedTurnJournal;
}) {
  const projectRoot = realpathSync(deps.projectRoot);
  const journal = deps.journal ?? new NativeHostedTurnJournal(deps.journalPath);
  const active = new Map<string, NativeTurnOwnership>();
  /** Claims this host created. Only the claimer may dispatch, so one not in `active` has no live owner. */
  const claimedHere = new Set<string>();
  /** Turns whose owner lifetime ended before their broker reservation could be durably settled; the permit lets a later cancel finish the settlement. */
  const stranded = new Map<string, NativeTurnOwnership>();
  let lastSettleRefusal: string | null = null;
  let claims = Promise.resolve();
  const starting = new Map<string, { readonly identity: NativeHostedTurnIdentity; readonly originSurface: NativeHostedTurnOriginSurface; readonly promise: Promise<NativeHostedTurnLookup> }>();
  const sessionTails = new Map<string, Promise<void>>();
  const provenSessionOwners = new Map<string, { readonly principalId: string; readonly originSurface: NativeHostedTurnOriginSurface }>();
  let closed = false;
  const sameAuthority = (a: NativePairedExecutionSnapshot, b: NativePairedExecutionSnapshot) => a.principalId === b.principalId && a.authorityId === b.authorityId && a.authorityRevision === b.authorityRevision && JSON.stringify([...a.scopes].sort()) === JSON.stringify([...b.scopes].sort());
  const keyOf = (identity: NativeHostedTurnIdentity) => JSON.stringify([identity.projectId, identity.principalId, identity.inputId]);
  function authorize(authority: NativePairedExecutionAuthority, options: NativeHostedTurnOptions) {
    if (closed) throw new NativeHostedTurnError('closed');
    const value = authority.current();
    if (!options.isAuthorized() || !value || value.kind !== 'pairing-token' || value.principalId !== value.authorityId
      || value.authorityRevision !== value.tokenId || !NATIVE_HOSTED_TURN_SCOPES.every(scope => value.scopes.includes('*') || value.scopes.includes(scope))) throw new NativeHostedTurnError('forbidden');
    return value;
  }
  function assertSession(sessionId: string, principalId: string, originSurface?: NativeHostedTurnOriginSurface) {
    if (closed) throw new NativeHostedTurnError('closed');
    const session = deps.manager.get(sessionId);
    const owner = provenSessionOwners.get(sessionId);
    if (owner?.principalId !== principalId || !session || session.status === 'terminated'
      || session.originSurface !== owner.originSurface || (originSurface !== undefined && originSurface !== owner.originSurface)
      || realpathSync(session.workspaceRoot) !== projectRoot || realpathSync(deps.projectRoot) !== projectRoot) throw new NativeHostedTurnError('stale');
    return session;
  }
  async function proveSession(sessionId: string, principalId: string, allowRecovery = false, originSurface?: NativeHostedTurnOriginSurface) {
    const records = await journal.sessionRecords(sessionId);
    const root = records.find(record => record.sessionId === sessionId && record.identity.continuationSessionId === undefined);
    if (!root) throw new NativeHostedTurnError('stale');
    const surface = root.originSurface ?? 'webui';
    if ((originSurface !== undefined && originSurface !== surface) || records.some(record =>
      !(record.state === 'cancelled' && record.sessionId === null) && (record.originSurface ?? 'webui') !== surface)) throw new NativeHostedTurnError('stale');
    if (records.some(record => record.identity.projectId !== deps.projectId || record.identity.principalId !== principalId)) throw new NativeHostedTurnError('forbidden');
    if (!allowRecovery && records.some(record => !isTerminalNativeHostedTurnState(record.state) && !active.has(keyOf(record.identity)))) throw new NativeHostedTurnError('recovery-required');
    for (const proven of provenSessionOwners.keys()) {
      const known = deps.manager.get(proven);
      if (!known || known.status === 'terminated') provenSessionOwners.delete(proven);
    }
    provenSessionOwners.set(sessionId, { principalId, originSurface: surface });
    if (allowRecovery) {
      const session = deps.manager.get(sessionId);
      if (!session || session.originSurface !== surface || realpathSync(session.workspaceRoot) !== projectRoot || realpathSync(deps.projectRoot) !== projectRoot) throw new NativeHostedTurnError('stale');
      return session;
    }
    return assertSession(sessionId, principalId, originSurface);
  }
  const continuation: NativeConversationContinuationOwner = {
    async capture(sessionId, principalId, selection) {
      await proveSession(sessionId, principalId);
      let context = await deps.manager.captureNativeContinuation(sessionId);
      if (selection) {
        const checkpoints = deps.checkpoints;
        if (!checkpoints) throw new NativeSelectedDiffError('missing');
        await checkpoints.init();
        if (realpathSync(checkpoints.workspaceRoot) !== projectRoot) throw new NativeHostedTurnError('stale');
        assertSession(sessionId, principalId);
        const diff = selection.kind === 'session' ? await checkpoints.sessionChanges(sessionId) : await checkpoints.diff(selection.baselineId).catch((error: unknown) => {
          if (error instanceof Error && error.message.startsWith('WorkspaceCheckpointManager: no checkpoint found with id ')) throw new NativeSelectedDiffError('missing');
          throw error;
        });
        assertSession(sessionId, principalId);
        if (realpathSync(checkpoints.workspaceRoot) !== projectRoot) throw new NativeHostedTurnError('stale');
        if (selection.kind === 'session' && (!('sessionId' in diff) || !('checkpointCount' in diff) || diff.sessionId !== sessionId || typeof diff.checkpointCount !== 'number' || diff.checkpointCount < 1 || diff.to === 'EMPTY')) throw new NativeSelectedDiffError('missing');
        if (selection.kind === 'workspace' && (diff.from !== selection.baselineId || diff.to !== 'WORKING')) throw new NativeSelectedDiffError('stale');
        if (diff.nativeRevision === undefined || diff.nativeRevision !== selection.revision) throw new NativeSelectedDiffError('stale');
        const selectedDiff = captureNativeSelectedDiffContext({ ...selection, unifiedDiff: selectNativeDiffHunk(diff.unifiedDiff, selection.fileIndex, selection.hunkIndex),
          provenance: selection.kind === 'session' ? { kind: 'session', sessionId, baselineCheckpointId: diff.from, latestCheckpointId: diff.to }
            : { kind: 'workspace', baselineId: diff.from, to: 'WORKING' } });
        if (deps.manager.withNativeContinuationDiff) context = deps.manager.withNativeContinuationDiff(context, selectedDiff);
        else {
          if (context.version === 2) throw new NativeHostedTurnError('unavailable');
          // Only historical embedded managers without v2 native issuance use
          // their original content-bound continuation protocol.
          context = captureNativeConversationContinuation({ ...context, selectedDiff,
            revision: createHash('sha256').update(canonicalNativeConversationContinuation(sessionId, context.messages, selectedDiff)).digest('hex') });
        }
      }
      assertSession(sessionId, principalId);
      deps.manager.assertNativeContinuation(context);
      return context;
    },
    assertCurrent(context, principalId, source) {
      assertSession(context.sessionId, principalId);
      deps.manager.assertNativeContinuation(context, source);
    },
  };
  deps.installContinuationOwner?.(continuation);
  async function session(sessionId: string, authority: NativePairedExecutionAuthority | undefined, options: NativeHostedTurnOptions): Promise<NativeHostedSessionLookup> {
    if (closed) throw new NativeHostedTurnError('closed');
    const records = await journal.sessionRecords(sessionId);
    if (!records.length) {
      if (deps.manager.get(sessionId)?.nativeConversation || deps.broker.getInputsSince(sessionId).some(input => input.metadata?.['nativeConversation'] !== undefined)) throw new NativeHostedTurnError('recovery-required');
      return { kind: 'legacy' };
    }
    if (!authority) throw new NativeHostedTurnError('forbidden');
    const principal = authorize(authority, options);
    const owned = await proveSession(sessionId, principal.principalId, true);
    return { kind: 'native', projectId: deps.projectId, sessionId, busy: owned.status === 'running' || sessionTails.has(sessionId) };
  }
  const localInputs = () => [...active.keys()].map(key => (JSON.parse(key) as [string, string, string])[2]);
  /** Records the end of a hosted turn on its intake capture, so intake alone refuses a replay. Best effort: unsettled only means the journal record stays. */
  async function settleIntake(identity: NativeHostedTurnIdentity, authority: NativePairedExecutionAuthority, options: NativeHostedTurnOptions): Promise<boolean> {
    if (!deps.intake.settle) return false;
    try {
      await deps.intake.settle({ inputId: identity.inputId, sourceRevision: identity.sourceRevision }, authority, { isAuthorized: options.isAuthorized });
      return true;
    } catch (error) {
      // The same refusal repeats for every turn until the cause is fixed; say it once.
      const reason = error instanceof Error ? error.message : String(error);
      if (reason !== lastSettleRefusal) {
        lastSettleRefusal = reason;
        logger.warn('Native turn left unsettled on intake; its journal record is kept', { inputId: identity.inputId, reason });
      }
      return false;
    }
  }
  /**
   * Before a claim, when the journal is near a cap, drop records that are terminal here and
   * durably settled on intake. Settling is attempted first, so a crash between a terminal
   * journal write and its intake write heals here instead of pinning the record forever.
   * Only the caller's own principal can be read; others are kept. Never drops a live turn.
   */
  async function compactJournal(principalId: string, authority: NativePairedExecutionAuthority, options: NativeHostedTurnOptions): Promise<void> {
    if (!deps.intake.settle) return;
    const { nearCap, terminal } = await journal.census();
    if (!nearCap) return;
    const finished: NativeHostedTurnIdentity[] = [];
    for (const record of terminal) {
      if (record.identity.projectId !== deps.projectId || record.identity.principalId !== principalId || active.has(keyOf(record.identity))) continue;
      if (await settleIntake(record.identity, authority, options)) finished.push(record.identity);
    }
    await journal.compact(finished, (record, owner) => active.has(keyOf(record.identity))
      || (owner !== null && owner.instance !== PROCESS_INSTANCE && owner.pid !== process.pid && processAlive(owner.pid)));
  }
  async function claimOwned(identity: NativeHostedTurnIdentity, originSurface: NativeHostedTurnOriginSurface, owned: NativeTurnOwnership, reserve: () => void,
    authority: NativePairedExecutionAuthority, options: NativeHostedTurnOptions): Promise<boolean> {
    const previous = claims;
    let release = () => {};
    claims = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      await compactJournal(identity.principalId, authority, options).catch(() => {});
      const claimed = await journal.claim(identity, localInputs(), originSurface, { pid: process.pid, instance: PROCESS_INSTANCE, host: NATIVE_HOST_IDENTITY });
      if (claimed) { active.set(keyOf(identity), owned); claimedHere.add(keyOf(identity)); reserve(); }
      return claimed;
    } catch (error) {
      if (error instanceof NativeHostedTurnJournalError && error.code === 'surface-conflict') throw new NativeHostedTurnError('stale');
      throw error;
    } finally { release(); }
  }
  async function waitPredecessor(previous: Promise<void> | undefined, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!previous) return;
    let cancel = () => {};
    const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); });
    try { await Promise.race([previous, aborted]); signal.throwIfAborted(); }
    finally { signal.removeEventListener('abort', cancel); }
  }
  async function sourceOf(input: NativeHostedTurnRequest, authority: NativePairedExecutionAuthority, options: NativeHostedTurnOptions) {
    const request = nativeHostedTurnRequestSchema.parse(input);
    if (request.projectId !== deps.projectId) throw new NativeHostedTurnError('stale');
    // Authority is read once here; the intake owner checks its own on the read below.
    const principal = authorize(authority, options);
    const result = await deps.intake.get({ inputId: request.inputId }, authority, { isAuthorized: options.isAuthorized });
    if (result.kind !== 'turn') throw new NativeHostedTurnError('not-turn');
    if (result.projectId !== request.projectId || result.sourceRef.inputId !== request.inputId || result.sourceRef.sourceRevision !== request.sourceRevision) throw new NativeHostedTurnError('stale');
    const identity: NativeHostedTurnIdentity = { projectId: deps.projectId, principalId: principal.principalId, requestId: result.requestId,
      inputId: result.sourceRef.inputId, sourceId: result.sourceRef.sourceId, sourceRevision: result.sourceRef.sourceRevision, sourceSessionId: result.sourceRef.sessionId,
      ...(result.sourceRef.continuation ? { continuationSessionId: result.sourceRef.continuation.sessionId } : {}) };

    return { source: result, identity, binding: Object.freeze({ ...principal, scopes: Object.freeze([...principal.scopes]) }) };
  }
  function project(record: NativeHostedTurnDispatch): NativeHostedTurnSnapshot {
    const live = active.get(keyOf(record.identity));
    const state = record.state === 'queued' ? live ? live.cancelled ? 'cancelling' : 'queued' : 'recovery-required' : record.state === 'dispatching' ? live ? live.cancelled ? 'cancelling' : 'running' : 'recovery-required'
      : record.state === 'preparing' && !live ? 'recovery-required' : record.state;
    return { projectId: record.identity.projectId, requestId: record.identity.requestId, inputId: record.identity.inputId,
      sourceRevision: record.identity.sourceRevision, state, sessionId: record.sessionId, brokerInputId: record.brokerInputId, correlationId: record.correlationId,
      ...(record.failure ? { failure: record.failure } : {}) };
  }
  async function status(input: NativeHostedTurnRequest, authority: NativePairedExecutionAuthority, options: NativeHostedTurnOptions): Promise<NativeHostedTurnLookup> {
    const { identity } = await sourceOf(input, authority, options);
    const record = await journal.read(identity); authorize(authority, options);
    return record ? project(record) : { kind: 'not-found' };
  }
  async function start(input: NativeHostedTurnStartRequest, authority: NativePairedExecutionAuthority, options: NativeHostedTurnOptions): Promise<NativeHostedTurnLookup> {
    return startForSurface('webui', input, authority, options);
  }
  async function startAgent(input: NativeHostedTurnStartRequest, authority: NativePairedExecutionAuthority, options: NativeHostedTurnOptions): Promise<NativeHostedTurnLookup> {
    return startForSurface('agent', input, authority, options);
  }
  async function startForSurface(originSurface: NativeHostedTurnOriginSurface, input: NativeHostedTurnStartRequest, authority: NativePairedExecutionAuthority, options: NativeHostedTurnOptions): Promise<NativeHostedTurnLookup> {
    options.signal?.throwIfAborted();
    const { permissionMode, ...sourceRequest } = nativeHostedTurnStartRequestSchema.parse(input);
    const { source, identity, binding } = await sourceOf(sourceRequest, authority, options);
    const key = keyOf(identity), pending = starting.get(key);
    if (pending) {
      if (pending.originSurface !== originSurface || JSON.stringify(pending.identity) !== JSON.stringify(identity)) throw new NativeHostedTurnError('stale');
      return pending.promise;
    }
    const run = prepare(source, identity, originSurface, authority, binding, options, permissionMode);
    starting.set(key, { identity, originSurface, promise: run });
    try { return await run; } finally { if (starting.get(key)?.promise === run) starting.delete(key); }
  }
  async function prepare(source: NativeConversationTurnSource, identity: NativeHostedTurnIdentity, originSurface: NativeHostedTurnOriginSurface, authority: NativePairedExecutionAuthority, binding: NativePairedExecutionSnapshot, options: NativeHostedTurnOptions, permissionMode?: GatePresetName): Promise<NativeHostedTurnLookup> {
    const key = keyOf(identity);
    // Each fact is established once: authority at entry and immediately before
    // dispatch; session ownership by one journal proof before admission (the
    // cached owner after that); the transcript prefix once, inside the session
    // lane, right before dispatch. The lane serialises turns on a session, so
    // nothing between those points can change what they established.
    const assertCurrent = () => {
      if (!sameAuthority(binding, authorize(authority, options))) throw new NativeHostedTurnError('stale');
    };
    options.signal?.throwIfAborted(); assertCurrent();
    let previous: Promise<void> | undefined;
    let releaseSlot = () => {};
    let slot: Promise<void> | undefined;
    const reserve = (sessionId: string) => {
      previous = sessionTails.get(sessionId);
      const ownDrain = new Promise<void>(resolve => { releaseSlot = resolve; });
      const barrier = previous ? Promise.all([previous, ownDrain]).then(() => {}) : ownDrain;
      slot = barrier;
      sessionTails.set(sessionId, barrier);
      void barrier.then(() => { if (sessionTails.get(sessionId) === barrier) sessionTails.delete(sessionId); });
    };
    const owned: NativeTurnOwnership = { cancelled: false, interrupted: false, controller: new AbortController(), sessionId: null, brokerInputId: null, permit: null, done: Promise.resolve() };
    if (!await claimOwned(identity, originSurface, owned, () => { if (identity.continuationSessionId) reserve(identity.continuationSessionId); }, authority, options)) {
      const record = await journal.read(identity);
      if (!record) throw new NativeHostedTurnError('unavailable');
      return project(record);
    }
    // This adapter reaches the actual owner with its opaque transport-created
    // authority. It does not replay a serialized receipt or mint from a lookup.
    const invoke = (async (method: string) => {
      if (owned.cancelled) throw new NativeHostedTurnError('closed');
      const result = method === 'workLedger.intake.admit'
        ? await deps.intake.admit({ inputId: identity.inputId, sourceRevision: identity.sourceRevision }, authority, { isAuthorized: options.isAuthorized })
        : method === 'workLedger.intake.get' ? await deps.intake.get({ inputId: identity.inputId }, authority, { isAuthorized: options.isAuthorized })
        : undefined;
      if (!result) throw new NativeHostedTurnError('invalid');
      return result;
    }) as OperatorRemoteClient['invoke'];
    const client = createOperatorNativeConversationIntakeClient({ invoke }, deps.projectId);
    let createdNewSession = false;
    try {
      if (source.continuation) await proveSession(source.continuation.sessionId, identity.principalId, false, originSurface);
      // Terminal admission replay neither rerolls Jev nor changes source evidence.
      const eligible = await client.admit({ inputId: identity.inputId, sourceRevision: identity.sourceRevision });
      if (eligible.kind !== 'turn' || JSON.stringify(eligible) !== JSON.stringify(source)) throw new NativeHostedTurnError('stale');
      // Intake's public projection crosses schema/JSON capture. Its v2 context
      // carries saved-source provenance through this exact issued permit.
      const permit = client.bindTurn(eligible);
      owned.permit = permit;
      options.signal?.throwIfAborted();
      if (owned.cancelled) throw new NativeHostedTurnError('closed');
      const session = source.continuation
        ? assertSession(source.continuation.sessionId, identity.principalId, originSurface)
        : await deps.manager.create({ workspaceRoot: projectRoot, title: 'Native conversation', originSurface, detachPolicy: 'survive' }, { nativeConversation: true, ...(permissionMode === undefined ? {} : { permissionMode }) });
      createdNewSession = !source.continuation;
      owned.sessionId = session.id;
      if (session.originSurface !== originSurface || realpathSync(session.workspaceRoot) !== projectRoot || realpathSync(deps.projectRoot) !== projectRoot) throw new NativeHostedTurnError('stale');
      if (owned.cancelled) throw new NativeHostedTurnError('closed');
      if (!slot) reserve(session.id);
      const queued = source.continuation !== undefined && (previous !== undefined || session.status === 'running');
      const input = await deps.broker.reserveNativeTurnInput(session.id, permit);
      owned.brokerInputId = input.id;
      const dispatch = { state: queued ? 'queued' as const : 'dispatching' as const, sessionId: session.id, brokerInputId: input.id, correlationId: input.correlationId };
      await journal.transition(identity, 'preparing', dispatch);
      if (owned.cancelled) throw new NativeHostedTurnError('closed');
      // Starts asynchronously after the strict claim. The request may detach;
      // this owner, not the HTTP response or browser, owns the actual lifetime.
      owned.done = Promise.resolve().then(async () => {
        if (owned.cancelled || closed) throw new NativeHostedTurnError('closed');
        await waitPredecessor(previous, owned.controller.signal);
        await deps.manager.waitForNativeAvailability(session.id, owned.controller.signal);
        if (queued) await journal.transition(identity, 'queued', { ...dispatch, state: 'dispatching' });
        // The one check before dispatch: authority, the session's owner, and the
        // transcript prefix the continuation was captured from.
        assertCurrent();
        if (source.continuation) {
          assertSession(session.id, identity.principalId, originSurface);
          deps.manager.assertNativeContinuation(source.continuation, permit);
        }
        if (owned.cancelled || closed) throw new NativeHostedTurnError('closed');
        try { await deps.manager.deliverNative(session.id, input.id, permit); }
        catch (error) {
          // The runtime ran this turn and it ended in an error. Admission knows
          // whether it failed before any effect, which makes it safe to start again.
          if (!owned.cancelled && !owned.interrupted) {
            owned.failure = { summary: redactDiagnosticText(summarizeError(error)).slice(0, 1000), retryable: readNativeConversationTurnStatus(permit) === 'retryable' };
          }
          throw error;
        }
        // A cancel or close that arrives after the turn finished and was saved did not stop it: record the completion.
        if (owned.interrupted) {
          const terminal = await deps.broker.settleNativeTurnInput(session.id, input.id, permit, 'cancelled');
          if (terminal.state !== 'cancelled') throw new NativeHostedTurnError('recovery-required');
          const record = await journal.read(identity);
          if (record && !isTerminalNativeHostedTurnState(record.state)) await journal.transition(identity, record.state, { ...dispatch, state: 'cancelled' });
          return;
        }
        const current = deps.broker.getInputsSince(session.id).find(item => item.id === input.id);
        if (!current || current.state !== 'delivered' || current.body !== source.text || current.correlationId !== input.correlationId) throw new NativeHostedTurnError('recovery-required');
        const terminal = await deps.broker.settleNativeTurnInput(session.id, input.id, permit, 'completed');
        if (terminal.state !== 'completed') throw new NativeHostedTurnError('recovery-required');
        await journal.transition(identity, 'dispatching', { ...dispatch, state: 'completed' });
      }).catch(async (error: unknown) => {
        logger.warn('[hosted-sessions] native hosted turn ended without completing', {
          inputId: identity.inputId, sessionId: session.id, cancelled: owned.cancelled,
          ...(owned.failure ? { failure: owned.failure.summary, retryable: owned.failure.retryable } : { error: redactDiagnosticText(summarizeError(error)) }) });
        stranded.set(key, owned);
        const brokerState = deps.broker.getInputsSince(session.id).find(item => item.id === input.id)?.state;
        // A strict settlement failure may leave visible in-memory terminal
        // state. Reconfirm it through the exact-owned durable operation; merely
        // reading that state must not turn a failed fsync into cancellation.
        const expected = brokerState === 'completed' || brokerState === 'failed' || brokerState === 'cancelled'
          ? brokerState : owned.cancelled ? 'cancelled' : 'failed';
        const terminal = await deps.broker.settleNativeTurnInput(session.id, input.id, permit, expected);
        if (terminal.state !== expected) throw new NativeHostedTurnError('recovery-required');
        const record = await journal.read(identity);
        if (record && (record.state === 'preparing' || record.state === 'queued' || record.state === 'dispatching')) {
          // A turn its owner ran to an error is `failed` and does not lock the
          // session. Only a turn whose outcome nobody knows needs recovery.
          const bound = { sessionId: record.sessionId, brokerInputId: record.brokerInputId, correlationId: record.correlationId };
          if (owned.cancelled) await journal.transition(identity, record.state, { state: 'cancelled', ...bound });
          else if (owned.failure) await journal.transition(identity, record.state, { state: 'failed', ...bound }, owned.failure);
          else await journal.transition(identity, record.state, { state: 'recovery-required', ...bound });
        }
        stranded.delete(key);
      }).finally(async () => {
        if (active.get(key) === owned) active.delete(key); releaseSlot(); client.dispose();
        // The journal is written first: a crash between the two leaves the record un-evictable, never replayable.
        const record = await journal.read(identity).catch(() => null);
        if (record && isTerminalNativeHostedTurnState(record.state)) {
          claimedHere.delete(key);
          // A failure that may be retried leaves intake open, so the same input can start again.
          if (record.failure?.retryable !== true) await settleIntake(identity, authority, options);
        }
      });
      // Observe persistence failures without pretending they succeeded. Status
      // retains the durable claim and reports recovery-required after this drains.
      void owned.done.catch(() => {});
      return project({ identity, ...dispatch });
    } catch (error) {
      // No native runtime was dispatched on this preparation failure. Release
      // the empty session so a cancelled/revoked preparation cannot exhaust capacity.
      let reservationSettled = owned.brokerInputId === null;
      if (owned.sessionId && owned.brokerInputId && owned.permit) {
        const expected = owned.cancelled ? 'cancelled' : 'failed';
        reservationSettled = await deps.broker.settleNativeTurnInput(owned.sessionId, owned.brokerInputId, owned.permit, expected)
          .then(terminal => terminal.state === expected, () => false);
        // Keep the permit so a later cancel in this process can retry the settlement instead of staying recovery-required.
        if (!reservationSettled) stranded.set(key, owned);
      }
      if (createdNewSession && owned.sessionId) await deps.manager.kill(owned.sessionId).catch(() => {});
      // Retire the claim, or it would stay non-terminal with no owner and
      // block every later turn on its session. Only once any reservation is
      // durably settled; otherwise the record honestly stays unresolved.
      // A transient refusal (the source or pairing moved, or the record could not
      // be read) is not a verdict on the input: it stays unsettled so a later
      // cancel decides, instead of being cancelled and settled here for good.
      const transient = error instanceof NativeHostedTurnError && !owned.cancelled && (error.code === 'unavailable' || error.code === 'stale');
      let outcome = error;
      if (reservationSettled) {
        if (transient) {
          await parkUndispatched(identity).catch(() => {});
          outcome = new NativeHostedTurnError(error.code, 'Preparation did not finish and the input was not cancelled; read its status, and cancel it to release the session.');
        } else {
          await retireUndispatched(identity).catch(() => {});
          const record = await journal.read(identity).catch(() => null);
          if (record?.state === 'cancelled') {
            claimedHere.delete(key);
            await settleIntake(identity, authority, options);
            if (error instanceof NativeHostedTurnError) outcome = new NativeHostedTurnError(error.code, 'The input was cancelled and cannot be started again.');
          }
        }
      }
      releaseSlot();
      active.delete(key); client.dispose();
      throw outcome;
    }
  }
  /** A claim whose preparation failed for a transient reason is held as recovery-required, so only an explicit cancel ends it. */
  async function parkUndispatched(identity: NativeHostedTurnIdentity): Promise<void> {
    const record = await journal.read(identity);
    if (!record || !['preparing', 'queued', 'dispatching'].includes(record.state)) return;
    try { await journal.transition(identity, record.state, { state: 'recovery-required', sessionId: record.sessionId, brokerInputId: record.brokerInputId, correlationId: record.correlationId }); }
    catch (error) { if (!(error instanceof NativeHostedTurnJournalError) || error.code !== 'conflict') throw error; }
  }
  /** A claim whose preparation failed before dispatch becomes cancelled; a concurrent move wins. */
  async function retireUndispatched(identity: NativeHostedTurnIdentity): Promise<void> {
    const record = await journal.read(identity);
    if (!record || !['preparing', 'queued', 'dispatching'].includes(record.state)) return;
    try { await journal.transition(identity, record.state, { state: 'cancelled', sessionId: record.sessionId, brokerInputId: record.brokerInputId, correlationId: record.correlationId }); }
    catch (error) { if (!(error instanceof NativeHostedTurnJournalError) || error.code !== 'conflict') throw error; }
  }
  /**
   * Whether a non-terminal record with no live owner here may be cancelled.
   * Never inferred from `active` alone: another daemon may be dispatching it.
   * Proof is either this host's own claim whose lifetime ended after durably
   * settling its reservation (`recovery-required`), or a claim whose recorded
   * owner process has exited and whose reservation is no longer pending.
   */
  async function settleStranded(record: NativeHostedTurnDispatch, key: string): Promise<boolean> {
    const owned = stranded.get(key);
    if (!owned?.sessionId || !owned.brokerInputId || !owned.permit) return false;
    const visible = deps.broker.getInputsSince(owned.sessionId).find(item => item.id === owned.brokerInputId)?.state;
    const expected = visible === 'completed' || visible === 'failed' ? visible : 'cancelled';
    try {
      const terminal = await deps.broker.settleNativeTurnInput(owned.sessionId, owned.brokerInputId, owned.permit, expected);
      if (terminal.state !== expected) return false;
      if (expected === 'completed' && !isTerminalNativeHostedTurnState(record.state)) {
        await journal.transition(record.identity, record.state, { state: 'completed', sessionId: record.sessionId, brokerInputId: record.brokerInputId, correlationId: record.correlationId });
      }
    } catch { return false; }
    stranded.delete(key);
    return true;
  }
  async function ownerEnded(record: NativeHostedTurnDispatch, key: string): Promise<boolean> {
    if (starting.has(key)) return false;
    if (claimedHere.has(key)) {
      if (record.state === 'recovery-required') return true;
      // This host claimed it and its owner lifetime is over (it is neither live nor starting), but a failed
      // durable write left the reservation or the record unsettled. Finish that settlement with the retained
      // permit; if the write still fails, the turn honestly stays recovery-required.
      return !active.has(key) && await settleStranded(record, key);
    }
    const owner = await journal.owner(record.identity);
    // Unknown host (a record that does not say) or another host: this machine cannot see that process, so it is kept.
    if (!owner || owner.host !== NATIVE_HOST_IDENTITY || owner.instance === PROCESS_INSTANCE || (owner.pid !== process.pid && processAlive(owner.pid))) return false;
    if (record.sessionId === null || record.brokerInputId === null) return true;
    const reservation = deps.broker.getInputsSince(record.sessionId).find(item => item.id === record.brokerInputId);
    return reservation === undefined || BROKER_TERMINAL.has(reservation.state ?? '');
  }
  async function cancel(input: NativeHostedTurnRequest, authority: NativePairedExecutionAuthority, options: NativeHostedTurnOptions): Promise<NativeHostedTurnLookup> {
    const { identity } = await sourceOf(input, authority, options), key = keyOf(identity);
    const fence = () => {
      const owned = active.get(key);
      if (owned) {
        owned.cancelled = true; owned.controller.abort();
        if (owned.sessionId && owned.permit && deps.manager.cancelNative(owned.sessionId, owned.permit) === true) owned.interrupted = true;
      }
      return owned;
    };
    const earlier = fence();
    await journal.prevent(identity);
    let record = await journal.read(identity);
    if (!record) throw new NativeHostedTurnError('unavailable');
    // Preparing has not crossed the dispatch CAS. This tombstone prevents it
    // even in a different process, so no execution drain needs to be invented.
    if (record.state === 'preparing') {
      try { record = await journal.transition(identity, 'preparing', { state: 'cancelled', sessionId: record.sessionId, brokerInputId: record.brokerInputId, correlationId: record.correlationId }); }
      catch (error) {
        // A simultaneous dispatch CAS may win the lock. Re-read its real state;
        // neither that conflict nor a failed/ambiguous write proves cancellation.
        if (!(error instanceof NativeHostedTurnJournalError) || error.code !== 'conflict') throw error;
        record = await journal.read(identity);
        if (!record) throw new NativeHostedTurnError('unavailable');
      }
    }
    const current = fence();
    if (!earlier && !current && !isTerminalNativeHostedTurnState(record.state) && !await ownerEnded(record, key)) {
      // Another process, or an interrupted process, owns the ambiguity. A file
      // write cannot stop that lifetime or prove its effects have drained.
      return { ...project(record), state: 'recovery-required' };
    }
    await starting.get(key)?.promise.catch(() => {});
    const latest = fence();
    await Promise.all([earlier?.done, current?.done, latest?.done]);
    record = await journal.read(identity);
    if (!record) throw new NativeHostedTurnError('unavailable');
    if (!isTerminalNativeHostedTurnState(record.state)) record = await journal.transition(identity, record.state, { state: 'cancelled', sessionId: record.sessionId, brokerInputId: record.brokerInputId, correlationId: record.correlationId });
    authorize(authority, options);
    if (isTerminalNativeHostedTurnState(record.state)) { claimedHere.delete(key); stranded.delete(key); await settleIntake(identity, authority, options); }
    return project(record);
  }
  return { start, startAgent, status, cancel, session, continuation,
    async close(): Promise<void> {
      closed = true;
      for (const owned of active.values()) { owned.cancelled = true; owned.controller.abort(); if (owned.sessionId && owned.permit && deps.manager.cancelNative(owned.sessionId, owned.permit) === true) owned.interrupted = true; }
      await Promise.allSettled([...starting.values()].map(pending => pending.promise));
      await Promise.allSettled([...active.values()].map(owned => owned.done));
    },
  };
}
export type NativeHostedTurnHost = ReturnType<typeof createNativeHostedTurnHost>;
