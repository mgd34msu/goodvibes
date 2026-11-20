import type { WorkspaceActionTarget } from '../workspace-actions.ts';

/** The workspace's print-level rows open the actions of `/verbosity` (terminal-shell/interaction-mode-command.ts). */
export const VERBOSITY_WORKSPACE_ACTIONS: Readonly<Record<string, WorkspaceActionTarget>> = {
  'mode-preset': { command: 'verbosity', action: 'set' },
  'mode-domain': { command: 'verbosity', action: 'set-domain' },
};
