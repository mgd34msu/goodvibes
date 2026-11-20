import type { WorkspaceActionTarget } from '../workspace-actions.ts';

/** The workspace's typed reasoning-effort row opens the action of `/effort` (terminal-shell/model-command.ts). */
export const EFFORT_WORKSPACE_ACTIONS: Readonly<Record<string, WorkspaceActionTarget>> = {
  'effort-level': { command: 'effort', action: 'set' },
};
