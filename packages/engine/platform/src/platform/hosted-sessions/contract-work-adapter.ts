/**
 * contract-work-adapter.ts, the in-process external work adapter over hosted
 * sessions.
 *
 * `dispatch` starts a contract in a hosted session: the one the request's
 * `metadata.sessionId` names (when `ownsSession` allows it), or a new one created for the dispatch in
 * `metadata.workspaceRoot` (else the adapter's default workspace). A
 * `metadata.principalId` (set by the operator surface from the authenticated
 * caller, never from the request body) owns both the session it creates and the
 * contract. The contract runs on that session's workspace floor, so its questions for the
 * owner are the session's replies and a turn in the session answers them.
 * `status` maps the contract to a snapshot (its status line, or its question
 * while it waits on the owner, as progress), `cancel` cancels it, and
 * `result` returns its answer as output and its status line as summary.
 *
 * The external task id is the contract id.
 *
 * A session the adapter created for a dispatch ends when its contract settles,
 * on the runner's own settle event, and an idempotency key is forgotten then
 * too: a requester that never polls again leaves nothing behind. Without a
 * settle source the next status, result or cancel after settlement does it.
 * Ending the session can retire its workspace floor and with it the runner that
 * held the contract, so the settled contract's status and result are kept here
 * for a while and answered from that copy.
 */
import {
  contractWorkHandle,
  contractWorkResult,
  contractWorkSnapshot,
  type ContractExternalWorkAdapter,
} from '../contract/external.js';
import { ContractOperatorError, type ContractOperatorService } from '../contract/operator-service.js';
import { logger } from '../utils/logger.js';
import { HostedSessionArgumentError } from './errors.js';
import { summarizeError } from '../utils/error-display.js';
import type { HostedSessionManager } from './manager.js';

export interface HostedContractWorkAdapterDeps {
  /**
   * The contracts operator surface: it starts a hosted session's contract on
   * the session's floor. When it can take a dispatcher, the adapter attaches
   * itself, so `contracts.dispatch` reaches it, and detaches on close.
   */
  readonly runner: Pick<ContractOperatorService, 'start' | 'get' | 'cancel'> & Partial<Pick<ContractOperatorService, 'attachDispatcher'>>;
  /** `kill` lets the adapter end a session it created once its contract is over or never started. */
  readonly hostedSessions: Pick<HostedSessionManager, 'create' | 'hosts'> & Partial<Pick<HostedSessionManager, 'kill'>>;
  /**
   * Where a session created for a dispatch works when the request names no workspace. Absolute.
   * A `metadata.workspaceRoot` the request names is admitted by the session manager's own
   * workspace rule (the daemon's working directory and registered workspaces), not here.
   */
  readonly workspaceRoot?: string | undefined;
  /**
   * Whether the requester may run work on the hosted session `metadata.sessionId` names.
   * Omitted ⇒ no request may name an existing session: the adapter has no requester
   * identity of its own, so it cannot tell whose session it is.
   */
  readonly ownsSession?: ((sessionId: string, request: Parameters<ContractExternalWorkAdapter['dispatch']>[0]) => boolean) | undefined;
  /**
   * Subscribes to contract settlement (passed, failed, cancelled) by contract
   * id; returns the unsubscribe. The daemon passes its runtime bus, where every
   * floor's runner publishes. Omitted ⇒ settlement is noticed on the next poll.
   */
  readonly settled?: ((listener: (contractId: string) => void) => () => void) | undefined;
}

/** The adapter, plus the release of its settle subscription. */
export interface HostedContractWorkAdapter extends ContractExternalWorkAdapter {
  close(): void;
}

/** The reason a cancel through the adapter records when the caller gives none. */
export const EXTERNAL_CANCEL_REASON = 'cancelled by the requester';

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** The contract statuses that have no further transition. */
const SETTLED_STATUSES: ReadonlySet<string> = new Set(['passed', 'failed', 'cancelled']);
/** How long the outcome of a contract whose session was ended stays readable, and how many are kept. */
const SETTLED_OUTCOME_RETENTION_MS = 24 * 60 * 60_000;
const SETTLED_OUTCOME_LIMIT = 512;

interface SettledOutcome {
  readonly snapshot: ReturnType<typeof contractWorkSnapshot>;
  readonly result: ReturnType<typeof contractWorkResult>;
  readonly at: number;
}

export function createHostedContractWorkAdapter(deps: HostedContractWorkAdapterDeps): HostedContractWorkAdapter {
  /** Sessions this adapter created for a dispatch, by contract id: it ends them with the work. */
  const createdFor = new Map<string, string>();
  /** The handle a dispatch with an idempotency key returned, so a retry does not start a second contract. */
  const dispatched = new Map<string, Promise<Awaited<ReturnType<ContractExternalWorkAdapter['dispatch']>>>>();
  /** The idempotency key each keyed dispatch's contract was started under, so settlement forgets it. */
  const keyOf = new Map<string, string>();
  /** Settled contracts whose session this adapter ended, in settle order: their runner may be gone. */
  const settledOutcomes = new Map<string, SettledOutcome>();

  const keepOutcome = (contractId: string, outcome: SettledOutcome): void => {
    settledOutcomes.delete(contractId);
    settledOutcomes.set(contractId, outcome);
    for (const [id, kept] of settledOutcomes) {
      if (settledOutcomes.size <= SETTLED_OUTCOME_LIMIT && outcome.at - kept.at < SETTLED_OUTCOME_RETENTION_MS) break;
      settledOutcomes.delete(id);
    }
  };
  /** A kept outcome still within its retention, or undefined. */
  const keptOutcome = (contractId: string): SettledOutcome | undefined => {
    const kept = settledOutcomes.get(contractId);
    if (kept === undefined) return undefined;
    if (Date.now() - kept.at < SETTLED_OUTCOME_RETENTION_MS) return kept;
    settledOutcomes.delete(contractId);
    return undefined;
  };

  const endSession = async (sessionId: string): Promise<void> => {
    try {
      await deps.hostedSessions.kill?.(sessionId);
    } catch (error) {
      logger.warn('[hosted-sessions] ending the session created for a dispatch failed', { sessionId, error: summarizeError(error) });
    }
  };

  const contractOf = (externalTaskId: string, contract = deps.runner.get(externalTaskId)) => {
    if (contract === null) throw new ContractOperatorError(`No contract ${externalTaskId} on this daemon.`, 'CONTRACT_NOT_FOUND', 404);
    return contract;
  };

  /** The contract settled: forget its idempotency key and end the session made for it. */
  const release = async (contractId: string): Promise<void> => {
    const key = keyOf.get(contractId);
    if (key !== undefined) {
      keyOf.delete(contractId);
      dispatched.delete(key);
    }
    const sessionId = createdFor.get(contractId);
    if (sessionId === undefined) return;
    createdFor.delete(contractId);
    // Read before the session ends: ending it may retire the floor whose runner holds the contract.
    const contract = deps.runner.get(contractId);
    if (contract !== null) keepOutcome(contractId, { snapshot: contractWorkSnapshot(contract), result: contractWorkResult(contract), at: Date.now() });
    await endSession(sessionId);
  };

  /** The poll-time release, used only when no settle source was given. */
  const releaseWhenSettled = async (externalTaskId: string, status: string): Promise<void> => {
    if (deps.settled !== undefined || !SETTLED_STATUSES.has(status)) return;
    await release(externalTaskId);
  };

  const unsubscribe = deps.settled?.((contractId) => {
    if (!createdFor.has(contractId) && !keyOf.has(contractId)) return;
    void release(contractId);
  });

  const dispatchOnce: ContractExternalWorkAdapter['dispatch'] = async (request) => {
    let sessionId = metadataString(request.metadata, 'sessionId');
    const principalId = metadataString(request.metadata, 'principalId');
    let created = false;
    if (sessionId !== undefined && !deps.hostedSessions.hosts(sessionId)) {
      throw new ContractOperatorError(`This daemon hosts no live session ${sessionId}.`, 'SESSION_NOT_LIVE', 409, 'sessionId');
    }
    if (sessionId !== undefined && deps.ownsSession?.(sessionId, request) !== true) {
      throw new ContractOperatorError(`This requester may not run work on hosted session ${sessionId}. Omit metadata.sessionId to run on a new session.`, 'SESSION_NOT_OWNED', 403, 'sessionId');
    }
    if (sessionId === undefined) {
      const requested = metadataString(request.metadata, 'workspaceRoot');
      const workspaceRoot = requested ?? deps.workspaceRoot;
      if (workspaceRoot === undefined) throw new ContractOperatorError('A dispatch without a hosted session needs metadata.workspaceRoot: no default workspace is set.', 'INVALID_ARGUMENT', 400, 'workspaceRoot');
      try {
        sessionId = (await deps.hostedSessions.create({ workspaceRoot, ...(principalId === undefined ? {} : { principalId }) })).id;
      } catch (error) {
        // The manager owns where work may run; its refusal is the caller's argument error here.
        if (error instanceof HostedSessionArgumentError) throw new ContractOperatorError(error.message, 'INVALID_ARGUMENT', 400, 'workspaceRoot');
        throw error;
      }
      created = true;
    }
    let started;
    try {
      started = await deps.runner.start({ ask: request.task, sessionId, ...(principalId === undefined ? {} : { principalId }) });
    } catch (error) {
      // A session made for this dispatch would otherwise hold a slot and a workspace floor with nothing in it.
      if (created) await endSession(sessionId);
      throw error;
    }
    if (created) {
      createdFor.set(started.contract.id, sessionId);
      // A contract that settled while it was being started has already sent its event.
      const now = deps.runner.get(started.contract.id);
      if (deps.settled !== undefined && now !== null && SETTLED_STATUSES.has(now.status)) void release(started.contract.id);
    }
    return contractWorkHandle(started.contract, {
      ...(request.contractId === undefined ? {} : { requestingContractId: request.contractId }),
      ...(request.status === undefined ? {} : { requestingStatus: request.status }),
    });
  };

  const adapter: HostedContractWorkAdapter = {
    async dispatch(request) {
      const key = metadataString(request.metadata, 'idempotencyKey');
      if (key === undefined) return dispatchOnce(request);
      const previous = dispatched.get(key);
      if (previous !== undefined) return previous;
      const attempt = dispatchOnce(request);
      dispatched.set(key, attempt);
      // A failed attempt is not remembered: the retry is the point of the key.
      attempt.then((handle) => {
        if (dispatched.get(key) !== attempt) return;
        keyOf.set(handle.externalTaskId, key);
        // Settled before the handle came back: the key has nothing left to guard.
        const contract = deps.runner.get(handle.externalTaskId);
        if (deps.settled !== undefined && contract !== null && SETTLED_STATUSES.has(contract.status)) void release(handle.externalTaskId);
      }, () => { if (dispatched.get(key) === attempt) dispatched.delete(key); });
      return attempt;
    },
    close() {
      unsubscribe?.();
      detachDispatcher?.();
    },
    async status(externalTaskId) {
      const found = deps.runner.get(externalTaskId);
      const kept = found === null ? keptOutcome(externalTaskId) : undefined;
      if (kept !== undefined) return kept.snapshot;
      const contract = contractOf(externalTaskId, found);
      const snapshot = contractWorkSnapshot(contract);
      await releaseWhenSettled(externalTaskId, contract.status);
      return snapshot;
    },
    async cancel(externalTaskId, reason) {
      const found = deps.runner.get(externalTaskId);
      // A settled contract whose session was ended has nothing left to cancel.
      if (found === null && keptOutcome(externalTaskId) !== undefined) return;
      contractOf(externalTaskId, found);
      deps.runner.cancel(externalTaskId, reason ?? EXTERNAL_CANCEL_REASON);
      const after = deps.runner.get(externalTaskId);
      if (after !== null) await releaseWhenSettled(externalTaskId, after.status);
    },
    async result(externalTaskId) {
      const found = deps.runner.get(externalTaskId);
      const kept = found === null ? keptOutcome(externalTaskId) : undefined;
      if (kept !== undefined) return kept.result;
      const contract = contractOf(externalTaskId, found);
      const result = contractWorkResult(contract);
      await releaseWhenSettled(externalTaskId, contract.status);
      return result;
    },
  };
  const detachDispatcher = deps.runner.attachDispatcher?.(adapter);
  return adapter;
}
