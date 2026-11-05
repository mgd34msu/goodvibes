import { createAgentViewRenderer } from '@goodvibes-jev/engine/terminal-shell/agent-view-render';
import { drawConversationTurn, appendConversationMessages } from './conversation-rendering.ts';
import { friendlyToolLabel } from '../renderer/tool-labels.ts';
export type { AgentViewInput } from '@goodvibes-jev/engine/terminal-shell/agent-view-render';
export const renderAgentView = createAgentViewRenderer({ drawConversationTurn, appendConversationMessages }, { toolLabel: friendlyToolLabel, showUnverifiedOutput: true });
