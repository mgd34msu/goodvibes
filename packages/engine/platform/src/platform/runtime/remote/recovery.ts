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
      reason: connection?.lastError ?? contract?.transport?.lastError ?? 'the connection to the runner reported an error',
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
      label: 'Look at its connection',
      // The Work place opens on the runners, where the connection is one key away.
      command: `/work`,
      reason: heartbeat.detail,
    });
  }
  if (taskId) {
    actions.push({
      id: 'task',
      label: 'Look at its task',
      // The task's own row in the Work place (Tasks here or Daemon tasks); typed, `/work task` shows it.
      command: `/work task ${taskId}`,
      reason: 'the runner is still working on a task; its row in Tasks here or Daemon tasks, in the Work place, says how far it got',
    });
  }
  actions.push({
    id: 'remote-panel',
    label: 'Open the runners in the Work place',
    command: '/work',
    reason: 'its connection, what it is held to and what it handed back are side by side there',
  });

  return actions;
}
