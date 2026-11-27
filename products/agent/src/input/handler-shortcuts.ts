import {
  handleGlobalShortcutToken as routeShortcut,
  runGlobalShortcutAction,
  type GlobalShortcutPolicy,
  type GlobalShortcutState,
} from '@goodvibes/engine/terminal-shell/global-shortcuts';
import type { InputToken } from '@goodvibes/engine/platform/platform/core';
import type { CommandContext } from './command-registry.ts';
import { cycleSessionPermissionMode, getSharedModeFlash } from '@goodvibes/engine/terminal-shell/session-permission-mode';
import { getSharedNotificationFeed } from '../core/notifications-feed.ts';
import { hasActiveExecutionMode, readExecutionMode, setExecutionMode } from '../permissions/execution-mode.ts';
export type { PromptEdit } from '@goodvibes/engine/terminal-shell/global-shortcuts';
export type GlobalShortcutRouteState = GlobalShortcutState & {
  commandContext?: CommandContext;
};

/** The failure row's key actions and what each asks of the row (turn-failure-actions.ts). */
const FAILURE_KEY_ACTIONS = {
  'failure-other-model': 'other-model',
  'failure-details': 'details',
  'failure-retry': 'retry',
  'failure-sign-in': 'sign-in',
} as const;

export function handleGlobalShortcutToken(state: GlobalShortcutRouteState, token: InputToken, viewportHeight: number): boolean {
  return routeShortcut(state, token, viewportHeight, SHORTCUT_POLICY);
}

/** Do what a completed leader sequence names, exactly as its own key would (leader-key.ts). */
export function runShortcutAction(state: GlobalShortcutRouteState, action: string): boolean {
  return runGlobalShortcutAction(state, action, SHORTCUT_POLICY);
}

const SHORTCUT_POLICY: GlobalShortcutPolicy<GlobalShortcutRouteState> = {
    rawKey(state, token) {
      // cycle-permission-mode (Shift+Tab by default; the tokenizer reads the
      // xterm back-tab CSI Z as tab-with-shift). Only when the composer owns
      // focus: modal/picker routes run earlier and keep their reverse-tab; the
      // session row switches with next-session / previous-session instead.
      if (state.keybindingsManager.lookup(token) === 'cycle-permission-mode') {
        void cycleMode(state);
        return true;
      }
      return undefined;
    },
    action(state, action) {
      switch (action) {
        case 'command-palette':
          state.commandContext?.openCommandPalette?.();
          state.requestRender();
          return true;

        case 'open-agents':
          state.commandContext?.openAgents?.();
          state.requestRender();
          return true;

        case 'open-notifications':
          // Ctrl+N: the notices the status bar counts.
          state.commandContext?.openNotifications?.();
          state.requestRender();
          return true;

        case 'failure-other-model':
        case 'failure-details':
        case 'failure-retry':
        case 'failure-sign-in':
          // On the newest failed turn's row; consumed either way, never typed text.
          state.commandContext?.failedTurnAction?.(FAILURE_KEY_ACTIONS[action]);
          state.requestRender();
          return true;

        case 'open-menu':
          // The menu of every place (terminal-shell/places).
          state.commandContext?.openPlaceMenu?.();
          state.requestRender();
          return true;

        case 'model-picker-group':
          // The model list's grouping, while the list is open.
          state.commandContext?.cycleModelPickerGroup?.();
          state.requestRender();
          return true;

        default:
          return undefined;
      }
    },
};

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
      ? { current: () => readExecutionMode(configManager), apply: (mode) => setExecutionMode(configManager, mode, { personAsked: true }) }
      : null,
    flash: getSharedModeFlash(),
    refused: (message) => {
      getSharedNotificationFeed().recordNotice({ domain: 'permissions', level: 'warning', title: message, body: undefined, timestamp: Date.now(), restored: false });
    },
    requestRender: () => state.requestRender(),
  });
}
