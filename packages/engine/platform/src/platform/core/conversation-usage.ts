/**
 * conversation-usage.ts, usage totals folded from a transcript's assistant
 * messages (re-exported by conversation.ts).
 *
 * The fold is the platform's (platform/core sumConversationUsage): a resumed
 * session hydrates its token counters and its context figure from it. The
 * context figure is the latest real turn request's; a follow-up
 * acknowledgement (sent without tool definitions) counts toward the totals
 * only, so the meter never drops to that smaller request's size.
 */

export { sumConversationUsage } from './orchestrator-usage.js';

import { sumConversationUsage } from './orchestrator-usage.js';
import type { ConversationMessageSnapshot, TokenUsage } from './conversation.js';
import type { Orchestrator } from './orchestrator.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { computeUsageCostUsd } from '../providers/model-pricing.js';

/** Where a restored transcript's responses are priced: the registry the live turns price with. */
export type TranscriptPricing = Pick<ProviderRegistry, 'listModels' | 'resolveModelPricing'>;

/**
 * The USD cost of one restored response at its own model's price, the same
 * resolution the live turn uses. A transcript names its model by display name,
 * so the name is mapped back to the model id of that provider first.
 */
function transcriptPriceOf(pricing: TranscriptPricing): (usage: TokenUsage, model: string | undefined, provider: string | undefined) => number | null {
  let ids: Map<string, string> | undefined;
  return (usage, model, provider) => {
    if (!model) return null;
    if (!ids) {
      ids = new Map();
      for (const definition of pricing.listModels()) {
        ids.set(`${definition.provider}\u0000${definition.displayName}`, definition.id);
        ids.set(`${definition.provider}\u0000${definition.id}`, definition.id);
      }
    }
    const modelId = ids.get(`${provider ?? ''}\u0000${model}`) ?? model;
    return computeUsageCostUsd(pricing.resolveModelPricing(modelId, provider), usage, provider);
  };
}

// Keep availability on the counter object: live turns mutate it, while a
// successful restore (including /clear) replaces it with a complete fold.
const unavailableUsage = new WeakSet<object>();

export function isConversationUsageAvailable(usage: object): boolean {
  return !unavailableUsage.has(usage);
}

export function isConversationContextAvailable(orchestrator: Pick<Orchestrator, 'usage' | 'lastInputTokens'>): boolean {
  return isConversationUsageAvailable(orchestrator.usage) || orchestrator.lastInputTokens > 0;
}

/**
 * Restore unknown billing as unavailable, without leaking persisted values.
 * With `pricing`, the restored totals carry the session's cost so far, each
 * response at its own model's price, and later responses add to it.
 */
export function hydrateConversationUsage(
  conversation: { getMessageSnapshot(): readonly ConversationMessageSnapshot[] },
  orchestrator: Pick<Orchestrator, 'usage' | 'lastInputTokens'>,
  pricing?: TranscriptPricing,
): void {
  const messages = conversation.getMessageSnapshot();
  let restored: ReturnType<typeof sumConversationUsage>;
  try {
    restored = sumConversationUsage(messages, pricing ? transcriptPriceOf(pricing) : undefined);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    // These are only the new live counters. Readers must not present them as
    // complete session totals, and no prior session's context survives.
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    unavailableUsage.add(usage);
    orchestrator.usage = usage;
    orchestrator.lastInputTokens = 0;
    return;
  }
  orchestrator.usage = restored.usage;
  orchestrator.lastInputTokens = restored.lastInputTokens;
}
