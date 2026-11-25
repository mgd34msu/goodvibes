import type { AcpConnection } from '../store/domains/acp.js';
import type { RemoteRunnerContract } from './types.js';
import type { RemoteHeartbeatSnapshot } from './heartbeat.js';

export interface RemoteRecoveryAction {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly reason: string;
}

export function deriveRemoteRecoveryActions(
  connection?: AcpConnection | null,
  contract?: RemoteRunnerContract | null,
  heartbeat?: RemoteHeartbeatSnapshot,
): RemoteRecoveryAction[] {
  const actions: RemoteRecoveryAction[] = [];
  const taskId = contract?.taskId;

  if (connection?.lastError || contract?.transport?.lastError) {
    actions.push({
      id: 'review-health',
      label: 'Review remote health',
      command: '/health check remote',
      reason: connection?.lastError ?? contract?.transport?.lastError ?? 'Remote transport reported an error.',
    });
  }
  if (heartbeat?.status === 'stale') {
    actions.push({
      id: 'inspect',
      label: 'Inspect the remote connection',
      // The Work place opens on the runners, where the connection is one key away.
      command: `/work`,
      reason: heartbeat.detail,
    });
  }
  if (taskId) {
    actions.push({
      id: 'task',
      label: 'Show the bound task',
      command: `/tasks show ${taskId}`,
      reason: `Remote session is still bound to task ${taskId}.`,
    });
  }
  actions.push({
    id: 'remote-panel',
    label: 'Open the runners in the Work place',
    command: '/work',
    reason: 'Inspect transport, runner contracts, and artifacts together.',
  });

  return actions;
}
