import type { WorkspaceActionTarget } from '../workspace-actions.ts';

/** The workspace's to-do rows open the actions of `/todo` (terminal-shell/todo-command.ts). */
export const TODO_WORKSPACE_ACTIONS: Readonly<Record<string, WorkspaceActionTarget>> = {
  'workplan-add': { command: 'todo', action: 'add' },
  'workplan-show': { command: 'todo', action: 'list' },
  'workplan-status': { command: 'todo', action: 'mark' },
  'workplan-delete': { command: 'todo', action: 'remove' },
  'workplan-clear-completed': { command: 'todo', action: 'clear-done' },
};
