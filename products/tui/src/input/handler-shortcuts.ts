import {
  handleGlobalShortcutToken as routeShortcut,
  handleKillRingShortcut,
  type GlobalShortcutState,
} from '@goodvibes-jev/engine/terminal-shell/global-shortcuts';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import type { CommandContext } from './command-registry.ts';
import type { KillRing } from './kill-ring.ts';
import { nextPermissionMode, permissionModeLabel, type PermissionModeValue } from '../core/permission-mode.ts';

export type GlobalShortcutRouteState = GlobalShortcutState & {
  commandContext?: CommandContext;
  handleDiffApply: () => boolean;
  killRing: KillRing;
};
export function handleGlobalShortcutToken(state: GlobalShortcutRouteState, token: InputToken, viewportHeight: number): boolean {
  return routeShortcut(state, token, viewportHeight, {
    modifiedPageScroll: false,
    killRing: (current) => current.killRing,
    applyDiff: (current) => current.handleDiffApply(),
    rawKey(state, token) {
      // Bare F2 opens the Agents modal (hardcoded, like pageup/pagedown/escape;
      // F2 inside the Agents modal closes it, see input/agents-modal.ts).
      if (token.logicalName === 'f2' && !token.ctrl && !token.meta) {
        state.commandContext?.openAgents?.();
        state.requestRender();
        return true;
      }

      // Shift+Tab cycles Safe owner → Safe Jev → YOLO → Safe owner. Handled here, hardcoded, like
      // escape/f2, because it is not in the keybinding table and bare Tab is
      // already heavily overloaded. Arrives as the legacy xterm backtab literal
      // ('\x1b[Z') OR, under a kitty/CSI-u terminal, as tab-with-shift. Only when
      // the composer owns focus; modal/picker routes run earlier and swallow the
      // token before it reaches here, so overlays keep their reverse-tab too.
      if (token.logicalName === '\x1b[Z' || (token.logicalName === 'tab' && token.shift)) {
        cycleSessionPermissionMode(state);
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

        default:
          return undefined;
      }
    },
  });
}

/**
 * Cycle the session permission mode (Shift+Tab). The change goes through the
 * SDK config surface, configManager.set('permissions.mode', ...), which is
 * what the SDK PermissionManager reads and what the orchestrator consults for
 * its standing plan-mode instruction, so every attached surface converges on
 * the same mode. The footer pill re-renders off the config-key subscription
 * wired in turn-event-wiring; the printed line narrates the change inline.
 */
function cycleSessionPermissionMode(state: GlobalShortcutRouteState): void {
  const configManager = state.commandContext?.platform?.configManager;
  if (!configManager) return;
  const current = configManager.get('permissions.mode') as PermissionModeValue | undefined;
  const next = nextPermissionMode(current);
  configManager.set('permissions.mode', next);
  state.commandContext?.print(`[Permissions] Mode: ${permissionModeLabel(next)}`);
  state.requestRender();
}
