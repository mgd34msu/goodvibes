/**
 * Work made before GoodVibes kept who asked for each piece of work (work-plans.ts `WorkCause`) has no recorded cause. It
 * is the owner's, with nothing asked: at the start of this project's Work each such piece of work is recorded as the
 * owner's own (`WorkPlans.ownOldWork`), so it reads and runs as theirs, as it did before; nothing refuses an act of the
 * user's on it, from any credential (`WorkPlans.noteCause`).
 */
import { randomUUID } from 'node:crypto';
import type { WorkLedgerAuthority, WorkLedgerService } from './types.js';
import type { WorkPlans } from './work-plans.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

export interface OldWorkCauseDeps {
  readonly projectId: string;
  readonly service: Pick<WorkLedgerService, 'readSnapshot'>;
  readonly authority: Pick<WorkLedgerAuthority, 'issueActor' | 'revokeActor'>;
  readonly plans: Pick<WorkPlans, 'hasCause' | 'causesKeptSince' | 'ownOldWork'>;
  /** Resolves once the store the ledger is read from is open (the daemon opens it alongside its start). */
  readonly ready?: (() => Promise<unknown>) | undefined;
}

/** Record every piece of this project's work made before causes were kept as the owner's own. Resolves when done. */
export async function keepOldWorkAsOwners(deps: OldWorkCauseDeps): Promise<number> {
  try { await deps.ready?.(); } catch (error) {
    logger.warn('[Work] work made before causes were kept could not be listed; it is recorded as the owner\'s at the next start', { error: summarizeError(error) });
    return 0;
  }
  const actor = deps.authority.issueActor({ projectId: deps.projectId, role: 'coordinator', actorId: `host:old-work-cause:${randomUUID()}` });
  try {
    const snapshot = await deps.service.readSnapshot(actor);
    const since = deps.plans.causesKeptSince();
    const old = snapshot.works.map((view) => view.work).filter((work) => work.createdAt < since && !deps.plans.hasCause(work.id)).map((work) => work.id);
    return deps.plans.ownOldWork(old);
  } catch (error) {
    logger.warn('[Work] work made before causes were kept could not be listed; it is recorded as the owner\'s at the next start', { error: summarizeError(error) });
    return 0;
  } finally { deps.authority.revokeActor(actor); }
}
