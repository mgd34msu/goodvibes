import { requireSemanticKnowledge } from '../decision-policy.js';
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { mapLimit } from '@goodvibes-jev/judgment';
import { extractedSentenceKind, readKnowledgeBattery } from './repair-decisions.js';
import { repairProfileValueCandidates } from './repair-profile/reader.js';
import { prepareKnowledgeExtractionValueReading } from './extraction-value/reader.js';
import { guardKnowledgeEdgeInput } from '../store-edge-writes.js';
import { captureKnowledgeSourceReferences, knowledgeSourceJudgmentUris, projectKnowledgeSourceReferences, prepareGeneratedKnowledgeNodeIdentity } from '../source-structural-references.js';
import { retainGeneratedFactRecordReferences } from '../generated-fact-record-references.js';
import { captureSemanticSourceRevision, semanticSourceFreshness, semanticSourceRevisionMetadata } from './source-revisions.js';
import { createSemanticNodeIdentityPlanner } from './node-identity-plan.js';
import { prepareSemanticIssueIdentity } from './auxiliary-identities.js';
import type { SemanticNodeSelector } from '../store-semantic-node-selector.js';
import { createSemanticNodeSlugPlanner } from './node-slug.js';
import { prepareObservedKnowledgeNodeInput } from '../store-node-observation.js';
import { KnowledgeRecordAdmissionHeldError } from '../store-record-snapshot.js';
import { enrichmentFactNodeInput, enrichmentGapNodeInput } from './enrichment-node-plans.js';
import { prepareEnrichmentFactDrafts, resolveEnrichmentSpaceId } from './enrichment-fact-drafts.js';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import { sourceRankingContent } from './answer-source-ranking.js';
import { freezeSupport } from './verification/projection.js';
import { createGeneratedFactWritePlanner, generatedFactSupportMetadata } from './fact-support-write-plan.js';
import { persistWikiPage, prepareWikiPageNodeInput, renderDeterministicWikiPage } from './wiki-page-persistence.js';
import type { KnowledgeStore } from '../store.js';
// Descriptive producer scores stay on the declared 0-100 scale. They never authorize activation.
import { clampConfidence, guardKnowledgeSemanticStateInput } from '../store-node-history.js';
import { prepareKnowledgeScopeSelection } from '../scope-selection.js';
import type {
  KnowledgeExtractionRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import type {
  KnowledgeSemanticEntityInput,
  KnowledgeSemanticExtraction,
  KnowledgeSemanticFactInput,
  KnowledgeSemanticGapInput,
  KnowledgeSemanticLlm,
  KnowledgeSemanticRelationInput,
} from './types.js';
import {
  clampText,
  normalizeWhitespace,
  readRecord,
  readString,
  readStringArray,
  semanticMetadata,
  semanticSlug,
  sourceKnowledgeSpace,
  sourceSemanticText,
  splitSentences,
  uniqueStrings,
} from './utils.js';
import { canonicalRepairSubjectNodes } from './repair-subjects.js';
import { KnowledgeRepairFactUsefulnessHeldError } from './repair-usefulness/reader.js';
import { readFactUsefulnessBatches } from './repair-usefulness/batch.js';
import { deriveRepairProfileFacts, projectRepairProfileInput, repairProfileSourceText, repairProfileSubject } from './repair-profile.js';
import { assertSemanticWriteAllowed, createSemanticPrimarySourcePlanner, createSemanticWriteGuard } from './primary-source-plan.js';
import { prepareSemanticSupersession } from './supersession-plan.js';
import { KnowledgeSemanticGenerationError } from './llm.js';
import { knowledgeTerms, selectKnowledgePassages, splitKnowledgePassages } from '../passages.js';
import { summarizeError } from '../../utils/error-display.js';
import { logger } from '../../utils/logger.js';

/** Output budget of the one generation request per source. */
const SEMANTIC_GENERATION_MAX_TOKENS = 4_096;
/** Characters of the surrounding text a sentence is read with when no generation model is configured. */
const SENTENCE_CONTEXT_CHARS = 1_200;
/** Source text shown with the batched usefulness reading: the passages that mention the facts or quote their evidence. */
const FACT_EVIDENCE_BYTES = 24 * 1024;

const semanticPersistenceGuards = new WeakMap<PersistedSemanticExtraction, () => void>();

export interface KnowledgeSemanticEnrichmentContext {
  readonly store: KnowledgeStore;
  readonly llm?: KnowledgeSemanticLlm | null | undefined;
}

export interface EnrichKnowledgeSourceOptions {
  readonly force?: boolean | undefined;
  readonly knowledgeSpaceId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
}

export interface PersistedSemanticExtraction {
  readonly source: KnowledgeSourceRecord;
  readonly skipped: boolean;
  readonly reason?: string | undefined;
  readonly extractor?: 'llm' | 'deterministic' | undefined;
  readonly facts: readonly KnowledgeNodeRecord[];
  readonly entities: readonly KnowledgeNodeRecord[];
  readonly wikiPage?: KnowledgeNodeRecord | undefined;
  readonly gaps: readonly KnowledgeNodeRecord[];
  /** Generated facts this pass left out: no quote in the source, a usefulness or support reading that did not settle, or a source that does not support them. */
  readonly factsLeftOut?: { readonly unquoted: number; readonly unsettled: number; readonly unsupported: number } | undefined;
}

export async function enrichKnowledgeSource(
  context: KnowledgeSemanticEnrichmentContext,
  source: KnowledgeSourceRecord,
  options: EnrichKnowledgeSourceOptions = {},
): Promise<PersistedSemanticExtraction> {
  requireSemanticKnowledge();
  const spaceId = resolveEnrichmentSpaceId(source, options.knowledgeSpaceId);
  const generationGuard = createSemanticWriteGuard(context.store, options.signal, options.shouldStop);
  generationGuard.source(source.id, source);
  const extraction = generationGuard.extraction(source.id);
  generationGuard.edges('source-edges', [`source:${source.id}`]);
  repairSubjectCandidatesForSource(context.store, source, (id) => generationGuard.node(id));
  generationGuard.assertCurrent();
  if (!extraction) return emptyResult(source, true, 'semantic enrichment requires extracted source evidence');
  const uris = knowledgeSourceJudgmentUris(source);
  const text = sourceSemanticText({ ...source, ...uris }, extraction);
  const structural = projectKnowledgeSourceReferences(source, extraction, captureKnowledgeSourceReferences(context.store, source, extraction));
  const generationSource = { id: structural?.sourceId ?? source.id, title: source.title, sourceType: source.sourceType, tags: source.tags,
    uri: uris.canonicalUri ?? uris.sourceUri ?? uris.url, provenance: sourceRankingContent(source).claimedProvenance };
  const { current: sourceCurrent, extractor: currentExtractor } = semanticSourceFreshness(context.store, source, extraction);
  const shouldUpgradeDeterministic = Boolean(context.llm && sourceCurrent && currentExtractor !== 'llm');
  const scopeSelection = await prepareKnowledgeScopeSelection(context.store, { includeAllSpaces: true },
    { signal: options.signal, shouldStop: options.shouldStop, kinds: ['source'], sourceIds: [source.id] });
  generationGuard.watch('enrichment-source-scope', () => { scopeSelection.assertCurrent(); return true; });
  if (!scopeSelection.source(source)) {
    generationGuard.assertCurrent();
    await markSourceSemanticState(context.store, source, extraction, {
      skippedReason: 'source is outside active knowledge scope',
    }, generationGuard.assertCurrent);
    return emptyResult(source, true, 'source is outside active knowledge scope');
  }
  if (!options.force && sourceCurrent && !shouldUpgradeDeterministic) {
    return emptyResult(source, true, 'semantic enrichment is current');
  }
  // Admit the complete original source, extraction and candidates before any
  // generation request. The reading remains live through the persistence pass.
  const generationSubjects = await linkedObjectsForSource(context.store, source, new Set(), options.signal, options.shouldStop);
  generationGuard.watch('generation-subject-selection', () => { generationSubjects.assertCurrent(); return true; });
  // Minimize and protect the complete generation input before any display cap.
  assertJudgmentInput({ source: generationSource, text, extraction: { format: extraction.format, title: extraction.title, summary: extraction.summary, sections: extraction.sections } });
  // This source/extraction owner outlives generation. The generation guard also
  // watches pre-write graph choices, which the native persistence pass changes.
  const valueOwner = createSemanticWriteGuard(context.store, options.signal, options.shouldStop);
  valueOwner.source(source.id, source);
  valueOwner.extraction(source.id, extraction);
  const assertValueOwnerCurrent = () => { valueOwner.assertCurrent(); scopeSelection.assertCurrent(); };
  const extractionValue = prepareKnowledgeExtractionValueReading({
    source: sourceRankingContent(source), text,
    extraction: { format: extraction.format, title: extraction.title, summary: extraction.summary,
      excerpt: extraction.excerpt, sections: extraction.sections },
  }, { signal: options.signal, assertCurrent: assertValueOwnerCurrent });
  const assertExtractionCurrent = () => { generationGuard.assertCurrent(); extractionValue.assertCurrent(); };
  if (!await extractionValue.read()) {
    assertExtractionCurrent();
    // No extraction attempt is made. Existing native supersession/support plans
    // still detach old support from this changed source and preserve other sources.
    const retired = await persistSemanticExtraction(context.store, source, extraction, {
      extractor: 'deterministic', entities: [], facts: [], relations: [], gaps: [], wikiPage: { markdown: '' },
    }, { knowledgeSpaceId: spaceId, signal: options.signal, shouldStop: options.shouldStop,
      assertCurrent: extractionValue.assertCurrent });
    const assertRetirementCurrent = semanticPersistenceGuards.get(retired)!;
    assertRetirementCurrent();
    await markSourceSemanticState(context.store, source, extraction, {
      skippedReason: 'source states no concrete fact worth a semantic extraction attempt',
    }, assertRetirementCurrent);
    assertRetirementCurrent();
    return emptyResult(source, true, 'source states no concrete fact worth a semantic extraction attempt');
  }
  assertExtractionCurrent();
  const llmExtraction = await extractSemanticsWithLlm(context.llm ?? null, generationSource, extraction, text, options.signal);
  assertExtractionCurrent();
  let extracted: KnowledgeSemanticExtraction;
  if (context.llm) {
    // A configured generation that fails or yields nothing usable is reported on
    // the source; the costlier per-sentence path is for running without one.
    const normalized = llmExtraction.ok ? normalizeSemanticExtraction(llmExtraction.value) : null;
    if (!normalized) {
      const reason = llmExtraction.ok ? 'semantic generation returned no usable facts' : `semantic generation failed: ${llmExtraction.reason}`;
      await markSourceSemanticState(context.store, source, extraction, { skippedReason: reason, generationFailed: true }, assertExtractionCurrent);
      return emptyResult(source, true, reason);
    }
    extracted = normalized;
  } else {
    extracted = await deterministicSemanticExtraction(context.store, source, extraction, text, options.signal, options.shouldStop, generationGuard, generationSubjects);
  }
  assertExtractionCurrent();
  const semantic = freezeSupport(structuredClone(extracted));
  const persisted = await persistSemanticExtraction(context.store, source, extraction, semantic, {
    knowledgeSpaceId: spaceId,
    signal: options.signal,
    shouldStop: options.shouldStop,
    assertCurrent: extractionValue.assertCurrent,
    subjects: generationSubjects,
  });
  assertSemanticWriteAllowed(options.signal, options.shouldStop);
  const assertPersistenceCurrent = semanticPersistenceGuards.get(persisted)!;
  assertPersistenceCurrent();
  await markSourceSemanticState(context.store, source, extraction, {
    extractor: semantic.extractor,
    factCount: persisted.facts.length,
    entityCount: persisted.entities.length,
    gapCount: persisted.gaps.length,
    ...(persisted.factsLeftOut ? { factsLeftOut: persisted.factsLeftOut } : {}),
  }, assertPersistenceCurrent);
  assertPersistenceCurrent();
  return persisted;
}

/** The generation's output, or why there is none. */
type GenerationOutcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string };

async function extractSemanticsWithLlm(
  llm: KnowledgeSemanticLlm | null,
  generationSource: Record<string, unknown>,
  extraction: KnowledgeExtractionRecord | null,
  text: string,
  signal?: AbortSignal,
): Promise<GenerationOutcome> {
  if (!llm) return { ok: false, reason: 'no generation model' };
  try {
    return { ok: true, value: await generateSemantics(llm, generationSource, extraction, text, signal) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, reason: error instanceof KnowledgeSemanticGenerationError ? error.reason : summarizeError(error) };
  }
}

function generateSemantics(
  llm: KnowledgeSemanticLlm,
  generationSource: Record<string, unknown>,
  extraction: KnowledgeExtractionRecord | null,
  text: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return llm.completeJson({
    purpose: 'knowledge-semantic-enrichment',
    maxTokens: SEMANTIC_GENERATION_MAX_TOKENS,
    signal,
    systemPrompt: [
      'You extract a durable semantic knowledge graph from source material.',
      'Return only JSON. Do not invent facts. Every fact must be grounded in the supplied source text.',
      'Capture capabilities, features, specifications, procedures, warnings, maintenance items, compatibility, configuration, and troubleshooting facts when present.',
      'Prefer precise facts over broad summaries. Preserve numbers, model names, ports, version names, constraints, and useful procedures. Every `confidence` field is an INTEGER on a 0-100 scale (0 = none, 100 = certain), never a 0-1 probability.',
      'Every fact `evidence` is an exact quote copied from the source text, so it can be found in it.',
    ].join(' '),
    prompt: JSON.stringify({
      source: generationSource,
      extraction: {
        format: extraction?.format,
        title: extraction?.title,
        summary: extraction?.summary,
        sections: extraction?.sections,
      },
      instructions: {
        outputShape: {
          summary: 'short source summary',
          entities: [{ title: 'entity name', kind: 'entity type', aliases: ['alternate names'], summary: 'one sentence', confidence: 0 }],
          facts: [{
            kind: 'feature|capability|specification|identity|procedure|warning|maintenance|compatibility|configuration|troubleshooting|relationship|note',
            title: 'short fact title',
            value: 'precise value when applicable',
            summary: 'source-grounded explanation',
            evidence: 'exact short quote copied from the source text',
            confidence: 0,
            labels: ['optional labels'],
            targetHints: ['entities this fact describes'],
          }],
          relations: [{ from: 'entity/fact title', relation: 'relation label', to: 'entity/fact title', evidence: 'source-grounded evidence', confidence: 0 }],
          gaps: [{ question: 'missing useful question', reason: 'why source does not answer it', subject: 'optional subject', severity: 'info|warning|error' }],
          wikiPage: { title: 'living page title', markdown: 'concise markdown page synthesized only from extracted facts' },
        },
      },
      text,
    }),
  });
}

function normalizeSemanticExtraction(value: unknown): KnowledgeSemanticExtraction | null {
  const record = readRecord(value);
  const facts = readArray(record.facts).map(normalizeFact).filter(isFact);
  const entities = readArray(record.entities).map(normalizeEntity).filter(isEntity);
  const relations = readArray(record.relations).map(normalizeRelation).filter(isRelation);
  const gaps = readArray(record.gaps).map(normalizeGap).filter(isGap);
  const wikiRecord = readRecord(record.wikiPage);
  const markdown = readString(wikiRecord.markdown);
  const title = readString(wikiRecord.title);
  if (facts.length === 0 && entities.length === 0 && !markdown) return null;
  return {
    summary: readString(record.summary),
    entities,
    facts,
    relations,
    gaps,
    ...(markdown || title ? { wikiPage: { ...(title ? { title } : {}), ...(markdown ? { markdown } : {}) } } : {}),
    extractor: 'llm',
  };
}

async function deterministicSemanticExtraction(
  store: KnowledgeStore,
  source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | null,
  text: string,
  signal?: AbortSignal,
  shouldStop?: () => boolean,
  generationGuard?: ReturnType<typeof createSemanticWriteGuard>,
  subjectSelection?: Awaited<ReturnType<typeof linkedObjectsForSource>>,
): Promise<KnowledgeSemanticExtraction> {
  const factText = repairProfileSourceText(extraction) || text;
  // The generation step already chose the source's subjects; they are not read again.
  const selection = subjectSelection ?? await linkedObjectsForSource(store, source, new Set(), signal, shouldStop);
  const subjects = selection.nodes.map(repairProfileSubject);
  const candidates = repairProfileValueCandidates(factText);
  // Each sentence is read with the text around it, not the whole document again.
  const states = candidates.map(candidate => ({ candidate: candidate.text,
    text: factText.slice(Math.max(0, candidate.start - SENTENCE_CONTEXT_CHARS), Math.min(factText.length, candidate.end + SENTENCE_CONTEXT_CHARS)), subjects }));
  assertJudgmentInput(states);
  const current = () => { assertSemanticWriteAllowed(signal, shouldStop); selection.assertCurrent(); generationGuard?.assertCurrent(); };
  const profileOwner = captureJudgmentPort('engine.knowledge.enrichment-profile', { signal, assertCurrent: current });
  const profileFacts = await deriveRepairProfileFacts({
    query: 'complete features specifications capabilities', source, extraction, text: factText, subjects,
    structuralReferences: captureKnowledgeSourceReferences(store, source, extraction),
  }, { signal: profileOwner.signal, assertCurrent: profileOwner.assertCurrent });
  profileOwner.assertCurrent();
  // Retain the settled profile's port identity without recursing through the
  // generation guard used by the in-flight reader.
  const retainedProfileOwner = captureJudgmentPort('engine.knowledge.enrichment-profile', { signal });
  profileOwner.assertCurrent();
  generationGuard?.watch('enrichment-profile-owner', () => { retainedProfileOwner.assertCurrent(); return true; });
  const readings = await mapLimit(states, 4, state => readKnowledgeBattery(extractedSentenceKind, state, signal, { assertCurrent: current }));
  current();
  for (const [index, reading] of readings.entries()) {
    reading.assertDecisionCurrent();
    generationGuard?.watch(`sentence-reading:${source.id}:${index}`, () => { reading.assertDecisionCurrent(); return true; });
  }
  const sentenceFacts: KnowledgeSemanticFactInput[] = candidates.flatMap((candidate, index) => {
    const reading = readings[index]!.readings.kind;
    return reading.choice === 'none' ? [] : [{ kind: reading.choice, title: candidate.text,
      summary: candidate.text, evidence: candidate.text, confidence: reading.confidence * 100, labels: [] }];
  });
  const facts: KnowledgeSemanticFactInput[] = [...profileFacts, ...sentenceFacts];
  // Source names and tags identify source records; they do not establish entities.
  const entities: KnowledgeSemanticEntityInput[] = [];
  return {
    summary: extraction?.summary ?? source.summary ?? clampText(factText || text, 360),
    entities,
    facts,
    relations: [],
    gaps: facts.length === 0
      ? [{ question: `What useful facts should be extracted from ${source.title ?? source.id}?`, reason: 'No high-confidence semantic facts were detected.', severity: 'info' }]
      : [],
    wikiPage: {
      title: source.title ? `${source.title} knowledge page` : 'Knowledge page',
      markdown: renderDeterministicWikiPage(source, facts),
    },
    extractor: 'deterministic',
  };
}

async function persistSemanticExtraction(
  store: KnowledgeStore,
  source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | null,
  semantic: KnowledgeSemanticExtraction,
  options: {
    readonly knowledgeSpaceId?: string | undefined;
    readonly assertCurrent?: (() => void) | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly shouldStop?: (() => boolean) | undefined;
    /** The source's subjects as the generation step chose them. */
    readonly subjects?: Awaited<ReturnType<typeof linkedObjectsForSource>> | undefined;
  },
): Promise<PersistedSemanticExtraction> {
  const spaceId = options.knowledgeSpaceId ?? sourceKnowledgeSpace(source);
  // Preflight every complete generated field before any verification/primary-source request.
  assertJudgmentInput(semantic);
  // The rows this pass reads, held by generation: the source, its extraction and
  // the edges at the source. Rows of other documents are not part of it, so a
  // concurrent enrichment of another source never retires this one.
  const guard = createSemanticWriteGuard(store, options.signal, options.shouldStop);
  guard.source(source.id, source);
  guard.extraction(source.id, extraction);
  guard.edges('source-edges', [`source:${source.id}`]);
  const planner = createSemanticPrimarySourcePlanner(store, guard, options.signal);
  // One claim the source does not support, or whose reading does not settle,
  // is left out; the rest of the source's facts are kept.
  const support = createGeneratedFactWritePlanner(store, guard, { signal: options.signal, partial: true });
  const entities: KnowledgeNodeRecord[] = [];
  const facts: KnowledgeNodeRecord[] = [];
  const gaps: KnowledgeNodeRecord[] = [];

  const nodeSlug = createSemanticNodeSlugPlanner(store);
  const nodeIdentities = new Map<string, ReturnType<typeof prepareGeneratedKnowledgeNodeIdentity>>();
  const roleIdentities = createSemanticNodeIdentityPlanner(store);
  const nativeNodeIdentity = (selector: SemanticNodeSelector) => {
    const identity = prepareGeneratedKnowledgeNodeIdentity(store, selector, roleIdentities);
    const previous = nodeIdentities.get(identity.id);
    if (previous) return previous;
    nodeIdentities.set(identity.id, identity); return identity;
  };
  const entityPlans = [...new Map(semantic.entities.map((entity) => {
    const identity = nativeNodeIdentity({ role: 'entity', spaceId, sourceId: source.id, title: entity.title });
    return [identity.id, {
      id: identity.id,
      kind: 'knowledge_entity' as const,
      slug: semanticSlug(`${spaceId}-${entity.title}`),
      title: entity.title,
      summary: entity.summary,
      aliases: entity.aliases,
      confidence: entity.confidence ?? 65,
      sourceId: source.id,
      metadata: semanticMetadata(spaceId, {
        ...(entity.metadata ?? {}),
        semanticKind: 'entity',
        entityKind: entity.kind ?? 'entity',
        sourceId: source.id,
        extractionId: extraction?.id,
        extractor: semantic.extractor,
        textHash: undefined, ...identity.metadata,
      }),
    }] as const;
  })).values()].map(nodeSlug);
  const entityIds = new Set(entityPlans.map((entity) => entity.id));
  for (const id of entityIds) guard.node(id);
  // Only exact saved entity roles overlay subjects. An unrelated old hash
  // label is preserved rather than replaced by a new differently titled entity.
  // The generation step's subject choice stands unless an entity of this pass is one of its candidates.
  const known = options.subjects;
  const subjectSelection = known && ![...entityIds].some((id) => known.candidateIds.has(id))
    ? known : await linkedObjectsForSource(store, source, entityIds, options.signal, options.shouldStop);
  guard.watch('source-subject-selection', () => { subjectSelection.assertCurrent(); return true; });
  const sourceLinkedObjects = subjectSelection.nodes;
  const proposedEntities: KnowledgeNodeRecord[] = entityPlans.map((plan) => {
    const existing = guard.node(plan.id);
    return { ...plan, aliases: plan.aliases ?? existing?.aliases ?? [], status: existing?.status ?? 'draft',
      metadata: { ...existing?.metadata, ...plan.metadata }, createdAt: existing?.createdAt ?? 0, updatedAt: existing?.updatedAt ?? 0 };
  });
  const featureKinds = new Set(['feature', 'capability', 'specification', 'compatibility', 'configuration']);
  // Support starts in code: a generated fact must quote the text it rests on.
  // A quote the source does not contain leaves the fact out without a request.
  const quotable = semantic.extractor === 'llm' ? quoteText(sourceSemanticText({ ...source, ...knowledgeSourceJudgmentUris(source) }, extraction)) : '';
  const proposedFacts = semantic.extractor === 'llm' ? semantic.facts.filter((fact) => quoteFound(fact.evidence, quotable)) : semantic.facts;
  const unquotedFacts = semantic.facts.length - proposedFacts.length;
  const subjects = sourceLinkedObjects.map(repairProfileSubject);
  const projected = projectRepairProfileInput({ query: 'Extract useful concrete facts about the supplied subjects from this complete source.',
    source, extraction, subjects, text: repairProfileSourceText(extraction),
    structuralReferences: captureKnowledgeSourceReferences(store, source, extraction) });
  // The source, its extraction and the subjects, held by row generation: one
  // indexed read per check instead of re-serialising them.
  const qualityRows = createSemanticWriteGuard(store, options.signal, options.shouldStop);
  qualityRows.source(source.id, source);
  qualityRows.extraction(source.id, extraction);
  for (const subject of sourceLinkedObjects) qualityRows.node(subject.id, subject);
  const assertQualityCurrent = () => {
    try {
      options.assertCurrent?.(); subjectSelection.assertCurrent(); qualityRows.assertCurrent();
    } catch (error) {
      if (error instanceof KnowledgeRecordAdmissionHeldError || (error instanceof Error && error.name === 'KnowledgeSourceQualityHeldError'
        && (error as { readonly reason?: unknown }).reason === 'stale')) throw new KnowledgeRepairFactUsefulnessHeldError('stale');
      throw error;
    }
  };
  // Feature-like facts are read for usefulness in batches of twelve, one
  // request each, over the passages that mention them, sent once per batch.
  const featureIndexes = proposedFacts.flatMap((fact, index) => featureKinds.has(fact.kind) ? [index] : []);
  const featureFacts = featureIndexes.map((index) => proposedFacts[index]!);
  const usefulness = featureFacts.length === 0 ? { useful: new Set<number>(), unsettled: 0 } : await readFactUsefulnessBatches({
    query: projected.query, subjects,
    source: { title: projected.source.title, sourceType: projected.source.sourceType,
      uri: projected.source.url ?? projected.source.sourceUri ?? projected.source.canonicalUri },
    text: selectKnowledgePassages(splitKnowledgePassages([[projected.text]], 1_200),
      knowledgeTerms(featureFacts.flatMap((fact) => [fact.title, fact.value, fact.evidence, fact.summary])), FACT_EVIDENCE_BYTES,
      featureFacts.flatMap((fact) => typeof fact.evidence === 'string' ? [fact.evidence] : [])).passages.map((passage) => passage.text).join('\n\n'),
    facts: featureFacts.map((fact) => ({ title: fact.title, kind: fact.kind, summary: fact.summary, value: fact.value, evidence: fact.evidence,
      subject: fact.targetHints, labels: fact.labels })),
  }, options.signal);
  guard.assertCurrent(); assertQualityCurrent();
  const usefulIndexes = new Set([...usefulness.useful].map((position) => featureIndexes[position]!));
  const persistedFacts = proposedFacts.filter((fact, index) => !featureKinds.has(fact.kind) || usefulIndexes.has(index));
  if (unquotedFacts > 0 || usefulness.unsettled > 0) {
    logger.info('Semantic enrichment left facts out', { sourceId: source.id, unquoted: unquotedFacts, unsettled: usefulness.unsettled });
  }
  // Rendering consumes the same settled fact set. Provider page text cannot
  // reintroduce a claim rejected by this complete-pass usefulness reading.
  const { wikiPage: suppliedWikiPage, ...extractedWithoutPage } = semantic;
  semantic = { ...extractedWithoutPage, facts: persistedFacts,
    ...(persistedFacts.length === semantic.facts.length && suppliedWikiPage ? { wikiPage: suppliedWikiPage } : {}) };
  const factDrafts = await prepareEnrichmentFactDrafts({ signal: options.signal, assertCurrent: assertQualityCurrent, store, source, extraction, spaceId, guard, primary: planner, support,
    allFacts: semantic.facts, persistedFacts,
    sourceSubjects: sourceLinkedObjects, proposedEntities,
  });
  const gapIdentities = [...new Map(semantic.gaps.map(gap => {
    const identity = nativeNodeIdentity({ role: 'gap', spaceId, sourceId: source.id, title: gap.question });
    return [identity.id, { gap, identity }] as const;
  })).values()];
  const wikiIdentity = (semantic.wikiPage?.markdown ?? renderDeterministicWikiPage(source, semantic.facts)).trim()
    ? nativeNodeIdentity({ role: 'wiki', spaceId, sourceId: source.id }) : undefined;
  const activeIds = new Set([...entityIds, ...factDrafts.map(fact => fact.factId), ...gapIdentities.map(plan => plan.identity.id), ...(wikiIdentity ? [wikiIdentity.id] : [])]);
  guard.watch('semantic-role-identities', () => { roleIdentities.assertCurrent(); return true; });
  for (const id of activeIds) guard.node(id);
  guard.edges('active-fact-edges', [...activeIds].map((id) => `node:${id}`));
  const resolveSupersession = prepareSemanticSupersession(store, source.id, spaceId, activeIds, guard, planner, support, assertQualityCurrent);
  await support.readAll();
  guard.assertCurrent(); assertQualityCurrent();
  const supportedDrafts = factDrafts.filter((draft) => support.outcome(draft.supportKey) === 'supported');
  const unsupportedDrafts = factDrafts.filter((draft) => support.outcome(draft.supportKey) === 'no-support');
  const unsupportedFacts = unsupportedDrafts.length;
  // Facts already stored under a dropped draft's identity: the only ones a later supersession has to settle.
  const unsupportedIds = new Set(unsupportedDrafts.filter((draft) => draft.existingFact).map((draft) => draft.factId));
  const supportUnsettled = factDrafts.length - supportedDrafts.length - unsupportedFacts;
  if (supportedDrafts.length < factDrafts.length) {
    // Rendering consumes only supported facts; a supplied page could still state a left-out claim.
    const kept = new Set(supportedDrafts.map((draft) => draft.fact));
    const { wikiPage: _droppedPage, ...withoutPage } = semantic;
    semantic = { ...withoutPage, facts: semantic.facts.filter((fact) => kept.has(fact)) };
    logger.info('Semantic enrichment left unsupported facts out', { sourceId: source.id, unsupported: unsupportedFacts, unsettled: supportUnsettled });
  }
  const leftOut = { unquoted: unquotedFacts, unsettled: usefulness.unsettled + supportUnsettled, unsupported: unsupportedFacts };
  const factPlans = [];
  const virtualSupport = new Map<string, unknown>();
  for (const draft of supportedDrafts) {
    const supportMetadata = generatedFactSupportMetadata(support.plans(draft.supportKey),
      virtualSupport.get(draft.factId) ?? draft.existingFact?.metadata.generatedFactSupport);
    virtualSupport.set(draft.factId, supportMetadata);
    const plan = { ...draft, supportMetadata, primarySourceId: await draft.resolve() };
    guard.assertCurrent(); assertQualityCurrent();
    factPlans.push({ ...plan, nodeInput: nodeSlug(enrichmentFactNodeInput(plan, spaceId, extraction, semantic)) });
  }
  const applySupersession = await resolveSupersession();
  guard.assertCurrent(); assertQualityCurrent();
  // A fact this source stated before but no longer supports is not rewritten by
  // this pass, so it is superseded like any other fact the source dropped:
  // retired, or kept on its other sources while they support it. Its own support
  // reading runs only when such a fact exists (never on an ordinary pass).
  let applyUnsupportedSupersession: (() => Promise<void>) | undefined;
  if (unsupportedIds.size > 0) {
    const unsupportedSupport = createGeneratedFactWritePlanner(store, guard, { signal: options.signal, partial: true });
    const resolveUnsupported = prepareSemanticSupersession(store, source.id, spaceId, activeIds, guard, planner, unsupportedSupport, assertQualityCurrent, unsupportedIds);
    await unsupportedSupport.readAll();
    guard.assertCurrent(); assertQualityCurrent();
    applyUnsupportedSupersession = await resolveUnsupported();
    guard.assertCurrent(); assertQualityCurrent();
  }
  const gapPlans = gapIdentities.map(({ gap, identity }) => ({ gap, nodeInput: prepareObservedKnowledgeNodeInput(store, nodeSlug(enrichmentGapNodeInput(gap, source,
    extraction, semantic, spaceId, store.getNode(identity.id), identity)), 'research-task', { source, extraction },
      () => ({ source: store.getSource(source.id), extraction: store.getExtractionBySourceId(source.id) })),
  }));
  const wikiDraft = wikiIdentity ? prepareWikiPageNodeInput(source, semantic, spaceId, wikiIdentity) : undefined;
  const wikiInput = wikiDraft ? nodeSlug(wikiDraft) : undefined;
  const activation = await store.prepareNodeWrites([...entityPlans, ...factPlans.map((plan) => plan.nodeInput),
    ...gapPlans.map((plan) => plan.nodeInput), ...(wikiInput ? [wikiInput] : [])], { signal: options.signal, requireAccepted: true, assertCurrent() { assertQualityCurrent(); roleIdentities.assertCurrent(); } });
  let activationIndex = 0;
  guard.assertCurrent();
  store.assertPreparedNodeWrites(activation);
  assertQualityCurrent();

  for (const input of entityPlans) {
    assertSemanticWriteAllowed(options.signal, options.shouldStop);
    assertQualityCurrent();
    const node = await store.upsertPreparedNode(activation, activationIndex++);
    nodeIdentities.get(node.id)!.retain(node);
    entities.push(node);
    await linkSourceToNode(store, source.id, node.id, 'mentions_entity', spaceId, semantic.extractor, {}, assertQualityCurrent);
  }
  for (const plan of factPlans) {
    assertSemanticWriteAllowed(options.signal, options.shouldStop);
    assertQualityCurrent();
    const { factLinkedObjects, supportMetadata } = plan;
    const previous = store.getNode(plan.factId) ?? undefined;
    const node = await store.upsertPreparedNode(activation, activationIndex++);
    retainGeneratedFactRecordReferences(store, node, support.plans(plan.supportKey), previous, plan.factIdentity);
    facts.push(node);
    await linkSourceToNode(store, source.id, node.id, 'supports_fact', spaceId, semantic.extractor, { generatedFactSupport: supportMetadata }, assertQualityCurrent);
    await linkFactToSourceLinkedObjects(store, source.id, node, factLinkedObjects, spaceId, semantic.extractor, supportMetadata, assertQualityCurrent);
    await linkFactToEntities(store, node, entities.filter((entity) => plan.entitySubjectIds.has(entity.id)), spaceId, semantic.extractor, supportMetadata, assertQualityCurrent);
  }

  for (const relation of semantic.relations) {
    assertSemanticWriteAllowed(options.signal, options.shouldStop);
    assertQualityCurrent();
    await linkRelation(store, entities, facts, relation, spaceId, semantic.extractor, assertQualityCurrent);
  }

  for (const { gap } of gapPlans) {
    assertSemanticWriteAllowed(options.signal, options.shouldStop);
    assertQualityCurrent();
    const node = await store.upsertPreparedNode(activation, activationIndex++);
    nodeIdentities.get(node.id)!.retain(node);
    gaps.push(node);
    await linkSourceToNode(store, source.id, node.id, 'has_gap', spaceId, semantic.extractor, {}, assertQualityCurrent);
    const issueIdentity = prepareSemanticIssueIdentity(store, { spaceId, nodeId: node.id, code: 'knowledge.semantic_gap', namespace: `knowledge:${spaceId}:semantic` });
    await store.applyPreparedIngest({ sources: [], extractions: [], nodes: [], edges: [], issues: [] }, async () => ({ nodes: [], edges: [], issues: [{
      id: issueIdentity.id,
      severity: gap.severity ?? 'info',
      code: 'knowledge.semantic_gap',
      message: gap.question,
      status: 'open',
      sourceId: source.id,
      nodeId: node.id,
      metadata: semanticMetadata(spaceId, {
        reason: gap.reason,
        subject: gap.subject,
        issueFamily: `knowledge:${spaceId}:semantic`,
      }),
    }], assertCurrent() { assertQualityCurrent(); issueIdentity.assertCurrent(); } }));
  }

  assertSemanticWriteAllowed(options.signal, options.shouldStop);
  const wikiPage = await persistWikiPage(store, source, semantic, spaceId, wikiInput, wikiInput ? () => store.upsertPreparedNode(activation, activationIndex++) : undefined, assertQualityCurrent);
  if (wikiPage) nodeIdentities.get(wikiPage.id)!.retain(wikiPage);
  await applySupersession();
  await applyUnsupportedSupersession?.();
  assertQualityCurrent();
  const result = { source, skipped: false, extractor: semantic.extractor, facts, entities, gaps, ...(wikiPage ? { wikiPage } : {}),
    ...(leftOut.unquoted + leftOut.unsettled + leftOut.unsupported > 0 ? { factsLeftOut: leftOut } : {}) };
  semanticPersistenceGuards.set(result, assertQualityCurrent);
  return result;
}



function quoteText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();
}

/**
 * Whether the source text (already passed through quoteText) contains a
 * fact's quoted evidence. A quote may skip
 * text with an ellipsis; every part of eight or more characters must be found.
 * A fact with no quote, or only short parts, is not decided here.
 */
function quoteFound(evidence: unknown, quotable: string): boolean {
  if (typeof evidence !== 'string') return true;
  const parts = quoteText(evidence).replace(/^["'\s]+|["'\s]+$/g, '').split(/\s*(?:\.\.\.|\u2026)\s*/).filter((part) => part.length >= 8);
  return parts.length === 0 || parts.every((part) => quotable.includes(part));
}

async function markSourceSemanticState(
  store: KnowledgeStore,
  source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord,
  details: Record<string, unknown>,
  assertCurrent: () => void = () => {},
): Promise<void> {
  // Derived bookkeeping in its own record, not the append-only source row. (Invariant 1.)
  assertCurrent();
  // Capture only after this pass has proved its actual final source/extraction
  // owners. Never adopt a replacement just because it carries a newer revision.
  const sourceRevision = captureSemanticSourceRevision(store, source, extraction);
  assertCurrent();
  const enrichedAt = Date.now();
  await store.upsertSemanticEnrichmentState(guardKnowledgeSemanticStateInput({
    sourceId: source.id,
    enrichedAt,
    metadata: { ...semanticSourceRevisionMetadata(sourceRevision), enrichedAt, ...details },
  }, assertCurrent));
}

async function linkSourceToNode(
  store: KnowledgeStore,
  sourceId: string,
  nodeId: string,
  relation: string,
  spaceId: string,
  extractor: string,
  metadata: Record<string, unknown> = {},
  assertCurrent: () => void = () => {},
): Promise<void> {
  await store.upsertEdge(guardKnowledgeEdgeInput({
    fromKind: 'source',
    fromId: sourceId,
    toKind: 'node',
    toId: nodeId,
    relation,
    weight: extractor === 'llm' ? 1 : 0.6,
    metadata: semanticMetadata(spaceId, { ...metadata, extractor }),
  }, assertCurrent));
}

async function linkFactToEntities(
  store: KnowledgeStore,
  fact: KnowledgeNodeRecord,
  entities: readonly KnowledgeNodeRecord[],
  spaceId: string,
  extractor: string,
  supportMetadata: unknown,
  assertCurrent: () => void = () => {},
): Promise<void> {
  for (const entity of entities) {
    await store.upsertEdge(guardKnowledgeEdgeInput({
      fromKind: 'node',
      fromId: fact.id,
      toKind: 'node',
      toId: entity.id,
      relation: 'describes',
      metadata: semanticMetadata(spaceId, { extractor, generatedFactSupport: supportMetadata }),
    }, assertCurrent));
  }
}

async function linkFactToSourceLinkedObjects(
  store: KnowledgeStore,
  sourceId: string,
  fact: KnowledgeNodeRecord,
  linkedObjects: readonly KnowledgeNodeRecord[],
  spaceId: string,
  extractor: string,
  supportMetadata: unknown,
  assertCurrent: () => void = () => {},
): Promise<void> {
  for (const object of linkedObjects) {
    await store.upsertEdge(guardKnowledgeEdgeInput({
      fromKind: 'node',
      fromId: fact.id,
      toKind: 'node',
      toId: object.id,
      relation: 'describes',
      weight: extractor === 'llm' ? 0.88 : 0.72,
      metadata: semanticMetadata(spaceId, { extractor, sourceId, generatedFactSupport: supportMetadata }),
    }, assertCurrent));
  }
}

async function linkRelation(
  store: KnowledgeStore,
  entities: readonly KnowledgeNodeRecord[],
  facts: readonly KnowledgeNodeRecord[],
  relation: KnowledgeSemanticRelationInput,
  spaceId: string,
  extractor: string,
  assertCurrent: () => void = () => {},
): Promise<void> {
  const from = findSemanticNode([...entities, ...facts], relation.from);
  const to = findSemanticNode([...entities, ...facts], relation.to);
  if (!from || !to || from.id === to.id) return;
  await store.upsertEdge(guardKnowledgeEdgeInput({
    fromKind: 'node',
    fromId: from.id,
    toKind: 'node',
    toId: to.id,
    relation: semanticSlug(relation.relation).replace(/-/g, '_') || 'related_to',
    weight: Math.max(0.1, Math.min(1, (relation.confidence ?? 70) / 100)),
    metadata: semanticMetadata(spaceId, {
      evidence: relation.evidence,
      extractor,
    }),
  }, assertCurrent));
}

function normalizeFact(value: unknown): KnowledgeSemanticFactInput | null {
  const record = readRecord(value);
  const kind = normalizeFactKind(readString(record.kind));
  const title = readString(record.title);
  if (!kind || !title) return null;
  return {
    kind,
    title,
    ...(readString(record.value) ? { value: readString(record.value) } : {}),
    ...(readString(record.summary) ? { summary: readString(record.summary) } : {}),
    ...(readString(record.evidence) ? { evidence: readString(record.evidence) } : {}),
    ...(typeof record.confidence === 'number' ? { confidence: clampConfidence(record.confidence) } : {}),
    labels: readStringArray(record.labels),
    targetHints: readStringArray(record.targetHints),
  };
}

function normalizeEntity(value: unknown): KnowledgeSemanticEntityInput | null {
  const record = readRecord(value);
  const title = readString(record.title);
  if (!title) return null;
  return {
    title,
    ...(readString(record.kind) ? { kind: readString(record.kind) } : {}),
    aliases: readStringArray(record.aliases),
    ...(readString(record.summary) ? { summary: readString(record.summary) } : {}),
    ...(typeof record.confidence === 'number' ? { confidence: clampConfidence(record.confidence) } : {}),
    metadata: readRecord(record.metadata),
  };
}

function normalizeRelation(value: unknown): KnowledgeSemanticRelationInput | null {
  const record = readRecord(value);
  const from = readString(record.from);
  const relation = readString(record.relation);
  const to = readString(record.to);
  if (!from || !relation || !to) return null;
  return {
    from,
    relation,
    to,
    ...(readString(record.evidence) ? { evidence: readString(record.evidence) } : {}),
    ...(typeof record.confidence === 'number' ? { confidence: clampConfidence(record.confidence) } : {}),
  };
}

function normalizeGap(value: unknown): KnowledgeSemanticGapInput | null {
  const record = readRecord(value);
  const question = readString(record.question);
  if (!question) return null;
  const severity = readString(record.severity);
  return {
    question,
    ...(readString(record.reason) ? { reason: readString(record.reason) } : {}),
    ...(readString(record.subject) ? { subject: readString(record.subject) } : {}),
    severity: severity === 'warning' || severity === 'error' ? severity : 'info',
  };
}

function normalizeFactKind(value: string | undefined): KnowledgeSemanticFactInput['kind'] | null {
  switch (value) {
    case 'feature':
    case 'capability':
    case 'specification':
    case 'identity':
    case 'procedure':
    case 'warning':
    case 'maintenance':
    case 'compatibility':
    case 'configuration':
    case 'troubleshooting':
    case 'relationship':
    case 'note':
      return value;
    default:
      return value ? 'note' : null;
  }
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The ids of the subjects a source is linked to: its discovery record and its `source_for` edges. */
function repairSubjectCandidateIds(store: KnowledgeStore, source: KnowledgeSourceRecord): string[] {
  const discovery = readRecord(source.metadata.sourceDiscovery);
  const sourceSpaceId = sourceKnowledgeSpace(source);
  return uniqueStrings([
    ...readStringArray(discovery.linkedObjectIds),
    ...store.edgesFor('source', source.id)
      .filter((edge) => edge.fromKind === 'source' && edge.fromId === source.id)
      .filter((edge) => edge.toKind === 'node' && edge.relation === 'source_for')
      .filter((edge) => {
        const edgeSpaceId = readString(edge.metadata.knowledgeSpaceId);
        return !edgeSpaceId || edgeSpaceId === sourceSpaceId;
      })
      .map((edge) => edge.toId),
  ]);
}

function repairSubjectCandidatesForSource(
  store: KnowledgeStore, source: KnowledgeSourceRecord,
  readNode: (id: string) => KnowledgeNodeRecord | null = (id) => store.getNode(id),
): KnowledgeNodeRecord[] {
  const ids = repairSubjectCandidateIds(store, source);
  const nodes: KnowledgeNodeRecord[] = [];
  for (const id of ids) {
    const node = readNode(id);
    if (node) nodes.push(node);
  }
  return nodes;
}

/**
 * The subjects a source is about, from the links it already has (its
 * discovery record and `source_for` edges). One linked subject, or none, is
 * the answer without a reading; only several are read to choose among them.
 */
async function linkedObjectsForSource(store: KnowledgeStore, source: KnowledgeSourceRecord,
  entityOverlayIds: ReadonlySet<string>, signal?: AbortSignal, shouldStop?: () => boolean) {
  const guard = createSemanticWriteGuard(store, signal, shouldStop);
  // The selection rests on which subjects the source is linked to, not on every
  // edge it has: the edges this pass writes from the source (a fact's support,
  // its wiki page) must not read as a change to its subjects.
  guard.watch('source-subject-links', () => repairSubjectCandidateIds(store, source));
  const nodes = repairSubjectCandidatesForSource(store, source, id =>
    entityOverlayIds.has(id) ? store.getNode(id) : guard.node(id));
  const candidateIds: ReadonlySet<string> = new Set(nodes.map((node) => node.id));
  const usable = nodes.filter((node) => !entityOverlayIds.has(node.id) && node.status !== 'stale' && !readString(node.metadata.semanticKind)
    && !['fact', 'wiki_page', 'knowledge_gap'].includes(node.kind)
    && node.metadata.generatedKnowledgePage !== true && node.metadata.generatedProjection !== true);
  if (usable.length <= 1) {
    const assertCurrent = () => { store.assertRecordSnapshotFrame(() => { guard.assertCurrent(); }); };
    assertCurrent(); return { nodes: usable, candidateIds, assertCurrent };
  }
  const selected = await canonicalRepairSubjectNodes({ store, spaceId: sourceKnowledgeSpace(source), context: { source },
    nodes, excludedNodeIds: [...entityOverlayIds], signal, shouldStop,
    text: `${source.title ?? ''} ${source.summary ?? ''} ${source.description ?? ''}` });
  const assertCurrent = () => { store.assertRecordSnapshotFrame(() => { guard.assertCurrent(); selected.assertCurrent(); }); };
  assertCurrent(); return { nodes: selected.nodes, candidateIds, assertCurrent };
}

function isFact(value: KnowledgeSemanticFactInput | null): value is KnowledgeSemanticFactInput {
  return Boolean(value);
}

function isEntity(value: KnowledgeSemanticEntityInput | null): value is KnowledgeSemanticEntityInput {
  return Boolean(value);
}

function isRelation(value: KnowledgeSemanticRelationInput | null): value is KnowledgeSemanticRelationInput {
  return Boolean(value);
}

function isGap(value: KnowledgeSemanticGapInput | null): value is KnowledgeSemanticGapInput {
  return Boolean(value);
}

function findSemanticNode(nodes: readonly KnowledgeNodeRecord[], label: string): KnowledgeNodeRecord | undefined {
  const lower = label.toLowerCase();
  const matches = nodes.filter((node) => node.title.toLowerCase() === lower);
  return matches.length === 1 ? matches[0] : undefined;
}

function emptyResult(source: KnowledgeSourceRecord, skipped: boolean, reason: string): PersistedSemanticExtraction {
  return { source, skipped, reason, facts: [], entities: [], gaps: [] };
}
