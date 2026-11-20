import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
import { logger } from '../utils/logger.js';
import { FenceIssuer, type Fence } from '../utils/owner-fence.js';
import { RefusalError, refusal } from '@goodvibes-jev/engine/errors';
import { readMultimodalPdf } from './pdf-source.js';
import { assertJudgmentInput, captureOwnedJson } from '../gate/judgment-input.js';
import { withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';
import { assessMultimodalEntities, MultimodalEntityHeldError, notAssessed, type MultimodalEntityAssessment } from './entity-centrality.js';
import { ArtifactStore } from '../artifacts/index.js';
import type { ArtifactDescriptor, ArtifactRecord } from '../artifacts/types.js';
import { MediaProviderRegistry } from '../media/index.js';
import { readKnowledgeArtifactJudgmentSource, extractKnowledgeArtifact } from '../knowledge/extractors.js';
import { KnowledgeService } from '../knowledge/index.js';
import { VoiceService } from '../voice/index.js';
import type { VoiceAudioArtifact } from '../voice/index.js';
import type {
  MultimodalAnalysisRequest,
  MultimodalAnalysisResult,
  MultimodalDetail,
  MultimodalKind,
  MultimodalPacket,
  MultimodalProviderDescriptor,
  MultimodalServiceStatus,
  MultimodalWritebackResult,
} from './types.js';

const PACKET_BUDGETS: Record<MultimodalDetail, number> = {
  compact: 280,
  standard: 680,
  detailed: 1_280,
};

function estimateTokens(...values: Array<string | undefined>): number {
  const total = values.reduce((sum, value) => sum + (value?.length ?? 0), 0);
  return Math.max(1, Math.ceil(total / 4));
}

/** Analyses kept for write-back in this process; the oldest goes first. */
const HELD_ANALYSES = 128;
/** Tokens a packet keeps free for the line that says what was left out. */
const PACKET_NOTE_TOKENS = 32;

const entityLimit = (kind: MultimodalKind): number => kind === 'image' ? 8 : 10;
const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** The result with its entity assessment recorded; provider metadata cannot mint these fields. */
function withAssessment(result: MultimodalAnalysisResult, assessment: MultimodalEntityAssessment): MultimodalAnalysisResult {
  const metadata = Object.fromEntries(Object.entries(result.metadata).filter(([key]) => key !== 'entityAssessmentSkipped'));
  return captureOwnedJson({ ...result, entities: assessment.entities, metadata: {
    ...metadata,
    provenance: assessment.provenance, entityAssessment: assessment.assessment,
    ...(assessment.skipped ? { entityAssessmentSkipped: assessment.skipped } : {}),
  } }) as MultimodalAnalysisResult;
}

/** What a packet says when entities were not listed. */
function entityNote(metadata: Record<string, unknown>): string | undefined {
  if (metadata.entityAssessment !== 'not-evaluated') return undefined;
  switch (metadata.entityAssessmentSkipped) {
    case 'budget': return 'Entities were not assessed: the source is too large for one assessment.';
    case 'unavailable': return 'Entities were not assessed: no decision model answered.';
    case 'not-requested': return metadata.provenance === 'classic'
      ? 'No decision model: semantic entity assessment was not performed.'
      : 'Entities were not requested; analyze with detail "detailed", or write the analysis back, to list them.';
    default: return metadata.provenance === 'classic' ? 'No decision model: semantic entity assessment was not performed.' : undefined;
  }
}

interface HeldAnalysis {
  readonly result: MultimodalAnalysisResult;
  /** The result exactly as it was returned; write-back compares a caller's copy to it. */
  readonly serialized: string;
  /** The full analysed text, screened, for an entity assessment write-back asks for. */
  readonly source: string;
  /** Every artifact the analysis read is still the one it read. */
  readonly assertArtifacts: () => void;
  enriched?: Promise<MultimodalAnalysisResult> | undefined;
}

function compactText(value: string | undefined, maxLength = 240): string | undefined {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1).trim()}…`;
}

function coerceStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim());
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function audioFormatFromMimeType(mimeType: string): VoiceAudioArtifact['format'] {
  const lower = mimeType.toLowerCase();
  if (lower.includes('wav')) return 'wav';
  if (lower.includes('mpeg') || lower.includes('mp3')) return 'mp3';
  if (lower.includes('ogg')) return 'ogg';
  if (lower.includes('webm')) return 'webm';
  if (lower.includes('flac')) return 'flac';
  // Name the real container (m4a, aac, opus, ...) rather than mislabel it as wav.
  const subtype = lower.split('/')[1]?.split(';')[0]?.trim().replace(/^x-/, '');
  return subtype || 'wav';
}

function detailLimit(detail: MultimodalDetail, compact: number, standard: number, detailed: number): number {
  switch (detail) {
    case 'compact':
      return compact;
    case 'detailed':
      return detailed;
    default:
      return standard;
  }
}

function mergeUnique(...groups: Array<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const group of groups) {
    for (const entry of group ?? []) {
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

/** What a stored analysis must say about entities that were not semantically assessed. */
function evaluationMarkers(result: MultimodalAnalysisResult): Record<string, unknown> {
  const skipped = result.metadata.entityAssessmentSkipped;
  return {
    ...(result.metadata.provenance === 'classic' ? { provenance: 'classic' } : {}),
    ...(result.metadata.entityAssessment === 'not-evaluated' ? { entityAssessment: 'not-evaluated' } : {}),
    ...(typeof skipped === 'string' ? { entityAssessmentSkipped: skipped } : {}),
  };
}

export class MultimodalService {
  private readonly sources = new WeakMap<MultimodalAnalysisResult, { text: string; artifacts: readonly ArtifactDescriptor[] }>();
  /** The one owner of a finished analysis until write-back; held in memory, bounded, never re-admitted after eviction. */
  private readonly analyses = new Map<string, HeldAnalysis>();

  private source(result: MultimodalAnalysisResult, text: string, artifacts: readonly ArtifactDescriptor[] = [result.artifact]): MultimodalAnalysisResult {
    this.sources.set(result, { text, artifacts });
    return result;
  }

  /** The held analysis a caller's copy names, refused with the reason and next step when it is gone or was changed. */
  /** The analysis this daemon returned and still holds, found by the id in a submitted copy; the copy must match it. */
  private held(result: unknown): HeldAnalysis {
    const snapshot = captureOwnedJson(result) as MultimodalAnalysisResult;
    const id = typeof snapshot?.id === 'string' ? snapshot.id : undefined;
    const held = id === undefined ? undefined : this.analyses.get(id);
    if (!held) {
      throw new RefusalError(refusal({
        code: 'MULTIMODAL_ANALYSIS_NOT_HELD', status: 410,
        state: 'the analysis is no longer held by this daemon',
        reason: `Analysis ${id ?? '(no id)'} cannot be written back: the daemon restarted after it ran, or ${HELD_ANALYSES} later analyses replaced it`,
        next: ['Run the analysis again with "writeback": true (POST /api/multimodal/analyze) to analyse and store it in one step'],
      }));
    }
    if (JSON.stringify(snapshot) !== held.serialized) {
      throw new RefusalError(refusal({
        code: 'MULTIMODAL_ANALYSIS_CHANGED', status: 409,
        state: 'the analysis differs from the one this daemon returned',
        reason: `Analysis ${id} was changed after it was returned; write-back stores an analysis only as the daemon produced it`,
        next: ['Send the analysis unchanged', 'Or run the analysis again'],
      }));
    }
    return held;
  }

  private hold(result: MultimodalAnalysisResult, source: string, assertArtifacts: () => void): MultimodalAnalysisResult {
    if (this.analyses.size >= HELD_ANALYSES) this.analyses.delete(this.analyses.keys().next().value!);
    this.analyses.set(result.id, { result, serialized: JSON.stringify(result), source, assertArtifacts });
    return result;
  }

  /** The held result, with entities assessed now when the analysis did not ask for them. One request per analysis at most. */
  private entitiesFor(held: HeldAnalysis, signal: AbortSignal | undefined, retried = false): Promise<MultimodalAnalysisResult> {
    if (held.result.metadata.entityAssessmentSkipped !== 'not-requested') return Promise.resolve(held.result);
    held.enriched ??= withConfiguredDecisionModelPolicy(async () =>
      withAssessment(held.result, await assessMultimodalEntities(held.source, entityLimit(held.result.kind), { signal })));
    const enriched = held.enriched;
    return enriched.catch((error: unknown) => {
      if (held.enriched === enriched) held.enriched = undefined;
      // The assessment throws only for an abort; when another write-back's abort ended it, this one asks once more.
      if (signal?.aborted || retried) throw error;
      return this.entitiesFor(held, signal, true);
    });
  }

  constructor(
    private readonly artifactStore: ArtifactStore,
    private readonly mediaProviders: MediaProviderRegistry,
    private readonly voiceService: VoiceService,
    private readonly knowledgeService: KnowledgeService,
  ) {}

  async getStatus(): Promise<MultimodalServiceStatus> {
    const providers = await this.listProviders();
    return {
      enabled: providers.length > 0,
      providerCount: providers.length,
      providers,
      note: 'Multimodal analysis routes images through media understanding, audio through speech-to-text, documents through TS extractors, and video through keyframe/transcript fusion. Generated markdown packets and write-back are optional.',
    };
  }

  async listProviders(): Promise<readonly MultimodalProviderDescriptor[]> {
    const media = (await this.mediaProviders.status())
      .filter((provider) => provider.capabilities.includes('understand'))
      .map<MultimodalProviderDescriptor>((provider) => ({
        id: provider.id,
        label: provider.label,
        transport: 'media',
        capabilities: ['image.describe'],
        configured: provider.configured,
        metadata: provider.metadata,
      }));
    const voice = (await this.voiceService.getStatus(true)).providers
      .filter((provider) => provider.capabilities.includes('stt'))
      .map<MultimodalProviderDescriptor>((provider) => ({
        id: provider.id,
        label: provider.label,
        transport: provider.capabilities.includes('realtime') ? 'hybrid' : 'voice',
        capabilities: provider.capabilities.includes('realtime')
          ? ['audio.transcribe', 'audio.realtime']
          : ['audio.transcribe'],
        configured: provider.configured,
        metadata: provider.metadata,
      }));
    const extractors: MultimodalProviderDescriptor[] = [
      {
        id: 'knowledge-extractors',
        label: 'Built-in Knowledge Extractors',
        transport: 'extractor',
        capabilities: ['document.extract', 'video.keyframe-fusion'],
        configured: true,
        metadata: {},
      },
    ];
    return [...media, ...voice, ...extractors].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }

  async analyze(request: MultimodalAnalysisRequest, options: { readonly signal?: AbortSignal | undefined } = {}): Promise<MultimodalAnalysisResult> {
    return withConfiguredDecisionModelPolicy(async () => {
      const owned = captureOwnedJson(request) as MultimodalAnalysisRequest;
      const signal = options.signal;
      signal?.throwIfAborted();
      assertJudgmentInput({ prompt: owned.prompt, metadata: owned.metadata, artifactInput: owned.artifact ? {
        filename: owned.artifact.filename, mimeType: owned.artifact.mimeType, uri: owned.artifact.uri, metadata: owned.artifact.metadata,
      } : undefined });
      const { descriptor, record, buffer, assertCurrent: contentCurrent, createdHere } = await this.resolveArtifactInput(owned);
      try {
        const initial = captureOwnedJson(descriptor) as ArtifactDescriptor;
        const sameArtifact = (artifact: ArtifactDescriptor) => {
          if (JSON.stringify(this.artifactStore.get(artifact.id)) !== JSON.stringify(artifact)) throw new MultimodalEntityHeldError('stale');
        };
        const assertArtifact = (artifact: ArtifactDescriptor) => { signal?.throwIfAborted(); sameArtifact(artifact); };
        assertArtifact(initial);
        assertJudgmentInput({ filename: initial.filename, metadata: initial.metadata, prompt: owned.prompt, metadataInput: owned.metadata, artifactMetadata: owned.artifact?.metadata });
        const assertEntryCurrent = () => { try { contentCurrent?.(); } catch { throw new MultimodalEntityHeldError('stale'); } assertArtifact(initial); };
        // This analysis's generation: the caller's cancel aborts it, and every effect below checks it first.
        const fence = new FenceIssuer('multimodal analysis').issue({ parent: signal });
        let result: MultimodalAnalysisResult;
        switch (this.resolveKind(initial)) {
          case 'image': result = await this.analyzeImage(initial, owned, signal); break;
          case 'audio': result = await this.analyzeAudio(initial, buffer, owned, fence); break;
          case 'video': result = await this.analyzeVideo(initial, owned, assertEntryCurrent, signal); break;
          default: result = await this.analyzeDocument(record, buffer, owned, assertEntryCurrent); break;
        }
        const source = this.sources.get(result)!;
        // The full text is what an agent, a later assessment and write-back read: screened once, here.
        assertJudgmentInput(source.text);
        const artifacts = captureOwnedJson(source.artifacts) as readonly ArtifactDescriptor[];
        // Entities are enrichment: assessed only when asked for, and never a reason to fail the analysis.
        const assessment = owned.detail === 'detailed'
          ? await assessMultimodalEntities(source.text, entityLimit(result.kind), { signal })
          : notAssessed('not-requested');
        // Write-back runs under its own request; this request's signal has no say after it returns.
        // A cancel that landed while the provider answered holds nothing.
        fence.check();
        return this.hold(withAssessment(result, assessment), source.text, () => { for (const artifact of artifacts) sameArtifact(artifact); });
      } catch (error) {
        // An artifact made only to hold this call's inline input has no analysis to belong to.
        if (createdHere) { try { this.artifactStore.delete(descriptor.id); } catch { logger.warn('Multimodal inline artifact cleanup was not confirmed.'); } }
        throw error;
      }
    });
  }

  /**
   * A packet of the analysis within `budgetLimit` tokens. It renders the copy it
   * is given and writes nothing, so any analysis can be packed, including one
   * from before a restart. What does not fit is cut or left out, and the last
   * line says so.
   */
  buildPacket(result: unknown, detail: MultimodalDetail = 'standard', budgetLimit = PACKET_BUDGETS[detail]): MultimodalPacket {
    const value = captureOwnedJson(result) as Partial<MultimodalAnalysisResult> | null;
    const metadata = value?.metadata && typeof value.metadata === 'object' ? value.metadata : {};
    const summary = typeof value?.summary === 'string' ? value.summary : undefined;
    const text = typeof value?.text === 'string' ? value.text : undefined;
    const labels = stringList(value?.labels), entities = stringList(value?.entities);
    const segments = (Array.isArray(value?.segments) ? value.segments : [])
      .filter((segment): segment is MultimodalAnalysisResult['segments'][number] => !!segment && typeof segment === 'object');
    const highlights = [
      summary,
      ...labels.slice(0, detailLimit(detail, 2, 4, 8)),
      ...segments.map((segment) => compactText(segment.text, detailLimit(detail, 100, 180, 260))),
    ].filter((entry): entry is string => Boolean(entry));
    const lines = ['## Multimodal Analysis', `Kind: ${String(value?.kind)} | detail: ${detail} | artifact: ${String(value?.artifact?.id)}`];
    let used = estimateTokens(lines.join('\n')), left = 0, cut = false;
    const room = budgetLimit - PACKET_NOTE_TOKENS;
    for (const line of [
      summary ? `Summary: ${summary}` : undefined,
      labels.length > 0 ? `Labels: ${labels.join(', ')}` : undefined,
      entities.length > 0 ? `Entities: ${entities.join(', ')}` : undefined,
      entityNote(metadata),
      text ? `Text: ${compactText(text, detailLimit(detail, 180, 320, 520))}` : undefined,
      ...segments.slice(0, detailLimit(detail, 2, 4, 8)).map((segment) => {
        const segmentLabel = segment.title ? `${segment.kind}:${segment.title}` : segment.kind;
        return segment.text ? `- ${segmentLabel}: ${compactText(segment.text, detailLimit(detail, 120, 220, 360))}` : undefined;
      }),
    ]) {
      if (!line) continue;
      const cost = estimateTokens(line, '\n');
      if (used + cost <= room) { lines.push(line); used += cost; continue; }
      // Cut the first line that does not fit into the room left; leave out the rest.
      const chars = (room - used) * 4 - 1;
      const shortened = chars >= 48 ? compactText(line, chars) : undefined;
      if (shortened) { lines.push(shortened); used += estimateTokens(shortened, '\n'); cut = true; } else left++;
    }
    if (cut || left > 0) lines.push(`Cut to fit ${budgetLimit} tokens${left > 0 ? `; ${left} more line${left === 1 ? '' : 's'} left out` : ''}. Ask for detail "detailed" or a larger budget for more.`);
    const rendered = lines.join('\n');
    return {
      detail,
      budgetLimit,
      estimatedTokens: estimateTokens(rendered),
      rendered,
      highlights: highlights.slice(0, detailLimit(detail, 4, 8, 16)),
    };
  }

  async writeBackAnalysis(
    submitted: unknown,
    input: {
      readonly sessionId?: string | undefined;
      readonly title?: string | undefined;
      readonly tags?: readonly string[] | undefined;
      readonly folderPath?: string | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    } = {},
    options: { readonly signal?: AbortSignal | undefined; readonly assertCurrent?: (() => void) | undefined } = {},
  ): Promise<MultimodalWritebackResult> {
    const held = this.held(submitted), signal = options.signal, assertOwner = options.assertCurrent?.bind(options);
    const owned = { assertCurrent: () => {
      signal?.throwIfAborted();
      assertSynchronousJudgmentGuard(assertOwner, () => new TypeError('Multimodal write owner must complete synchronously and return no value.'));
      held.assertArtifacts();
    } };
    input = captureOwnedJson(input) as typeof input;
    owned.assertCurrent();
    const result = await this.entitiesFor(held, signal);
    owned.assertCurrent();
    const created = await this.artifactStore.createForPublication({
      kind: 'document',
      mimeType: 'application/json',
      filename: `${result.artifact.filename ?? result.artifact.id}.analysis.json`,
      text: `${JSON.stringify(result, null, 2)}\n`,
      metadata: {
        ...(input.metadata ?? {}),
        sourceArtifactId: result.artifact.id,
        multimodalKind: result.kind,
        providerIds: [...result.providerIds],
        ...evaluationMarkers(result),
      },
    }, { signal, assertCurrent: owned.assertCurrent });
    const analysisArtifact = created.artifact;
    const assertAnalysisCurrent = () => { owned.assertCurrent(); created.original.assertCurrent(); created.lease.assertCurrent(); };
    let released = false;
    const release = () => { if (released) return; released = true; try { created.lease.release(); } catch { logger.warn('Multimodal artifact publication release could not be confirmed.'); } };
    let committedSourceId: string | undefined;
    let completionWarning: string | undefined;
    try {
      assertAnalysisCurrent();
      const ingest = await this.knowledgeService.ingestArtifact({
        artifactId: analysisArtifact.id,
        title: input.title ?? `${result.artifact.filename ?? result.artifact.id} analysis`,
        tags: mergeUnique(
          input.tags,
          result.labels,
          result.entities,
          [`multimodal:${result.kind}`],
        ),
        folderPath: input.folderPath,
        sessionId: input.sessionId,
        sourceType: 'document',
        connectorId: 'multimodal-analysis',
        metadata: {
          ...(input.metadata ?? {}),
          sourceArtifactId: result.artifact.id,
          multimodalKind: result.kind,
          providerIds: [...result.providerIds],
          ...evaluationMarkers(result),
        },
      }, { signal, assertCurrent: assertAnalysisCurrent, onCommitted: (id) => { committedSourceId = id; } });
      committedSourceId ??= ingest.source.id;
      // Once the guarded knowledge transaction commits, its receipt is final.
      // Usage is optional bookkeeping and must not revive a canceled operation.
      try {
        owned.assertCurrent();
        await this.knowledgeService.recordUsage({
          targetKind: 'source',
          targetId: ingest.source.id,
          usageKind: 'multimodal-writeback',
          sessionId: input.sessionId,
          metadata: {
            sourceArtifactId: result.artifact.id,
            multimodalKind: result.kind,
          },
        }, owned.assertCurrent);
      } catch { /* The committed source remains valid; no stale usage is written. */ }
    } catch (error) {
      if (!committedSourceId) {
        // Failure may race another persisted reference or an uncertain rename.
        // Release our own publication lease before the aggregate original-only
        // cleanup tries the same lock; retain every uncertain/foreign artifact.
        release();
        try {
          const cleanup = await this.knowledgeService.cleanupUnreferencedArtifact(created.original);
          if (cleanup === 'held' || cleanup === 'unavailable') logger.debug('Multimodal writeback retained an artifact whose cleanup was deferred or unavailable.');
        } catch { logger.warn('Multimodal artifact cleanup was not confirmed; the primary writeback failure was preserved.'); }
        throw error;
      }
      completionWarning = 'The knowledge transaction committed, but post-commit persistence or bookkeeping did not finish. The committed records were retained; durable completion needs verification.';
    } finally { release(); }
    return {
      analysisArtifact,
      knowledgeSourceId: committedSourceId,
      metadata: {
        ...(completionWarning ? { completionWarning } : {}),
        sourceArtifactId: result.artifact.id,
        multimodalKind: result.kind,
        ...evaluationMarkers(result),
      },
    };
  }

  private async resolveArtifactInput(
    request: MultimodalAnalysisRequest,
  ): Promise<{ descriptor: ArtifactDescriptor; record: ArtifactRecord; buffer: Buffer; assertCurrent?: (() => void) | undefined; createdHere?: true }> {
    const artifactId = request.artifactId ?? request.artifact?.artifactId;
    if (artifactId) {
      const descriptor = captureOwnedJson(this.artifactStore.get(artifactId)) as ArtifactDescriptor | null;
      if (!descriptor) throw new MultimodalEntityHeldError('stale');
      const acquired = await this.artifactStore.readContent(artifactId), { record, buffer } = acquired;
      const assertCurrent = acquired.assertCurrent?.bind(acquired); assertCurrent?.();
      if (record.id !== descriptor.id || record.sizeBytes !== descriptor.sizeBytes || buffer.byteLength !== record.sizeBytes
        || JSON.stringify(this.artifactStore.get(artifactId)) !== JSON.stringify(descriptor)) throw new MultimodalEntityHeldError('stale');
      return {
        descriptor,
        record,
        buffer, assertCurrent,
      };
    }

    const artifact = request.artifact;
    if (!artifact) throw new Error('Multimodal analysis requires artifactId or artifact input.');
    const created = await this.artifactStore.create({
      ...(artifact.dataBase64 ? { dataBase64: artifact.dataBase64 } : {}),
      ...(artifact.uri ? { uri: artifact.uri, allowPrivateHosts: artifact.allowPrivateHosts } : {}),
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
      ...(artifact.filename ? { filename: artifact.filename } : {}),
      metadata: artifact.metadata ?? {},
    });
    try {
      const acquired = await this.artifactStore.readContent(created.id);
      return { descriptor: created, record: acquired.record, buffer: acquired.buffer, assertCurrent: acquired.assertCurrent?.bind(acquired), createdHere: true };
    } catch (error) {
      try { this.artifactStore.delete(created.id); } catch { logger.warn('Multimodal inline artifact cleanup was not confirmed.'); }
      throw error;
    }
  }

  private resolveKind(descriptor: ArtifactDescriptor): MultimodalKind {
    switch (descriptor.kind) {
      case 'image':
        return 'image';
      case 'audio':
        return 'audio';
      case 'video':
        return 'video';
      default:
        return 'document';
    }
  }

  private async analyzeImage(
    descriptor: ArtifactDescriptor,
    request: MultimodalAnalysisRequest,
    signal?: AbortSignal,
  ): Promise<MultimodalAnalysisResult> {
    assertJudgmentInput({ metadata: descriptor.metadata, filename: descriptor.filename, prompt: request.prompt, requestMetadata: request.metadata });
    // The same selection as generate: a key saved in the secret store counts on the first request after start-up.
    const provider = await this.mediaProviders.resolveProvider('understand', request.imageProviderId);
    if (!provider?.analyze) {
      throw new Error('No image-understanding provider is registered.');
    }
    const response = await provider.analyze({
      artifact: {
        artifactId: descriptor.id,
        mimeType: descriptor.mimeType,
        filename: descriptor.filename,
        sizeBytes: descriptor.sizeBytes,
        metadata: descriptor.metadata,
      },
      prompt: request.prompt,
      modelId: request.modelId,
      metadata: request.metadata,
      signal,
    });
    const result = captureOwnedJson(response) as typeof response;
    assertJudgmentInput(result);
    const text = compactText(result.text, 2_000);
    const summary = compactText(result.description ?? text, 320);
    const segments = [
      ...(text ? [{ kind: 'ocr' as const, text, metadata: {} }] : []),
      ...(summary ? [{ kind: 'summary' as const, text: summary, metadata: {} }] : []),
    ];
    return this.source({
      id: `mm-${crypto.randomUUID()}`,
      kind: 'image',
      artifact: descriptor,
      providerIds: [result.providerId],
      summary,
      ...(text ? { text } : {}),
      labels: mergeUnique(result.labels),
      entities: [],
      segments,
      metadata: result.metadata,
    }, [result.description ?? '', result.text ?? '', ...(result.labels ?? [])].join(' '));
  }

  private async analyzeAudio(
    descriptor: ArtifactDescriptor,
    buffer: Buffer,
    request: MultimodalAnalysisRequest,
    fence: Fence,
  ): Promise<MultimodalAnalysisResult> {
    assertJudgmentInput({ metadata: descriptor.metadata, prompt: request.prompt, requestMetadata: request.metadata });
    fence.check();
    const response = await this.voiceService.transcribe(request.audioProviderId, {
      audio: {
        mimeType: descriptor.mimeType,
        format: audioFormatFromMimeType(descriptor.mimeType),
        dataBase64: buffer.toString('base64'),
        metadata: descriptor.metadata,
      },
      language: request.language,
      modelId: request.modelId,
      prompt: request.prompt,
      metadata: request.metadata,
      // The provider request ends with the analysis: a cancel stops the transcription, not only its result.
      signal: fence.signal,
    });
    fence.check();
    const transcript = captureOwnedJson(response) as typeof response;
    assertJudgmentInput(transcript);
    const summary = compactText(transcript.text, 320);
    const text = compactText(transcript.text, 4_000);
    const segments = (transcript.segments ?? []).map((segment) => ({
      kind: 'transcript' as const,
      text: segment.text,
      startMs: segment.startMs,
      endMs: segment.endMs,
      confidence: segment.confidence,
      metadata: {},
    }));
    return this.source({
      id: `mm-${crypto.randomUUID()}`,
      kind: 'audio',
      artifact: descriptor,
      providerIds: [transcript.providerId],
      summary,
      ...(text ? { text } : {}),
      labels: request.language ? [request.language] : transcript.language ? [transcript.language] : [],
      entities: [],
      segments,
      metadata: transcript.metadata,
    }, [transcript.text, ...(transcript.segments ?? []).map(segment => segment.text)].join(' '));
  }

  private async analyzeDocument(
    record: ArtifactRecord,
    buffer: Buffer,
    _request: MultimodalAnalysisRequest,
    assertCurrent: () => void,
  ): Promise<MultimodalAnalysisResult> {
    // Screen original bytes decoded as text before an extractor clips summaries/search text.
    const isPdf = record.mimeType === 'application/pdf' || record.filename?.toLowerCase().endsWith('.pdf');
    const pdf = isPdf ? await readMultimodalPdf(buffer, assertCurrent) : undefined;
    const source = pdf?.source ?? await readKnowledgeArtifactJudgmentSource(record, buffer);
    assertCurrent();
    const extraction = captureOwnedJson(pdf?.extraction ?? await extractKnowledgeArtifact(record, buffer)) as Awaited<ReturnType<typeof extractKnowledgeArtifact>>;
    assertCurrent();
    assertJudgmentInput(extraction);
    // A PDF has pages, not headings: each page is a segment titled by its number, never a label.
    const segments: MultimodalAnalysisResult['segments'][number][] = pdf
      ? pdf.pages.slice(0, 12).flatMap((page, index) => {
        const text = compactText(page, 2_000);
        return text ? [{ kind: 'section' as const, title: `Page ${index + 1}`, text, metadata: { page: index + 1 } }] : [];
      })
      : extraction.sections.slice(0, 12).map((section) => ({ kind: 'section' as const, title: section, text: section, metadata: {} }));
    const text = compactText([extraction.summary ?? '', extraction.excerpt ?? ''].join('\n\n'), 4_000);
    return this.source({
      id: `mm-${crypto.randomUUID()}`,
      kind: 'document',
      artifact: this.artifactStore.get(record.id)!,
      providerIds: ['knowledge-extractors'],
      summary: compactText(extraction.summary ?? extraction.excerpt, 320),
      ...(text ? { text } : {}),
      labels: mergeUnique(extraction.sections.slice(0, 8)),
      entities: [],
      segments,
      metadata: {
        extractorId: extraction.extractorId,
        format: extraction.format,
        structure: extraction.structure,
        extractionMetadata: extraction.metadata,
      },
    }, extraction.format === 'unknown' ? '' : source);
  }

  private async analyzeVideo(
    descriptor: ArtifactDescriptor,
    request: MultimodalAnalysisRequest,
    assertCurrent: () => void,
    signal?: AbortSignal,
  ): Promise<MultimodalAnalysisResult> {
    const requestMetadata = request.metadata ?? {};
    const keyframeIds = coerceStringList(requestMetadata.keyframeArtifactIds ?? descriptor.metadata.keyframeArtifactIds);
    const transcriptArtifactId = typeof requestMetadata.transcriptArtifactId === 'string'
      ? requestMetadata.transcriptArtifactId
      : typeof descriptor.metadata.transcriptArtifactId === 'string'
        ? descriptor.metadata.transcriptArtifactId
        : undefined;
    const audioArtifactId = typeof requestMetadata.audioArtifactId === 'string'
      ? requestMetadata.audioArtifactId
      : typeof descriptor.metadata.audioArtifactId === 'string'
        ? descriptor.metadata.audioArtifactId
        : undefined;

    if (keyframeIds.length > 6) throw new MultimodalEntityHeldError('budget');
    const referencedIds = [...new Set([...keyframeIds, ...(audioArtifactId ? [audioArtifactId] : []), ...(transcriptArtifactId ? [transcriptArtifactId] : [])])];
    const referenced = new Map(referencedIds.map(id => {
      const artifact = captureOwnedJson(this.artifactStore.get(id)) as ArtifactDescriptor | null;
      if (!artifact) throw new MultimodalEntityHeldError('stale');
      assertJudgmentInput({ metadata: artifact.metadata, filename: artifact.filename });
      return [id, artifact] as const;
    }));
    const check = () => { assertCurrent(); for (const artifact of referenced.values()) {
      if (JSON.stringify(this.artifactStore.get(artifact.id)) !== JSON.stringify(artifact)) throw new MultimodalEntityHeldError('stale');
    } };
    check();
    const sourceTexts: string[] = [];
    const sourceArtifacts: ArtifactDescriptor[] = [descriptor, ...referenced.values()];
    const sceneSegments: Array<MultimodalAnalysisResult['segments'][number]> = [];
    const labels: string[] = [];
    const providerIds = new Set<string>();

    for (const [index, keyframeId] of keyframeIds.entries()) {
      check();
      const frameDescriptor = referenced.get(keyframeId)!;
      if (!frameDescriptor) continue;
      const frameAnalysis = await this.analyzeImage(frameDescriptor, {
        imageProviderId: request.imageProviderId,
        modelId: request.modelId,
        prompt: request.prompt ? `${request.prompt}\nFocus on this video keyframe.` : 'Describe this video keyframe.',
        metadata: request.metadata,
      }, signal);
      sourceTexts.push(this.sources.get(frameAnalysis)!.text);
      sourceArtifacts.push(captureOwnedJson(frameDescriptor) as ArtifactDescriptor);
      for (const providerId of frameAnalysis.providerIds) providerIds.add(providerId);
      labels.push(...frameAnalysis.labels);
      sceneSegments.push({
        kind: 'scene',
        title: `Scene ${index + 1}`,
        text: frameAnalysis.summary ?? frameAnalysis.text,
        metadata: {
          frameArtifactId: frameDescriptor.id,
        },
      });
    }

    if (audioArtifactId) {
      check();
      const audioDescriptor = referenced.get(audioArtifactId)!;
      if (audioDescriptor) {
        const audioResult = await this.analyzeAudio(
          audioDescriptor,
          (await this.artifactStore.readContent(audioArtifactId)).buffer,
          {
            audioProviderId: request.audioProviderId,
            modelId: request.modelId,
            prompt: request.prompt,
            language: request.language,
            metadata: request.metadata,
          },
          new FenceIssuer('multimodal video analysis').issue({ parent: signal }),
        );
        sourceTexts.push(this.sources.get(audioResult)!.text);
        sourceArtifacts.push(captureOwnedJson(audioDescriptor) as ArtifactDescriptor);
        for (const providerId of audioResult.providerIds) providerIds.add(providerId);
        labels.push(...audioResult.labels);
        sceneSegments.push(...audioResult.segments.slice(0, 6));
      }
    }
    if (transcriptArtifactId) {
      check();
      const transcriptDescriptor = referenced.get(transcriptArtifactId)!;
      if (transcriptDescriptor) {
        const transcriptText = (await this.artifactStore.readContent(transcriptArtifactId)).buffer
          .toString('utf-8')
          .trim();
        assertJudgmentInput(transcriptText);
        sourceTexts.push(transcriptText);
        sourceArtifacts.push(captureOwnedJson(transcriptDescriptor) as ArtifactDescriptor);
        if (transcriptText) {
          sceneSegments.push({
            kind: 'transcript',
            text: compactText(transcriptText, 4_000) ?? transcriptText,
            metadata: { transcriptArtifactId },
          });
        }
      }
    }

    check();
    const summary = compactText([
      sceneSegments[0]?.text,
      sceneSegments[1]?.text,
      sceneSegments.find((segment) => segment.kind === 'transcript')?.text,
    ].filter(Boolean).join(' '), 320) ?? 'Video metadata is available but no keyframes or transcripts were provided for deeper analysis.';

    return this.source({
      id: `mm-${crypto.randomUUID()}`,
      kind: 'video',
      artifact: descriptor,
      providerIds: [...providerIds].length > 0 ? [...providerIds] : ['knowledge-extractors'],
      summary,
      text: compactText(sceneSegments.map((segment) => segment.text).filter(Boolean).join('\n\n'), 4_000),
      labels: mergeUnique(labels),
      entities: [],
      segments: sceneSegments,
      metadata: {
        keyframeArtifactIds: keyframeIds,
        transcriptArtifactId,
        audioArtifactId,
      },
    }, sourceTexts.join('\n\n'), sourceArtifacts);
  }
}
