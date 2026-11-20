import type { WorkspaceActionTarget } from '../workspace-actions.ts';

/** The workspace's secret rows open the actions of `/secrets` (terminal-shell/secrets-command.ts). */
export const SECRETS_WORKSPACE_ACTIONS: Readonly<Record<string, WorkspaceActionTarget>> = {
  'secret-set': { command: 'secrets', action: 'set-secret' },
  'secret-link': { command: 'secrets', action: 'link-secret' },
  'secret-test': { command: 'secrets', action: 'test-reference' },
  'secret-delete': { command: 'secrets', action: 'delete-secret' },
};
