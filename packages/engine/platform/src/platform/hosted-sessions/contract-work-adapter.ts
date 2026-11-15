/**
 * contract-work-adapter.ts, the in-process external work adapter over hosted
 * sessions (docs/design/contract-runner.md 8.4).
 *
 * `dispatch` starts a contract in a hosted session: the one the request's
 * `metadata.sessionId` names (when `ownsSession` allows it), or a new one created for the dispatch in
 * `metadata.workspaceRoot` (else the adapter's default workspace). The
 * contract runs on that session's workspace floor, so its questions for the
 * owner are the session's replies and a turn in the session answers them.
 * `status` maps the contract to a snapshot (its status line, or its question
 * while it waits on the owner, as progress), `cancel` cancels it, and
 * `result` returns its answer as output and its status line as summary.
 *
 * The external task id is the contract id.
 */
import {
  contractWorkHandle,
  contractWorkResult,
  contractWorkSnapshot,
  type ContractExternalWorkAdapter,
} from '../contract/external.js';
import type { ContractOperatorService } from '../contract/operator-service.js';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { HostedSessionManager } from './manager.js';

export interface HostedContractWorkAdapterDeps {
  /** The contracts operator surface: it starts a hosted session's contract on the session's floor. */
  readonly runner: Pick<ContractOperatorService, 'start' | 'get' | 'cancel'>;
  /** `kill` lets the adapter end a session it created once its contract is over or never started. */
  readonly hostedSessions: Pick<HostedSessionManager, 'create' | 'hosts'> & Partial<Pick<HostedSessionManager, 'kill'>>;
  /** Where a session created for a dispatch works when the request names no workspace. Absolute. */
  readonly workspaceRoot?: string | undefined;
  /**
   * Directories a request's `metadata.workspaceRoot` must lie inside (symlinks resolved).
   * Omitted ⇒ none: only the adapter's own `workspaceRoot`, which is always allowed.
   */
  readonly allowedWorkspaceRoots?: readonly string[] | undefined;
  /**
   * Whether the requester may run work on the hosted session `metadata.sessionId` names.
   * Omitted ⇒ no request may name an existing session: the adapter has no requester
   * identity of its own, so it cannot tell whose session it is.
   */
  readonly ownsSession?: ((sessionId: string, request: Parameters<ContractExternalWorkAdapter['dispatch']>[0]) => boolean) | undefined;
}

/** The reason a cancel through the adapter records when the caller gives none. */
export const EXTERNAL_CANCEL_REASON = 'cancelled by the requester';

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** The contract statuses that have no further transition. */
const SETTLED_STATUSES: ReadonlySet<string> = new Set(['passed', 'failed', 'cancelled']);

/** The real path of `path`, or of its nearest existing ancestor with the rest appended, so a symlink inside a root cannot lead out of it. */
function canonicalPath(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      tail.push(basename(head));
      head = parent;
    }
  }
}

function insideRoot(root: string, candidate: string): boolean {
  const fromRoot = relative(canonicalPath(root), canonicalPath(candidate));
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}

export function createHostedContractWorkAdapter(deps: HostedContractWorkAdapterDeps): ContractExternalWorkAdapter {
  /** Sessions this adapter created for a dispatch, by contract id: it ends them with the work. */
  const createdFor = new Map<string, string>();
  /** The handle a dispatch with an idempotency key returned, so a retry does not start a second contract. */
  const dispatched = new Map<string, Promise<Awaited<ReturnType<ContractExternalWorkAdapter['dispatch']>>>>();

  const endSession = async (sessionId: string): Promise<void> => {
    try {
      await deps.hostedSessions.kill?.(sessionId);
    } catch (error) {
      logger.warn('[hosted-sessions] ending the session created for a dispatch failed', { sessionId, error: summarizeError(error) });
    }
  };

  const contractOf = (externalTaskId: string) => {
    const contract = deps.runner.get(externalTaskId);
    if (contract === null) throw new Error(`No contract ${externalTaskId} on this daemon.`);
    return contract;
  };

  /** Ends the session made for a contract once the contract has settled. */
  const releaseWhenSettled = async (externalTaskId: string, status: string): Promise<void> => {
    const sessionId = createdFor.get(externalTaskId);
    if (sessionId === undefined || !SETTLED_STATUSES.has(status)) return;
    createdFor.delete(externalTaskId);
    await endSession(sessionId);
  };

  const dispatchOnce: ContractExternalWorkAdapter['dispatch'] = async (request) => {
    let sessionId = metadataString(request.metadata, 'sessionId');
    let created = false;
    if (sessionId !== undefined && !deps.hostedSessions.hosts(sessionId)) {
      throw new Error(`This daemon hosts no live session ${sessionId}.`);
    }
    if (sessionId !== undefined && deps.ownsSession?.(sessionId, request) !== true) {
      throw new Error(`This requester may not run work on hosted session ${sessionId}. Omit metadata.sessionId to run on a new session.`);
    }
    if (sessionId === undefined) {
      const requested = metadataString(request.metadata, 'workspaceRoot');
      const workspaceRoot = requested ?? deps.workspaceRoot;
      if (workspaceRoot === undefined) throw new Error('A dispatch without a hosted session needs metadata.workspaceRoot: no default workspace is set.');
      if (requested !== undefined) {
        const roots = [...(deps.allowedWorkspaceRoots ?? []), ...(deps.workspaceRoot === undefined ? [] : [deps.workspaceRoot])];
        if (!isAbsolute(requested) || !roots.some((root) => insideRoot(root, requested))) {
          throw new Error(`metadata.workspaceRoot ${requested} is outside the workspaces this daemon allows for dispatched work.`);
        }
      }
      sessionId = (await deps.hostedSessions.create({ workspaceRoot })).id;
      created = true;
    }
    let started;
    try {
      started = await deps.runner.start({ ask: request.task, sessionId });
    } catch (error) {
      // A session made for this dispatch would otherwise hold a slot and a workspace floor with nothing in it.
      if (created) await endSession(sessionId);
      throw error;
    }
    if (created) createdFor.set(started.contract.id, sessionId);
    return contractWorkHandle(started.contract, {
      ...(request.contractId === undefined ? {} : { requestingContractId: request.contractId }),
      ...(request.status === undefined ? {} : { requestingStatus: request.status }),
    });
  };

  return {
    async dispatch(request) {
      const key = metadataString(request.metadata, 'idempotencyKey');
      if (key === undefined) return dispatchOnce(request);
      const previous = dispatched.get(key);
      if (previous !== undefined) return previous;
      const attempt = dispatchOnce(request);
      dispatched.set(key, attempt);
      // A failed attempt is not remembered: the retry is the point of the key.
      attempt.catch(() => { if (dispatched.get(key) === attempt) dispatched.delete(key); });
      return attempt;
    },
    async status(externalTaskId) {
      const contract = contractOf(externalTaskId);
      const snapshot = contractWorkSnapshot(contract);
      await releaseWhenSettled(externalTaskId, contract.status);
      return snapshot;
    },
    async cancel(externalTaskId, reason) {
      contractOf(externalTaskId);
      deps.runner.cancel(externalTaskId, reason ?? EXTERNAL_CANCEL_REASON);
      const after = deps.runner.get(externalTaskId);
      if (after !== null) await releaseWhenSettled(externalTaskId, after.status);
    },
    async result(externalTaskId) {
      const contract = contractOf(externalTaskId);
      const result = contractWorkResult(contract);
      await releaseWhenSettled(externalTaskId, contract.status);
      return result;
    },
  };
}
