import type { WorkspaceActionTarget } from '../workspace-actions.ts';

/** The workspace's Agent home rows open the actions of `/agent-home` (commands/agent-runtime-profile-runtime.ts). */
export const AGENT_HOME_WORKSPACE_ACTIONS: Readonly<Record<string, WorkspaceActionTarget>> = {
  profile: { command: 'agent-home', action: 'create' },
  'profile-show': { command: 'agent-home', action: 'show' },
  'profile-default': { command: 'agent-home', action: 'use' },
  'profile-default-clear': { command: 'agent-home', action: 'use-base' },
  'profile-delete': { command: 'agent-home', action: 'delete' },
  'profile-from-discovered': { command: 'agent-home', action: 'create-learned' },
  'profile-template-show': { command: 'agent-home', action: 'starter' },
  'profile-template-export': { command: 'agent-home', action: 'export-starter' },
  'profile-template-import': { command: 'agent-home', action: 'import-starter' },
  'profile-template-from-discovered': { command: 'agent-home', action: 'starter-learned' },
};
