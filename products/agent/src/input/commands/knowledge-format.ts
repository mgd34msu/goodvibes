import {cleanInline,sourceLabel,createKnowledgeLabels} from '@goodvibes-jev/engine/terminal-shell/knowledge-labels';
export {cleanInline,sourceLabel} from '@goodvibes-jev/engine/terminal-shell/knowledge-labels';
export const {nodeLabel}=createKnowledgeLabels('  confidence ');
import type { KnowledgeMapResult, KnowledgeService } from '@goodvibes-jev/engine/sdk/platform/knowledge';

export type KnowledgeAskResult = Awaited<ReturnType<KnowledgeService['ask']>>;



export function formatKnowledgeMap(result: KnowledgeMapResult): string {
  return [
    'Agent Knowledge map',
    `  nodes: ${result.nodeCount}${result.totalNodeCount !== undefined && result.totalNodeCount !== result.nodeCount ? ` of ${result.totalNodeCount}` : ''}`,
    `  edges: ${result.edgeCount}${result.totalEdgeCount !== undefined && result.totalEdgeCount !== result.edgeCount ? ` of ${result.totalEdgeCount}` : ''}`,
    '  route /api/goodvibes-agent/knowledge/map',
  ].join('\n');
}





export function renderKnowledgeAskResult(result: KnowledgeAskResult): string {
  const answer = result.answer;
  const lines = [
    `[knowledge] ${result.query}`,
    answer.text,
    '',
    `mode ${answer.mode}  confidence ${answer.confidence}  synthesized ${answer.synthesized ? 'yes' : 'no'}`,
  ];

  if (answer.sources.length > 0) {
    lines.push('', 'Sources:');
    for (const source of answer.sources) lines.push(`  - ${sourceLabel(source)}`);
  }

  if (answer.facts.length > 0) {
    lines.push('', 'Facts:');
    for (const fact of answer.facts) lines.push(`  - ${nodeLabel(fact)}`);
  }

  if (answer.linkedObjects.length > 0) {
    lines.push('', 'Linked objects:');
    for (const object of answer.linkedObjects) lines.push(`  - ${nodeLabel(object)}`);
  }

  if (answer.gaps.length > 0) {
    lines.push('', 'Gaps:');
    for (const gap of answer.gaps) lines.push(`  - ${nodeLabel(gap)}`);
  }

  return lines.join('\n');
}
