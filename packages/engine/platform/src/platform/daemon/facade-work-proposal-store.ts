import { join } from 'node:path';
import { WorkProposalStore } from '../agents/work-proposal-store.js';
import { readConversationGateConfig } from '../agents/conversation-gate.js';
import type { ConfigManager } from '../config/manager.js';
import type { ConversationGateDeps } from './surface-conversation-gate.js';
import { settleUnstartedWork } from './surface-conversation-gate.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/**
 * Construct the facade's existing proposal store without changing its policy.
 * A proposal nobody answers is dropped by the store; the broker closes the
 * held message behind it so the session does not read as having work waiting
 * forever.
 */
export function createFacadeWorkProposalStore(
  config: Pick<ConfigManager, 'get' | 'getCategory' | 'getControlPlaneConfigDir'>,
  sessionBroker: ConversationGateDeps['sessionBroker'],
  now?: () => number,
): WorkProposalStore {
  // Pending work proposals for the conversation-first spawn gate. Persisted
  // beside the other control-plane state so a proposal survives a daemon
  // restart; the store validates and reaps on load, so a stale one is not
  // answerable after it expires.
  const workProposals = new WorkProposalStore({
    storePath: join(config.getControlPlaneConfigDir(), 'work-proposals.json'),
    maxPending: () => readConversationGateConfig(config).maxPendingProposals,
    ...(now ? { now } : {}),
    onUnanswered: (proposal) => {
      void settleUnstartedWork(
        { sessionBroker },
        proposal,
        'The proposed work was not answered in time, so it was not started. Send the message again.',
      );
    },
  });
  void workProposals.init().catch((error: unknown) => {
    logger.warn('WorkProposalStore init failed; the conversation gate will re-propose', {
      error: summarizeError(error),
    });
  });
  return workProposals;
}
