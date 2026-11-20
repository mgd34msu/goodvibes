import type { WorkspaceActionTarget } from '../workspace-actions.ts';

/** The workspace's channel rows open the actions of `/channels` (terminal-shell/channels-command.ts). */
export const CHANNELS_WORKSPACE_ACTIONS: Readonly<Record<string, WorkspaceActionTarget>> = {
  'channel-send': { command: 'channels', action: 'send' },
  'channel-doctor': { command: 'channels', action: 'doctor' },
  'channel-setup': { command: 'channels', action: 'setup' },
  'channel-show': { command: 'channels', action: 'configured' },
};
