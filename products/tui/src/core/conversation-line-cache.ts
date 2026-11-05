import { MessageLineCache as PlatformCache } from '@goodvibes-jev/engine/terminal-shell/conversation-line-cache';
import { buildConversationTurnModel, drawConversationTurn, renderConversationMessageUnit, type ConversationRenderContext } from './conversation-rendering.ts';
export type { TurnTail } from '@goodvibes-jev/engine/terminal-shell/conversation-line-cache';
export class MessageLineCache extends PlatformCache<ConversationRenderContext> {
  constructor() { super({ buildTurnModel: buildConversationTurnModel, drawTurn: drawConversationTurn, drawMessage: renderConversationMessageUnit, messageKind: (context, index) => context.messageKindRegistry.get(index), separator: 'prose' }); }
}
