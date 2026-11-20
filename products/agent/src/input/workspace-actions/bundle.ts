import type { WorkspaceActionTarget } from '../workspace-actions.ts';

/** The workspace's support bundle rows open the actions of `/bundle` (commands/support-bundle-runtime.ts). */
export const BUNDLE_WORKSPACE_ACTIONS: Readonly<Record<string, WorkspaceActionTarget>> = {
  'support-bundle-export': { command: 'bundle', action: 'save' },
  'support-bundle-inspect': { command: 'bundle', action: 'check' },
  'support-bundle-import': { command: 'bundle', action: 'load' },
};
