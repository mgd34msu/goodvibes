import { createHash } from 'node:crypto';
import { createKnowledgeExtractionOwner } from './extraction-ownership.js';
import type { KnowledgeIngestOwnership } from './ingest-context.js';
import type { KnowledgeIngestUriCanonicalizer } from './uri-canonicalization/ingest-owner.js';
import type { ArtifactRecord } from '../artifacts/types.js';
import { extractKnowledgeArtifact, type KnowledgeExtractionResult } from './extractors.js';
import { knowledgeExtractionNeedsRefresh } from './extraction-policy.js';
import { KnowledgeIngestStoppedError, knowledgeIngestStop } from './ingest-stopped.js';
import type { KnowledgeIngestContext } from './ingest-context.js';
import type { KnowledgeExtractionRecord, KnowledgeSourceRecord } from './types.js';

/** An artifact read and extracted for one source: a plain value handed to the compile step. */
export interface PreparedKnowledgeExtraction {
  readonly kind: 'extracted';
  readonly sourceId: string;
  readonly artifactId: string;
  readonly record: ArtifactRecord;
  readonly extracted: KnowledgeExtractionResult;
  /** sha256 of the artifact bytes; stored on the source as `contentHash`. */
  readonly contentHash: string;
}

/** The fetched bytes equal what the indexed source was built from: nothing to read again. */
export interface UnchangedKnowledgeContent {
  readonly kind: 'unchanged';
  readonly sourceId: string;
  readonly artifactId: string;
  readonly contentHash: string;
  readonly source: KnowledgeSourceRecord;
  readonly extraction: KnowledgeExtractionRecord;
}

/**
 * Reads the artifact once and extracts it. With `skipUnchanged`, bytes whose
 * hash equals the indexed source's `contentHash` (and whose extraction is
 * current) return `unchanged` before any extraction reading. The caller's
 * `assertCurrent` (the ingest guard over the stored source row) is the one check.
 */
export async function prepareKnowledgeExtraction(
  context: KnowledgeIngestContext,
  sourceId: string,
  artifactId: string,
  uris: KnowledgeIngestUriCanonicalizer,
  ownership: KnowledgeIngestOwnership & { readonly skipUnchanged?: boolean | undefined } = {},
): Promise<PreparedKnowledgeExtraction | UnchangedKnowledgeContent> {
  const signal = ownership.signal ? AbortSignal.any([ownership.signal, uris.signal]) : uris.signal;
  const owner = createKnowledgeExtractionOwner({ signal, assertCurrent: () => { ownership.assertCurrent?.(); uris.assertCurrent(); } });
  owner.assertCurrent();
  await context.store.init();
  let content: Awaited<ReturnType<typeof context.artifactStore.readContent>>;
  try { content = await context.artifactStore.readContent(artifactId); }
  catch (error) {
    throw knowledgeIngestStop(error, signal) ?? new KnowledgeIngestStoppedError('changed', `artifact ${artifactId} could not be read`, { cause: error });
  }
  owner.assertCurrent();
  const { record, buffer } = content;
  if (record.id !== artifactId || buffer.byteLength !== record.sizeBytes) {
    throw new KnowledgeIngestStoppedError('changed', `artifact ${artifactId} does not match its stored record`);
  }
  if (content.assertCurrent) {
    const readCurrent = content.assertCurrent.bind(content);
    owner.retain(() => {
      try { readCurrent(); }
      catch (error) { throw new KnowledgeIngestStoppedError('changed', `artifact ${artifactId} changed while it was read`, { cause: error }); }
    });
  }
  const contentHash = createHash('sha256').update(buffer).digest('hex');
  if (ownership.skipUnchanged) {
    const source = context.store.getSource(sourceId);
    const extraction = context.store.getExtractionBySourceId(sourceId);
    if (source?.status === 'indexed' && source.contentHash === contentHash && extraction && !knowledgeExtractionNeedsRefresh(extraction)) {
      return Object.freeze({ kind: 'unchanged', sourceId, artifactId, contentHash, source, extraction });
    }
  }
  const extracted = await extractKnowledgeArtifact(record, buffer, owner);
  owner.assertCurrent();
  return Object.freeze({ kind: 'extracted', sourceId, artifactId, record, extracted, contentHash });
}
