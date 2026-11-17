import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
/**
 * memory-usage-detection.ts, reference detection and the per-turn usage
 * tracker every product shares.
 *
 * Did the model's output USE an injected memory, or was the memory merely
 * present in the prompt? Jev reads every memory injected into one turn against
 * the response in ONE request (the `engine.state.memory-usage` battery, the
 * response sent once), so a turn costs one decision-model request however many
 * memories it carried.
 *
 * Exactly two tiers:
 *   - 'referenced': the reading says yes, the response uses the specific
 *     information in this memory.
 *   - 'present': the memory was injected but the reading does not say yes.
 *     An uncertain reading counts as present: the tier claims use only when
 *     the reading supports it.
 *
 * It is NOT a relevance score and NOT ground truth, a memory can shape an
 * answer without showing in it. Everywhere this signal is shown it is
 * labelled as a reading (see MEMORY_USAGE_SIGNAL_NOTE). With decision models
 * off nothing is read and the injections are counted as not assessed.
 */
import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { memoryUsage } from './batteries/memory-usage.js';
import { retainOwnedJson, snapshotJudgmentInput } from '../gate/judgment-input.js';
import { prepareJudgmentResult } from '../gate/judgment-result.js';
import { decisionOrClassic } from '../runtime/decision-policy.js';
import type { MemoryUsageChange } from './memory-usage-stats.js';
import type { MemoryRecord } from './memory-store.js';

export type MemoryReferenceTier = 'referenced' | 'present';

export interface MemoryReferenceInput {
  readonly id: string;
  readonly summary: string;
  readonly detail?: string | undefined;
}

export interface MemoryReferenceResult {
  readonly provenance?: 'classic';
  readonly referenced: readonly string[];
  readonly present: readonly string[];
  /** Ids whose use was read (empty under the classic policy: nothing was assessed). */
  readonly assessed: readonly string[];
  readonly perId: ReadonlyMap<string, MemoryReferenceTier>;
  readonly assertCurrent: () => void;
}

const SITE = 'state.memory-usage-detection';

/** Memories one reading covers; well inside the judgment port's choice limit. A turn never injects this many. */
const MAX_READ_PER_TURN = 200;

export async function detectReferencedMemoryIds(
  responseText: string,
  records: readonly MemoryReferenceInput[],
  options: Pick<JudgmentReadingOptions, 'signal' | 'assertCurrent'> = {},
): Promise<MemoryReferenceResult> {
  return decisionOrClassic(() => detectDecisionReferencedMemoryIds(responseText, records, options), () => {
    const input = { responseText, records };
    const original = retainOwnedJson(input);
    const signal = options.signal, callerCurrent = options.assertCurrent;
    const current = () => {
      signal?.throwIfAborted(); original.assertCurrent();
      if (options.signal !== signal || options.assertCurrent !== callerCurrent) throw new Error('Memory usage owner changed.');
      assertSynchronousJudgmentGuard(callerCurrent, () => new Error('Memory usage guard must be synchronous.'));
      signal?.throwIfAborted(); original.assertCurrent();
    };
    current();
    // These records were injected by the host. Their use in the answer was
    // not assessed, so presence must never earn a reference credit.
    const present = (original.snapshot as typeof input).records.map(record => record.id);
    return { provenance: 'classic' as const, referenced: [], present, assessed: [],
      perId: new Map(present.map(id => [id, 'present' as const])), assertCurrent: current };
  });
}
async function detectDecisionReferencedMemoryIds(responseText: string, records: readonly MemoryReferenceInput[],
  options: Pick<JudgmentReadingOptions, 'signal' | 'assertCurrent'>): Promise<MemoryReferenceResult> {
  const original = retainOwnedJson({ responseText, records });
  const input = snapshotJudgmentInput(original.snapshot) as { responseText: string; records: readonly MemoryReferenceInput[] };
  const current = () => { original.assertCurrent(); options.signal?.throwIfAborted();
    assertSynchronousJudgmentGuard(() => options.assertCurrent?.(), () => new Error('Memory usage guard must be synchronous.'));
  };
  current();
  const referenced: string[] = [];
  const present: string[] = [];
  const perId = new Map<string, MemoryReferenceTier>();
  if (!input.records.length) return { referenced, present, assessed: [], perId, assertCurrent: current };
  // Any past the cap stay unassessed rather than costing a second request.
  const read = input.records.slice(0, MAX_READ_PER_TURN);
  const owner = captureJudgmentPort(SITE, { ...options, assertCurrent: current, prepareResultCapture: prepareJudgmentResult });
  const { ranked } = await memoryUsage.rerank(
    owner.port,
    input.responseText,
    read.map((record) => ({ id: record.id, content: { summary: record.summary, ...(record.detail === undefined ? {} : { detail: record.detail }) } })),
    { site: SITE, signal: owner.signal, beforeAttempt: owner.assertCurrent },
  );
  owner.assertCurrent();
  const readings = new Map(ranked.map((entry) => [entry.id, entry.reading]));
  for (const record of input.records) {
    const reading = readings.get(record.id);
    const tier: MemoryReferenceTier = reading?.outcome === 'act' && reading.verdict === 'yes' ? 'referenced' : 'present';
    perId.set(record.id, tier);
    if (tier === 'referenced') referenced.push(record.id);
    else present.push(record.id);
  }
  return { referenced, present, assessed: read.map((record) => record.id), perId, assertCurrent: owner.assertCurrent };
}

/** What the tracker needs from the memory side: the injected records and one counter update per turn. */
export interface MemoryUsageRecordSource {
  get(id: string): Pick<MemoryRecord, 'id' | 'summary' | 'detail'> | null;
  recordUsage(change: MemoryUsageChange, at?: number): Promise<void>;
}

/**
 * Ties the two ends of a turn together: the ids injected when the prompt is
 * composed (any number of compositions per turn, kept in memory), then at the
 * turn's end one reading of their use and ONE counter update for the turn. An
 * aborted turn still counts its injections, unassessed, and invents no use.
 * Any product that injects memories and sees its turns end feeds it the same
 * way, so the counters on the record mean the same thing everywhere.
 */
export class MemoryUsageTracker {
  private readonly injectedByTurn = new Map<string, { readonly ids: Set<string>; readonly controller: AbortController; started: boolean }>();

  public constructor(private readonly memory: MemoryUsageRecordSource) {}

  /** At prompt composition. Without a turn id (a follow-up) the injection is counted at once, unassessed. */
  public onComposed(turnId: string | null, injectedIds: readonly string[]): void {
    const ids = injectedIds.filter((id) => id.trim());
    if (ids.length === 0) return;
    if (!turnId) {
      void this.memory.recordUsage({ injected: ids }).catch(() => { /* counters are instrumentation only */ });
      return;
    }
    const turn = this.injectedByTurn.get(turnId);
    if (turn && !turn.started) { for (const id of ids) turn.ids.add(id); return; }
    this.injectedByTurn.set(turnId, { ids: new Set(ids), controller: new AbortController(), started: false });
  }

  /** At turn completion: one reading of which injected memories the output used, one counter update. */
  public async onTurnCompleted(turnId: string, response: string): Promise<void> {
    const turn = this.injectedByTurn.get(turnId);
    if (!turn || turn.started) return;
    turn.started = true;
    const records = [...turn.ids].flatMap((id) => {
      const record = this.memory.get(id);
      return record ? [{ id: record.id, summary: record.summary, detail: record.detail }] : [];
    });
    const assertCurrent = () => {
      turn.controller.signal.throwIfAborted();
      if (this.injectedByTurn.get(turnId) !== turn) throw new Error('Memory usage turn is no longer current.');
    };
    let change: MemoryUsageChange = { injected: [...turn.ids] };
    try {
      const result = await detectReferencedMemoryIds(response, records, { signal: turn.controller.signal, assertCurrent });
      change = { injected: [...turn.ids], assessed: result.assessed, referenced: result.referenced };
    } catch (error) {
      // A turn aborted while its use was being read: counted, unassessed, and not an error.
      if (!turn.controller.signal.aborted) throw error;
    } finally {
      if (this.injectedByTurn.get(turnId) === turn) this.injectedByTurn.delete(turnId);
      turn.controller.abort();
      await this.memory.recordUsage(change);
    }
  }

  /** At turn error/cancel: count the injections, unassessed, without crediting a reference. */
  public onTurnAborted(turnId: string): void {
    const turn = this.injectedByTurn.get(turnId);
    if (!turn) return;
    this.injectedByTurn.delete(turnId);
    turn.controller.abort();
    if (!turn.started) void this.memory.recordUsage({ injected: [...turn.ids] }).catch(() => { /* counters are instrumentation only */ });
  }
}
