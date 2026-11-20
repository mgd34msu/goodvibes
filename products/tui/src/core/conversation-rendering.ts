import { createConversationRenderer } from '@goodvibes/engine/terminal-shell/conversation-rendering';
import { getSplashLines } from '../utils/splash-lines.ts';
export * from './conversation-render-context.ts';
export { isNavigableSystemContent } from '@goodvibes/engine/terminal-shell/conversation-rendering';
export const { isNavigableSystemMessage, renderConversationUserMessage, renderConversationSystemMessage, buildConversationTurnModel, drawConversationTurn, renderConversationTurn, appendConversationMessages, renderConversationMessageUnit, addConversationSplashScreen, conversationTextToLines, logConversationText, logConversationToolResult } = createConversationRenderer({
  getSplashLines, systemNavigation: 'kind', rows: { paragraphSpacing: true, systemAccent: 'muted' }, model: undefined,
  compactionPreview: 're-injected instructions + session summary', compactionSpacing: 'trailing',
});
