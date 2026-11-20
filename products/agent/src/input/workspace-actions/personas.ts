import type { WorkspaceActionTarget } from '../workspace-actions.ts';

/** The workspace's persona rows open the actions of `/personas` (commands/personas-runtime.ts). */
export const PERSONAS_WORKSPACE_ACTIONS: Readonly<Record<string, WorkspaceActionTarget>> = {
  'persona-search': { command: 'personas', action: 'search' },
  'persona-show': { command: 'personas', action: 'show' },
  'persona-discovery-import': { command: 'personas', action: 'import' },
};
