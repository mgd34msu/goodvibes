import { createKnowledgeAnswerRenderer } from '@goodvibes-jev/engine/terminal-shell/knowledge-answer';
import { cleanInline, sourceLabel, createKnowledgeLabels } from '@goodvibes-jev/engine/terminal-shell/knowledge-labels';
export { cleanInline, sourceLabel } from '@goodvibes-jev/engine/terminal-shell/knowledge-labels';
export const { nodeLabel } = createKnowledgeLabels('  confidence ');
import type { KnowledgeMapResult, KnowledgeService } from '@goodvibes-jev/engine/platform/platform/knowledge';

export type KnowledgeAskResult = Awaited<ReturnType<KnowledgeService['ask']>>;

export function formatKnowledgeMap(result: KnowledgeMapResult): string {
  return [
    'Agent Knowledge map',
    `  nodes: ${result.nodeCount}${result.totalNodeCount !== undefined && result.totalNodeCount !== result.nodeCount ? ` of ${result.totalNodeCount}` : ''}`,
    `  edges: ${result.edgeCount}${result.totalEdgeCount !== undefined && result.totalEdgeCount !== result.edgeCount ? ` of ${result.totalEdgeCount}` : ''}`,
    '  route /api/goodvibes-agent/knowledge/map',
  ].join('\n');
}

export const renderKnowledgeAskResult = createKnowledgeAnswerRenderer({ nodeLabel, separator: ' ' });
