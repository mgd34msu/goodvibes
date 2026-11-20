import type { WorkspaceActionTarget } from '../workspace-actions.ts';

/** The workspace's session rows open the actions of `/session` (terminal-shell/session-command.ts). */
export const SESSION_WORKSPACE_ACTIONS: Readonly<Record<string, WorkspaceActionTarget>> = {
  'session-save': { command: 'session', action: 'save' },
  'session-load': { command: 'session', action: 'resume' },
  'session-resume': { command: 'session', action: 'resume' },
  'session-rename': { command: 'session', action: 'rename' },
  'session-fork': { command: 'session', action: 'fork' },
  'session-info': { command: 'session', action: 'info' },
  'session-search': { command: 'session', action: 'search' },
  'session-export-saved': { command: 'session', action: 'save-saved' },
  'session-delete': { command: 'session', action: 'delete' },
  'conversation-export': { command: 'session', action: 'save-file' },
};
