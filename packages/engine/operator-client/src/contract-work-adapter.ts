/**
 * contract-work-adapter.ts, the external work adapter for partner surfaces
 * over the daemon's `contracts.*` operator methods.
 *
 * `dispatch` calls `contracts.start` with the task as the ask (and the
 * request's `metadata.sessionId`, `metadata.workspaceRoot` and
 * `metadata.isolation` when given: a hosted session's id starts the contract
 * in that session; `metadata.idempotencyKey` is the call's `Idempotency-Key`,
 * so a replayed dispatch gets the contract the first one started, and without
 * one the client generates a key per call, which its own retries reuse),
 * `status` reads the contract's small summary (`contracts.status`) into a
 * snapshot, `cancel` calls `contracts.cancel`, and `result` reads
 * `contracts.get` into the contract's answer and status line. The external task id is the contract
 * id. The mapping is the contracts package's, shared with the in-process
 * hosted adapter, so both report a contract the same way.
 */
import {
  contractWorkHandle,
  contractWorkResult,
  contractWorkSnapshot,
  type ContractExternalWorkAdapter,
  type ContractWorkFields,
} from '@goodvibes-jev/engine/contracts';
import type { OperatorRemoteClient } from './client-core.js';

/** The reason a cancel through the adapter records when the caller gives none. */
export const OPERATOR_WORK_CANCEL_REASON = 'cancelled by the requester';

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function metadataIsolation(metadata: Record<string, unknown> | undefined): 'auto' | 'worktree' | 'shared' | undefined {
  const value = metadata?.['isolation'];
  return value === 'auto' || value === 'worktree' || value === 'shared' ? value : undefined;
}

/** A contract summary as the fields the work mapping reads: its open question, and its last change as the one decision time. */
function summaryWorkFields(summary: {
  readonly id: string; readonly status: ContractWorkFields['status']; readonly sessionId: string; readonly ownerAgentId: string;
  readonly createdAt: number; readonly completedAt?: number | undefined; readonly statusLine?: string | undefined; readonly error?: string | undefined;
  readonly openEscalation?: { readonly id: string; readonly at: number; readonly question: string } | undefined; readonly updatedAt: number;
}): ContractWorkFields {
  return {
    id: summary.id,
    status: summary.status,
    sessionId: summary.sessionId,
    ownerAgentId: summary.ownerAgentId,
    createdAt: summary.createdAt,
    ...(summary.completedAt === undefined ? {} : { completedAt: summary.completedAt }),
    ...(summary.statusLine === undefined ? {} : { statusLine: summary.statusLine }),
    ...(summary.error === undefined ? {} : { error: summary.error }),
    escalations: summary.openEscalation === undefined ? [] : [summary.openEscalation],
    decisions: [{ at: summary.updatedAt }],
  };
}

/** An adapter over an operator client; the client's own auth and transport carry every call. */
export function createOperatorContractWorkAdapter(client: Pick<OperatorRemoteClient, 'invoke'>): ContractExternalWorkAdapter {
  return {
    async dispatch(request) {
      const sessionId = metadataString(request.metadata, 'sessionId');
      const workspaceRoot = metadataString(request.metadata, 'workspaceRoot');
      const isolation = metadataIsolation(request.metadata);
      const idempotencyKey = metadataString(request.metadata, 'idempotencyKey');
      const started = await client.invoke('contracts.start', {
        ask: request.task,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        ...(isolation === undefined ? {} : { isolation }),
      }, idempotencyKey === undefined ? {} : { idempotencyKey });
      return contractWorkHandle(started.contract, {
        ...(request.contractId === undefined ? {} : { requestingContractId: request.contractId }),
        ...(request.status === undefined ? {} : { requestingStatus: request.status }),
      });
    },
    async status(externalTaskId) {
      const summary = await client.invoke('contracts.status', { contractId: externalTaskId });
      // Only an `ifRevision` that matched answers without the summary, and none is sent here.
      if ('notModified' in summary) throw new Error(`Contract ${externalTaskId} answered without its status; read it again.`);
      return contractWorkSnapshot(summaryWorkFields(summary));
    },
    async cancel(externalTaskId, reason) {
      await client.invoke('contracts.cancel', { contractId: externalTaskId, reason: reason ?? OPERATOR_WORK_CANCEL_REASON });
    },
    async result(externalTaskId) {
      return contractWorkResult(await client.invoke('contracts.get', { contractId: externalTaskId }));
    },
  };
}
