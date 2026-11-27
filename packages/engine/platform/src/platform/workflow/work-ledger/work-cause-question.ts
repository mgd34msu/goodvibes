/**
 * Work made before GoodVibes kept who asked for each piece of work (work-plans.ts `WorkCause`) has no recorded cause.
 * It is put to the owner once, in Waiting for you: "keep it as mine" records it as his; "drop it" stops it (the ledger
 * cancels it, and a run of it left is stopped). Until he answers it runs nothing (`WorkPlans.noteCause` refuses every
 * act that would make it run). Only live work is asked about: done or stopped work runs nothing anyway.
 *
 * Told once: the question's key (`work-cause:<work id>`) is in the inbox for good, and the work is marked asked on its
 * record. An answer given while this host was not listening is taken at the next start.
 */
import { randomUUID } from 'node:crypto';
import type { ContractQuestionInbox } from '../../contract/owner-inbox-bridge.js';
import type { WorkLedgerAuthority, WorkLedgerService } from './types.js';
import type { WorkPlans } from './work-plans.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

export const WORK_CAUSE_QUESTION_KEY_PREFIX = 'work-cause:';
export const KEEP_AS_MINE = 'keep it as mine';
export const DROP_IT = 'drop it';

export interface WorkCauseQuestionDeps {
  readonly projectId: string;
  readonly service: Pick<WorkLedgerService, 'readSnapshot' | 'execute'>;
  readonly authority: Pick<WorkLedgerAuthority, 'issueActor' | 'revokeActor'>;
  readonly plans: Pick<WorkPlans, 'hasCause' | 'askCause' | 'causeAsked' | 'answerCause' | 'causesKeptSince'>;
  readonly inbox: ContractQuestionInbox;
  /** Stops a run of the work left from before, when there is one (the native host's cancel). */
  readonly stopRun?: ((workId: string) => Promise<void>) | undefined;
  /** Resolves once the store the ledger is read from is open (the daemon opens it alongside its start). */
  readonly ready?: (() => Promise<unknown>) | undefined;
}

/** Ask about each live piece of work with no recorded cause, once, and take each answer. Returns the stop. */
export function askUnrecordedWorkCauses(deps: WorkCauseQuestionDeps): () => void {
  let stopped = false;
  const applying = new Set<string>();

  async function drop(workId: string): Promise<void> {
    const actor = deps.authority.issueActor({ projectId: deps.projectId, role: 'coordinator', actorId: `host:work-cause:${randomUUID()}` });
    try {
      await deps.stopRun?.(workId).catch((error: unknown) => logger.warn('[Work] a dropped piece of work had a run that could not be stopped', { workId, error: summarizeError(error) }));
      const snapshot = await deps.service.readSnapshot(actor);
      const view = snapshot.works.find((entry) => entry.work.id === workId);
      if (!view || view.work.reportedState === 'cancelled' || view.work.reportedState === 'complete') return;
      await deps.service.execute({ type: 'cancel', requestId: randomUUID(), expectedRevision: snapshot.revision, workId,
        reason: 'Dropped by the owner: it was asked for before GoodVibes kept who asked for each piece of work.' }, actor);
    } finally { deps.authority.revokeActor(actor); }
  }

  async function apply(item: { readonly id: string; readonly status: string; readonly key?: string | undefined; readonly answer?: { readonly option?: string | undefined; readonly text?: string | undefined } | undefined }): Promise<void> {
    if (item.status !== 'answered' || !item.key?.startsWith(WORK_CAUSE_QUESTION_KEY_PREFIX) || applying.has(item.id)) return;
    const workId = item.key.slice(WORK_CAUSE_QUESTION_KEY_PREFIX.length);
    if (!deps.plans.causeAsked(workId)) return;
    const said = (item.answer?.option ?? item.answer?.text ?? '').trim().toLowerCase();
    const answer = said.startsWith('drop') ? 'drop' : said.startsWith('keep') ? 'keep' : undefined;
    if (!answer) return;
    applying.add(item.id);
    try {
      deps.plans.answerCause(workId, answer);
      if (answer === 'drop') await drop(workId);
    } catch (error) {
      logger.warn('[Work] the answer about who a piece of work is for was not taken', { workId, error: summarizeError(error) });
    } finally { applying.delete(item.id); }
  }

  const stopAnswers = deps.inbox.subscribe((item) => { if (!stopped) void apply(item); });

  void (async () => {
    try { await deps.ready?.(); } catch (error) {
      logger.warn('[Work] work with no recorded cause could not be listed; it is asked about at the next start', { error: summarizeError(error) });
      return;
    }
    if (stopped) return;
    const actor = deps.authority.issueActor({ projectId: deps.projectId, role: 'coordinator', actorId: `host:work-cause:${randomUUID()}` });
    try {
      const snapshot = await deps.service.readSnapshot(actor);
      for (const view of snapshot.works) {
        if (stopped) return;
        const work = view.work;
        // Only work made before causes were kept: newer work has its cause noted by its first act.
        if (work.createdAt >= deps.plans.causesKeptSince() || deps.plans.hasCause(work.id) || work.reportedState === 'complete' || work.reportedState === 'cancelled' || view.attempt?.state !== 'active') continue;
        const key = `${WORK_CAUSE_QUESTION_KEY_PREFIX}${work.id}`;
        const latest = deps.inbox.latestByKey('question', key);
        if (latest) { if (latest.status === 'answered') await apply(latest); continue; }
        deps.plans.askCause(work.id);
        deps.inbox.postNow({
          kind: 'question', key, askedBy: 'your work',
          title: `Keep this piece of work as yours? "${work.title.replace(/\s+/g, ' ').trim().slice(0, 150)}"`,
          detail: 'It was asked for before GoodVibes kept who asked for each piece of work, so it is not recorded as yours. '
            + 'Until you answer it runs nothing. Keep it as yours, and it runs as yours when you start it or go on with it in Work; '
            + 'drop it, and it is stopped and moves to History.',
          options: [KEEP_AS_MINE, DROP_IT],
          metadata: { workId: work.id },
        }, 'work');
      }
    } catch (error) {
      logger.warn('[Work] work with no recorded cause could not be listed; it is asked about at the next start', { error: summarizeError(error) });
    } finally { deps.authority.revokeActor(actor); }
  })();

  return () => { stopped = true; stopAnswers(); };
}
