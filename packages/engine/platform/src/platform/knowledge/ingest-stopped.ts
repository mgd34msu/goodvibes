/** Why an ingest stopped before it published. */
export type KnowledgeIngestStopReason = 'cancelled' | 'changed' | 'model-unsure' | 'model-unavailable';

const STOP_MESSAGES: Readonly<Record<KnowledgeIngestStopReason, string>> = Object.freeze({
  cancelled: 'Knowledge ingest was cancelled; nothing new was published.',
  changed: 'Knowledge ingest stopped: the source or its stored file changed while it was being read. Run the ingest again.',
  'model-unsure': 'Knowledge ingest is held: the decision model could not settle a reading of this document. The source is kept pending and a refresh reads it again.',
  'model-unavailable': 'Knowledge ingest is held: the decision model could not be reached. The source is kept pending and a refresh reads it again.',
});

/**
 * The one stop signal of the ingest path. `reason` says what happened; a
 * cancellation is never stored, every other stop leaves the source pending with
 * the reason so it can be found, retried or dismissed.
 */
export class KnowledgeIngestStoppedError extends Error {
  readonly reason: KnowledgeIngestStopReason;
  readonly detail: string | undefined;
  constructor(reason: KnowledgeIngestStopReason, detail?: string, options?: { readonly cause?: unknown }) {
    super(detail ? `${STOP_MESSAGES[reason]} (${detail})` : STOP_MESSAGES[reason], options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'KnowledgeIngestStoppedError';
    this.reason = reason;
    this.detail = detail;
  }
}

/** The stop an error stands for: a stop as itself, an abort as a cancellation. */
export function knowledgeIngestStop(error: unknown, signal?: AbortSignal): KnowledgeIngestStoppedError | undefined {
  // An aborted signal decides it: whatever a layer below wrapped the abort in,
  // the ingest was cancelled.
  if (signal?.aborted) {
    return error instanceof KnowledgeIngestStoppedError && error.reason === 'cancelled'
      ? error : new KnowledgeIngestStoppedError('cancelled', undefined, { cause: error });
  }
  if (error instanceof KnowledgeIngestStoppedError) return error;
  if (error instanceof Error && error.name === 'AbortError') return new KnowledgeIngestStoppedError('cancelled', undefined, { cause: error });
  return undefined;
}
