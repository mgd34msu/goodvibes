import { GoodVibesError } from '@goodvibes-jev/engine/errors';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeExtractionRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { deriveRepairProfileFactPass, repairProfileSourceText, repairProfileSubject, type RepairProfileFact } from '../semantic/repair-profile.js';
import { captureKnowledgeSourceReferences } from '../source-structural-references.js';
import { createSemanticWriteGuard } from '../semantic/primary-source-plan.js';
import { semanticSlug } from '../semantic/utils.js';
import type { SourceLinkedRepairProfileFactInput } from '../semantic/self-improvement-promotion.js';
import { buildHomeGraphMetadata } from './helpers.js';
import { logger } from '../../utils/logger.js';
import type { HomeGraphPageSourceReader } from './page-quality.js';

type ExtractionBySourceId = ReadonlyMap<string, ReturnType<KnowledgeStore['getExtractionBySourceId']>>;
/** Linked sources whose text is read for a device page's profile facts; the rest are counted, not read. */
export const MAX_PROFILE_SOURCES_PER_DEVICE_PAGE = 8;
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GoodVibesError('Home Graph device passport refresh was cancelled.', {
    category: 'timeout', source: 'runtime', operation: 'homegraph.refreshDevicePassport',
  });
}

export interface DevicePageProfileFactPlan {
  readonly node: Omit<KnowledgeNodeRecord, 'confidence' | 'id'>;
  readonly source: KnowledgeSourceRecord;
  readonly extraction: KnowledgeExtractionRecord;
  readonly title: string;
  readonly summary: string;
  readonly evidence: string;
  readonly classification: RepairProfileFact;
  readonly authority: 'official-vendor' | 'vendor' | 'secondary';
}

/** The page's profile fact plans, and how many linked sources were over the limit and not read. */
export type DevicePageProfileFactPlans = DevicePageProfileFactPlan[] & { readonly omittedSources: number };

export async function buildDevicePageProfileFacts(input: {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly installationId: string;
  readonly device: KnowledgeNodeRecord;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly sourceReader: HomeGraphPageSourceReader;
  readonly extractionsBySourceId?: ExtractionBySourceId | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<DevicePageProfileFactPlans> {
  throwIfAborted(input.signal);
  const facts: DevicePageProfileFactPlan[] = [];
  const guard = createSemanticWriteGuard(input.store, input.signal);
  guard.watch(`node:${input.device.id}`, () => input.store.getNode(input.device.id), input.device);
  // The caller passes the passport's sources best first; only the first few are read.
  const sources = input.sources.slice(0, MAX_PROFILE_SOURCES_PER_DEVICE_PAGE);
  const omittedSources = input.sources.length - sources.length;
  if (omittedSources > 0) {
    logger.info('Home Graph device page read the profile facts of its first linked sources only', {
      deviceId: input.device.id, read: sources.length, omitted: omittedSources });
  }
  const entries = sources.flatMap((source) => {
    guard.watch(`source:${source.id}`, () => input.store.getSource(source.id), source);
    const extraction = input.extractionsBySourceId?.get(source.id) ?? input.store.getExtractionBySourceId(source.id);
    guard.watch(`extraction:${source.id}`, () => input.store.getExtractionBySourceId(source.id), extraction);
    const text = repairProfileSourceText(extraction);
    return extraction && text.trim() ? [{ source, extraction, text }] : [];
  });
  const profiles = await deriveRepairProfileFactPass(entries.map(({ source, extraction, text }) => ({
    query: `complete features specifications ${input.device.title}`, source, extraction, text,
    subjects: [repairProfileSubject(input.device)], structuralReferences: captureKnowledgeSourceReferences(input.store, source, extraction),
  })), { signal: input.signal });
  guard.assertCurrent();
  for (const [index, { source, extraction }] of entries.entries()) {
    throwIfAborted(input.signal);
    const { authority } = await input.sourceReader.read(source);
    guard.assertCurrent();
    if (authority === 'unverified') continue;
    const profileFacts = profiles[index]!;
    for (const profileFact of profileFacts) {
      throwIfAborted(input.signal);
      const subjectIds = [input.device.id];
      const sourceIds = [source.id];
      const now = Date.now();
      facts.push({
        node: {
          kind: 'fact',
          slug: semanticSlug(`${input.spaceId}-${profileFact.title}-${profileFact.summary}-${source.id}`),
          title: profileFact.title,
          summary: profileFact.summary,
          aliases: profileFact.aliases,
          status: 'active',
          sourceId: source.id,
          metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, {
            semanticKind: 'fact',
            factKind: profileFact.kind,
            value: profileFact.value,
            evidence: profileFact.evidence,
            labels: profileFact.labels,
            sourceId: source.id,
            sourceIds,
            subject: input.device.title,
            subjectIds,
            targetHints: [{ id: input.device.id, title: input.device.title, kind: input.device.kind }],
            linkedObjectIds: subjectIds,
            extractor: 'page-profile',
            sourceAuthority: authority,
          }),
          createdAt: now,
          updatedAt: now,
        },
        source,
        extraction,
        title: profileFact.title,
        summary: profileFact.summary,
        evidence: profileFact.evidence,
        classification: profileFact,
        authority: authority,
      });
    }
  }
  return Object.assign(facts, { omittedSources });
}

export function devicePageProfileFactInput(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  device: KnowledgeNodeRecord,
  fact: DevicePageProfileFactPlan,
): SourceLinkedRepairProfileFactInput {
  return {
    store,
    spaceId,
    source: fact.source,
    extraction: fact.extraction,
    subjects: [device],
    authority: fact.authority,
    title: fact.title,
    summary: fact.summary,
    evidence: fact.evidence,
    classification: fact.classification,
    extractor: 'page-profile',
    edgeMetadata: {
      linkedBy: 'generated-page-profile',
    },
    metadataBuilder: (metadata) => buildHomeGraphMetadata(spaceId, installationId, metadata),
  };
}
