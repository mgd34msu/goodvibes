import type { WorkspaceActionTarget } from '../workspace-actions.ts';

/** The workspace's profile rows open the actions of `/about-me` (terminal-shell/about-me-command.ts). */
export const ABOUT_ME_WORKSPACE_ACTIONS: Readonly<Record<string, WorkspaceActionTarget>> = {
  'owner-profile-read': { command: 'about-me', action: 'show' },
  'owner-profile-get': { command: 'about-me', action: 'field' },
  'owner-profile-person': { command: 'about-me', action: 'person' },
  'owner-profile-provenance': { command: 'about-me', action: 'where' },
  'owner-profile-set': { command: 'about-me', action: 'set' },
  'owner-profile-forget': { command: 'about-me', action: 'forget' },
  'owner-profile-forget-note': { command: 'about-me', action: 'forget-line' },
  'owner-profile-status': { command: 'about-me', action: 'status' },
};
