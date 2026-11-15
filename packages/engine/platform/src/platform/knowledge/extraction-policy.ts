import { decisionOrClassic } from '../runtime/decision-policy.js';
import { createKnowledgeExtractionOwner, type KnowledgeExtractionOwner } from './extraction-ownership.js';
import { assertJudgmentInput, JudgmentInputError } from '../gate/judgment-input.js';
import { extractionReadability } from './batteries/extraction-readability.js';
import type { KnowledgeExtractionRecord } from './types.js';
import { KnowledgeIngestStoppedError, knowledgeIngestStop, type KnowledgeIngestStopReason } from './ingest-stopped.js';

export { KnowledgeIngestStoppedError, type KnowledgeIngestStopReason } from './ingest-stopped.js';

/**
 * The current extractor generation. Stamped onto every extraction's metadata at
 * write time (`extractorVersion`). Bump this when the extraction pipeline improves
 * so that the retained raw-artifact lake is re-processed: an extraction produced by
 * an older generation is treated as stale-by-version and re-extracted from its
 * stored artifact, even when its prior text was non-empty. This is what turns the
 * retained lake into a compounding asset. Extractions written before versioning
 * carry no stamp and resolve to version 0, so they re-extract once.
 */
export const KNOWLEDGE_EXTRACTOR_VERSION = 5;

export function readKnowledgeExtractorVersion(metadata: Record<string, unknown>): number {
  const value = readDocumentFields(metadata, ['extractorVersion']).extractorVersion;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export const KNOWLEDGE_MAX_STRUCTURE_SEARCH_TEXT_CHARS = 128 * 1024;

/** Transport budget only; no length or character-ratio readability threshold. */
export const KNOWLEDGE_EXTRACTION_SAMPLE_CHARS = 4_096;

/** An extraction stopped; `reason` says why (by default the model could not settle a reading). */
export class KnowledgeExtractionJudgmentHoldError extends KnowledgeIngestStoppedError {
  constructor(reason: KnowledgeIngestStopReason = 'model-unsure', detail?: string, options?: { readonly cause?: unknown }) {
    super(reason, detail, options);
    this.name = 'KnowledgeExtractionJudgmentHoldError';
  }
}

const LIMITED_EXTRACTION_MARKERS = [
  'html extraction found no main content',
  'pdf extraction produced limited text',
  'no readable text streams',
  'no specialized extractor matched',
  'has no specialized in-core extractor',
];

/** Any extracted text at all, and none of it this codebase's own placeholder messages. */
function hasExtractedText(extraction: Pick<KnowledgeExtractionRecord, 'excerpt' | 'summary' | 'sections' | 'structure' | 'metadata'>): boolean {
  const values = [extraction.structure?.searchText, extraction.structure?.text, extraction.structure?.content,
    extraction.metadata?.searchText, extraction.metadata?.text, extraction.metadata?.content, extraction.excerpt, extraction.summary, ...(extraction.sections ?? [])];
  return values.some((value) => typeof value === 'string' && value.trim().length > 0
    && !LIMITED_EXTRACTION_MARKERS.some((marker) => value.toLowerCase().includes(marker)));
}

/**
 * Whether a stored extraction's text is readable. Read once when the extraction
 * is written (`metadata.readable`, beside `extractorVersion`); an extraction
 * written before that field existed counts as readable when it holds extracted
 * text. No model request.
 */
export function knowledgeExtractionIsReadable(extraction: Pick<KnowledgeExtractionRecord, 'excerpt' | 'summary' | 'sections' | 'structure' | 'metadata'> | null | undefined): boolean {
  if (!extraction) return false;
  const stored = extraction.metadata?.readable;
  return typeof stored === 'boolean' ? stored : hasExtractedText(extraction);
}

/**
 * True when the extraction must be produced again from its stored artifact:
 * there is none, an older extractor wrote it, or it was read as unreadable when
 * written. Decided from stored fields; no model request.
 */
export function knowledgeExtractionNeedsRefresh(
  extraction: KnowledgeExtractionRecord | null,
  currentExtractorVersion: number = KNOWLEDGE_EXTRACTOR_VERSION,
): boolean {
  if (!extraction) return true;
  if (readKnowledgeExtractorVersion(extraction.metadata) < currentExtractorVersion) return true;
  return !knowledgeExtractionIsReadable(extraction);
}

/** The stored search text of an extraction container (`searchText`, `text` or `content`). */
export function readKnowledgeSearchText(record: Record<string, unknown>): string | undefined {
  const candidates = readDocumentFields(record, ['searchText', 'text', 'content']);
  const value = candidates.searchText ?? candidates.text ?? candidates.content;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Readability of a newly extracted non-PDF document, decided in code when it is
 * written: it holds extracted text, and that text did not decode into
 * replacement or control characters (what a binary file read as text yields).
 * Office, HTML and markup text comes from a parser; PDF text has its own reading
 * in the PDF extractor, which stamps `metadata.readable` itself.
 */
export function newKnowledgeExtractionIsReadable(extraction: Pick<KnowledgeExtractionRecord, 'excerpt' | 'summary' | 'sections' | 'structure' | 'metadata'>): boolean {
  if (!hasExtractedText(extraction)) return false;
  const text = readKnowledgeSearchText(extraction.structure) ?? readKnowledgeSearchText(extraction.metadata)
    ?? [extraction.excerpt, extraction.summary, ...extraction.sections].filter((value) => typeof value === 'string').join('\n');
  const undecodable = text.match(/[\u0000-\u0008\u000e-\u001f\ufffd]/gu)?.length ?? 0;
  return undecodable * 100 <= text.length;
}

/** The readability reading for one extracted text, used while an extraction is being produced. */
export function hasUsefulKnowledgeExtractionText(value: string | undefined, owner?: KnowledgeExtractionOwner): Promise<boolean> {
  return readKnowledgeExtractionTextUsability(value, owner?.signal, owner);
}

/** Shared readability operation with caller-owned cancellation. */
export async function readKnowledgeExtractionTextUsability(value: string | undefined, signal?: AbortSignal, owner: KnowledgeExtractionOwner = createKnowledgeExtractionOwner({ signal })): Promise<boolean> {
  owner.assertCurrent();
  if (signal?.aborted) throw new KnowledgeExtractionJudgmentHoldError('cancelled');
  if (!value?.trim()) return false;
  assertJudgmentInput(value);
  const normalized = value.toLowerCase();
  // These are this codebase's own extractor placeholder messages, not guesses.
  if (LIMITED_EXTRACTION_MARKERS.some((marker) => normalized.includes(marker))) return false;
  return requireExtractionJudgment(() => decisionOrClassic(async () => {
    const run = await extractionReadability.run(owner.port('knowledge.extraction.readability'), {
      sample: value.slice(0, KNOWLEDGE_EXTRACTION_SAMPLE_CHARS),
    }, { site: 'knowledge.extraction.readability', ...(signal ? { signal } : {}), beforeAttempt: owner.assertCurrent });
    owner.assertCurrent();
    if (signal?.aborted) throw new KnowledgeExtractionJudgmentHoldError('cancelled');
    const reading = run.readings.readable;
    if (reading.outcome !== 'act' || reading.verdict === 'uncertain') {
      run.recordAction('hold');
      throw new KnowledgeExtractionJudgmentHoldError('model-unsure', 'text readability');
    }
    run.recordAction(reading.verdict === 'yes' ? 'keep-readable-text' : 'reject-unreadable-text');
    return reading.verdict === 'yes';
  }, () => {
    owner.assertCurrent();
    // Classic retains nonempty parser output. This is text presence, not a
    // semantic readability certificate; extraction metadata records that limit.
    return Boolean(value.trim());
  }), signal);
}

/**
 * A stop keeps its own reason; an abort is a cancellation; any other failure of
 * the reading is the model being unavailable, with the failure kept as `cause`.
 */
export async function requireExtractionJudgment<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (error instanceof JudgmentInputError) throw error;
    throw knowledgeIngestStop(error, signal) ?? new KnowledgeExtractionJudgmentHoldError('model-unavailable', undefined, { cause: error });
  }
}

/** Preflight document content, not database ids, timestamps or unrelated bookkeeping. */
export function assertKnowledgeExtractionInput(extraction: KnowledgeExtractionRecord | null | undefined): void {
  if (!extraction) return;
  const document = readDocumentFields(extraction, ['structure', 'metadata', 'excerpt', 'summary', 'sections']);
  assertJudgmentInput(document.sections);
  // Array iteration can consume non-enumerable data entries too. The preceding
  // check rejects accessors before their descriptors are projected as data.
  const sections = Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(document.sections))
    .filter(([key]) => key !== 'length').map(([key, descriptor]) => [key, descriptor.value as unknown]));
  assertJudgmentInput({
    structure: readDocumentFields(document.structure, ['searchText', 'text', 'content']),
    metadata: readDocumentFields(document.metadata, ['searchText', 'text', 'content']),
    excerpt: document.excerpt, summary: document.summary, sections,
  });
}

/** Project only consumed fields, without executing getters or losing hidden data fields. */
function readDocumentFields<T extends object, K extends keyof T>(record: T, fields: readonly K[]): Pick<T, K> {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new JudgmentInputError('unsupported-input');
  const prototype: unknown = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) throw new JudgmentInputError('unsupported-input');
  return Object.fromEntries(fields.map((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, field);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) throw new JudgmentInputError('unsupported-input');
    return [field, descriptor?.value as unknown];
  })) as Pick<T, K>;
}
