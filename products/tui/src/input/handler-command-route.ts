import { createCommandModeTokenHandler } from '@goodvibes-jev/engine/terminal-shell/command-mode-route';
import { scheduleCommandArguments } from './commands/schedule-arguments.ts';
import { activeTokens } from '../renderer/theme.ts';
import { loadSkillByTrigger } from '@goodvibes-jev/engine/platform/platform/tools';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { CommandContext, CommandRegistry } from './command-registry.ts';
import type { AutocompleteEngine } from './autocomplete.ts';
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import type { ConversationManager } from '../core/conversation';
import { handleClipboardPaste, type ClipboardPasteSource } from './handler-content-actions.ts';

export type CommandModeRouteState = {
  commandMode: boolean;
  prompt: string;
  cursorPos: number;
  autocomplete: AutocompleteEngine | null;
  modalStack: string[];
  commandRegistry: CommandRegistry | null;
  commandContext?: CommandContext;
  conversationManager: ConversationManager | null;
  requestRender: () => void;
  handleEscape: () => void;
  projectRoot: string;
  pasteRegistry: Map<string, string>;
  imageRegistry: Map<string, { data: string; mediaType: string }>;
  nextPasteId: number;
  nextImageId: number;
  saveUndoState: () => void;
  ensureInputCursorVisible: () => void;
  clipboard?: ClipboardPasteSource;
};

/** The command context with the composer-bound actions (clipboard paste, nested commands) bound to this route's state. */
function withComposerBindings(context: CommandContext, state: CommandModeRouteState): CommandContext {
  return {
    ...context,
    pasteFromClipboard: () => {
      const result = handleClipboardPaste(
        {
          prompt: state.prompt,
          cursorPos: state.cursorPos,
          pasteRegistry: state.pasteRegistry,
          nextPasteId: state.nextPasteId,
          imageRegistry: state.imageRegistry,
          nextImageId: state.nextImageId,
          saveUndoState: state.saveUndoState,
          ensureInputCursorVisible: state.ensureInputCursorVisible,
          requestRender: state.requestRender,
        },
        context.workspace.shellPaths?.workingDirectory ?? state.projectRoot,
        state.clipboard,
      );
      state.prompt = result.prompt;
      state.cursorPos = result.cursorPos;
      state.nextImageId = result.nextImageId;
      state.nextPasteId = result.nextPasteId;
      return result;
    },
    executeCommand: async (name, args) => {
      const wrapped = withComposerBindings(context, state);
      const handled = state.commandRegistry?.get(name) ? await state.commandRegistry.execute(name, args, wrapped) : false;
      if (handled) return true;
      return (await context.executeCommand?.(name, args)) ?? false;
    },
  };
}

export const handleCommandModeToken = createCommandModeTokenHandler<CommandContext, CommandModeRouteState>({
  dismissSplash: true,
  passOriginalInput: true,
  passthroughKeys: ['left', 'right', 'home', 'end'],
  unknownCommand: (name) => `Unknown command: /${name}. Type /help for available commands.`,
  commandError: (error, name) => `Command /${name} failed: ${summarizeError(error)}`,
  prepare(context, state, raw) {
    const parts = raw.slice(1).trim().split(/\s+/),
      name = parts[0] ?? '';
    const args = name === 'schedule' || name === 'sched' ? scheduleCommandArguments(raw.slice(1)) : parts.slice(1);
    if (!args) {
      context.scheduleReading?.cancel();
      context.print('Invalid schedule command quoting.');
      state.requestRender();
      return undefined;
    }
    return { name, args, context: withComposerBindings(context, state) };
  },
});
