import { observeKnowledgeValue, type KnowledgeValueObservation } from '../../local-value-observation.js';
import { types as nodeTypes } from 'node:util';
import { captureOwnedJson } from '../../../gate/judgment-input.js';
import { projectKnowledgeSourceReferences } from '../../source-structural-references.js';
import { storedKnowledgeSourceReferences } from './structural-references.js';
import type { SupportReferenceLabels } from './structural-references.js';
import { knowledgeContentHash } from '../../content-hash.js';
import type { JsonValue } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, JudgmentInputError } from '../../../gate/judgment-input.js';
import { getKnowledgeSpaceId } from '../../spaces.js';
import { isGeneratedKnowledgeSource } from '../../generated-projections.js';
import type { KnowledgeNodeRecord } from '../../types.js';
import { KnowledgeGeneratedFactSupportHeldError as Held, type GeneratedFactSupportInput } from './types.js';

export function supportHash(value: unknown): string {
  return knowledgeContentHash(JSON.stringify(value));
}
export function freezeSupport<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSupport(child);
    Object.freeze(value);
  }
  return value;
}
/** Structural inspection before any property reads, JSON conversion or privacy scan. */
function assertPlainSnapshot(value: unknown): void {
  let nodes = 0, chars = 0;
  const ancestors = new Set<object>();
  function visit(entry: unknown, depth: number): void {
    if (++nodes > 20_000 || depth > 64) throw new JudgmentInputError('unsupported-input');
    if (typeof entry === 'string') { chars += entry.length; if (chars > 1_000_000) throw new JudgmentInputError('unsupported-input'); return; }
    if (entry === undefined || entry === null || typeof entry === 'boolean') return;
    if (typeof entry === 'number' && Number.isFinite(entry)) return;
    if (typeof entry !== 'object' || nodeTypes.isProxy(entry) || ancestors.has(entry)) throw new JudgmentInputError('unsupported-input');
    const proto: unknown = Object.getPrototypeOf(entry);
    if (Array.isArray(entry) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new JudgmentInputError('unsupported-input');
    if (Object.getOwnPropertySymbols(entry).length) throw new JudgmentInputError('unsupported-input');
    ancestors.add(entry);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(entry))) {
      if (descriptor.get || descriptor.set) throw new JudgmentInputError('unsupported-input');
      if (key !== 'length' && descriptor.enumerable) visit(descriptor.value, depth + 1);
    }
    ancestors.delete(entry);
  }
  visit(value, 0);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function optionalText(value: unknown): void { if (value !== undefined && typeof value !== 'string') throw new Held('malformed'); }
function stringArray(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value)) throw new Held('malformed');
  for (let index = 0; index < value.length; index++) if (typeof value[index] !== 'string') throw new Held('malformed');
}
function sameSpace(value: unknown, spaceId: string): void {
  if (!record(value) || !record(value.metadata)) throw new Held('malformed');
  for (const key of ['knowledgeSpaceId', 'spaceId', 'namespace']) {
    const declared = value.metadata[key];
    if (declared !== undefined && (!text(declared) || declared.trim() !== spaceId)) throw new Held('foreign-space');
  }
  if (getKnowledgeSpaceId(value) !== spaceId) throw new Held('foreign-space');
}
function subjectProjection(subject: KnowledgeNodeRecord) {
  if (!text(subject.id) || !text(subject.title) || !text(subject.kind)) throw new Held('malformed');
  if (subject.status !== 'active' && subject.status !== 'draft') throw new Held('stale');
  stringArray(subject.aliases); optionalText(subject.summary);
  const identity: Record<string, string> = {};
  for (const key of ['manufacturer', 'brand', 'model', 'modelNumber', 'variant', 'entityKind']) {
    optionalText(subject.metadata[key]);
    if (typeof subject.metadata[key] === 'string') identity[key] = subject.metadata[key];
  }
  return { id: subject.id, kind: subject.kind, title: subject.title, aliases: [...subject.aliases], ...(subject.summary === undefined ? {} : { summary: subject.summary }), identity };
}
const CLAIM_KEYS = new Set(['id', 'kind', 'title', 'summary', 'value', 'evidence', 'labels', 'aliases', 'subject', 'targetHints']);
const HINT_KEYS = new Set(['id', 'kind', 'title']);

interface OriginalSupportValues { readonly source: unknown; readonly extraction: unknown; readonly claim: unknown; readonly subjects: readonly unknown[] }
const supportOriginals = new WeakMap<object, OriginalSupportValues>();
/** Share one detached version only after matching its complete current data.
 * The maps belong to one synchronous reader pass and are cleared before I/O. */
export function createSupportOriginalValues() {
  const sources = new Map<string, KnowledgeValueObservation>(), extractions = new Map<string, KnowledgeValueObservation>();
  const subjects = new Map<string, KnowledgeValueObservation>(), claims = new Map<string, KnowledgeValueObservation[]>();
  const oneVersion = (map: Map<string, KnowledgeValueObservation>, id: string, value: unknown): unknown => {
    const known = map.get(id);
    if (known) { if (!known.matches(value)) throw new Held('stale'); return known.snapshot; }
    const original = observeKnowledgeValue(value); map.set(id, original); return original.snapshot;
  };
  return { capture(input: GeneratedFactSupportInput): OriginalSupportValues {
    const existing = claims.get(input.claim.id) ?? [], same = existing.find(original => original.matches(input.claim));
    const claim = same ?? observeKnowledgeValue(input.claim);
    if (!same) { existing.push(claim); claims.set(input.claim.id, existing); }
    return Object.freeze({ source: oneVersion(sources, input.source.id, input.source),
      extraction: oneVersion(extractions, input.extraction!.id, input.extraction), claim: claim.snapshot,
      subjects: Object.freeze(input.subjects.map(subject => oneVersion(subjects, subject.id, subject))) });
  }, clear(): void { sources.clear(); extractions.clear(); subjects.clear(); claims.clear(); } };
}

/** Comparison data for this exact detached projection's lifetime only. It is
 * never joins model/public serialization, persisted metadata or native
 * publication authority. */
export function releaseOriginalSupportValues(projection: object): void { supportOriginals.delete(projection); }
export function originalSupportValues(projection: object): OriginalSupportValues {
  const original = supportOriginals.get(projection);
  if (!original) throw new Held('malformed');
  return original;
}

/** Produces only explicit evidence and identity fields; arbitrary metadata never leaves this boundary. */
export function projectSupportInput(input: GeneratedFactSupportInput, labels?: SupportReferenceLabels, originals?: ReturnType<typeof createSupportOriginalValues>) {
  assertPlainSnapshot(input);
  if (!record(input) || !text(input.spaceId) || input.spaceId !== input.spaceId.trim()
    || !record(input.source) || !record(input.claim) || !Array.isArray(input.subjects)) throw new Held('malformed');
  const { source, extraction, claim, spaceId } = input;
  sameSpace(source, spaceId);
  if (!record(extraction)) throw new Held('missing-evidence');
  sameSpace(extraction, spaceId);
  for (const subject of input.subjects) {
    if (!record(subject)) throw new Held('malformed');
    sameSpace(subject, spaceId);
  }
  if (!text(source.sourceType) || !text(source.id) || !text(extraction.id) || extraction.sourceId !== source.id) throw new Held('malformed');
  if (!Number.isFinite(source.updatedAt) || !Number.isFinite(extraction.updatedAt)) throw new Held('malformed');
  if (source.status !== 'indexed' && source.status !== 'pending') throw new Held('stale');
  if (isGeneratedKnowledgeSource(source)) throw new Held('missing-evidence');
  if (!text(claim.id) || !text(claim.kind) || !text(claim.title) || Object.keys(claim).some((key) => !CLAIM_KEYS.has(key))) throw new Held('malformed');
  for (const value of [claim.summary, claim.subject, source.title, source.url, source.sourceUri, source.canonicalUri, extraction.title, extraction.summary, extraction.excerpt]) optionalText(value);
  stringArray(extraction.sections);
  for (const values of [claim.labels, claim.aliases]) if (values !== undefined) stringArray(values);
  if (claim.targetHints !== undefined && Array.isArray(claim.targetHints)) {
    for (let index = 0; index < claim.targetHints.length; index++) if (!Object.hasOwn(claim.targetHints, index)) throw new Held('malformed');
  }
  if (claim.targetHints !== undefined && (!Array.isArray(claim.targetHints) || claim.targetHints.some((hint) => {
    if (typeof hint === 'string') return false;
    return !record(hint) || Object.keys(hint).some((key) => !HINT_KEYS.has(key)) || !text(hint.id) || !text(hint.kind) || !text(hint.title);
  }))) throw new Held('malformed');
  if (!record(extraction.structure) || !record(extraction.metadata)) throw new Held('malformed');
  // Established extractor text paths only. Never copy arbitrary structure/metadata blobs.
  const texts: Record<string, string> = {};
  const containers: readonly [string, unknown][] = [
    ['structure', extraction.structure], ['structure.structure', extraction.structure.structure],
    ['structure.metadata', extraction.structure.metadata], ['metadata', extraction.metadata],
  ];
  for (const [path, container] of containers) {
    if (!record(container)) continue;
    for (const key of ['text', 'content', 'searchText']) {
      const value = container[key];
      optionalText(value);
      if (typeof value === 'string') texts[`${path}.${key}`] = value;
    }
  }
  if (![extraction.excerpt, ...extraction.sections, ...Object.values(texts)].some(text)) throw new Held('missing-evidence');
  const structural = projectKnowledgeSourceReferences(source, extraction, storedKnowledgeSourceReferences(input));
  const sourceState = {
    id: structural?.sourceId ?? source.id, sourceType: source.sourceType,
    ...(source.title === undefined ? {} : { title: source.title }),
    ...(source.url === undefined ? {} : { url: source.url }),
    ...(source.sourceUri === undefined || structural?.omitSourceUri ? {} : { sourceUri: source.sourceUri }),
    ...(source.canonicalUri === undefined || structural?.omitCanonicalUri ? {} : { canonicalUri: source.canonicalUri }),
  };
  const extractionState = {
    id: structural?.extractionId ?? extraction.id, sourceId: structural?.sourceId ?? extraction.sourceId,
    ...(extraction.title === undefined ? {} : { title: extraction.title }),
    ...(extraction.summary === undefined ? {} : { summary: extraction.summary }),
    ...(extraction.excerpt === undefined ? {} : { excerpt: extraction.excerpt }),
    sections: extraction.sections, texts,
  };
  const references = labels?.forInput(input);
  const projectedClaim = references ? { ...claim, id: references.claimId,
    ...(claim.targetHints === undefined ? {} : { targetHints: claim.targetHints.map((hint) =>
      typeof hint === 'string' ? hint : { ...hint, id: references.subjects.get(String(hint.id)) ?? hint.id }) }),
  } : claim;
  const subjects = input.subjects.map((subject) => {
    const state = subjectProjection(subject);
    return { originalId: subject.id, state: { ...state, id: references?.subjects.get(subject.id) ?? state.id } };
  });
  const state = { spaceId, claim: projectedClaim, source: sourceState, extraction: extractionState, subjects: subjects.map((subject) => subject.state) };
  // Called for EVERY selected input before the reader sends ANY request, without clipping.
  assertJudgmentInput(state);
  const fields: { name: string; value: JsonValue }[] = [];
  for (const name of ['kind', 'title', 'summary', 'value', 'evidence', 'subject'] as const) {
    const value = projectedClaim[name];
    if (value !== undefined) fields.push({ name, value: JSON.parse(JSON.stringify(value)) as JsonValue });
  }
  for (const name of ['labels', 'aliases', 'targetHints'] as const) {
    projectedClaim[name]?.forEach((value, index) => fields.push({ name: `${name}[${index}]`, value: JSON.parse(JSON.stringify(value)) as JsonValue }));
  }
  // Detach the request/plan from caller-owned objects before the first await.
  const snapshot = JSON.parse(JSON.stringify({ state, fields, subjects, claim })) as {
    state: JsonValue; fields: typeof fields; subjects: { originalId: string; state: ReturnType<typeof subjectProjection> }[]; claim: typeof claim;
  };
  const projection = freezeSupport({ ...snapshot, spaceId, claimId: claim.id, sourceId: source.id,
    extractionId: extraction.id, extractionUpdatedAt: extraction.updatedAt });
  supportOriginals.set(projection, originals ? originals.capture(input) : Object.freeze({ source: captureOwnedJson(source), extraction: captureOwnedJson(extraction),
    claim: captureOwnedJson(claim), subjects: Object.freeze(input.subjects.map(subject => captureOwnedJson(subject))) }));
  return projection;
}
export type ProjectedSupportInput = ReturnType<typeof projectSupportInput>;
