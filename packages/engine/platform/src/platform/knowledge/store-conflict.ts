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
