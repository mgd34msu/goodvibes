import {
  handleGlobalShortcutToken as routeShortcut,
  type GlobalShortcutState,
} from '@goodvibes-jev/engine/terminal-shell/global-shortcuts';
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import type { CommandContext } from './command-registry.ts';
import { cycleSessionPermissionMode, getSharedModeFlash } from '@goodvibes-jev/engine/terminal-shell/session-permission-mode';
import { getSharedNotificationFeed } from '../core/notifications-feed.ts';
import { hasActiveExecutionMode, readExecutionMode, setExecutionMode } from '../permissions/execution-mode.ts';
export type { PromptEdit } from '@goodvibes-jev/engine/terminal-shell/global-shortcuts';
export type GlobalShortcutRouteState = GlobalShortcutState & {
  commandContext?: CommandContext;
  cycleAgentWorkspaceCategory: (direction: 'next' | 'prev') => void;
  dismissAgentWorkspace: () => boolean;
};
export function handleGlobalShortcutToken(state: GlobalShortcutRouteState, token: InputToken, viewportHeight: number): boolean {
  return routeShortcut(state, token, viewportHeight, {
    modifiedPageScroll: true,
    rawKey(state, token) {
      // cycle-permission-mode (Shift+Tab by default; the tokenizer reads the
      // xterm back-tab CSI Z as tab-with-shift). Only when the composer owns
      // focus: modal/picker routes and the session chips run earlier and keep
      // their reverse-tab.
      if (state.keybindingsManager.lookup(token) === 'cycle-permission-mode') {
        void cycleMode(state);
        return true;
      }
      return undefined;
    },
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

        case 'open-notifications':
          // Ctrl+N: the notices the status bar counts.
          state.commandContext?.openNotifications?.();
          state.requestRender();
          return true;

        case 'failure-other-model':
        case 'failure-details':
          // Alt+O / Alt+I on the newest failed turn's row; consumed either way, never typed text.
          state.commandContext?.failedTurnAction?.(action === 'failure-other-model' ? 'other-model' : 'details');
          state.requestRender();
          return true;

        default:
          return undefined;
      }
    },
  });
}

/**
 * Shift+Tab: this session's permission mode (session-permission-mode.ts); a
 * hosted session's mode is its host's, so the change goes there. The status
 * bar's mode segment shows the new words and flashes; nothing is written into
 * the conversation. A change that cannot be made is a notice.
 */
async function cycleMode(state: GlobalShortcutRouteState): Promise<void> {
  const context = state.commandContext;
  const configManager = context?.platform?.configManager;
  if (!context || !configManager) return;
  await cycleSessionPermissionMode({
    configManager,
    confirm: context.confirm,
    hosted: hasActiveExecutionMode(configManager)
      ? { current: () => readExecutionMode(configManager), apply: (mode) => setExecutionMode(configManager, mode) }
      : null,
    flash: getSharedModeFlash(),
    refused: (message) => {
      getSharedNotificationFeed().recordNotice({ domain: 'permissions', level: 'warning', title: message, body: undefined, timestamp: Date.now(), restored: false });
    },
    requestRender: () => state.requestRender(),
  });
}
