// ---------------------------------------------------------------------------
// work-plan-store.ts, per-project work plan persisted at
//   <home>/.goodvibes/<surfaceRoot>/work-plans/project-<hash>.json
//
// The surface root is supplied by the product that owns the plan, so two
// products sharing a home directory keep separate plans and neither has to
// spell the segment at a call site. The file name is a pure function of the
// project (work-plan-location.ts), resolved once when the store is built.
//
// Recovery discipline (applies to every read):
//
//  * CONTENT, NOT EXISTENCE, decides whether the file is usable. A plan file
//    can exist and still be unusable, zero-byte, truncated mid-write, or
//    otherwise torn by a crash. Every read parses defensively and validates the
//    parsed SHAPE; an unusable file degrades to an empty plan instead of
//    throwing out of the store's public methods.
//  * AN UNREADABLE FILE IS PRESERVED, NOT OVERWRITTEN. It is moved aside to
//    `<plan>.json.corrupt-<time>-<rand>` so a user can still recover their list,
//    and so is a file this build reads only partly (items it cannot read, a
//    status it does not know) before the first rewrite. Those copies are
//    themselves bounded (age TTL + count cap).
//  * THE STORE IS BOUNDED. Terminal (done/cancelled) items age out and are
//    capped by count. Items the user still has open, pending, in_progress,
//    blocked, failed, are NEVER reclaimed by either bound.
//  * NOTHING IS DELETED SILENTLY. Whatever a sweep reclaimed is recorded on the
//    plan as `housekeeping` and rendered by `toMarkdown()`.
//
// A read is pure: no lock, no directory, no sweep, no quarantine, no write. A
// damaged file is reported on the plan it returns and left as it is. Every
// change runs under the plan's kernel-released process lock, so two products
// editing one project's plan never overwrite each other's change; the change
// is also where the bounds are applied and an unreadable file is moved aside,
// in the one write it makes anyway.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync, type AtomicWriteOptions } from '../config/atomic-write.js';
import { requireSurfaceRoot } from '../runtime/surface-root.js';
import { quarantineCorruptFile, reapOwnedQuarantines, writeDocument } from '../utils/atomic-json-store.js';
import { withProcessLockSync } from '../utils/process-lock.js';
import { captureRevisions, assertCurrent, type RevisionSource } from '../utils/revision.js';
import { importAssignedWorkPlans, workPlanPath } from './work-plan-location.js';

/** A caller's restriction on the store's writes: checked before each write, told after it. */
export type WorkPlanEffectOptions = Pick<AtomicWriteOptions, 'assertCurrent' | 'onEffect'>;

/**
 * Age TTL for TERMINAL (done/cancelled) items. Once a completed or cancelled
 * item has been untouched this long it is reclaimed by the next read. Chosen to
 * comfortably outlive "I finished that last month and want to see it" while
 * still bounding a plan that is never manually cleared.
 */
export const WORK_PLAN_TERMINAL_ITEM_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Count cap for TERMINAL (done/cancelled) items: the most recently completed
 * this many are kept, older ones are reclaimed oldest-first. Live items are
 * neither counted against this cap nor removed by it.
 */
export const WORK_PLAN_TERMINAL_ITEM_CAP = 200;

/** Age TTL for quarantined (unreadable) plan files, the recovery copy's own bound. */
export const WORK_PLAN_QUARANTINE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/** Count cap for quarantined plan files kept alongside one plan; oldest go first. */
export const WORK_PLAN_QUARANTINE_CAP = 5;

/**
 * Minimum gap between quarantine-directory scans for one store instance. The
 * item bounds are evaluated on every read (they are a pure pass over in-memory
 * items); the directory scan is throttled so a redrawing modal cannot turn it
 * into a per-frame readdir. This is what makes the sweep periodic rather than
 * startup-only: a long-lived session keeps sweeping on this cadence.
 */
export const WORK_PLAN_QUARANTINE_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export const WORK_PLAN_STATUSES = [
  'pending',
  'in_progress',
  'blocked',
  'done',
  'failed',
  'cancelled',
] as const;

export type WorkPlanItemStatus = typeof WORK_PLAN_STATUSES[number];

export interface WorkPlanLinkTargets {
  readonly agentId?: string | undefined;
  readonly contractId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly sessionId?: string | undefined;
}

export interface WorkPlanItem {
  readonly id: string;
  readonly title: string;
  readonly status: WorkPlanItemStatus;
  readonly owner?: string | undefined;
  readonly source?: string | undefined;
  readonly notes?: string | undefined;
  readonly linked?: WorkPlanLinkTargets | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number | undefined;
}

/**
 * What the last recovery/bounding sweep reclaimed. Persisted with the plan and
 * rendered by `toMarkdown()` so a removal is always disclosed, counts and
 * paths only, never item text.
 */
export interface WorkPlanHousekeeping {
  /** Unix ms of the sweep that produced these counts. */
  readonly at: number;
  /** Terminal items reclaimed by the age TTL. */
  readonly expiredItems: number;
  /** Terminal items reclaimed by the count cap. */
  readonly cappedItems: number;
  /** True when the plan file on disk could not be parsed and the plan was reset. */
  readonly resetFromUnreadableFile?: boolean | undefined;
  /** Where the unreadable file was preserved, when there was content worth keeping. */
  readonly quarantinePath?: string | undefined;
  /** Quarantined files removed by their own TTL / count cap. */
  readonly quarantinesRemoved?: number | undefined;
  /** Historical paths without matching native receipts are kept for inspection. */
  readonly preservedUnverifiedQuarantines?: number | undefined;
  /** A read found damage and left the file as it is; the next change preserves it aside. */
  readonly recoveryRequired?: boolean | undefined;
  /** Saved items this build could not read (no title, or `items` was not a list) and therefore dropped; the original file was preserved at `quarantinePath`. */
  readonly droppedItems?: number | undefined;
  /** Saved items whose status this build does not know; they were set to pending and the original file was preserved at `quarantinePath`. */
  readonly coercedItems?: number | undefined;
}

/** One preserved copy of a plan file this build could not read in full. */
export interface WorkPlanRecovery {
  readonly at: number;
  readonly path: string;
}

export interface WorkPlan {
  /** A plan that was never saved has no plan ID yet; the first change saves it. */
  readonly registration?: 'registered' | 'unregistered';
  readonly id: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly title: string;
  readonly items: readonly WorkPlanItem[];
  readonly activeItemId?: string | undefined;
  readonly source?: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Result of the most recent sweep that actually reclaimed something. */
  readonly housekeeping?: WorkPlanHousekeeping | undefined;
  /**
   * Every earlier plan file preserved aside, oldest first, within the same age
   * and count bounds as the preserved files themselves. Kept apart from
   * `housekeeping` so a later sweep does not drop where a copy went.
   */
  readonly recoveries?: readonly WorkPlanRecovery[] | undefined;
  /** Preserved older files whose metadata cannot establish a project owner. */
  readonly unassignedPlanPaths?: readonly string[] | undefined;
}

export interface WorkPlanStoreOptions {
  readonly homeDirectory: string;
  /**
   * The owning product's storage scope, the `<surfaceRoot>` segment in
   * `<home>/.goodvibes/<surfaceRoot>/work-plans/`. Supplied rather than spelled
   * here so the plan lands under the same scope as the rest of that product's
   * state.
   */
  readonly surfaceRoot: string;
  readonly projectId: string;
  readonly projectRoot: string;
  /**
   * Recorded on a newly-created plan as its `source`, naming which product
   * opened it. Omitted ⇒ the plan carries no source, which is what `readString`
   * already tolerates on read.
   */
  readonly source?: string | undefined;
}

export interface AddWorkPlanItemOptions {
  readonly status?: WorkPlanItemStatus | undefined;
  readonly owner?: string | undefined;
  readonly source?: string | undefined;
  readonly notes?: string | undefined;
  readonly linked?: WorkPlanLinkTargets | undefined;
}

export interface UpdateWorkPlanItemPatch {
  readonly title?: string | undefined;
  readonly status?: WorkPlanItemStatus | undefined;
  readonly owner?: string | null | undefined;
  readonly source?: string | null | undefined;
  readonly notes?: string | null | undefined;
  readonly linked?: WorkPlanLinkTargets | null | undefined;
}

function nowMs(): number {
  return Date.now();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function isWorkPlanStatus(value: unknown): value is WorkPlanItemStatus {
  return typeof value === 'string' && WORK_PLAN_STATUSES.includes(value as WorkPlanItemStatus);
}

function createItemId(): string {
  return `wpi-${randomUUID().slice(0, 8)}`;
}

function normalizeLinked(value: unknown): WorkPlanLinkTargets | undefined {
  if (!isObject(value)) return undefined;
  const agentId = readString(value.agentId);
  const contractId = readString(value.contractId);
  const taskId = readString(value.taskId);
  const sessionId = readString(value.sessionId);
  const linked: WorkPlanLinkTargets = {
    ...(agentId ? { agentId } : {}),
    ...(contractId ? { contractId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
  return Object.keys(linked).length > 0 ? linked : undefined;
}

function normalizeItem(value: unknown, fallbackCreatedAt: number): WorkPlanItem | null {
  if (!isObject(value)) return null;
  const title = readString(value.title);
  if (!title) return null;
  const status = isWorkPlanStatus(value.status) ? value.status : 'pending';
  const createdAt = typeof value.createdAt === 'number' ? value.createdAt : fallbackCreatedAt;
  const updatedAt = typeof value.updatedAt === 'number' ? value.updatedAt : createdAt;
  const completedAt = typeof value.completedAt === 'number' ? value.completedAt : undefined;
  const owner = readString(value.owner);
  const source = readString(value.source);
  const notes = readString(value.notes);
  const linked = normalizeLinked(value.linked);
  return {
    id: readString(value.id) ?? createItemId(),
    title,
    status,
    ...(owner ? { owner } : {}),
    ...(source ? { source } : {}),
    ...(notes ? { notes } : {}),
    ...(linked ? { linked } : {}),
    createdAt,
    updatedAt,
    ...(completedAt !== undefined ? { completedAt } : {}),
  };
}

/** How many saved items `normalizeItem` would drop or change, so a lossy read is disclosed instead of silent. */
function countLossyItems(value: unknown): { dropped: number; coerced: number } {
  if (value === undefined) return { dropped: 0, coerced: 0 };
  if (!Array.isArray(value)) return { dropped: 1, coerced: 0 };
  let dropped = 0, coerced = 0;
  for (const item of value) {
    if (!isObject(item) || !readString(item.title)) dropped += 1;
    else if (!isWorkPlanStatus(item.status)) coerced += 1;
  }
  return { dropped, coerced };
}

function formatStatus(status: WorkPlanItemStatus): string {
  return status.replace(/_/g, ' ');
}

/**
 * Terminal = the user is done with it. Only these two statuses are eligible for
 * the age TTL and the count cap. `blocked` and `failed` still need attention and
 * `pending`/`in_progress` are live, so none of them are ever auto-reclaimed.
 */
function isTerminalStatus(status: WorkPlanItemStatus): boolean {
  return status === 'done' || status === 'cancelled';
}

/** The timestamp a terminal item is aged from. */
function terminalAgeStamp(item: WorkPlanItem): number {
  return item.completedAt ?? item.updatedAt ?? item.createdAt;
}

function normalizeHousekeeping(value: unknown): WorkPlanHousekeeping | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.at !== 'number') return undefined;
  const expiredItems = typeof value.expiredItems === 'number' ? value.expiredItems : 0;
  const cappedItems = typeof value.cappedItems === 'number' ? value.cappedItems : 0;
  const quarantinePath = readString(value.quarantinePath);
  const quarantinesRemoved = typeof value.quarantinesRemoved === 'number' ? value.quarantinesRemoved : undefined;
  return {
    at: value.at,
    expiredItems,
    cappedItems,
    ...(value.resetFromUnreadableFile === true ? { resetFromUnreadableFile: true } : {}),
    ...(quarantinePath ? { quarantinePath } : {}),
    ...(quarantinesRemoved !== undefined ? { quarantinesRemoved } : {}),
    ...(typeof value.preservedUnverifiedQuarantines === 'number' ? { preservedUnverifiedQuarantines: value.preservedUnverifiedQuarantines } : {}),
    ...(value.recoveryRequired === true ? { recoveryRequired: true } : {}),
    ...(typeof value.droppedItems === 'number' ? { droppedItems: value.droppedItems } : {}),
    ...(typeof value.coercedItems === 'number' ? { coercedItems: value.coercedItems } : {}),
  };
}

function normalizeRecoveries(value: unknown): WorkPlanRecovery[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): WorkPlanRecovery[] => {
    if (!isObject(entry) || typeof entry.at !== 'number') return [];
    const path = readString(entry.path);
    return path ? [{ at: entry.at, path }] : [];
  });
}

/** The preserved-copy list after a sweep: the new copy appended, then the copies' own age and count bounds. */
function boundRecoveries(previous: readonly WorkPlanRecovery[], added: WorkPlanRecovery | undefined, now: number): WorkPlanRecovery[] {
  return [...previous, ...(added ? [added] : [])]
    .filter((entry) => now - entry.at <= WORK_PLAN_QUARANTINE_TTL_MS)
    .slice(-WORK_PLAN_QUARANTINE_CAP);
}

/**
 * Parse a plan file's CONTENT. Returns null for anything that is not a JSON
 * object, empty/whitespace-only (a zero-byte file left by a crash), truncated
 * JSON, or a valid JSON scalar/array. Never throws.
 */
function parsePlanDocument(raw: string): Record<string, unknown> | null {
  if (raw.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  return isObject(parsed) ? parsed : null;
}

/** One-line, content-free disclosure of what the last sweep reclaimed. */
function formatHousekeeping(record: WorkPlanHousekeeping): string {
  const parts: string[] = [];
  if (record.recoveryRequired) parts.push('the saved plan file could not be read in full and is unchanged; the next change preserves a copy of it and continues');
  if (record.resetFromUnreadableFile) {
    parts.push(record.quarantinePath
      ? `the previous plan file could not be read and was preserved at ${record.quarantinePath}`
      : 'the previous plan file was empty or unreadable and was reset');
  }
  if (record.droppedItems || record.coercedItems) {
    const where = record.quarantinePath ? `the original file was preserved at ${record.quarantinePath}` : 'the file is unchanged until the next change preserves a copy';
    parts.push(`${record.droppedItems ?? 0} item(s) this version could not read were dropped and ${record.coercedItems ?? 0} item(s) with an unknown status were set to pending; ${where}`);
  }
  if (record.expiredItems > 0) parts.push(`${record.expiredItems} completed item(s) aged out`);
  if (record.cappedItems > 0) parts.push(`${record.cappedItems} completed item(s) over the retention cap removed`);
  if (record.quarantinesRemoved && record.quarantinesRemoved > 0) {
    parts.push(`${record.quarantinesRemoved} old quarantined plan file(s) deleted`);
  }
  if (parts.length === 0) parts.push('nothing reclaimed');
  return `Housekeeping (${new Date(record.at).toISOString()}): ${parts.join('; ')}.`;
}

export function nextWorkPlanStatus(status: WorkPlanItemStatus): WorkPlanItemStatus {
  switch (status) {
    case 'pending':
      return 'in_progress';
    case 'in_progress':
      return 'done';
    case 'done':
      return 'pending';
    case 'blocked':
    case 'failed':
    case 'cancelled':
      return 'pending';
  }
}

/** How long a writer waits for another process's edit of the same plan before refusing. */
const WORK_PLAN_LOCK_WAIT_MS = 2_000;

export class WorkPlanStore implements RevisionSource {
  readonly id = 'work plan';
  /** The plan file; fixed for the life of the store. */
  readonly filePath: string;
  readonly homeDirectory: string;
  private readonly options: WorkPlanStoreOptions;
  private readonly lockPath: string;
  /** Earlier-build files that could not be attributed to a project; left in place for the owner. */
  private readonly unassignedPlanPaths: readonly string[];

  /**
   * Unix ms of this instance's last quarantine-directory scan. Zero means the
   * first read of the session sweeps, that read IS the recovery point.
   */
  private lastQuarantineSweepAt = 0;
  private lastUnverifiedQuarantines = 0;

  private observedIdentity: string | undefined;
  private revisionCounter = 0;
  private lastSummary: string | null = null;

  constructor(options: WorkPlanStoreOptions) {
    this.options = Object.freeze({ ...options });
    this.homeDirectory = options.homeDirectory;
    const directory = join(options.homeDirectory, '.goodvibes', requireSurfaceRoot(options.surfaceRoot), 'work-plans');
    this.unassignedPlanPaths = importAssignedWorkPlans(directory);
    this.filePath = workPlanPath(directory, options);
    this.lockPath = `${this.filePath}.writer.sqlite`;
  }

  /** Moves up whenever the plan file changed, by this store or another process; one `lstat`. */
  revision(): number {
    const stat = lstatSync(this.filePath, { bigint: true, throwIfNoEntry: false });
    const identity = stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : 'absent';
    if (identity !== this.observedIdentity) {
      if (this.observedIdentity !== undefined) this.revisionCounter++;
      this.observedIdentity = identity;
    }
    return this.revisionCounter;
  }

  /** The plan as saved. Pure: takes no lock and touches nothing on disk. */
  getActivePlan(): WorkPlan {
    const loaded = this.loadFromDisk(undefined, true);
    const plan = this.unassignedPlanPaths.length ? { ...loaded.plan, unassignedPlanPaths: this.unassignedPlanPaths } : loaded.plan;
    return loaded.recovery ? { ...plan, housekeeping: loaded.recovery } : plan;
  }

  listItems(): readonly WorkPlanItem[] {
    return this.getActivePlan().items;
  }

  /**
   * One line on the plan as this store last wrote it (item count and counts by
   * status), taken from the plan the write already held, so a caller that just
   * changed one item can say where the plan stands without reading it again.
   * Null before this store's first write.
   */
  lastWriteSummary(): string | null {
    return this.lastSummary;
  }

  addItem(title: string, options: AddWorkPlanItemOptions = {}, effects?: WorkPlanEffectOptions): WorkPlanItem {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) throw new Error('Work plan item title is required.');
    return this.locked(() => {
      const plan = this.readForChange(effects);
      const time = nowMs();
      const item: WorkPlanItem = {
        id: createItemId(),
        title: normalizedTitle,
        status: options.status ?? 'pending',
        ...(options.owner ? { owner: options.owner } : {}),
        ...(options.source ? { source: options.source } : {}),
        ...(options.notes ? { notes: options.notes } : {}),
        ...(options.linked ? { linked: options.linked } : {}),
        createdAt: time,
        updatedAt: time,
        ...(options.status === 'done' ? { completedAt: time } : {}),
      };
      this.writePlan({
        ...plan,
        items: [...plan.items, item],
        activeItemId: item.id,
        updatedAt: time,
      }, effects);
      return item;
    }, effects);
  }

  updateItem(idOrPrefix: string, patch: UpdateWorkPlanItemPatch, effects?: WorkPlanEffectOptions): WorkPlanItem {
    return this.locked(() => this.updateLocked(this.readForChange(effects), idOrPrefix, patch, effects), effects);
  }

  setItemStatus(idOrPrefix: string, status: WorkPlanItemStatus, effects?: WorkPlanEffectOptions): WorkPlanItem {
    return this.updateItem(idOrPrefix, { status }, effects);
  }

  cycleItemStatus(idOrPrefix: string): WorkPlanItem {
    return this.locked(() => {
      const plan = this.readForChange();
      const item = this.resolveItem(plan, idOrPrefix);
      return this.updateLocked(plan, item.id, { status: nextWorkPlanStatus(item.status) });
    });
  }

  removeItem(idOrPrefix: string, effects?: WorkPlanEffectOptions): WorkPlanItem {
    return this.locked(() => {
      const plan = this.readForChange(effects);
      const item = this.resolveItem(plan, idOrPrefix);
      const remaining = plan.items.filter((candidate) => candidate.id !== item.id);
      this.writePlan({
        ...plan,
        items: remaining,
        activeItemId: remaining[0]?.id,
        updatedAt: nowMs(),
      }, effects);
      return item;
    }, effects);
  }

  clearCompleted(effects?: WorkPlanEffectOptions): number {
    return this.locked(() => {
      const { plan, swept } = this.readSwept(effects);
      const remaining = plan.items.filter((item) => item.status !== 'done' && item.status !== 'cancelled');
      const removed = plan.items.length - remaining.length;
      if (removed === 0) {
        // Nothing of the user's to clear; what the sweep reclaimed is still saved.
        if (swept) this.writePlan(plan, effects);
        return 0;
      }
      this.writePlan({
        ...plan,
        items: remaining,
        activeItemId: remaining[0]?.id,
        updatedAt: nowMs(),
      }, effects);
      return removed;
    }, effects);
  }

  /**
   * Writes the current plan's `toMarkdown()` output to a sibling `.md` file
   * next to the JSON store file, so the checklist can be opened outside the
   * product that wrote it. Returns the written path alongside the markdown that
   * was written.
   */
  exportMarkdown(): { readonly path: string; readonly markdown: string } {
    const markdown = this.toMarkdown(this.getActivePlan());
    const path = this.filePath.replace(/\.json$/, '.md');
    atomicWriteFileSync(path, `${markdown}\n`, { mkdirp: true });
    return { path, markdown };
  }

  toMarkdown(plan: WorkPlan = this.getActivePlan()): string {
    const lines = [
      `# ${plan.title}`,
      '',
      `Project: ${plan.projectRoot}`,
      `Project ID: ${plan.projectId}`,
      `Updated: ${new Date(plan.updatedAt).toISOString()}`,
    ];
    // Disclosure: whatever the last sweep reclaimed is stated here, so a
    // removal can never be mistaken for silent data loss.
    if (plan.housekeeping) { lines.push(formatHousekeeping(plan.housekeeping)); if (plan.housekeeping.preservedUnverifiedQuarantines) lines.push(`${plan.housekeeping.preservedUnverifiedQuarantines} unverified historical recovery path(s) were preserved beside ${this.filePath}; inspect them before manual cleanup.`); }
    for (const recovery of plan.recoveries ?? []) {
      if (recovery.path !== plan.housekeeping?.quarantinePath) lines.push(`An earlier plan file was preserved at ${recovery.path} (${new Date(recovery.at).toISOString()}).`);
    }
    if (plan.unassignedPlanPaths?.length) {
      lines.push('Preserved work-plan files could not be assigned to a project. Inspect these before recovering their items:');
      for (const path of plan.unassignedPlanPaths) lines.push(`- ${path}`);
    }
    lines.push('');
    if (plan.items.length === 0) {
      lines.push('No work plan items recorded.');
      return lines.join('\n');
    }
    for (const item of plan.items) {
      const marker = item.status === 'done' ? 'x' : ' ';
      const suffix = item.status === 'pending' ? '' : ` (${formatStatus(item.status)})`;
      lines.push(`- [${marker}] ${item.title}${suffix}`);
      if (item.owner) lines.push(`  - Owner: ${item.owner}`);
      if (item.source) lines.push(`  - Source: ${item.source}`);
      if (item.notes) lines.push(`  - Notes: ${item.notes}`);
    }
    return lines.join('\n');
  }

  private locked<T>(fn: () => T, effects?: WorkPlanEffectOptions): T {
    // The first lock of a project creates the directory and the lock file: a
    // filesystem effect of this store that a restricting caller must see.
    if (!lstatSync(this.lockPath, { throwIfNoEntry: false })) {
      effects?.assertCurrent?.();
      mkdirSync(dirname(this.lockPath), { recursive: true, mode: 0o700 });
      try { closeSync(openSync(this.lockPath, 'wx', 0o600)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      effects?.onEffect?.(false);
    }
    try {
      return withProcessLockSync(this.lockPath, fn, { waitMs: WORK_PLAN_LOCK_WAIT_MS });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'PROCESS_LOCK_BUSY') {
        throw new Error(`The work plan is being changed by another GoodVibes process (${this.filePath}); try again in a moment.`);
      }
      throw error;
    }
  }

  private updateLocked(plan: WorkPlan, idOrPrefix: string, patch: UpdateWorkPlanItemPatch, effects?: WorkPlanEffectOptions): WorkPlanItem {
    const item = this.resolveItem(plan, idOrPrefix);
    const time = nowMs();
    const nextStatus = patch.status ?? item.status;
    const next: WorkPlanItem = this.pruneItem({
      ...item,
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      status: nextStatus,
      ...(patch.owner !== undefined ? { owner: patch.owner || undefined } : {}),
      ...(patch.source !== undefined ? { source: patch.source || undefined } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes || undefined } : {}),
      ...(patch.linked !== undefined ? { linked: patch.linked || undefined } : {}),
      updatedAt: time,
      ...(nextStatus === 'done' ? { completedAt: item.completedAt ?? time } : { completedAt: undefined }),
    });
    if (!next.title) throw new Error('Work plan item title is required.');
    this.writePlan({
      ...plan,
      items: plan.items.map((candidate) => candidate.id === item.id ? next : candidate),
      activeItemId: next.id,
      updatedAt: time,
    }, effects);
    return next;
  }

  /**
   * The plan a change starts from, under the plan lock: loaded from disk
   * (content-validated; an unreadable file is preserved aside), then put
   * through the recovery/bounding sweep. Writes nothing itself: the change
   * writes once, carrying whatever the sweep reclaimed and its disclosure.
   */
  private readSwept(effects?: WorkPlanEffectOptions): { plan: WorkPlan; swept: boolean } {
    effects?.assertCurrent?.();
    const loaded = this.loadFromDisk(effects, false);
    const result = this.sweep(loaded.plan, loaded.recovery, effects);
    return { plan: result.plan, swept: result.changed };
  }

  private readForChange(effects?: WorkPlanEffectOptions): WorkPlan {
    return this.readSwept(effects).plan;
  }

  /**
   * Read and validate the plan file's CONTENT. A missing file is the ordinary
   * empty case. A file that exists but does not parse into a plan object is
   * moved aside (never overwritten in place) and reported as a recovery.
   */
  private loadFromDisk(effects?: WorkPlanEffectOptions, readOnly = false): { plan: WorkPlan; recovery: WorkPlanHousekeeping | null } {
    let bytes: Buffer;
    try { bytes = readFileSync(this.filePath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { plan: this.createEmptyPlan(false), recovery: null };
    }
    let raw: string, invalidEncoding = false;
    try { raw = new TextDecoder('utf8', { fatal: true }).decode(bytes); } catch { raw = ''; invalidEncoding = true; }
    const parsed = invalidEncoding ? null : parsePlanDocument(raw);
    if (parsed && (('projectId' in parsed && parsed.projectId !== this.options.projectId)
      || ('projectRoot' in parsed && parsed.projectRoot !== this.options.projectRoot))) {
      throw new Error(`Saved work plan at ${this.filePath} belongs to a different project; its contents were left untouched.`);
    }
    if (parsed === null) {
      // The file EXISTED but its contents are not a usable plan: zero-byte,
      // truncated mid-write, or otherwise torn. Existence is not validity.
      const recovery = !readOnly && (invalidEncoding || raw.trim().length > 0) ? this.quarantineUnreadableFile(effects) : undefined;
      return {
        plan: this.createEmptyPlan(true),
        recovery: {
          at: nowMs(),
          expiredItems: 0,
          cappedItems: 0,
          ...(readOnly ? { recoveryRequired: true } : { resetFromUnreadableFile: true }),
          ...(recovery ? { quarantinePath: recovery.path, quarantinesRemoved: recovery.reaped, preservedUnverifiedQuarantines: recovery.unknown } : {}),
        },
      };
    }
    const lossy = countLossyItems(parsed.items);
    // A file this version reads only partly (an unknown status, an item shape
    // it does not know) is not rewritten in place: the original is preserved
    // first, as for an unreadable file, so a newer build's items are not lost.
    const lossyRecovery: WorkPlanHousekeeping | null = lossy.dropped + lossy.coerced === 0 ? null : (() => {
      const kept = readOnly ? undefined : this.quarantineUnreadableFile(effects, {
        reason: 'saved work plan has items this version cannot read in full',
        recovery: 'The plan continues with the items this version understands; the original bytes remain at the reported recovery path.',
      });
      return { at: nowMs(), expiredItems: 0, cappedItems: 0, droppedItems: lossy.dropped, coercedItems: lossy.coerced,
        ...(readOnly ? { recoveryRequired: true } : {}),
        ...(kept ? { quarantinePath: kept.path, quarantinesRemoved: kept.reaped, preservedUnverifiedQuarantines: kept.unknown } : {}) };
    })();
    const time = nowMs();
    const createdAt = typeof parsed.createdAt === 'number' ? parsed.createdAt : time;
    const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : createdAt;
    const items = Array.isArray(parsed.items)
      ? parsed.items.map((item) => normalizeItem(item, createdAt)).filter((item): item is WorkPlanItem => item !== null)
      : [];
    const activeItemId = readString(parsed.activeItemId);
    const source = readString(parsed.source);
    const housekeeping = normalizeHousekeeping(parsed.housekeeping);
    const recoveries = normalizeRecoveries(parsed.recoveries);
    return {
      plan: {
        id: readString(parsed.id) ?? '',
        projectId: readString(parsed.projectId) ?? this.options.projectId,
        projectRoot: readString(parsed.projectRoot) ?? this.options.projectRoot,
        title: readString(parsed.title) ?? 'Work Plan',
        items,
        ...(activeItemId && items.some((item) => item.id === activeItemId) ? { activeItemId } : {}),
        ...(source ? { source } : {}),
        createdAt,
        updatedAt,
        ...(housekeeping ? { housekeeping } : {}),
        ...(recoveries.length ? { recoveries } : {}),
      },
      recovery: lossyRecovery,
    };
  }

  /**
   * Apply both bounds (age TTL, then count cap) over TERMINAL items only, plus
   * the throttled quarantine-file sweep. Pure with respect to disk except for
   * quarantine deletions; the caller persists the result when `changed`.
   *
   * Idempotent: re-running it on the returned plan reclaims nothing further.
   */
  private sweep(
    plan: WorkPlan,
    recovery: WorkPlanHousekeeping | null,
    effects?: WorkPlanEffectOptions,
  ): { plan: WorkPlan; changed: boolean } {
    const now = nowMs();
    const expired = new Set<WorkPlanItem>();
    for (const item of plan.items) {
      if (!isTerminalStatus(item.status)) continue;
      if (now - terminalAgeStamp(item) > WORK_PLAN_TERMINAL_ITEM_TTL_MS) expired.add(item);
    }
    const survivors = plan.items.filter((item) => !expired.has(item));
    // Count cap applies to terminal survivors only, newest completions kept.
    const terminalSurvivors = survivors
      .filter((item) => isTerminalStatus(item.status))
      .sort((a, b) => terminalAgeStamp(b) - terminalAgeStamp(a));
    const capped = new Set<WorkPlanItem>(terminalSurvivors.slice(WORK_PLAN_TERMINAL_ITEM_CAP));
    const kept = survivors.filter((item) => !capped.has(item));
    const sweep = this.sweepQuarantines(now, effects);
    const quarantinesRemoved = sweep.removed + (recovery?.quarantinesRemoved ?? 0);
    const unknownChanged = sweep.unknown !== (plan.housekeeping?.preservedUnverifiedQuarantines ?? 0);

    const recoveries = boundRecoveries(plan.recoveries ?? [], recovery?.quarantinePath ? { at: now, path: recovery.quarantinePath } : undefined, now);
    const recoveriesChanged = recoveries.length !== (plan.recoveries?.length ?? 0);
    const changed = expired.size > 0 || capped.size > 0 || recovery !== null || quarantinesRemoved > 0 || unknownChanged || recoveriesChanged;
    if (!changed) return { plan, changed: false };

    const housekeeping: WorkPlanHousekeeping = {
      at: now,
      expiredItems: expired.size,
      cappedItems: capped.size,
      ...(recovery?.resetFromUnreadableFile ? { resetFromUnreadableFile: true } : {}),
      ...(recovery?.quarantinePath ? { quarantinePath: recovery.quarantinePath } : {}),
      ...(recovery?.droppedItems ? { droppedItems: recovery.droppedItems } : {}),
      ...(recovery?.coercedItems ? { coercedItems: recovery.coercedItems } : {}),
      ...(quarantinesRemoved > 0 ? { quarantinesRemoved } : {}),
      ...(sweep.unknown > 0 ? { preservedUnverifiedQuarantines: sweep.unknown } : {}),
    };
    const activeItemId = plan.activeItemId && kept.some((item) => item.id === plan.activeItemId)
      ? plan.activeItemId
      : undefined;
    return {
      plan: {
        id: plan.id,
        ...(plan.registration ? { registration: plan.registration } : {}),
        projectId: plan.projectId,
        projectRoot: plan.projectRoot,
        title: plan.title,
        items: kept,
        ...(activeItemId ? { activeItemId } : {}),
        ...(plan.source ? { source: plan.source } : {}),
        createdAt: plan.createdAt,
        // `updatedAt` tracks the user's edits; a garbage-collection pass is not
        // one, so it is deliberately left alone. housekeeping.at dates the sweep.
        updatedAt: plan.updatedAt,
        housekeeping,
        ...(recoveries.length ? { recoveries } : {}),
      },
      changed: true,
    };
  }

  /**
   * Move an unparseable or partly readable plan file aside so the user can
   * still recover it. A failed preservation propagates before any reset.
   */
  private quarantineUnreadableFile(effects?: WorkPlanEffectOptions, why?: { reason: string; recovery: string }): { path: string; reaped: number; unknown: number } {
    const outcome = quarantineCorruptFile(this.filePath, { label: 'workflow/work-plan', reason: why?.reason ?? 'saved work plan is not a usable JSON document',
      recovery: why?.recovery ?? 'The local plan is rebuilt empty; the original bytes remain at the reported recovery path.',
      maxFiles: WORK_PLAN_QUARANTINE_CAP, maximumAgeMs: WORK_PLAN_QUARANTINE_TTL_MS,
      assertCurrent: effects?.assertCurrent, onEffect: effects?.onEffect,
    });
    this.lastQuarantineSweepAt = nowMs(); this.lastUnverifiedQuarantines = outcome.preservedUnknown;
    return { path: outcome.quarantinePath, reaped: outcome.reaped, unknown: outcome.preservedUnknown };
  }

  /** Only persisted native receipt/payload pairs participate in these bounds.
   * Unverified historical copies and orphan receipts remain disclosed/intact. */
  private sweepQuarantines(now: number, effects?: WorkPlanEffectOptions): { removed: number; unknown: number } {
    if (now - this.lastQuarantineSweepAt < WORK_PLAN_QUARANTINE_SWEEP_INTERVAL_MS) return { removed: 0, unknown: this.lastUnverifiedQuarantines };
    const result = reapOwnedQuarantines(this.filePath, { now, maxFiles: WORK_PLAN_QUARANTINE_CAP, maximumAgeMs: WORK_PLAN_QUARANTINE_TTL_MS,
      assertCurrent: effects?.assertCurrent, onEffect: effects?.onEffect,
    });
    this.lastQuarantineSweepAt = now; this.lastUnverifiedQuarantines = result.preservedUnknown;
    return { removed: result.reaped, unknown: result.preservedUnknown };
  }

  /** `saved` is false for a project whose plan has never been written: no ID yet. */
  private createEmptyPlan(saved: boolean): WorkPlan {
    const time = nowMs();
    return {
      id: '',
      registration: saved ? 'registered' : 'unregistered',
      projectId: this.options.projectId,
      projectRoot: this.options.projectRoot,
      title: 'Work Plan',
      items: [],
      ...(this.options.source ? { source: this.options.source } : {}),
      createdAt: time,
      updatedAt: time,
    };
  }

  private writePlan(plan: WorkPlan, effects?: WorkPlanEffectOptions): WorkPlan {
    const { registration: _registration, unassignedPlanPaths: _unassigned, ...stored } = plan;
    const saved: WorkPlan = stored.id ? stored : { ...stored, id: `wp-${randomUUID()}` };
    effects?.assertCurrent?.();
    writeDocument(this.filePath, saved);
    effects?.onEffect?.(true);
    this.lastSummary = summarizeWorkPlanItems(saved.items);
    return saved;
  }

  private resolveItem(plan: WorkPlan, idOrPrefix: string): WorkPlanItem {
    const needle = idOrPrefix.trim();
    if (!needle) throw new Error('Work plan item id is required.');
    const exact = plan.items.find((item) => item.id === needle);
    if (exact) return exact;
    const matches = plan.items.filter((item) => item.id.startsWith(needle));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(`Work plan item id "${needle}" is ambiguous: ${matches.map((item) => item.id).join(', ')}`);
    }
    throw new Error(`Work plan item not found: ${needle}`);
  }

  private pruneItem(item: WorkPlanItem & {
    owner?: string | undefined;
    source?: string | undefined;
    notes?: string | undefined;
    linked?: WorkPlanLinkTargets | undefined;
    completedAt?: number | undefined;
  }): WorkPlanItem {
    return {
      id: item.id,
      title: item.title,
      status: item.status,
      ...(item.owner ? { owner: item.owner } : {}),
      ...(item.source ? { source: item.source } : {}),
      ...(item.notes ? { notes: item.notes } : {}),
      ...(item.linked ? { linked: item.linked } : {}),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      ...(item.completedAt !== undefined ? { completedAt: item.completedAt } : {}),
    };
  }
}

/** "12 items: 3 pending, 1 in progress, 8 done", statuses with no items left out. */
export function summarizeWorkPlanItems(items: readonly WorkPlanItem[]): string {
  const counts = new Map<WorkPlanItemStatus, number>();
  for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  const parts = WORK_PLAN_STATUSES.filter((status) => counts.has(status)).map((status) => `${counts.get(status)} ${status.replace(/_/g, ' ')}`);
  return `${items.length} item${items.length === 1 ? '' : 's'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

export interface WorkPlanItemsObservation {
  readonly items: readonly WorkPlanItem[];
  assertCurrent(): void;
}

/** One read of a store's items for a caller-owned operation. The returned
 * check costs one `lstat` and throws a `StaleError` naming the work plan when
 * the plan file changed since the read. */
export function captureWorkPlanItems(store: WorkPlanStore): WorkPlanItemsObservation {
  const token = captureRevisions([store]);
  const items = store.getActivePlan().items;
  return { items, assertCurrent: () => assertCurrent(token) };
}
