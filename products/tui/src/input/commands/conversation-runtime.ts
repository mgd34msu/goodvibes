import { createConversationReading } from '@goodvibes/engine/terminal-shell/conversation-runtime-command';
import { deriveComposerState } from '../../core/composer-state.ts';
import type { CommandContext } from '../command-registry.ts';
import { requireReadModels } from './runtime-services.ts';

/** Reading the open conversation, for `/session`'s "Look through this conversation" actions. */
export const conversationReading = createConversationReading<CommandContext>((ctx) => requireReadModels(ctx).session.getSnapshot(), deriveComposerState);
