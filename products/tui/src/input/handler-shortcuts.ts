import {
  handleGlobalShortcutToken as routeShortcut,
  handleKillRingShortcut,
  type GlobalShortcutState,
} from '@goodvibes/engine/terminal-shell/global-shortcuts';
import type { InputToken } from '@goodvibes/engine/platform/platform/core';
import type { CommandContext } from './command-registry.ts';
import type { KillRing } from './kill-ring.ts';
import { cycleSessionPermissionMode, getSharedModeFlash } from '@goodvibes/engine/terminal-shell/session-permission-mode';
import { getSharedNotificationFeed } from '../views/notifications-feed.ts';

export type GlobalShortcutRouteState = GlobalShortcutState & {
  commandContext?: CommandContext;
  killRing: KillRing;
};

/** The failure row's key actions and what each asks of the row (turn-failure-actions.ts). */
const FAILURE_KEY_ACTIONS = {
  'failure-other-model': 'other-model',
  'failure-details': 'details',
  'failure-sign-in': 'sign-in',
} as const;

export function handleGlobalShortcutToken(state: GlobalShortcutRouteState, token: InputToken, viewportHeight: number): boolean {
  return routeShortcut(state, token, viewportHeight, {
    modifiedPageScroll: false,
    killRing: (current) => current.killRing,
    rawKey(state, token) {
      // Bare F2 opens the Agents modal (hardcoded, like pageup/pagedown/escape;
      // F2 inside the Agents modal closes it, see input/agents-modal.ts).
      if (token.logicalName === 'f2' && !token.ctrl && !token.meta) {
        state.commandContext?.openAgents?.();
        state.requestRender();
        return true;
      }

      // cycle-permission-mode (Shift+Tab by default; the tokenizer reads the
      // xterm back-tab CSI Z as tab-with-shift). Only when the composer owns
      // focus: modal/picker routes run earlier and keep their reverse-tab.
      if (state.keybindingsManager.lookup(token) === 'cycle-permission-mode') {
        void cycleMode(state);
        return true;
      }

      return undefined;
    },
    action(state, action) {
      const edit = handleKillRingShortcut(state, action);
      if (edit !== undefined) return edit;
      switch (action) {
        case 'clear-cancel':
          state.handleCtrlC();
          return true;

        case 'cancel-tool-call':
          // Cancel JUST the currently-running tool call (the live transcript row).
          // No-op (still consumed) when nothing is running, the composer keeps the
          // keystroke rather than letting it fall through as text.
          state.commandContext?.cancelToolCall?.();
          return true;

        case 'toggle-memory-provenance':
          // Expand/collapse the provenance chip's drill-in. No-op when the chip is
          // not showing; still consumed so the composer never sees a stray Alt+M.
          state.commandContext?.toggleMemoryProvenance?.();
          return true;

        case 'voice-input':
          // Start recording, or stop the recording already running. Routed globally;
          // still consumed when voice input is not wired, so a stray Alt+V never
          // lands in the prompt as text.
          state.commandContext?.toggleVoiceInput?.();
          return true;

        case 'toggle-keep-awake': {
          // Flip the daemon-held keep-awake toggle; the always-visible "sleep
          // disabled" chip is the confirmation. Fire-and-forget (the seam renders on
          // completion); errors are swallowed so a keystroke never throws.
          const power = state.commandContext;
          const current = power?.getPowerState?.().keepAwake ?? false;
          void power?.setKeepAwake?.(!current);
          return true;
        }

        case 'command-palette':
          state.commandContext?.openCommandPalette?.();
          state.requestRender();
          return true;

        case 'open-agents':
          // Ctrl+O: the Agents modal (the same as F2).
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
        case 'failure-sign-in':
          // Alt+O / Alt+I / Alt+S on the newest failed turn's row; consumed either way, never typed text.
          state.commandContext?.failedTurnAction?.(FAILURE_KEY_ACTIONS[action]);
          state.requestRender();
          return true;

        default:
          return undefined;
      }
    },
  });
}

/**
 * Shift+Tab: this session's permission mode (session-permission-mode.ts). The
 * status bar's mode segment shows the new words and flashes; nothing is
 * written into the conversation. A change that cannot be made is a notice.
 */
async function cycleMode(state: GlobalShortcutRouteState): Promise<void> {
  const context = state.commandContext;
  const configManager = context?.platform?.configManager;
  if (!context || !configManager) return;
  await cycleSessionPermissionMode({
    configManager,
    confirm: context.confirm,
    flash: getSharedModeFlash(),
    refused: (message) => {
      getSharedNotificationFeed().recordNotice({ domain: 'permissions', level: 'warning', title: message, body: undefined, timestamp: Date.now(), restored: false });
    },
    requestRender: () => state.requestRender(),
  });
}
