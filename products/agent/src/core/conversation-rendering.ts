import { createConversationRenderer } from '@goodvibes-jev/engine/terminal-shell/conversation-rendering';
import { getSplashLines } from '../utils/splash-lines.ts';
import { friendlyToolLabel } from '../renderer/tool-labels.ts';
export * from './conversation-render-context.ts';
export { isNavigableSystemContent } from '@goodvibes-jev/engine/terminal-shell/conversation-rendering';
export const { isNavigableSystemMessage, renderConversationUserMessage, renderConversationSystemMessage, buildConversationTurnModel, drawConversationTurn, renderConversationTurn, appendConversationMessages, renderConversationMessageUnit, addConversationSplashScreen, conversationTextToLines, logConversationText, logConversationToolResult } = createConversationRenderer({
  getSplashLines, systemNavigation: 'severity', rows: { paragraphSpacing: false, systemAccent: 'info' }, model: { toolLabel: friendlyToolLabel, showUnverifiedOutput: true },
  compactionPreview: 'compacted-context handoff (re-injected instructions + session summary)', compactionSpacing: 'leading',
});
