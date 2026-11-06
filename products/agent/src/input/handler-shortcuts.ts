import {
  handleGlobalShortcutToken as routeShortcut,
  type GlobalShortcutState,
} from '@goodvibes-jev/engine/terminal-shell/global-shortcuts';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import type { CommandContext } from './command-registry.ts';
export type { PromptEdit } from '@goodvibes-jev/engine/terminal-shell/global-shortcuts';
export type GlobalShortcutRouteState = GlobalShortcutState & {
  commandContext?: CommandContext;
  cycleAgentWorkspaceCategory: (direction: 'next' | 'prev') => void;
  dismissAgentWorkspace: () => boolean;
};
export function handleGlobalShortcutToken(state: GlobalShortcutRouteState, token: InputToken, viewportHeight: number): boolean {
  return routeShortcut(state, token, viewportHeight, {
    modifiedPageScroll: true,
    action(state, action) {
      switch (action) {
        case 'workspace-close-all':
        case 'workspace-close':
          state.dismissAgentWorkspace();
          state.requestRender();
          return true;

        case 'workspace-picker':
          state.commandContext?.openWorkspacePicker?.();
          state.requestRender();
          return true;

        case 'activity-open':
          state.commandContext?.openActivityModal?.();
          state.requestRender();
          return true;

        case 'workspace-tab-next':
          state.cycleAgentWorkspaceCategory('next');
          return true;

        case 'workspace-tab-prev':
          state.cycleAgentWorkspaceCategory('prev');
          return true;

        default:
          return undefined;
      }
    },
  });
}
