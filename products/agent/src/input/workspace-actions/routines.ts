import type { WorkspaceActionTarget } from '../workspace-actions.ts';

/** The workspace's routine rows open the actions of `/routines` (commands/routines-runtime.ts). */
export const ROUTINES_WORKSPACE_ACTIONS: Readonly<Record<string, WorkspaceActionTarget>> = {
  'routine-search': { command: 'routines', action: 'search' },
  'routine-show': { command: 'routines', action: 'show' },
  'routine-discovery-import': { command: 'routines', action: 'import' },
  'routine-receipt': { command: 'routines', action: 'receipt' },
  'routine-schedule': { command: 'routines', action: 'promote' },
};
