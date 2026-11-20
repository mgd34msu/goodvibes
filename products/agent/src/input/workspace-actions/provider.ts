import type { WorkspaceActionTarget } from '../workspace-actions.ts';

/** The workspace's provider and subscription sign-in rows open the actions of `/provider` (terminal-shell/provider-command.ts). */
export const PROVIDER_WORKSPACE_ACTIONS: Readonly<Record<string, WorkspaceActionTarget>> = {
  'provider-use': { command: 'provider', action: 'use' },
  'provider-add': { command: 'provider', action: 'add' },
  'provider-remove': { command: 'provider', action: 'remove' },
  'subscription-login-start': { command: 'provider', action: 'sign-in' },
  'subscription-login-finish': { command: 'provider', action: 'finish-sign-in' },
  'subscription-logout': { command: 'provider', action: 'sign-out' },
  'subscription-inspect': { command: 'provider', action: 'see-sign-in' },
  'subscription-bundle-export': { command: 'provider', action: 'save-sign-ins' },
  'subscription-bundle-inspect': { command: 'provider', action: 'check-sign-ins' },
};
