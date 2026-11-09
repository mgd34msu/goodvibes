import { sourceLabel } from './knowledge-labels.js';
import type { KnowledgeService } from '@goodvibes-jev/engine/platform/platform/knowledge';
type KnowledgeAskResult = Awaited<ReturnType<KnowledgeService['ask']>>;
export function createKnowledgeAnswerRenderer(presentation: {
  readonly nodeLabel: (node: KnowledgeAskResult['answer']['facts'][number]) => string;
  readonly separator: string;
}) {
  return function renderKnowledgeAskResult(result: KnowledgeAskResult): string {
    const answer = result.answer;
    const lines = [
      `[knowledge] ${result.query}`,
      answer.text,
      '',
      `mode${presentation.separator}${answer.mode}  confidence${presentation.separator}${answer.confidence}  synthesized${presentation.separator}${answer.synthesized ? 'yes' : 'no'}`,
    ];

    if (answer.sources.length > 0) {
      lines.push('', 'Sources:');
      for (const source of answer.sources) lines.push(`  - ${sourceLabel(source)}`);
    }

    if (answer.facts.length > 0) {
      lines.push('', 'Facts:');
      for (const fact of answer.facts) lines.push(`  - ${presentation.nodeLabel(fact)}`);
    }

    if (answer.linkedObjects.length > 0) {
      lines.push('', 'Linked objects:');
      for (const object of answer.linkedObjects) lines.push(`  - ${presentation.nodeLabel(object)}`);
    }

    if (answer.gaps.length > 0) {
      lines.push('', 'Gaps:');
      for (const gap of answer.gaps) lines.push(`  - ${presentation.nodeLabel(gap)}`);
    }

    return lines.join('\n');
  };
}
