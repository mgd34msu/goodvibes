import { createCommandModeTokenHandler } from '@goodvibes/engine/terminal-shell/command-mode-route';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { summarizeCommandError } from './commands/command-error.ts';
import type { CommandContext, CommandRegistry } from './command-registry.ts';
import type { AutocompleteEngine } from './autocomplete.ts';
import type { InputToken } from '@goodvibes/engine/platform/platform/core';
import type { ConversationManager } from '../core/conversation';
import { handleClipboardPaste, type ClipboardPasteSource } from './handler-content-actions.ts';
import { splitSlashCommand } from './slash-command-parser.ts';
import { activeTokens } from '../renderer/theme.ts';

export type CommandModeRouteState = {
  commandMode: boolean;
  prompt: string;
  cursorPos: number;
  autocomplete: AutocompleteEngine | null;
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
  surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
  unknownCommand: (name) => `Unknown command /${name}. Type /help for available commands.`,
  commandError: (error) => summarizeCommandError(error),
  prepare(context, state, raw) {
    // One split for both apps: an unclosed quote refuses the line instead of being closed silently.
    const split = splitSlashCommand(raw, (name) => state.commandRegistry?.get(name));
    if (!split.ok) {
      context.print(split.reason);
      state.requestRender();
      return undefined;
    }
    return { name: split.name, args: split.args, context: withComposerBindings(context, state) };
  },
});
