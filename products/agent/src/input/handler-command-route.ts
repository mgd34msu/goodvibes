import { createCommandModeTokenHandler } from '@goodvibes-jev/engine/terminal-shell/command-mode-route';
import { loadSkillByTrigger } from '@goodvibes-jev/engine/platform/platform/tools';
import { summarizeCommandError } from './commands/command-error.ts';
import type { CommandContext, CommandRegistry } from './command-registry.ts';
import type { AutocompleteEngine } from './autocomplete.ts';
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import type { ConversationManager } from '../core/conversation';
import type { ClipboardPasteSource } from './handler-content-actions.ts';
import { parseSlashCommand } from './slash-command-parser.ts';
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

export const handleCommandModeToken = createCommandModeTokenHandler<CommandContext, CommandModeRouteState>({
  dismissSplash: false,
  passOriginalInput: false,
  passthroughKeys: ['left', 'right'],
  unknownCommand: (name) => `Unknown command /${name}. Type /help for available commands.`,
  commandError: (error) => summarizeCommandError(error),
  prepare(context, _state, raw) {
    const { name, args } = parseSlashCommand(raw);
    return { name, args: [...args], context };
  },
});
