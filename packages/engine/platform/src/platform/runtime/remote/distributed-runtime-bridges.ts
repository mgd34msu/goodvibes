import { summarizeError } from '../../utils/error-display.js';
import { logger } from '../../utils/logger.js';
import type {
  DistributedPeerRecord,
  DistributedPendingWork,
  DistributedRuntimeManagerState,
} from './distributed-runtime-types.js';
import { summarizeValue } from './distributed-runtime-utils.js';

/**
 * The session, approval and automation bridges report work to other owners.
 * They run after the work record is persisted and never throw: a bridge that
 * fails must not leave the work settled in memory but unsettled on disk (it
 * would run again after a restart), nor keep the caller's waiters hanging.
 */

/** Which bridges failed for one piece of work (empty when every bridge delivered). */
export type DistributedBridgeName = 'session' | 'approval' | 'automation';

export interface DistributedBridgeReport {
  readonly failed: ReadonlyArray<DistributedBridgeName>;
  /** Bridges that were asked for and are not attached, so nothing was delivered to them. */
  readonly absent: ReadonlyArray<DistributedBridgeName>;
}

/**
 * Text that a peer chose (its label, the command it was sent, the error it reported) goes into
 * session messages as one bounded quoted line, so it cannot open a line of its own that reads as
 * another speaker in the continuation prompt.
 */
function peerText(value: unknown, max = 280): string {
  return JSON.stringify(summarizeValue(value, max));
}

async function runBridge(label: 'session' | 'approval' | 'automation', work: DistributedPendingWork, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    logger.warn('Distributed runtime bridge failed; the work record itself is saved', {
      bridge: label,
      workId: work.id,
      status: work.status,
      error: summarizeError(error),
    });
    return false;
  }
}

export async function bridgeQueuedDistributedWork(
  state: DistributedRuntimeManagerState,
  peer: DistributedPeerRecord,
  work: DistributedPendingWork,
): Promise<DistributedBridgeReport> {
  const failed: DistributedBridgeName[] = [];
  const sessionBridge = state.sessionBridge;
  if (work.sessionId && sessionBridge) {
    const sessionId = work.sessionId;
    if (!await runBridge('session', work, () => sessionBridge.appendSystemMessage(
      sessionId,
      `Queued remote ${peer.kind} work on ${peerText(peer.label, 80)}: ${peerText(work.command)}`,
      {
        remotePeerId: peer.id,
        remotePeerKind: peer.kind,
        remoteWorkId: work.id,
        remoteWorkStatus: work.status,
        automationRunId: work.automationRunId,
        approvalId: work.approvalId,
      },
    ))) failed.push('session');
  }
  return { failed, absent: [] };
}

export async function bridgeSettledDistributedWork(
  state: DistributedRuntimeManagerState,
  peer: DistributedPeerRecord,
  work: DistributedPendingWork,
  /** Run only these bridges (a retry); omitted runs all of them. */
  only?: ReadonlyArray<DistributedBridgeName>,
): Promise<DistributedBridgeReport> {
  const failed: DistributedBridgeName[] = [];
  const absent: DistributedBridgeName[] = [];
  const wanted = (name: DistributedBridgeName): boolean => !only || only.includes(name);
  const statusLabel = work.status === 'completed' || work.status === 'failed' || work.status === 'expired'
    ? work.status
    : 'cancelled';
  const summary = work.status === 'completed'
    ? summarizeValue(work.result) || 'no result'
    : summarizeValue(work.error) || statusLabel;

  const sessionBridge = state.sessionBridge;
  if (work.sessionId && !sessionBridge && wanted('session')) absent.push('session');
  if (work.sessionId && sessionBridge && wanted('session')) {
    const sessionId = work.sessionId;
    if (!await runBridge('session', work, () => sessionBridge.appendSystemMessage(
      sessionId,
      `Remote ${peer.kind} ${peerText(peer.label, 80)} ${statusLabel}: ${peerText(work.command)}${summary ? ` ${peerText(summary)}` : ''}`,
      {
        remotePeerId: peer.id,
        remotePeerKind: peer.kind,
        remoteWorkId: work.id,
        remoteWorkStatus: work.status,
        automationRunId: work.automationRunId,
        approvalId: work.approvalId,
      },
    ))) failed.push('session');
  }

  const approvalBridge = state.approvalBridge;
  if (work.approvalId && !approvalBridge && wanted('approval')) absent.push('approval');
  if (work.approvalId && approvalBridge && wanted('approval')) {
    const approvalId = work.approvalId;
    if (!await runBridge('approval', work, () => approvalBridge.recordRemoteUpdate(approvalId, {
      actor: peer.id,
      actorSurface: 'service',
      note: `Remote ${peer.kind} ${peerText(peer.label, 80)} ${statusLabel}: ${peerText(work.command)}`,
      metadata: {
        remotePeerId: peer.id,
        remoteWorkId: work.id,
        remoteWorkStatus: work.status,
      },
    }))) failed.push('approval');
  }

  const automationBridge = state.automationBridge;
  if (work.automationRunId && !automationBridge && wanted('automation')) absent.push('automation');
  if (work.automationRunId && automationBridge && wanted('automation')) {
    const runId = work.automationRunId;
    if (!await runBridge('automation', work, () => automationBridge.recordExternalRunResult(runId, {
      // The automation run vocabulary has no `expired`; work that timed out
      // is a failed run, with the expiry named in the error.
      status: work.status === 'completed' ? 'completed' : work.status === 'cancelled' ? 'cancelled' : 'failed',
      result: work.result,
      error: work.error,
      telemetry: work.telemetry,
      metadata: {
        remotePeerId: peer.id,
        remoteWorkId: work.id,
        remotePeerKind: peer.kind,
      },
    }))) failed.push('automation');
  }
  return { failed, absent };
}
