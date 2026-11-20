/**
 * The provider transport and cache readings as the adapters call them
 * (batteries/provider-cache.ts). Each remembers what it read, so a model id or
 * an error text is read once per process.
 */
import type { YesNoReading } from '@goodvibes/judgment';
import { judgmentPort } from '@goodvibes/engine/errors';
import { cacheMinimum, copilotClaudeModel } from './batteries/provider-cache.js';
import { ReadingMemo } from './provider-readings.js';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { requireActingReading } from '../types/judgment-held.js';
import { decisionOrClassic } from '../runtime/decision-policy.js';

const holds = (reading: YesNoReading): boolean => requireActingReading(reading).verdict === 'yes';

interface CacheReadingMemos {
  readonly claude: ReadingMemo<boolean>;
  readonly cacheMinimum: ReadingMemo<boolean>;
}
// Scoped to the installed judgment port: readings made by a retired decision model must not outlive it.
let memosByPort = new WeakMap<object, CacheReadingMemos>();
function memosFor(port: object): CacheReadingMemos {
  let memos = memosByPort.get(port);
  if (!memos) { memos = { claude: new ReadingMemo(256), cacheMinimum: new ReadingMemo(128) }; memosByPort.set(port, memos); }
  return memos;
}

/** Whether a Copilot model id names an Anthropic Claude model; only settled readings choose a transport. */
export function readsAsCopilotClaudeModel(modelId: string, site: string): Promise<boolean> {
  // The adapter checks actual /models endpoint/vendor declarations first.
  // Classic's remaining compatibility rule uses Copilot's explicit Claude ID
  // prefix; it never fabricates a model-family reading or confidence.
  return decisionOrClassic(() => readDecisionCopilotClaudeModel(modelId, site), () => modelId.toLowerCase().startsWith('claude-'));
}
function readDecisionCopilotClaudeModel(modelId: string, site: string): Promise<boolean> {
  assertJudgmentInput({ model_id: modelId });
  const port = judgmentPort(site);
  return memosFor(port).claude.get(modelId, async () => {
    const run = await copilotClaudeModel.run(port, { model_id: modelId }, { site });
    const claude = holds(run.readings.claude);
    run.recordAction(claude ? 'anthropic-transport' : 'openai-transport');
    return claude;
  });
}

/** Whether a failed cache creation says the content is below the cache minimum; uncertainty is not cached as false. */
export function readsAsBelowCacheMinimum(errorText: string, site: string): Promise<boolean> {
  return decisionOrClassic(() => readDecisionBelowCacheMinimum(errorText, site), () => false);
}
function readDecisionBelowCacheMinimum(errorText: string, site: string): Promise<boolean> {
  const state = { error: errorText };
  assertJudgmentInput(state);
  const port = judgmentPort(site);
  return memosFor(port).cacheMinimum.get(state.error, async () => {
    const run = await cacheMinimum.run(port, state, { site });
    const below = holds(run.readings.belowMinimum);
    run.recordAction(below ? 'mark-uncacheable' : 'try-again-later');
    return below;
  });
}

/** Forgets every remembered reading here; for tests that swap the judgment port. */
export function forgetProviderCacheReadings(): void {
  memosByPort = new WeakMap();
}
