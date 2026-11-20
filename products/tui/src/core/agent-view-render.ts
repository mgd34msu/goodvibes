import { createAgentViewRenderer } from '@goodvibes/engine/terminal-shell/agent-view-render';
import { drawConversationTurn, appendConversationMessages } from './conversation-rendering.ts';
export type { AgentViewInput } from '@goodvibes/engine/terminal-shell/agent-view-render';
export const renderAgentView = createAgentViewRenderer({ drawConversationTurn, appendConversationMessages });
