import { startFreshConversation as start } from '@goodvibes/engine/terminal-shell/fresh-conversation';
import type { CommandContext } from '../command-registry.ts';
export type { FreshConversationResult } from '@goodvibes/engine/terminal-shell/fresh-conversation';
export const startFreshConversation = (ctx: CommandContext) => start(ctx, ctx.session.surface);
