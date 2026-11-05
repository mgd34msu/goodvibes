import { createConversationRuntimeCommand } from '@goodvibes-jev/engine/terminal-shell/conversation-runtime-command';
import { deriveComposerState } from '../../core/composer-state.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireReadModels } from './runtime-services.ts';
export function registerConversationRuntimeCommands(registry: CommandRegistry): void {
  registry.register(createConversationRuntimeCommand<CommandContext>(ctx => requireReadModels(ctx).session.getSnapshot(), deriveComposerState, false));
}
