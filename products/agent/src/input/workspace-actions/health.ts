import type { WorkspaceActionTarget } from '../workspace-actions.ts';

/** The workspace's health row opens "Check one area" of `/health` (terminal-shell/health-command.ts). */
export const HEALTH_WORKSPACE_ACTIONS: Readonly<Record<string, WorkspaceActionTarget>> = {
  'health-repair': { command: 'health', action: 'check' },
};
