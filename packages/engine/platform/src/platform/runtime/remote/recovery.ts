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

  const lostForGood = (connection?.transportState ?? contract?.transport?.state) === 'terminal_failure';
  // A runner lost for good shows its last error beside its steps; a step repeating it says nothing more.
  if (!lostForGood && (connection?.lastError || contract?.transport?.lastError)) {
    actions.push({
      id: 'review-health',
      label: 'What went wrong',
      command: 'System, Health: check one area, Remote runners',
      reason: connection?.lastError ?? contract?.transport?.lastError ?? 'Remote transport reported an error.',
    });
  }
  // Lost for good (its agent stopped answering or went away): nothing brings this one back, a new one takes the task up.
  if (lostForGood) {
    actions.push({
      id: 'start-again',
      label: 'Start it again',
      command: '/work',
      reason: 'save what it did first with "save its work" on the Runners tab of the Work place, then start a runner on the same task',
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
