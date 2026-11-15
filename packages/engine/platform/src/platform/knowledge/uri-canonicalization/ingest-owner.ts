import type { KnowledgeIngestContext, KnowledgeIngestOwnership } from '../ingest-context.js';
import { KnowledgeIngestStoppedError } from '../ingest-stopped.js';
import { knowledgeIngestGuard } from '../ingest-preparation.js';
import { createKnowledgeUriCanonicalizer, type KnowledgeUriCanonicalizer } from './reader.js';

/**
 * The URI reader of one ingest. It canonicalizes under the ingest's signal and
 * checks, and after `reserveSource`/`attachArtifact` its check also covers the
 * reserved source row (by store generation) and the attached artifact.
 */
export interface KnowledgeIngestUriCanonicalizer extends KnowledgeUriCanonicalizer {
  readonly signal: AbortSignal;
  readonly reserveSource: (sourceId: string, canonicalUri?: string) => void;
  readonly attachArtifact: (artifactId: string) => void;
}

export function createKnowledgeIngestUriCanonicalizer(context: KnowledgeIngestContext, ownership: KnowledgeIngestOwnership = {},
  assertSourceCurrent?: () => void, callerSignal: AbortSignal | undefined = ownership.signal): KnowledgeIngestUriCanonicalizer {
  const signal = callerSignal ?? new AbortController().signal;
  const callerCurrent = ownership.assertCurrent;
  let assertReservationCurrent = (): void => {};
  let assertArtifactCurrent = (): void => {};
  const assertCurrent = (): void => {
    if (signal.aborted) throw new KnowledgeIngestStoppedError('cancelled', undefined, { cause: signal.reason });
    try { callerCurrent?.(); }
    catch (error) {
      if (error instanceof KnowledgeIngestStoppedError) throw error;
      throw new KnowledgeIngestStoppedError('changed', undefined, { cause: error });
    }
    assertSourceCurrent?.();
    assertReservationCurrent();
    assertArtifactCurrent();
  };
  const reader = createKnowledgeUriCanonicalizer({ signal, assertCurrent });
  return Object.freeze({
    signal,
    // The ingest's own checks first, so a stop keeps its reason; then the reader's.
    assertCurrent: () => { assertCurrent(); reader.assertCurrent(); },
    canonicalize: (input: string) => reader.canonicalize(input),
    canonicalizeAll: (inputs: readonly string[]) => reader.canonicalizeAll(inputs),
    reserveSource(sourceId: string, canonicalUri?: string) {
      assertReservationCurrent = knowledgeIngestGuard(context, sourceId, canonicalUri, signal);
      assertReservationCurrent();
    },
    attachArtifact(artifactId: string) {
      const record = context.artifactStore.getRecord(artifactId);
      if (!record) throw new KnowledgeIngestStoppedError('changed', `artifact ${artifactId} is no longer stored`);
      const { sizeBytes, createdAt } = record;
      assertArtifactCurrent = () => {
        const current = context.artifactStore.getRecord(artifactId);
        if (!current || current.sizeBytes !== sizeBytes || current.createdAt !== createdAt) {
          throw new KnowledgeIngestStoppedError('changed', `artifact ${artifactId} was replaced or removed during the ingest`);
        }
      };
    },
  });
}
