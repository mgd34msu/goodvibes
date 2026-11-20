import type { WorkspaceActionTarget } from '../workspace-actions.ts';

/**
 * The workspace's task, approval and schedule-run rows open the actions of
 * `/tasks`, `/approval`, `/questions` and `/schedule`. An approval is answered
 * (approved or denied) with `/questions answer`; a schedule's runs are run,
 * paused, resumed, stopped and retried with `/schedule`.
 */
export const TASKS_WORKSPACE_ACTIONS: Readonly<Record<string, WorkspaceActionTarget>> = {
  'task-list-filter': { command: 'tasks', action: 'list' },
  'task-show': { command: 'tasks', action: 'show' },
  'task-output': { command: 'tasks', action: 'output' },
  'approval-review': { command: 'approval', action: 'kinds' },
  'approval-approve': { command: 'questions', action: 'answer' },
  'approval-deny': { command: 'questions', action: 'answer' },
  'approval-cancel': { command: 'questions', action: 'answer' },
  'automation-job-run': { command: 'schedule', action: 'run-now' },
  'automation-job-pause': { command: 'schedule', action: 'pause' },
  'automation-job-resume': { command: 'schedule', action: 'resume' },
  'automation-run-cancel': { command: 'schedule', action: 'stop-run' },
  'automation-run-retry': { command: 'schedule', action: 'retry-run' },
};
