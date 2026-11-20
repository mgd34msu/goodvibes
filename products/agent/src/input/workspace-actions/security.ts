import type { WorkspaceActionTarget } from '../workspace-actions.ts';

/** The workspace's trust rows open the actions of `/security` (terminal-shell/security-command.ts). */
export const SECURITY_WORKSPACE_ACTIONS: Readonly<Record<string, WorkspaceActionTarget>> = {
  'trust-bundle-export': { command: 'security', action: 'save-trust' },
  'trust-bundle-inspect': { command: 'security', action: 'read-trust' },
};
