import { createRecallReviewCommands } from '@goodvibes-jev/engine/terminal-shell/recall-review';
import type { CommandContext } from '../command-registry.ts';
import { getMemoryApi, getMemorySpine } from './recall-query.ts';
import { formatConsolidationProposalForReview } from '../../agent/memory-consolidation-proposals.ts';
export const { handleRecallQueue, handleRecallReview, handleRecallExplain, handleRecallPromote } =
  createRecallReviewCommands<CommandContext>(
    (context) => {
      // The review queue and scope changes act on the store a connected host owns; the local registry is only the embedded fallback.
      const spine = getMemorySpine(context);
      if (spine) return spine;
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
      scopedQueue: false,
      temporal: false,
      confirmPromote: true,
      queueExtras(context) {
        const proposals = context.clients?.memoryConsolidation?.listPendingProposals() ?? [];
        return proposals.length
          ? ['[memory] Pending consolidation proposals (' + proposals.length + '):', ...proposals.map(formatConsolidationProposalForReview)]
          : [];
      },
    },
  );
