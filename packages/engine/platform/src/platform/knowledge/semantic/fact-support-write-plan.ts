import { sameKnowledgeRecord } from '../store-record-representation.js';
import { withStoredKnowledgeSourceReferences, withEngineGeneratedSupportReferences, type EngineGeneratedSupportReferences } from './verification/structural-references.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeExtractionRecord, KnowledgeNodeRecord } from '../types.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import type { SemanticWriteGuard } from './primary-source-plan.js';
import { prepareGeneratedFactSupport, readGeneratedFactSupport } from './verification/generated-fact-support.js';
import {
  KnowledgeGeneratedFactSupportHeldError,
  type GeneratedFactSupportClaim,
  type GeneratedFactSupportInput,
  type GeneratedFactSupportOptions,
  type GeneratedFactSupportPlan,
  type GeneratedFactSupportVerdict,
  type GeneratedFactSupportReceipt,
} from './verification/types.js';

interface NativeGeneratedFactPlanReferences {
  readonly store: KnowledgeStore;
  readonly claimId: string;
  readonly receipts: readonly GeneratedFactSupportReceipt[];
  readonly assertCurrent: () => void;
}
// Only the actual whole-pass reader installs successful plan objects here.
const nativeGeneratedPlans = new WeakMap<GeneratedFactSupportPlan, NativeGeneratedFactPlanReferences>();
export function captureNativeGeneratedFactPlanReferences(store: KnowledgeStore, plan: GeneratedFactSupportPlan): NativeGeneratedFactPlanReferences {
  const proof = nativeGeneratedPlans.get(plan);
  if (!proof || proof.store !== store) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  proof.assertCurrent();
  return proof;
}

/** Exact identifiers are not case-folded natural-language labels. */
export function exactKnowledgeIds(values: readonly (string | undefined | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

/** How one added claim came out of its support reading. */
export type GeneratedFactSupportOutcome = 'supported' | 'no-support' | 'unsettled';

/**
 * Gather one entire persistence pass before the first support request is sent.
 * By default the pass is whole: one claim that is not supported holds it. With
 * `partial`, such a claim is left out ({@link outcome}) and the rest go on.
 */
export function createGeneratedFactWritePlanner(
  store: KnowledgeStore, guard: SemanticWriteGuard, options: GeneratedFactSupportOptions & { readonly partial?: boolean | undefined } = {},
) {
  const requests: GeneratedFactSupportInput[] = [];
  const slots = new Map<string, number[]>();
  // These keys only deduplicate this pass; nothing persists or verifies them.
  // Intern complete component encodings once per distinct value, rather than
  // hashing (or retaining) another full source/extraction for every claim.
  // Preserve JSON field order, source order and unset-field semantics exactly.
  const parts = new Map<string | undefined, number>();
  const requestsByParts = new Map<string, string>();
  function part(value: unknown): number {
    const encoded = JSON.stringify(value);
    const previous = parts.get(encoded);
    if (previous !== undefined) return previous;
    const id = parts.size;
    parts.set(encoded, id);
    return id;
  }
  const nativeOwners: Array<{ readonly claimId: string; readonly assertCurrent: () => void }> = [];
  let settled: readonly (GeneratedFactSupportPlan | undefined)[] | undefined;
  const outcomes = new Map<string, GeneratedFactSupportOutcome>();
  let started = false;
  function add(
    spaceId: string, claim: GeneratedFactSupportClaim, sourceIds: readonly string[],
    subjects: readonly KnowledgeNodeRecord[],
    originalExtractions: ReadonlyMap<string, KnowledgeExtractionRecord | null> = new Map(),
    proposedSubjectIds: ReadonlySet<string> = new Set(),
    generatedReferences?: EngineGeneratedSupportReferences,
  ): string {
    if (started) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
    for (const subject of subjects) {
      if (getKnowledgeSpaceId(subject) !== spaceId) throw new KnowledgeGeneratedFactSupportHeldError('foreign-space');
      // Proposed entities are verified as proposals, while their prior stored
      // records (including absence/operator state) remain in the write read-set.
      if (proposedSubjectIds.has(subject.id)) guard.node(subject.id);
      else guard.watch(`node:${subject.id}`, () => store.getNode(subject.id), subject);
    }
    const sources = exactKnowledgeIds(sourceIds).map((id) => {
      const source = guard.source(id);
      if (!source || (source.status !== 'indexed' && source.status !== 'pending')) throw new KnowledgeGeneratedFactSupportHeldError('missing-evidence');
      if (getKnowledgeSpaceId(source) !== spaceId) throw new KnowledgeGeneratedFactSupportHeldError('foreign-space');
      const extraction = originalExtractions.has(id)
        ? guard.watch(`extraction:${id}`, () => store.getExtractionBySourceId(id), originalExtractions.get(id)!)
        : guard.extraction(id);
      return { source, extraction };
    });
    if (sources.length === 0) throw new KnowledgeGeneratedFactSupportHeldError('missing-evidence');
    const tuple = JSON.stringify([part(spaceId), part(claim),
      sources.map(({ source, extraction }) => [part(source), part(extraction)]), subjects.map(part)]);
    const previous = requestsByParts.get(tuple);
    if (previous !== undefined) return previous;
    const key = `support:${slots.size}`;
    const indices = sources.map(({ source, extraction }) => {
      const index = requests.length;
      const input = withStoredKnowledgeSourceReferences({ spaceId, claim, source, extraction, subjects }, store, source, store.getExtractionBySourceId(source.id));
      requests.push(generatedReferences ? withEngineGeneratedSupportReferences(input, generatedReferences) : input);
      const originalSource = store.getSource(source.id), originalExtraction = store.getExtractionBySourceId(source.id);
      if (!originalSource || !sameKnowledgeRecord(source, originalSource)
        || !sameKnowledgeRecord(extraction ?? null, originalExtraction ?? null)) throw new KnowledgeGeneratedFactSupportHeldError('stale');
      // The rows a support reading was read from, held by store generation: a
      // check is two indexed reads, never a copy or a deep compare.
      const sourceGeneration = store.getSourceGeneration(source.id);
      const extractionId = originalExtraction?.id ?? null;
      const extractionGeneration = originalExtraction ? store.getRecordGeneration('extraction', originalExtraction.id) : null;
      const claimId = claim.id;
      nativeOwners.push({ claimId, assertCurrent() {
        if (store.getSourceGeneration(source.id) !== sourceGeneration
          || (store.getExtractionBySourceId(source.id)?.id ?? null) !== extractionId
          || (extractionId ? store.getRecordGeneration('extraction', extractionId) : null) !== extractionGeneration) {
          throw new KnowledgeGeneratedFactSupportHeldError('stale');
        }
      } });
      return index;
    });
    slots.set(key, indices);
    requestsByParts.set(tuple, key);
    return key;
  }
  return {
    add,
    async readAll(): Promise<void> {
      if (started) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
      started = true;
      try {
        guard.assertCurrent();
        const { partial, ...readOptions } = options;
        // A whole pass stops at the first claim that is not supported.
        const verdicts: readonly GeneratedFactSupportVerdict[] = partial ? await readGeneratedFactSupport(requests, readOptions)
          : (await prepareGeneratedFactSupport(requests, readOptions)).map((plan) => ({ supported: true as const, plan }));
        guard.assertCurrent();
        if (verdicts.length !== requests.length) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
        const proofs = verdicts.map((verdict, index) => {
          const owner = nativeOwners[index];
          if (!owner) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
          owner.assertCurrent();
          const claimId = verdict.supported ? verdict.plan.claimId : verdict.claimId;
          if (claimId !== owner.claimId || (verdict.supported && verdict.plan.receipts.some(receipt => receipt.claimId !== owner.claimId))) {
            throw new KnowledgeGeneratedFactSupportHeldError('stale');
          }
          return verdict.supported
            ? { plan: verdict.plan, proof: Object.freeze({ store, claimId: owner.claimId, receipts: verdict.plan.receipts, assertCurrent: owner.assertCurrent }) }
            : undefined;
        });
        // No successful prefix escapes a failed whole-pass source check.
        guard.assertCurrent();
        for (const entry of proofs) entry?.proof.assertCurrent();
        for (const entry of proofs) if (entry) nativeGeneratedPlans.set(entry.plan, entry.proof);
        // A claim is supported only when every source it rests on supports it.
        for (const [key, indices] of slots) {
          const refused = indices.flatMap((index) => { const verdict = verdicts[index]!; return verdict.supported ? [] : [verdict.reason]; });
          outcomes.set(key, refused.length === 0 ? 'supported' : refused.includes('no-support') ? 'no-support' : 'unsettled');
        }
        settled = proofs.map((entry) => entry?.plan);
      } finally {
        parts.clear(); requestsByParts.clear(); requests.length = 0; nativeOwners.length = 0;
      }
    },
    /** How the claim added under `key` came out; only a supported claim has {@link plans}. */
    outcome(key: string): GeneratedFactSupportOutcome {
      const outcome = settled ? outcomes.get(key) : undefined;
      if (!outcome) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
      return outcome;
    },
    plans(key: string): readonly GeneratedFactSupportPlan[] {
      if (!settled || !slots.has(key)) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
      const outcome = outcomes.get(key);
      if (outcome !== 'supported') throw new KnowledgeGeneratedFactSupportHeldError(outcome ?? 'malformed');
      return slots.get(key)!.map((index) => settled![index]!);
    },
  };
}
export type GeneratedFactWritePlanner = ReturnType<typeof createGeneratedFactWritePlanner>;

/** Keep receipts per claim/source; a last writer must not erase earlier provenance. */
export function generatedFactSupportMetadata(
  plans: readonly GeneratedFactSupportPlan[], existing: unknown,
): { readonly version: 2; readonly receipts: readonly unknown[] } {
  const previous = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing as { readonly version?: unknown; readonly receipts?: unknown } : {};
  if (typeof previous.version === 'number' && previous.version > 2) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
  const receipts = new Map<string, unknown>();
  if (Array.isArray(previous.receipts)) for (const value of previous.receipts) {
    if (value && typeof value === 'object' && typeof value.receiptId === 'string') receipts.set(supportReceiptKey(value), value);
  }
  for (const receipt of generatedFactSupportReceipts(plans)) receipts.set(supportReceiptKey(receipt), receipt);
  return { version: 2, receipts: [...receipts.values()] };
}
export function generatedFactSupportReceipts(plans: readonly GeneratedFactSupportPlan[]): readonly GeneratedFactSupportReceipt[] {
  return plans.flatMap((plan) => plan.receipts);
}

/** Keep the latest attestation per source/field/subject, not one copy per reread. */
function supportReceiptKey(value: { readonly receiptId: string; readonly [key: string]: unknown } | GeneratedFactSupportReceipt): string {
  if (typeof value.sourceId !== 'string' || typeof value.field !== 'string' || typeof value.battery !== 'string') return value.receiptId;
  return JSON.stringify([value.sourceId, value.field, value.subjectId ?? null, value.battery, value.batteryVersion]);
}
