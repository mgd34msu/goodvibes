import { randomUUID } from 'node:crypto';
import { SOURCE_SCREENING_LIMITS, type ProtectedSource, type ProtectedSourceOwner, type SourceScreeningHold, type SourceScreeningReceipt } from '@goodvibes-jev/engine/platform/platform/security';
import { ToolInputProjectionError, type ToolInputProjectionRequest, type ToolInputProjector, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { captureModelReadingInput } from './agent-harness-model-reading-source.ts';
import { createComparisonOperation } from './agent-model-compare-operation.ts';
import type { AgentModelCompareToolDeps } from './agent-model-compare-types.ts';

/** The most text one comparison can send to each candidate: the prompt, any inlined document, the system prompt and the request. */
export const COMPARISON_TEXT_LIMIT = 1_000_000;

/** Characters two neighbouring slices of one long string share. */
const SLICE_OVERLAP = 512;

const clearedRequests = new WeakMap<object, () => void>();
export function assertComparisonCandidateSource(args: Record<string, unknown>): void {
  const assertCurrent = clearedRequests.get(args);
  if (!assertCurrent) throw new ToolInputProjectionError('held');
  assertCurrent();
}

/** The text every candidate sends. It is the same for every candidate (they differ only by model), so it is screened once. */
export function comparisonSharedText(prompt: string, systemPrompt: string, comparisonRequest: unknown): unknown {
  return captureModelReadingInput({ prompt, systemPrompt, comparisonRequest });
}

function tooLarge(characters: number): Error {
  return new Error(`Nothing was sent: this comparison is ${characters.toLocaleString('en-US')} characters (prompt, inlined document, system prompt and request together) and the limit is ${COMPARISON_TEXT_LIMIT.toLocaleString('en-US')}. Compare a shorter document or an excerpt saved as its own artifact.`);
}

/** Whole values retain their key paths when the complete text needs several batches. */
function sourceBatches(source: unknown): readonly (readonly string[])[] {
  const serialized = JSON.stringify(source);
  if (typeof serialized !== 'string') throw new Error('Nothing was sent: the comparison request is not plain text and data.');
  if (serialized.length > COMPARISON_TEXT_LIMIT) throw tooLarge(serialized.length);
  const parts: string[] = [];
  const collect = (value: unknown, path: readonly string[]) => {
    const part = path.length ? JSON.stringify({ path, value }) : serialized;
    if (part.length <= SOURCE_SCREENING_LIMITS.characters) { parts.push(part); return; }
    if (!value || typeof value !== 'object' || !Object.keys(value).length) {
      // One string longer than a screening batch (a document inlined into the prompt): screen it as
      // slices under the same path that overlap, so a value cannot hide across a slice boundary.
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      // JSON escaping can double a character, so a slice is at most half a batch.
      const width = Math.floor((SOURCE_SCREENING_LIMITS.characters - JSON.stringify({ path, slice: 0, value: '' }).length - 64) / 2);
      const overlap = Math.min(SLICE_OVERLAP, Math.floor(width / 4));
      for (let offset = 0, slice = 0; ; offset += width - overlap, slice += 1) {
        parts.push(JSON.stringify({ path, slice, value: text.slice(offset, offset + width) }));
        if (offset + width >= text.length) break;
      }
      return;
    }
    for (const [key, entry] of Object.entries(value)) collect(entry, [...path, key]);
  };
  collect(source, []);
  const batches: string[][] = [];
  let size = 0;
  for (const part of parts) {
    let batch = batches.at(-1);
    if (!batch || batch.length >= SOURCE_SCREENING_LIMITS.parts || size + part.length > SOURCE_SCREENING_LIMITS.characters) {
      batch = []; batches.push(batch); size = 0;
    }
    batch.push(part); size += part.length;
  }
  if (batches.length > SOURCE_SCREENING_LIMITS.sources) throw tooLarge(serialized.length);
  return batches;
}

/** Why no candidate was sent, and what to do. */
function screeningHeld(reason: SourceScreeningHold): string {
  if (reason === 'protected-input') return 'Nothing was sent: the prompt or document holds text that looks like a credential or private value. Remove it, then run the comparison again.';
  if (reason === 'route-unavailable' || reason === 'proxy-configured') return 'Nothing was sent: private-text screening is not available in this session, so no candidate model may receive the text.';
  if (reason === 'busy') return 'Nothing was sent: private-text screening is busy. Run the comparison again in a moment.';
  return `Nothing was sent: private-text screening did not finish (${reason}). Run the comparison again.`;
}

interface SharedScreening {
  readonly batches: readonly (readonly string[])[];
  readonly serialized: string;
  released: boolean;
}
const screenings = new Map<string, SharedScreening>();

/**
 * Screens the text all candidates of one comparison will send, once, before
 * any candidate is admitted. Each candidate names the returned id and is
 * cleared by comparing its own text to the screened text; nothing is read or
 * screened again per candidate. `release` ends the screening for every candidate.
 */
export async function screenComparisonRequest(owner: ProtectedSourceOwner | undefined, shared: unknown, signal?: AbortSignal): Promise<{ readonly id: string; release(): Promise<void> }> {
  if (!owner) throw new ToolInputProjectionError('unconfigured');
  const batches = sourceBatches(shared);
  const handles: ProtectedSource[] = [];
  const release = async () => {
    const results = await Promise.allSettled(handles.map(handle => Promise.resolve().then(() => owner.release(handle))));
    if (results.some(result => result.status === 'rejected')) throw new ToolInputProjectionError('unavailable');
  };
  try {
    for (const parts of batches) { signal?.throwIfAborted(); handles.push(owner.capture(parts)); }
    const receipts: SourceScreeningReceipt[] = [];
    for (const handle of handles) {
      signal?.throwIfAborted();
      const screened = await owner.screen(handle);
      if (screened.status !== 'settled') throw new ToolInputProjectionError('held', screeningHeld(screened.reason));
      receipts.push(screened.receipt);
    }
    // The receipts must hold exactly the batches captured.
    receipts.forEach((receipt, index) => {
      const projected = owner.project(receipt), parts = batches[index]!;
      if (projected.length !== parts.length || projected.some((part, at) => part !== parts[at])) throw new ToolInputProjectionError('held');
    });
  } catch (error) { await release().catch(() => {}); throw error; }
  const id = randomUUID();
  const screening: SharedScreening = { batches, serialized: JSON.stringify(batches), released: false };
  screenings.set(id, screening);
  return { id, async release() { screening.released = true; screenings.delete(id); await release(); } };
}

/** The registered owner clears each candidate against the comparison's one screening before hosted admission. */
export function createComparisonCandidateProjector(registry: ToolRegistry, deps: AgentModelCompareToolDeps): ToolInputProjector {
  return Object.freeze({ async project(request: ToolInputProjectionRequest) {
    if (deps.toolRegistry !== registry) throw new ToolInputProjectionError('held');
    const operation = createComparisonOperation(deps, request.args,
      { signal: request.signal, assertCurrent: request.assertCurrent });
    operation.assertCurrent();
    const captured = captureModelReadingInput(request.args);
    if (typeof captured.modelId !== 'string' || typeof captured.providerId !== 'string') throw new ToolInputProjectionError('held');
    const screening = typeof captured.screeningId === 'string' ? screenings.get(captured.screeningId) : undefined;
    if (!screening) throw new ToolInputProjectionError('held', 'A comparison candidate is sent only by agent_model_compare mode:"run", which screens the request first.');
    const shared = comparisonSharedText(String(captured.prompt ?? ''), String(captured.systemPrompt ?? ''), captured.comparisonRequest);
    if (JSON.stringify(sourceBatches(shared)) !== screening.serialized) throw new ToolInputProjectionError('held');
    const modelId = captured.modelId, providerId = captured.providerId;
    const provider = deps.providerRegistry.getForModel(modelId, providerId);
    const serializedArgs = JSON.stringify(captured);
    let released = false;
    const assertCurrent = () => {
      if (released || screening.released) throw new ToolInputProjectionError('held');
      request.signal?.throwIfAborted(); operation.assertCurrent();
      if (deps.providerRegistry.getForModel(modelId, providerId) !== provider) throw new ToolInputProjectionError('held');
    };
    assertCurrent();
    return { status: 'projected' as const, args: captured, assertCurrent,
      async release() { released = true; },
      assertRepairedArgs(args: Record<string, unknown>) {
        const assertBound = () => {
          assertCurrent();
          if (JSON.stringify(captureModelReadingInput(args)) !== serializedArgs) throw new ToolInputProjectionError('held');
        };
        assertBound(); clearedRequests.set(args, assertBound);
      },
    };
  } });
}
