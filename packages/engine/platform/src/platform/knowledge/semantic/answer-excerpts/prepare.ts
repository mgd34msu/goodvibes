import { knowledgeSourceJudgmentUris } from '../../source-structural-references.js';
import { getKnowledgeSpaceId } from '../../spaces.js';
import type { KnowledgeSourceRecord, KnowledgeExtractionRecord } from '../../types.js';
import { readRecord } from '../utils.js';
import { readAnswerExcerpts, KnowledgeAnswerExcerptHeldError as Held, type AnswerExcerptDocument } from './reader.js';

/** A quoted passage of a source, with where it is: the field and its half-open UTF-16 offsets. */
export interface LocalAnswerExcerptSpan {
  readonly sourceId: string;
  readonly extractionId?: string | undefined;
  readonly field: string;
  /** Half-open UTF-16 offsets for String.slice on the exact original field. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** The text fields of a source and its extraction, in reading order. Identical bodies stored twice are kept once. */
export function answerExcerptDocuments(source: KnowledgeSourceRecord, extraction: KnowledgeExtractionRecord | null | undefined): AnswerExcerptDocument[] {
  const result: AnswerExcerptDocument[] = [];
  const seen = new Set<string>();
  const add = (field: string, kind: AnswerExcerptDocument['kind'], value: unknown) => {
    if (typeof value !== 'string' || !value.trim() || seen.has(value)) return;
    seen.add(value);
    result.push({ field, kind, text: value });
  };
  add('source.summary', 'source-summary', source.summary);
  add('source.description', 'source-description', source.description);
  if (extraction) {
    add('extraction.title', 'extraction', extraction.title);
    add('extraction.summary', 'extraction', extraction.summary);
    add('extraction.excerpt', 'extraction', extraction.excerpt);
    extraction.sections.forEach((section, index) => add(`extraction.sections[${index}]`, 'extraction', section));
    const structure = readRecord(extraction.structure);
    for (const [path, container] of [
      ['extraction.structure', structure], ['extraction.structure.structure', readRecord(structure.structure)],
      ['extraction.structure.metadata', readRecord(structure.metadata)], ['extraction.metadata', readRecord(extraction.metadata)],
    ] as const) for (const key of ['searchText', 'text', 'content']) add(`${path}.${key}`, 'extraction', container[key]);
  }
  return result;
}

/** Classic quotes complete local fields, with exact offsets and no semantic selection claim. */
export function localKnowledgeSourceSpans(source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | null | undefined): readonly LocalAnswerExcerptSpan[] {
  return Object.freeze(answerExcerptDocuments(source, extraction).map((document) => Object.freeze({
    sourceId: source.id, ...(document.kind === 'extraction' && extraction ? { extractionId: extraction.id } : {}),
    field: document.field, start: 0, end: document.text.length, text: document.text,
  })));
}

export interface AnswerExcerptEntry {
  readonly source: KnowledgeSourceRecord;
  readonly extraction?: KnowledgeExtractionRecord | null | undefined;
  /** Claims and subjects the excerpt is read against (untrusted context, sent as text). */
  readonly context: string;
  /** Extra words that make a passage a better match (subject titles, aliases). */
  readonly hints?: readonly unknown[] | undefined;
}

export interface AnswerSourceExcerpts {
  readonly spans: readonly LocalAnswerExcerptSpan[];
  /** `local` when the reading did not settle and the best-matching passages were kept. */
  readonly decidedBy: 'model' | 'cache' | 'local';
  /** Passages of the source that were not shown to the reading. */
  readonly omitted: number;
}

/**
 * Quoted passages for sources a relevance reading already accepted: one
 * request per source, all sources at once, each over at most a few short
 * passages of that source (see ANSWER_EXCERPT_LIMITS). A source whose reading
 * does not settle keeps its best-matching passages. Rejected sources are never
 * passed here, so nothing is prepared or sent for them.
 */
export async function readAnswerSourceExcerpts(query: string, entries: readonly AnswerExcerptEntry[],
  signal?: AbortSignal): Promise<ReadonlyMap<string, AnswerSourceExcerpts>> {
  const readings = await Promise.all(entries.map(async ({ source, extraction, context, hints }) => {
    if (extraction && (extraction.sourceId !== source.id || getKnowledgeSpaceId(extraction) !== getKnowledgeSpaceId(source))) throw new Held('malformed');
    const documents = answerExcerptDocuments(source, extraction);
    const uris = knowledgeSourceJudgmentUris(source);
    const reading = await readAnswerExcerpts({ query, context, hints, documents, signal,
      source: { title: source.title ?? '', sourceType: source.sourceType, uri: uris.url ?? uris.sourceUri ?? uris.canonicalUri ?? '' } });
    const spans: LocalAnswerExcerptSpan[] = reading.spans.map((span) => Object.freeze({
      sourceId: source.id, ...(span.kind === 'extraction' && extraction ? { extractionId: extraction.id } : {}),
      field: span.field, start: span.start, end: span.end, text: span.text,
    }));
    return [source.id, Object.freeze({ spans: Object.freeze(spans), decidedBy: reading.decidedBy, omitted: reading.omitted })] as const;
  }));
  return new Map(readings);
}
