import type { WorkspaceActionTarget } from '../workspace-actions.ts';

/** The workspace's hand-off row opens the action of `/agents` (terminal-shell/agents-command.ts). */
export const AGENTS_WORKSPACE_ACTIONS: Readonly<Record<string, WorkspaceActionTarget>> = {
  'delegate-task': { command: 'agents', action: 'hand-off' },
};
