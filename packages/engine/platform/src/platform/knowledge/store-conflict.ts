/**
 * Another process (or another owner of the same file) saved the knowledge
 * store first, so this write was not saved. When `reloaded` is true the store
 * has already adopted the current on-disk image and dropped the unsaved write
 * from memory: retrying the same operation is safe. When false, a batch or a
 * prepared publication in this process still holds pending rows, so the reload
 * waits until that work settles; retry after it finishes.
 */
export class KnowledgeStoreConflictError extends Error {
  readonly code = 'KNOWLEDGE_STORE_CONFLICT';
  readonly retryable = true;

  constructor(readonly reloaded: boolean, options?: { readonly cause?: unknown }) {
    super(reloaded
      ? 'Knowledge store was changed by another process before this write was saved; the write was discarded and the store reloaded from disk. Retry the operation.'
      : 'Knowledge store was changed by another process before this write was saved; the write was not saved and the store will reload once the current batch finishes. Retry the operation after it completes.',
    options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'KnowledgeStoreConflictError';
  }
}

/**
 * A refinement task was asked to move somewhere its current state does not
 * allow (cancelling a closed or suppressed task). Nothing was changed.
 */
export class KnowledgeRefinementTaskRefusedError extends Error {
  readonly code = 'KNOWLEDGE_REFINEMENT_TASK_REFUSED';

  constructor(readonly taskId: string, readonly state: string, reason: string) {
    super(`Refinement task ${taskId}: ${reason}. Nothing was changed.`);
    this.name = 'KnowledgeRefinementTaskRefusedError';
  }
}
