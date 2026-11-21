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
 * A `metadata.idempotencyKey` is kept where contracts.start keeps its retry
 * key: in the workspace's contract store, scoped to the caller, recorded before
 * the contract is published and read again after a daemon restart. A keyed
 * dispatch whose key already started a contract returns that contract and
 * creates nothing; a session made for an attempt that turns out to repeat an
 * earlier one is ended at once.
 *
 * A session the adapter created for a dispatch is recorded on its contract
 * (`sessionCreatedForDispatch`) and ends when the contract settles: on the
 * runner's own settle event, or on the next status, result or cancel when the
 * contract settled while nothing was listening (a daemon restart). Ending the
 * session can retire its workspace floor and with it the runner that held the
 * contract, so the settled contract's status and result are kept here for a
 * while and answered from that copy.
 */
import { resolve } from 'node:path';
import {
  contractWorkHandle,
  contractWorkResult,
  contractWorkSnapshot,
  type ContractExternalWorkAdapter,
} from '../contract/external.js';
import { ContractOperatorError, type ContractOperatorService } from '../contract/operator-service.js';
import { dispatchStartFingerprint } from '../contract/runner.js';
import { readIdempotentStartRecord } from '../contract/store.js';
import type { ContractView } from '../contract/types.js';
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

/** The namespace a dispatch's retry key is kept under, apart from contracts.start keys of the same caller. */
const DISPATCH_KEY_PREFIX = 'dispatch\u0000';

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
  /** Settled contracts whose session this adapter ended, in settle order: their runner may be gone. */
  const settledOutcomes = new Map<string, SettledOutcome>();
  /** Contracts whose dispatch session is being ended now, so two settle notices end it once. */
  const ending = new Set<string>();

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

  /**
   * A settled contract whose session was created for its dispatch (as its
   * record says, also after a restart): keep its outcome, then end the session
   * if it is still hosted. Anything else is left alone.
   */
  const release = async (contractId: string): Promise<void> => {
    const contract = deps.runner.get(contractId);
    if (contract === null || contract.sessionCreatedForDispatch !== true || !SETTLED_STATUSES.has(contract.status)) return;
    if (ending.has(contractId) || !deps.hostedSessions.hosts(contract.sessionId)) return;
    ending.add(contractId);
    try {
      // Read before the session ends: ending it may retire the floor whose runner holds the contract.
      keepOutcome(contractId, { snapshot: contractWorkSnapshot(contract), result: contractWorkResult(contract), at: Date.now() });
      await endSession(contract.sessionId);
    } finally {
      ending.delete(contractId);
    }
  };

  const unsubscribe = deps.settled?.((contractId) => { void release(contractId); });

  /** The contract an earlier dispatch with this caller's key started in `workspaceRoot`, or null. One small file read. */
  const recordedDispatch = (workspaceRoot: string, principalId: string | undefined, key: string, ask: string): ContractView | null => {
    const projectRoot = resolve(workspaceRoot);
    let record: ReturnType<typeof readIdempotentStartRecord>;
    // An unreadable record is answered by the keyed start itself, which names it.
    try { record = readIdempotentStartRecord(projectRoot, `${principalId ?? ''}\u0000${key}`); } catch { return null; }
    if (record === undefined || record.fingerprint !== dispatchStartFingerprint(ask, projectRoot)) return null;
    return deps.runner.get(record.contractId);
  };

  const handleOf = (contract: ContractView, request: Parameters<ContractExternalWorkAdapter['dispatch']>[0]) => contractWorkHandle(contract, {
    ...(request.contractId === undefined ? {} : { requestingContractId: request.contractId }),
    ...(request.status === undefined ? {} : { requestingStatus: request.status }),
  });

  const adapter: HostedContractWorkAdapter = {
    async dispatch(request) {
      let sessionId = metadataString(request.metadata, 'sessionId');
      const principalId = metadataString(request.metadata, 'principalId');
      const requestedKey = metadataString(request.metadata, 'idempotencyKey');
      const key = requestedKey === undefined ? undefined : `${DISPATCH_KEY_PREFIX}${requestedKey}`;
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
        // A key that already started work returns it before anything is created, also after a restart.
        if (key !== undefined) {
          const earlier = recordedDispatch(workspaceRoot, principalId, key, request.task);
          if (earlier !== null) return handleOf(earlier, request);
        }
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
        started = await deps.runner.start({
          ask: request.task,
          sessionId,
          ...(principalId === undefined ? {} : { principalId }),
          ...(key === undefined ? {} : { idempotencyKey: key }),
          ...(created || key !== undefined ? { dispatch: { sessionCreated: created } } : {}),
        });
      } catch (error) {
        // A session made for this dispatch would otherwise hold a slot and a workspace floor with nothing in it.
        if (created) await endSession(sessionId);
        throw error;
      }
      // The key had already started work (a concurrent or earlier attempt): that contract keeps its own session.
      if (started.replayed === true && created) await endSession(sessionId);
      // A contract that settled while it was being started has already sent its event.
      else if (created) void release(started.contract.id);
      return handleOf(started.contract, request);
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
      await release(externalTaskId);
      return snapshot;
    },
    async cancel(externalTaskId, reason) {
      const found = deps.runner.get(externalTaskId);
      // A settled contract whose session was ended has nothing left to cancel.
      if (found === null && keptOutcome(externalTaskId) !== undefined) return;
      contractOf(externalTaskId, found);
      deps.runner.cancel(externalTaskId, reason ?? EXTERNAL_CANCEL_REASON);
      await release(externalTaskId);
    },
    async result(externalTaskId) {
      const found = deps.runner.get(externalTaskId);
      const kept = found === null ? keptOutcome(externalTaskId) : undefined;
      if (kept !== undefined) return kept.result;
      const contract = contractOf(externalTaskId, found);
      const result = contractWorkResult(contract);
      await release(externalTaskId);
      return result;
    },
  };
  const detachDispatcher = deps.runner.attachDispatcher?.(adapter);
  return adapter;
}
