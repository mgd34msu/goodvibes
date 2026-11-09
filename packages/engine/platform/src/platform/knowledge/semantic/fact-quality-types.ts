import { KnowledgeRepairFactUsefulnessHeldError } from './repair-usefulness/types.js';

/** Local data-change observation for the existing bounded page-recovery pass.
 * The identifier selects its already captured fact; it grants no write authority. */
export class KnowledgeFactReadSetStaleError extends KnowledgeRepairFactUsefulnessHeldError {
  constructor(readonly factId: string) { super('stale'); }
}
