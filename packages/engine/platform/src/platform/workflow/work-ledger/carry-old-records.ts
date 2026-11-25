/**
 * carry-old-records.ts, the old planning records carried into Work once, at
 * the first start of this version.
 *
 * Earlier versions kept a project's planning interview (its planning state
 * with its tasks, its work plans and its decisions) as knowledge sources, and
 * asked the owner to import them into the work ledger by hand. The checklist's
 * rows are not among them: they stay the checklist. Carrying stored data
 * forward is the product's own act, not a decision for anyone: the daemon's
 * host does it itself, with the import's own preparation and the ledger's own
 * import command, as the coordinator. Nothing is dropped: every source is
 * carried whole (a set too large for one import is carried one source at a
 * time); a source already in Work (imported by hand before) is left as it is.
 * The old records are only read, never changed, so a 3.5.0 binary after a
 * rollback reads them exactly as before (and its work ledger shows the carried
 * works, which it reads as imported works).
 *
 * Once everything is carried, the announce-once store holds the mark and the
 * one line to the owner ("N pieces of work ... carried into Work"). A source
 * that could not be carried leaves no mark: it is said in one line and tried
 * again at the next start.
 */
import { randomUUID } from 'node:crypto';
import { prepareLegacyWorkLedgerMigration } from './legacy-import.js';
import type { WorkLedgerAuthority, WorkLedgerResult, WorkLedgerService } from './types.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

export interface CarryOldWorkRecordsDeps {
  readonly hostId: string;
  readonly projectId: string;
  /** Resolves once the stores the old records are read from are open (the daemon starts them alongside). */
  readonly ready?: (() => Promise<unknown>) | undefined;
  readonly service: Pick<WorkLedgerService, 'readSnapshot' | 'execute'>;
  readonly authority: Pick<WorkLedgerAuthority, 'issueActor' | 'revokeActor'>;
  /** Every old planning record of the project, by id: its planning sources and its work-plan task rows. */
  readonly sourceIds: () => readonly string[];
  readonly readSource: (id: string) => { readonly source: unknown; readonly generation: string | null };
  /** The announce-once store: its mark says the carry is done, its pending line reaches the owner. */
  readonly announcements: { has(id: string): boolean; recordOnce(id: string, text?: string): unknown; notify(id: string, text: string): boolean };
}

export interface CarryOldWorkRecordsOutcome {
  readonly carried: number;
  readonly alreadyInWork: number;
  readonly left: readonly { readonly id: string; readonly reason: string }[];
}

/** The project's old planning sources in the knowledge store (connector `goodvibes-project-planning`), read page by page. */
export function oldPlanningSourceIds(
  store: { listSourcesPage(offset: number, limit: number): readonly { readonly id: string; readonly connectorId?: string | undefined; readonly metadata?: unknown }[] },
  projectId: string,
): readonly string[] {
  const ids: string[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = store.listSourcesPage(offset, 200);
    for (const source of page) {
      const metadata = source.metadata !== null && typeof source.metadata === 'object' ? source.metadata as Record<string, unknown> : {};
      if (source.connectorId === 'goodvibes-project-planning' && metadata['projectPlanning'] === true && metadata['projectId'] === projectId) ids.push(source.id);
    }
    if (page.length < 200) return ids;
  }
}

const carriedMark =(projectId: string): string => `work-records-carried:${projectId}`;

type BatchOutcome = { readonly kind: 'carried'; readonly works: number } | { readonly kind: 'already' } | { readonly kind: 'left'; readonly reason: string; readonly split: boolean };

/** Carry the project's old planning records into Work, once; undefined when it was done before. */
export async function carryOldWorkRecords(deps: CarryOldWorkRecordsDeps): Promise<CarryOldWorkRecordsOutcome | undefined> {
  const mark = carriedMark(deps.projectId);
  if (deps.announcements.has(mark)) return undefined;
  let ids: string[];
  try {
    await deps.ready?.();
    ids = [...new Set(deps.sourceIds())].sort();
  } catch (error) {
    // The old records could not be listed: nothing is marked, so the next start tries again; said once now.
    const text = `Your old planning records could not be read to carry them into Work (${summarizeError(error)}). They are kept as they were; GoodVibes tries again at the next start.`;
    logger.warn('[Work] old planning records could not be listed', { error: summarizeError(error) });
    deps.announcements.notify(`${mark}:left`, text);
    return { carried: 0, alreadyInWork: 0, left: [{ id: '(all)', reason: summarizeError(error) }] };
  }
  if (ids.length === 0) {
    deps.announcements.recordOnce(mark);
    return { carried: 0, alreadyInWork: 0, left: [] };
  }
  const actor = deps.authority.issueActor({ projectId: deps.projectId, role: 'coordinator', actorId: `host:work-records-carry:${randomUUID()}` });
  const outcome = { carried: 0, alreadyInWork: 0, left: [] as { id: string; reason: string }[] };
  try {
    const batch = async (sourceIds: readonly string[]): Promise<BatchOutcome> => {
      const sources = sourceIds.map((id) => deps.readSource(id));
      const missing = sources.findIndex((source) => source.generation === null || source.source === null || source.source === undefined);
      if (missing >= 0) return { kind: 'left', reason: `the record ${sourceIds[missing]} could not be read`, split: sourceIds.length > 1 };
      const snapshot = await deps.service.readSnapshot(actor);
      const prepared = prepareLegacyWorkLedgerMigration({
        hostId: deps.hostId, projectId: deps.projectId, expectedLedgerRevision: snapshot.revision, pendingLocalChanges: false,
        sources: sources as { source: unknown; generation: string }[], occupiedWorkIds: snapshot.works.map((view) => view.work.id),
      });
      if (prepared.kind === 'blocked') {
        if (prepared.code === 'target-conflict' && sourceIds.length === 1) return { kind: 'already' };
        return { kind: 'left', reason: prepared.reason, split: sourceIds.length > 1 && (prepared.code === 'limit' || prepared.code === 'target-conflict' || prepared.code === 'identity-conflict') };
      }
      const result: WorkLedgerResult = await deps.service.execute(
        { type: 'import_legacy', requestId: randomUUID(), expectedRevision: snapshot.revision, manifest: prepared.manifest }, actor);
      if (result.kind === 'accepted') return { kind: 'carried', works: result.event.type === 'import_legacy' ? result.event.works.length : 0 };
      if (result.kind === 'rejected' && result.code === 'conflict' && /already exists/u.test(result.reason)) {
        return sourceIds.length === 1 ? { kind: 'already' } : { kind: 'left', reason: result.reason, split: true };
      }
      return { kind: 'left', reason: result.kind === 'rejected' ? result.reason : 'the work ledger did not take it', split: false };
    };
    const whole = await batch(ids);
    const settle = (sourceIds: readonly string[], result: BatchOutcome): void => {
      if (result.kind === 'carried') outcome.carried += result.works;
      else if (result.kind === 'already') outcome.alreadyInWork += sourceIds.length;
      else for (const id of sourceIds) outcome.left.push({ id, reason: result.reason });
    };
    if (whole.kind === 'left' && whole.split) {
      // Too large for one import, or part of it is in Work already: one record at a time, nothing left out.
      for (const id of ids) settle([id], await batch([id]));
    } else settle(ids, whole);
  } catch (error) {
    outcome.left.push({ id: '(all)', reason: summarizeError(error) });
  } finally {
    deps.authority.revokeActor(actor);
  }
  if (outcome.left.length === 0) {
    const n = outcome.carried;
    const records = ids.length - outcome.alreadyInWork;
    const kept = records === 1 ? 'The old record is kept as it was.' : 'The old records are kept as they were.';
    deps.announcements.recordOnce(mark, n > 0
      ? `${n} piece${n === 1 ? '' : 's'} of work from ${records === 1 ? 'your old planning record' : `your ${records} old planning records`} ${n === 1 ? 'was' : 'were'} carried into Work, where ${n === 1 ? 'it shows' : 'they show'} under History. ${kept}`
      : records > 0 ? `${records === 1 ? 'Your old planning record' : `Your ${records} old planning records`} (decisions, with no piece of work in ${records === 1 ? 'it' : 'them'}) ${records === 1 ? 'was' : 'were'} carried into Work's history. ${kept}`
        : undefined);
    if (records > 0) logger.info('[Work] old planning records carried into Work', { records, works: n, alreadyInWork: outcome.alreadyInWork });
  } else {
    const text = `${outcome.left.length} of your old planning records could not be carried into Work (${outcome.left[0]!.reason}). They are kept as they were; GoodVibes tries again at the next start.`;
    logger.warn('[Work] old planning records not carried', { left: outcome.left.length, reason: outcome.left[0]!.reason, carried: outcome.carried });
    deps.announcements.notify(`${mark}:left`, text);
  }
  return outcome;
}
