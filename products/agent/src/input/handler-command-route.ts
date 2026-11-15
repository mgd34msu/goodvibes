import { createCommandModeTokenHandler } from '@goodvibes-jev/engine/terminal-shell/command-mode-route';
import { loadSkillByTrigger } from '@goodvibes-jev/engine/platform/platform/tools';
import { summarizeCommandError } from './commands/command-error.ts';
import type { CommandContext, CommandRegistry } from './command-registry.ts';
import type { AutocompleteEngine } from './autocomplete.ts';
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import type { ConversationManager } from '../core/conversation';
import { handleClipboardPaste, type ClipboardPasteSource } from './handler-content-actions.ts';
import { parseSlashCommand } from './slash-command-parser.ts';
import { scheduleCommandArguments } from './commands/schedule-arguments.ts';
import { activeTokens } from '../renderer/theme.ts';

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

/** The command context with clipboard paste bound to this route's prompt state, so /paste and run_keybinding paste edit the composer. */
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
  };
}

export const handleCommandModeToken = createCommandModeTokenHandler<CommandContext, CommandModeRouteState>({
  unknownCommand: (name) => `Unknown command /${name}. Type /help for available commands.`,
  commandError: (error) => summarizeCommandError(error),
  prepare(context, state, raw) {
    const { name, args } = parseSlashCommand(raw);
    if (name === 'schedule' || name === 'sched') {
      // A schedule command is refused when its quoting is incomplete or has an empty word,
      // rather than closing the quote silently and shifting the words that follow.
      const strict = scheduleCommandArguments(raw.slice(1));
      if (!strict) {
        context.print('Not run: the schedule command has an unclosed quote or an empty quoted word, so its words could land in the wrong fields. Close the quote or fill the empty word, then run it again.');
        state.requestRender();
        return undefined;
      }
      return { name, args: strict, context: withComposerBindings(context, state) };
    }
    return { name, args: [...args], context: withComposerBindings(context, state) };
  },
});
