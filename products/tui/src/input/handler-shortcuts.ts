import {
  handleGlobalShortcutToken as routeShortcut,
  handleKillRingShortcut,
  type GlobalShortcutState,
} from '@goodvibes-jev/engine/terminal-shell/global-shortcuts';
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import type { CommandContext } from './command-registry.ts';
import type { KillRing } from './kill-ring.ts';
import { nextPermissionMode, permissionModeLabel, type PermissionModeValue } from '../core/permission-mode.ts';

export type GlobalShortcutRouteState = GlobalShortcutState & {
  commandContext?: CommandContext;
  killRing: KillRing;
};
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

      // cycle-permission-mode (Shift+Tab by default) arrives as the legacy xterm
      // backtab literal ('\x1b[Z') or, under a kitty/CSI-u terminal, as
      // tab-with-shift; the literal is read as Shift+Tab so the table decides
      // either way. Only when the composer owns focus: modal/picker routes run
      // earlier and keep their reverse-tab.
      const chord = token.logicalName === '\x1b[Z' ? { ...token, logicalName: 'tab', shift: true } : token;
      if (state.keybindingsManager.lookup(chord) === 'cycle-permission-mode') {
        void cycleSessionPermissionMode(state);
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
 * Cycle this session's permission mode (Shift+Tab). The change is a runtime
 * override: the PermissionManager, the orchestrator's plan-mode instruction
 * and the footer pill (subscribed to the key in turn-event-wiring) read it at
 * once, and it ends with the session. The saved default changes only in
 * /permissions or Settings. Entering the mode with no approvals asks once
 * (default No); the cycle then stays where it was.
 */
async function cycleSessionPermissionMode(state: GlobalShortcutRouteState): Promise<void> {
  const context = state.commandContext;
  const configManager = context?.platform?.configManager;
  if (!context || !configManager) return;
  const current = configManager.get('permissions.mode') as PermissionModeValue | undefined;
  const next = nextPermissionMode(current);
  if (next === 'yolo') {
    const confirmed = await context.confirm?.({
      title: `Switch this session to ${permissionModeLabel(next)}?`,
      body: 'Every tool call in this session runs without asking you, including commands, file changes and messages. The saved default is not changed; it ends with the session.',
      confirmLabel: `Use ${permissionModeLabel(next)}`,
      tone: 'danger',
    }) ?? false;
    if (!confirmed) {
      context.print(`[Permissions] Mode stays ${permissionModeLabel(current ?? 'safe-owner')} for this session.`);
      state.requestRender();
      return;
    }
  }
  // A managed lock on the setting makes the override throw; report it, do not crash the input loop.
  try {
    configManager.setRuntimeOverride('permissions.mode', next);
  } catch (error) {
    context.print(`[Permissions] Mode stays ${permissionModeLabel(current ?? 'safe-owner')}: ${error instanceof Error ? error.message : String(error)}`);
    state.requestRender();
    return;
  }
  context.print(`[Permissions] Mode for this session: ${permissionModeLabel(next)} (the saved default is set in /permissions or Settings)`);
  state.requestRender();
}
