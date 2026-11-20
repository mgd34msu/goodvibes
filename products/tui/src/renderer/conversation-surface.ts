import { renderConversationFoldedRow as paint, type ConversationEventTone, type ConversationStatusSegment } from '@goodvibes/engine/terminal-shell/conversation-surface';
export * from '@goodvibes/engine/terminal-shell/conversation-surface';
export const renderConversationFoldedRow = (width: number, tone: ConversationEventTone, details: readonly ConversationStatusSegment[], preview?: string | null) => paint(width, tone, details, preview, 'trailing');
