import { createRecallReviewCommands } from '@goodvibes-jev/engine/terminal-shell/recall-review';
import type { CommandContext } from '../command-registry.ts';
import { getMemoryApi } from './recall-query.ts';
import { formatAgentRecordReviewState } from '../../agent/record-labels.ts';
import { formatConsolidationProposalForReview } from '../../agent/memory-consolidation-proposals.ts';
export const { handleRecallQueue, handleRecallReview, handleRecallExplain, handleRecallPromote } =
  createRecallReviewCommands<CommandContext>(
    (context) => {
      const memory = getMemoryApi(context);
      return memory
        ? {
            reviewQueue: (limit) => memory.reviewQueue(limit),
            updateReview: (id, patch) => memory.review(id, patch),
            update: (id, patch) => memory.update(id, patch),
          }
        : null;
    },
    getMemoryApi,
    {
      tag: '[memory]',
      command: 'memory',
      validValuesLabel: 'Valid values',
      validValuesSuffix: '.',
      scopedQueue: false,
      temporal: false,
      staleSeparator: ', ',
      confirmPromote: true,
      reviewState: formatAgentRecordReviewState,
      queueExtras(context) {
        const proposals = context.clients?.memoryConsolidation?.listPendingProposals() ?? [];
        return proposals.length
          ? ['[memory] Pending consolidation proposals (' + proposals.length + '):', ...proposals.map(formatConsolidationProposalForReview)]
          : [];
      },
    },
  );
