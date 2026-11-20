import { types as nodeTypes } from 'node:util';
import { sameKnowledgeRecord } from '../../store-record-representation.js';
import { requireSemanticKnowledge } from '../../decision-policy.js';
import { knowledgeClockIso } from '../../store-record-representation.js';
import { createSupportReferenceLabels } from './structural-references.js';
import { judgmentPort } from '@goodvibes/engine/errors';
import type { JsonValue, JudgmentPort } from '@goodvibes/judgment';
import { GENERATED_FACT_SUPPORT_SLOTS as SLOTS, generatedFactBatchSupport as battery, generatedFactSupportState } from './batteries.js';
import { freezeSupport, projectSupportInput, createSupportOriginalValues, originalSupportValues, releaseOriginalSupportValues, type ProjectedSupportInput } from './projection.js';
import { GENERATED_FACT_SUPPORT_LIMITS as LIMITS, KnowledgeGeneratedFactSupportHeldError as Held,
  type GeneratedFactSupportInput, type GeneratedFactSupportOptions, type GeneratedFactSupportPlan, type GeneratedFactSupportReceipt,
  type GeneratedFactSupportVerdict } from './types.js';
export * from './types.js';

/** One claim of one source, with the subjects it is attached to, as the reading sees it. */
interface ClaimJob {
  readonly claim: JsonValue;
  readonly subjects: readonly JsonValue[];
}
/** One source and extraction, sent once, with every distinct claim read against it. */
interface SourceGroup {
  readonly source: JsonValue;
  readonly extraction: JsonValue;
  readonly jobs: ClaimJob[];
  readonly keys: Map<string, number>;
}
/** One request: up to SLOTS.length claims of one group. */
interface BatchRequest {
  readonly group: SourceGroup;
  readonly offset: number;
  readonly count: number;
}
interface ClaimSettlement { readonly probability: number; readonly decisionId?: string | undefined }
/** A slot whose claim or subject attachment read 'no', or did not settle. */
interface ClaimRefusal { readonly refused: 'no-support' | 'unsettled' }
function bounded(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  const result = value;
  if (!Number.isInteger(result) || result < 0 || (maximum > 0 && result > maximum)) throw new Held('budget');
  return result;
}
function versionsAgree(inputs: readonly ProjectedSupportInput[]): void {
  const versions = new Map<string, unknown>();
  const compare = (key: string, value: unknown) => {
    if (versions.has(key) && !sameKnowledgeRecord(versions.get(key), value)) throw new Held('stale');
    versions.set(key, value);
  };
  for (const input of inputs) {
    const original = originalSupportValues(input);
    compare(`source:${input.sourceId}`, original.source);
    compare(`extraction:${input.extractionId}`, original.extraction);
    compare(`source-extraction:${input.sourceId}`, original.extraction);
    input.subjects.forEach((subject, index) => compare(`subject:${subject.originalId}`, original.subjects[index]));
  }
}
/** Validate custom ports too: a malformed noul may otherwise accidentally reach an act band. */
function checkedPort(port: JudgmentPort): JudgmentPort {
  return { ...port, model: port.model, async ask(request) {
    requireSemanticKnowledge();
    const result = await port.ask(request);
    if (!result || !result.answers || (result.decisionId !== undefined && (typeof result.decisionId !== 'string' || !result.decisionId.trim()))) throw new Held('malformed');
    for (const key of Object.keys(request.questions)) {
      const answer: unknown = result.answers[key];
      if (!answer || typeof answer !== 'object' || !('type' in answer) || answer.type !== 'noul'
        || !('noul' in answer) || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new Held('malformed');
    }
    return result;
  } };
}
function receipt(input: ProjectedSupportInput, field: 'claim' | 'subjectAttachment', subjectId: string | undefined,
  settled: ClaimSettlement): GeneratedFactSupportReceipt {
  const body = {
    ...(settled.decisionId === undefined ? {} : { decisionId: settled.decisionId }), battery: battery.name, batteryVersion: battery.version,
    version: 2 as const, spaceId: input.spaceId, claimId: input.claimId,
    field, sourceId: input.sourceId, extractionId: input.extractionId,
    extractionUpdatedAt: knowledgeClockIso(input.extractionUpdatedAt),
    ...(subjectId === undefined ? {} : { subjectId }),
    evidenceReference: { extractionId: input.extractionId },
    verdict: 'yes' as const, outcome: 'act' as const, probability: settled.probability,
  };
  // The saved whole receipt and its source/field tuple carry the evidence.
  // Its local label is never recomputed or used to verify that evidence.
  return freezeSupport({ receiptId: `fact-support-${crypto.randomUUID()}`, ...body });
}

/**
 * Read-only, whole-pass barrier. Every supplied claim×source and every proposed
 * attachment must settle act/yes before ANY plans are returned; the first claim
 * that does not stops the pass. Claims of one source are read together: one
 * request per twelve claims, the extraction sent once. It performs no storage
 * writes; the caller must revalidate its exact read-set at write time.
 */
export async function prepareGeneratedFactSupport(inputs: readonly GeneratedFactSupportInput[], options: GeneratedFactSupportOptions = {}): Promise<readonly GeneratedFactSupportPlan[]> {
  const verdicts = await readSupport(inputs, options, true);
  const plans: GeneratedFactSupportPlan[] = [];
  for (const verdict of verdicts) {
    if (!verdict.supported) throw new Held(verdict.reason);
    plans.push(verdict.plan);
  }
  return Object.freeze(plans);
}

/**
 * The same reading, one verdict per input in input order: a claim whose
 * reading (or a subject attachment's) is 'no' or does not settle is left out
 * with its reason and the others keep their plans. Only a request that fails
 * (unavailable, malformed, budget, cancelled) holds the whole pass.
 */
export async function readGeneratedFactSupport(inputs: readonly GeneratedFactSupportInput[], options: GeneratedFactSupportOptions = {}): Promise<readonly GeneratedFactSupportVerdict[]> {
  return readSupport(inputs, options, false);
}

async function readSupport(inputs: readonly GeneratedFactSupportInput[], options: GeneratedFactSupportOptions, wholePass: boolean): Promise<readonly GeneratedFactSupportVerdict[]> {
  requireSemanticKnowledge();
  if (options.signal?.aborted) throw new Held('aborted');
  if (nodeTypes.isProxy(inputs)) throw new Held('malformed');
  if (!Array.isArray(inputs) || inputs.length > LIMITS.inputs) throw new Held('budget');
  if (Object.getPrototypeOf(inputs) !== Array.prototype || Object.values(Object.getOwnPropertyDescriptors(inputs)).some((item) => item.get || item.set)) throw new Held('malformed');
  for (let index = 0; index < inputs.length; index++) if (!Object.hasOwn(inputs, index)) throw new Held('malformed');
  const maxRequests = bounded(options.maxRequests, LIMITS.requests), maxBytes = bounded(options.maxBytes, LIMITS.bytes);
  const concurrency = Math.max(1, bounded(options.concurrency, LIMITS.concurrency)), timeoutMs = bounded(options.timeoutMs ?? 0, 2_147_483_647);
  // No port is even acquired until every selected input has passed privacy and
  // identity checks. In particular, a protected late field cannot leak early ones.
  let projectionBytes = 0;
  const referenceLabels = createSupportReferenceLabels(), originalValues = createSupportOriginalValues();
  let projections: ProjectedSupportInput[];
  try { projections = inputs.map((input) => {
    const projection = projectSupportInput(input, referenceLabels, originalValues);
    // Measured only against a caller's finite byte budget.
    if (Number.isFinite(maxBytes)) {
      projectionBytes += new TextEncoder().encode(JSON.stringify(projection)).byteLength;
      if (projectionBytes > maxBytes) throw new Held('budget');
    }
    return projection;
  }); } finally { originalValues.clear(); }
  versionsAgree(projections);
  for (const projection of projections) releaseOriginalSupportValues(projection);
  // Claims of the same source are read together, the extraction sent once per
  // request; an identical claim with the same subjects is read once.
  const groups = new Map<string, SourceGroup>();
  const slotsByInput = projections.map((input) => {
    const state = input.state;
    const groupKey = JSON.stringify([input.sourceId, input.extractionId]);
    let group = groups.get(groupKey);
    if (!group) { group = { source: state.source, extraction: state.extraction, jobs: [], keys: new Map() }; groups.set(groupKey, group); }
    const claimKey = JSON.stringify([input.claimId, state.claim, state.subjects]);
    let index = group.keys.get(claimKey);
    if (index === undefined) { index = group.jobs.length; group.keys.set(claimKey, index); group.jobs.push({ claim: state.claim, subjects: state.subjects }); }
    return { group, index };
  });
  const requests: BatchRequest[] = [];
  const questionBytes = Number.isFinite(maxBytes)
    ? new TextEncoder().encode(JSON.stringify(Object.fromEntries(Object.entries(battery.items).map(([name, item]) => [name, item.question])))).byteLength : 0;
  let bytes = 0;
  for (const group of groups.values()) {
    for (let offset = 0; offset < group.jobs.length; offset += SLOTS.length) {
      if (requests.length >= maxRequests) throw new Held('budget');
      const count = Math.min(SLOTS.length, group.jobs.length - offset);
      if (Number.isFinite(maxBytes)) {
        bytes += new TextEncoder().encode(JSON.stringify(generatedFactSupportState(group.source, group.extraction, group.jobs.slice(offset, offset + count)))).byteLength
          + questionBytes + 1_024;
        if (bytes > maxBytes) throw new Held('budget');
      }
      requests.push({ group, offset, count });
    }
  }
  if (options.signal?.aborted) throw new Held('aborted');
  if (requests.length === 0) return Object.freeze([]);

  const controller = new AbortController();
  let cancellation: Held | undefined;
  const cancel = (reason: Held) => { cancellation ??= reason; controller.abort(); };
  const onAbort = () => cancel(new Held('aborted'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = timeoutMs > 0 ? setTimeout(() => cancel(new Held('budget')), timeoutMs) : undefined;
  const assertCurrent = () => { if (cancellation) throw cancellation; if (options.signal?.aborted) throw new Held('aborted'); };
  const settled = new Map<SourceGroup, Array<ClaimSettlement | ClaimRefusal>>();
  let next = 0;
  async function read(request: BatchRequest, port: JudgmentPort) {
    assertCurrent();
    let removeAbort = () => {};
    // Even a custom port ignoring AbortSignal cannot keep a pass alive forever.
    const aborted = new Promise<never>((_resolve, reject) => {
      const listener = () => reject(cancellation ?? new Held('aborted'));
      controller.signal.addEventListener('abort', listener, { once: true });
      removeAbort = () => controller.signal.removeEventListener('abort', listener);
      if (controller.signal.aborted) listener();
    });
    try {
      const only = SLOTS.slice(0, request.count);
      const state = generatedFactSupportState(request.group.source, request.group.extraction, request.group.jobs.slice(request.offset, request.offset + request.count));
      const run = await Promise.race([battery.runSome(port, state, only, { signal: controller.signal, site: battery.name }), aborted]);
      assertCurrent();
      const readings = only.map((name) => run.readings[name]);
      const refusals = readings.map((reading): ClaimRefusal | undefined => reading && reading.outcome === 'act' && reading.verdict === 'yes' ? undefined
        : { refused: reading?.outcome === 'act' && reading.verdict === 'no' ? 'no-support' : 'unsettled' });
      const refused = refusals.filter((refusal) => refusal !== undefined).length;
      if (wholePass && refused > 0) {
        run.recordAction('held: a generated claim or its subject attachment is unsupported or unsettled');
        throw new Held(refusals.some((refusal) => refusal?.refused === 'no-support') ? 'no-support' : 'unsettled');
      }
      run.recordAction(refused === 0
        ? `verified: ${request.count} generated claim(s) and their subject attachments; persistence remains subject to read-set validation`
        : `verified ${request.count - refused} of ${request.count} generated claim(s); ${refused} left out as unsupported or unsettled; persistence remains subject to read-set validation`);
      const results = settled.get(request.group) ?? [];
      readings.forEach((reading, index) => {
        results[request.offset + index] = refusals[index]
          ?? { probability: reading!.probability, ...(run.result.decisionId === undefined ? {} : { decisionId: run.result.decisionId }) };
      });
      settled.set(request.group, results);
    } finally { removeAbort(); }
  }
  try {
    assertCurrent();
    const port = checkedPort(judgmentPort('engine.knowledge.generated-fact-support'));
    await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, async () => {
      while (next < requests.length) {
        assertCurrent();
        const index = next++;
        try { await read(requests[index]!, port); }
        catch (error) { const held = error instanceof Held ? error : new Held('unavailable'); cancel(held); throw held; }
      }
    }));
    assertCurrent();
    return freezeSupport(projections.map((input, index): GeneratedFactSupportVerdict => {
      const { group, index: job } = slotsByInput[index]!;
      const result = settled.get(group)?.[job];
      if (!result) throw new Held('malformed');
      if ('refused' in result) return { supported: false, claimId: input.claimId, reason: result.refused };
      return { supported: true, plan: { claim: input.claim, claimId: input.claimId, sourceId: input.sourceId, extractionId: input.extractionId,
        receipts: [receipt(input, 'claim', undefined, result), ...input.subjects.map((subject) => receipt(input, 'subjectAttachment', subject.originalId, result))] } };
    }));
  } catch (error) { throw error instanceof Held ? error : new Held('unavailable'); }
  finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', onAbort); }
}
