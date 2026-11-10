/**
 * The state tool's mirror of `mode=memory action=set` writes into the retrievable memory store
 * (see mirrorMemoryRecord), and the reading that files a new record under its memory class.
 */
import { assertJudgmentInput, JudgmentInputError } from '../../gate/judgment-input.js';
import { decisionModelPolicyState, judgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { decisionOrClassic, isClassicOperation, withConfiguredDecisionModelPolicy } from '../../runtime/decision-policy.js';
import type { MemoryRegistry } from '../../state/memory-registry.js';
import type { MemoryClass, ProvenanceLink } from '../../state/memory-store.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { memoryClass, memoryClassView } from '../batteries/memory-class.js';
import { ToolInputProjectionError } from '../input-projection.js';

const MEMORY_CLASS_SITE = 'tools.state.memory-class';

/** The class a new mirrored memory record is filed under (see mirrorMemoryRecord). */
async function readMemoryClass(key: string, value: string, options: JudgmentReadingOptions): Promise<{ cls: MemoryClass; assertCurrent: () => void }> {
  const state = memoryClassView(key, value);
  const port = judgmentPort(MEMORY_CLASS_SITE), model = port.model;
  const current = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); if (judgmentPort(MEMORY_CLASS_SITE) !== port || port.model !== model) throw new ToolInputProjectionError('held'); };
  const run = await memoryClass.run(port, state, { site: MEMORY_CLASS_SITE, beforeAttempt: current, ...(options.signal ? { signal: options.signal } : {}) })
    .catch((error: unknown) => { options.signal?.throwIfAborted(); options.assertCurrent?.(); throw error; });
  current();
  const reading = run.readings.memory_class;
  if (reading.outcome !== 'act') {
    run.recordAction('memory write held: unsettled class');
    throw new ToolInputProjectionError('held');
  }
  const cls: MemoryClass = reading.choice;
  run.recordAction(`filed as ${cls}`);
  return { cls, assertCurrent: current };
}

/** What mirroring one memory write does: update the key's existing record, or add a record of this class. */
export type MemoryMirrorPlan = {
  readonly cls: MemoryClass;
  readonly classification: 'pending' | 'assessed';
  readonly provenance?: 'classic';
  readonly assertCurrent: () => void;
  readonly assertOwnerCurrent: () => void;
  readonly signal?: AbortSignal | undefined;
  readonly existingId?: string;
  readonly tags?: string[];
};

/**
 * Plan the mirror of a `mode=memory action=set` write before the flat file is written: find the
 * key's existing record, or read the class a new record is filed under with
 * `engine.tools.memory-class` (tools/batteries/memory-class.ts). An acted reading files it under that class; an unavailable classification preserves
 * the complete record as fresh with a classification-pending tag. Updates are reclassified from their complete replacement content. Undefined when there is no registry or it cannot be read (mirroring is best-effort). Expected classification unavailability does not veto the requested memory write; cancellation and internal client faults stop the operation.
 */
export async function planMemoryMirror(memoryRegistry: MemoryRegistry | undefined, safeKey: string, value: string, options: JudgmentReadingOptions = {}): Promise<MemoryMirrorPlan | undefined> {
  return withConfiguredDecisionModelPolicy(async () => {
    const signal = options.signal, owner = options.assertCurrent;
    const assertOwnerCurrent = () => {
      signal?.throwIfAborted(); decisionModelPolicyState();
      if (options.signal !== signal || options.assertCurrent !== owner) throw new ToolInputProjectionError('held');
      const result: unknown = owner?.();
      if (result !== undefined) { drainOwned(result); throw new ToolInputProjectionError('held'); }
      signal?.throwIfAborted();
    };
    assertOwnerCurrent();
    if (!memoryRegistry) return undefined;
    // Even an unclassified mirror can enter embedding/retrieval, so Classic
    // retains complete native privacy admission before any indexed copy.
    try { assertJudgmentInput({ key: safeKey, value }); }
    catch (error) { if (error instanceof JudgmentInputError) return undefined; throw error; }
    let existing: { id: string; tags: string[] } | undefined;
    try {
      existing = memoryRegistry.getAll().find((record) => record.tags.includes(`state-memory:${safeKey}`));
    } catch (err) {
      logger.warn('state tool: memory registry unreadable, write not mirrored (flat-file write unaffected)', { key: safeKey, error: summarizeError(err) });
      return undefined;
    }
    const expected = JSON.stringify(existing);
    // Existing native storage bucket, not a semantic classification or truth
    // certificate. Pending tags and the result describe every unassessed copy.
    let cls: MemoryClass = 'fact';
    let classificationPending = false;
    let observation: (() => void) | undefined;
    try {
      const reading = await decisionOrClassic<{ cls: MemoryClass; assertCurrent: () => void } | null>(
        () => readMemoryClass(safeKey, value, { signal, assertCurrent: assertOwnerCurrent }), () => null);
      if (reading) { cls = reading.cls; observation = reading.assertCurrent; }
      else classificationPending = true;
    }
    catch (error) {
      // Keep private/untransmittable values in the local source of truth only.
      // Mirroring may embed content, so it must not bypass its transmission check.
      if (error instanceof JudgmentInputError) return undefined;
      if (error instanceof JudgmentError && (error.kind === 'aborted' || error.kind === 'internal')) throw error;
      classificationPending = true;
      logger.debug('state tool: classification unavailable; preserving complete memory for review', { error: summarizeError(error) });
    }
    assertOwnerCurrent();
    const assertCurrent = () => {
      assertOwnerCurrent(); observation?.();
      const current = memoryRegistry.getAll().find((record) => record.tags.includes(`state-memory:${safeKey}`));
      if (JSON.stringify(current) !== expected) throw new ToolInputProjectionError('held');
    };
    assertCurrent();
    const classic = isClassicOperation();
    return { cls, assertCurrent, assertOwnerCurrent, signal, classification: classificationPending ? 'pending' : 'assessed',
      ...(classic ? { provenance: 'classic' as const } : {}), ...(existing ? { existingId: existing.id } : {}),
      tags: [...(existing?.tags ?? ['state-memory', `state-memory:${safeKey}`]).filter(tag => tag !== 'classification-pending' && tag !== 'classic-memory'),
        ...(classificationPending ? ['classification-pending'] : []), ...(classic ? ['classic-memory'] : [])] };
  });
}

/**
 * Mirror a `mode=memory action=set` write into a retrievable `memory_records` row so passive
 * per-turn knowledge injection (which only reads `memory_records`, never the flat
 * `.goodvibes/memory/*.json` files) can surface it. This closes the trust gap where a distilled
 * preference lived only as a flat file that retrieval never saw.
 *
 * Deduped per key via a stable `state-memory:<key>` tag, so repeated statements of the same
 * preference UPDATE the single record instead of piling up duplicates. Provenance is a `file` link
 * back to the flat-file twin (honest about where the record came from). The record enters at
 * reviewState 'fresh' with default confidence, visible to retrieval (the confidence>=55 gate) but
 * NOT stamped 'reviewed'/high-trust, so a self-recorded preference cannot inject itself at unearned
 * trust; the existing confidence-floor/review flow governs it from there.
 *
 * Best-effort: returns true when a record was written, false when there is no plan or the write
 * failed, the caller's flat-file write (the source of truth for `mode=memory list/get`) is
 * unaffected either way.
 */
export async function mirrorMemoryRecord(
  memoryRegistry: MemoryRegistry | undefined,
  safeKey: string,
  value: string,
  plan: MemoryMirrorPlan | undefined,
): Promise<boolean> {
  if (!memoryRegistry || !plan) return false;
  try {
    const flat = value.replace(/\s+/g, ' ').trim();
    const summary = flat.length > 160 ? `${flat.slice(0, 157)}...` : (flat || safeKey);
    const provenance: ProvenanceLink[] = [
      { kind: 'file', ref: `.goodvibes/memory/${safeKey}.json`, label: `state tool memory (${safeKey})` },
    ];
    plan.assertCurrent();
    if (plan.existingId) {
      const updated = memoryRegistry.update(plan.existingId, { cls: plan.cls, summary, detail: value, resetReview: true, ...(plan.tags ? { tags: plan.tags } : {}) },
        { signal: plan.signal, assertCurrent: plan.assertOwnerCurrent });
      if (!updated) return false;
    } else {
      await memoryRegistry.add({
        scope: 'project',
        cls: plan.cls,
        summary,
        detail: value,
        tags: plan.tags ?? ['state-memory', `state-memory:${safeKey}`],
        provenance,
        review: { state: 'fresh' },
      }, { signal: plan.signal, assertCurrent: plan.assertOwnerCurrent });
    }
    return true;
  } catch (err) {
    logger.warn('state tool: memory record mirror failed (flat-file write unaffected)', {
      key: safeKey,
      error: summarizeError(err),
    });
    return false;
  }
}
