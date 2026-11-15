/** Provider output-cap readings and deterministic chat-capability lookup. */
import { knownCatalogChatCapability } from '../providers/model-catalog-facts.js';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import {
  anthropicOutputCap,
  type AnthropicOutputCapRow,
} from './batteries/model-limits.js';
import { ReadingMemo } from './provider-readings.js';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { requireActingReading } from '../types/judgment-held.js';
import { decisionOrClassic, isClassicOperation } from '../runtime/decision-policy.js';

interface OutputCapReadings {
  readonly rows: Map<string, AnthropicOutputCapRow | null>;
  readonly memo: ReadingMemo<AnthropicOutputCapRow | null>;
}
// Scoped to the installed judgment port: a cap read by a retired decision model must not outlive it.
let readingsByPort = new WeakMap<object, OutputCapReadings>();
function readingsFor(port: object): OutputCapReadings {
  let readings = readingsByPort.get(port);
  if (!readings) { readings = { rows: new Map(), memo: new ReadingMemo(256) }; readingsByPort.set(port, readings); }
  return readings;
}

/** The remembered output-cap row of an Anthropic model id: a row, null for none, undefined when not read. */
export function knownAnthropicOutputCapRow(modelId: string): AnthropicOutputCapRow | null | undefined {
  if (isClassicOperation()) return undefined;
  let port: object;
  try { port = judgmentPort('routing.model-limits.known'); } catch { return undefined; }
  return readingsFor(port).rows.get(modelId);
}

/** Reads which documented output-cap row an Anthropic model id belongs to; null only for a settled none; uncertainty remains held. */
export function readAnthropicOutputCapRow(modelId: string, site: string): Promise<AnthropicOutputCapRow | null> {
  // Classic leaves the interpreted family unknown. The adapter already uses
  // the smallest documented cap when neither live nor catalog facts exist.
  return decisionOrClassic(() => readDecisionAnthropicOutputCapRow(modelId, site), () => null);
}
function readDecisionAnthropicOutputCapRow(modelId: string, site: string): Promise<AnthropicOutputCapRow | null> {
  assertJudgmentInput({ modelId });
  const port = judgmentPort(site);
  const { rows, memo } = readingsFor(port);
  const known = rows.get(modelId);
  if (known !== undefined) return Promise.resolve(known);
  return memo.get(modelId, async () => {
    const dispatched = await anthropicOutputCap.route(port, { model_id: modelId }, { site });
    requireActingReading(dispatched.reading);
    const row = dispatched.route !== 'none' ? dispatched.route : null;
    dispatched.recordAction(`cap:${row ?? 'none'}`);
    rows.set(modelId, row);
    return row;
  });
}

/**
 * Keep every listed model unless the catalog says it is not a chat model: a
 * gateway's own aliases and a model released today are callable before any
 * outside catalog lists them. A model the catalog does not know is kept and
 * reported as unclassified.
 */
export async function readChatModelIds(provider: string, modelIds: readonly string[], _site: string,
  onUnclassified?: (modelId: string) => void, options: { readonly keepUnclassified?: boolean } = {}): Promise<string[]> {
  const keepUnclassified = options.keepUnclassified ?? true;
  return modelIds.filter(modelId => {
    const chat = knownCatalogChatCapability(provider, modelId);
    if (chat === undefined) onUnclassified?.(modelId);
    return chat === true || (chat === undefined && keepUnclassified);
  });
}

/** Forgets every remembered model-fact reading; for tests that swap the judgment port. */
export function forgetModelLimitReadings(): void {
  readingsByPort = new WeakMap();
}
