/**
 * The rules 3.5.0 kept for the daemon's own folder, carried once so an upgrade never weakens a protection.
 *
 * Up to 3.5.0 an answer remembered "in this project" for work the daemon ran itself (a runner, a coding agent or a
 * session it hosted, an agent it started) was saved for the folder the daemon was started in, whatever project the
 * work was in, and those rules were checked for every such call in every project. Since then a rule belongs to the
 * project it was asked in and is checked only there (call-project.ts). At every start of this version, for each such
 * rule this version has not written yet (one 3.5.0 saved, before the upgrade or during a rollback):
 *
 * 1. Placed: a rule saved for the daemon's folder is matched to the approval record whose answer made it (the same
 *    rule rebuilt from the record's call, tier and answer, as the broker and the gate build it). The record says the
 *    project when the work said it: a runner's or a hosted coding agent's call carries its folder
 *    (`args.destination.cwd`), a call put through the daemon by another program carries its caller's folder. A rule
 *    whose records all name one other project is moved there.
 * 2. Not placed (no record left, or records that say nothing but the daemon's folder, or disagree):
 *    - a rule that refuses or asks keeps doing so for daemon-run work in every project, as it did under 3.5.0: it is
 *      kept for every project and marked `carried: '3.5.0'`, listed in Rules under "Every project (carried from
 *      3.5.0)", where the owner places it in one project (`permissions.place`) or removes it;
 *    - a rule that allows stays the daemon's folder's: an allow never spreads.
 * 3. The owner is told once per carry, in plain words, how many were placed, carried to every project and kept for the
 *    folder. Each rule considered is written again by this version, so the next start finds it done.
 *
 * Nothing else is touched: rules of any other folder were made by a program in that folder and are already right.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { buildDurableRuleForDecision, type RememberTier } from './approval-rules.js';
import type { OwnerOnlyKind } from '../gate/classify.js';
import { projectRootOfDirectory } from './call-project.js';
import { projectIdentity, type StoredUserPermissionRule, type UserPermissionRuleStore } from './user-rule-store.js';

export const DAEMON_FOLDER_RULES_NOTICE_ID = 'permission-rules-per-project';

/** The part of an approval record the carry reads. */
export interface CarriedApprovalRecord {
  readonly id: string;
  readonly status: string;
  readonly request: { readonly tool: string; readonly args: Readonly<Record<string, unknown>>; readonly workingDirectory?: string | undefined; readonly ownerOnly?: string | undefined };
  readonly decision?: { readonly approved?: boolean | undefined; readonly rememberTier?: string | undefined; readonly disposition?: string | undefined } | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** The project an approval record's call was made in, when the call itself says so; undefined when it does not. */
function projectOfRecord(approval: CarriedApprovalRecord): string | undefined {
  const destination = text(record(approval.request.args['destination'])?.['cwd']);
  const caller = text(record(record(approval.metadata?.['capabilityCall'])?.['caller'])?.['workingDirectory']);
  const folder = destination ?? caller;
  return folder ? projectIdentity(projectRootOfDirectory(folder)) : undefined;
}

/** The rule an answered approval with a durable tier made, as the broker and the gate build it. */
function ruleOfRecord(approval: CarriedApprovalRecord): { readonly rule: ReturnType<typeof buildDurableRuleForDecision>; readonly tier: string } | undefined {
  const tier = approval.decision?.rememberTier;
  // A 3.5.0 record says its answer by the decision's `disposition` (its kept line carries no status); else by status.
  const answer = approval.decision?.disposition ?? approval.status;
  if (!tier || tier === 'session' || (answer !== 'approved' && answer !== 'denied')) return undefined;
  const approved = answer === 'approved';
  // The owner-only kind is the record's own field, written by the gate from its kinds: read back as one of them.
  const ownerOnly = approval.request.ownerOnly as OwnerOnlyKind | undefined;
  const rule = buildDurableRuleForDecision({ toolName: approval.request.tool, args: { ...approval.request.args }, tier: tier as RememberTier,
    effect: approved ? 'allow' : 'deny', ...(approved && ownerOnly ? { ownerOnly } : {}) });
  return rule ? { rule, tier } : undefined;
}

/**
 * A settled record keeps no arguments; the log keeps the record's earlier lines, the call as asked among them, until it
 * is compacted. Each record whose arguments are gone is given the ones its earliest line kept (and that line's metadata
 * where its own has none). A log that cannot be read leaves the records as they are.
 */
function withAskedArguments(records: readonly CarriedApprovalRecord[], logPath: string | undefined): readonly CarriedApprovalRecord[] {
  if (!logPath) return records;
  const asked = new Map<string, { args: Readonly<Record<string, unknown>>; metadata?: Readonly<Record<string, unknown>> }>();
  let content: string;
  try { content = readFileSync(logPath, 'utf8'); } catch { return records; }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const id = text(parsed['id']);
    const args = record(record(parsed['request'])?.['args']);
    if (!id || asked.has(id) || !args || Object.keys(args).length === 0) continue;
    const metadata = record(parsed['metadata']);
    asked.set(id, { args, ...(metadata ? { metadata } : {}) });
  }
  return records.map((one) => {
    const kept = asked.get(text(one.id) ?? '');
    if (!kept || Object.keys(one.request.args).length > 0) return one;
    return { ...one, request: { ...one.request, args: kept.args }, ...(!one.metadata || Object.keys(one.metadata).length === 0 ? (kept.metadata ? { metadata: kept.metadata } : {}) : {}) };
  });
}
const sameRule =(a: StoredUserPermissionRule['rule'], b: NonNullable<ReturnType<typeof buildDurableRuleForDecision>>): boolean =>
  isDeepStrictEqual({ ...a, id: '' }, { ...b, id: '' });

const nameOf = (folder: string): string => basename(folder) || folder;
const count = (n: number, one: string, many: string): string => n === 1 ? `One ${one}` : `${n} ${many}`;

/**
 * The notice's id for one carry: the first carry keeps the id it always had; a later one (rules a 3.5.0 daemon saved
 * during a rollback, carried at the next start of this version) is told under an id of its own rules, so it is told
 * once too.
 */
function noticeIdFor(candidates: readonly StoredUserPermissionRule[], announcements: { has(id: string): boolean }): string {
  if (!announcements.has(DAEMON_FOLDER_RULES_NOTICE_ID)) return DAEMON_FOLDER_RULES_NOTICE_ID;
  return `${DAEMON_FOLDER_RULES_NOTICE_ID}:${candidates.map((entry) => entry.rule.id).sort().join(',')}`;
}

/**
 * Carry the daemon folder's 3.5.0 rules (see the file's comment) at every start: the rules not yet carried are the
 * daemon folder's that this version did not write (no `writtenBy`, user-rule-store.ts), so a rule a 3.5.0 daemon saved
 * during a rollback is carried at the next start of this version, and a start with nothing left carries nothing.
 * Every rule it considers is written again by this version (placed, carried or kept), which marks it: running it again
 * finds none. Never throws. Returns what was done, for the log.
 */
export async function noteDaemonFolderRules(
  store: Pick<UserPermissionRuleStore, 'list' | 'awaitReady' | 'add'>,
  daemonFolder: string | null | undefined,
  announcements: { has(id: string): boolean; recordOnce(id: string, text?: string): unknown },
  approvals?: { start(): Promise<void>; listApprovals(limit: number): readonly CarriedApprovalRecord[]; historyPath?(): string } | undefined,
): Promise<{ readonly placed: number; readonly carried: number; readonly kept: number } | undefined> {
  try {
    if (!daemonFolder) return undefined;
    await store.awaitReady();
    const folder = projectIdentity(daemonFolder);
    const candidates = store.list().filter((entry) => entry.project === folder && entry.rule.origin === 'user' && entry.tier !== 'never-run'
      && entry.carried === undefined && entry.keptFor === undefined && entry.writtenBy === undefined);
    if (candidates.length === 0) { if (!announcements.has(DAEMON_FOLDER_RULES_NOTICE_ID)) announcements.recordOnce(DAEMON_FOLDER_RULES_NOTICE_ID); return { placed: 0, carried: 0, kept: 0 }; }
    const noticeId = noticeIdFor(candidates, announcements);
    let records: readonly CarriedApprovalRecord[] = [];
    if (approvals) {
      try { await approvals.start(); records = withAskedArguments(approvals.listApprovals(Number.MAX_SAFE_INTEGER), approvals.historyPath?.()); }
      catch (error) { logger.warn('[permissions] the approval records could not be read to place earlier rules; none is placed', { error: summarizeError(error) }); }
    }
    const made = records.flatMap((approval) => { const rebuilt = ruleOfRecord(approval); return rebuilt?.rule ? [{ ...rebuilt, rule: rebuilt.rule, project: projectOfRecord(approval) }] : []; });
    const placedIn = new Map<string, number>();
    let carried = 0, kept = 0;
    for (const entry of candidates) {
      const projects = new Set(made.filter((one) => one.tier === entry.tier && sameRule(entry.rule, one.rule)).map((one) => one.project ?? folder));
      const only = projects.size === 1 ? [...projects][0]! : undefined;
      if (only !== undefined && only !== folder) {
        await store.add({ ...entry, project: only });
        // A refusal (or an ask) also stays where 3.5.0 reads it, as it was, for a 3.5.0 daemon put back: this version
        // never reads that copy (user-rule-store.ts `keptFor`), and it goes when the placed rule is removed. An allow
        // gets none: it never spreads.
        if (entry.rule.effect !== 'allow') {
          await store.add({ ...entry, rule: { ...entry.rule, id: `${entry.rule.id}~3.5.0` }, keptFor: { release: '3.5.0', of: entry.rule.id } });
        }
        placedIn.set(only, (placedIn.get(only) ?? 0) + 1);
      } else if (entry.rule.effect !== 'allow') {
        // A refusal (or an ask) that cannot be placed keeps refusing daemon-run work everywhere, as under 3.5.0.
        const { project: _folder, ...everywhere } = entry;
        await store.add({ ...everywhere, carried: '3.5.0' });
        carried += 1;
      } else {
        // Kept the folder's, as it was: written again only so it carries this version's mark and is not considered again.
        await store.add(entry);
        kept += 1;
      }
    }
    const placed = [...placedIn.values()].reduce((sum, n) => sum + n, 0);
    const where = [...placedIn.entries()].map(([project, n]) => `${n} in ${nameOf(project)}`).join(', ');
    const name = nameOf(folder);
    const lines = [
      `Permission rules now belong to the project they were asked in. ${candidates.length === 1 ? 'One rule' : `${candidates.length} rules`} remembered before this version for work the daemon ran itself had been saved for ${name} (${folder}), the folder the daemon was started in, whatever project the work was in.`,
      ...(placed > 0 ? [`${placed === 1 ? 'One of them was' : `${placed} of them were`} moved to the project ${placed === 1 ? 'it was' : 'they were'} made in, as the answers that made ${placed === 1 ? 'it' : 'them'} show (${where}).`] : []),
      ...(carried > 0 ? [`${count(carried, 'rule that refuses or asks', 'rules that refuse or ask')} could not be placed, so ${carried === 1 ? 'it keeps' : 'they keep'} applying in every project, as before: Rules lists ${carried === 1 ? 'it' : 'them'} under "Every project (carried from 3.5.0)", where you keep ${carried === 1 ? 'it' : 'each'} for one project or remove it.`] : []),
      ...(kept > 0 ? [`${count(kept, 'rule that allows', 'rules that allow')} could not be placed and ${kept === 1 ? 'applies' : 'apply'} only in ${name} now: work elsewhere asks again there once.`] : []),
    ];
    announcements.recordOnce(noticeId, lines.join(' '));
    logger.info('[permissions] rules kept for the daemon\'s folder carried', { placed, carried, kept, records: records.length, answers: made.length });
    return { placed, carried, kept };
  } catch (error) {
    logger.warn('[permissions] the rules kept for the daemon\'s folder could not be carried; they stay as they were', { error: summarizeError(error) });
    return undefined;
  }
}
