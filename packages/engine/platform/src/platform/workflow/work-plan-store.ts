// ---------------------------------------------------------------------------
// work-plan-store.ts, per-project work plan persisted at
//   <home>/.goodvibes/<surfaceRoot>/work-plans/
//
// The surface root is supplied by the product that owns the plan, so two
// products sharing a home directory keep separate plans and neither has to
// spell the segment at a call site.
//
// Recovery discipline (applies to every read):
//
//  * CONTENT, NOT EXISTENCE, decides whether the file is usable. A plan file
//    can exist and still be unusable, zero-byte, truncated mid-write, or
//    otherwise torn by a crash. Every read parses defensively and validates the
//    parsed SHAPE; an unusable file degrades to an empty plan instead of
//    throwing out of the store's public methods (which used to brick every
//    /work-plan operation until the user deleted the file by hand).
//  * AN UNREADABLE FILE IS PRESERVED, NOT OVERWRITTEN. It is renamed aside to
//    `<plan>.json.corrupt-<ms>-<rand>` so a user can still recover their list.
//    Those quarantine copies are themselves bounded (age TTL + count cap) so
//    the recovery path cannot become its own leak.
//  * THE STORE IS BOUNDED. Terminal (done/cancelled) items age out and are
//    capped by count. Items the user still has open, pending, in_progress,
//    blocked, failed, are NEVER reclaimed by either bound: garbage collection
//    must not delete live work.
//  * NOTHING IS DELETED SILENTLY. Whatever a sweep reclaimed is recorded on the
//    plan as `housekeeping` and rendered by `toMarkdown()` (which /work-plan
//    show prints), so a reclaim is distinguishable from data loss.
//
// Sweeps are idempotent and safe to run from more than one process: removal is
// computed from the file's own contents, writes go through atomicWriteFileSync
// (rename(2)), and unlink races are treated as already-done.
// ---------------------------------------------------------------------------

import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { types as nodeTypes } from 'node:util';
import { ToolInputProjectionError } from '../tools/input-projection.js';
import { atomicWriteFileSync, type AtomicWriteOptions } from '../config/atomic-write.js';
import { requireSurfaceRoot } from '../runtime/surface-root.js';
import { captureExistingDirectory, captureQuarantineSource, readCapturedQuarantineSource, quarantineCorruptFile, reapOwnedQuarantines, type QuarantineSource, QuarantineEncodingError } from '../utils/atomic-json-store.js';
import { fileObservationIdentity } from '../utils/file-observation.js';
import { resolveWorkPlanLocation } from './work-plan-location.js';

const nativeWorkPlanStores = new WeakSet<object>();
const nativeApply = Reflect.apply, nativeStoreAdd = WeakSet.prototype.add, nativeStoreHas = WeakSet.prototype.has;
const ownDescriptor = Object.getOwnPropertyDescriptor, prototypeOf = Object.getPrototypeOf, ownKeys = Reflect.ownKeys;

export type WorkPlanEffectOptions = Pick<AtomicWriteOptions, 'assertCurrent' | 'onEffect'>;
function retainEffects(effects: WorkPlanEffectOptions | undefined): WorkPlanEffectOptions | undefined {
  if (!effects) return undefined;
  const current = effects.assertCurrent?.bind(effects), effect = effects.onEffect?.bind(effects);
  const check = (value: unknown) => { if (value !== undefined) { drainOwned(value); throw new TypeError('Work plan effect callbacks must be synchronous and return no value.'); } };
  return Object.freeze({ assertCurrent: () => check(current?.()), onEffect: (published?: boolean) => check(effect?.(published)) });
}

export interface WorkPlanReadOptions { readonly readOnly?: boolean; }

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
  /** Readonly inspection found damage; no reset or quarantine was performed. */
  readonly recoveryRequired?: boolean | undefined;
}

export interface WorkPlan {
  /** A readonly uninitialized projection has no saved plan ID. */
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
  };
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
  if (record.recoveryRequired) parts.push('the saved plan requires recovery; readonly inspection left it unchanged');
  if (record.resetFromUnreadableFile) {
    parts.push(record.quarantinePath
      ? `the previous plan file could not be read and was preserved at ${record.quarantinePath}`
      : 'the previous plan file was empty or unreadable and was reset');
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

export class WorkPlanStore {
  /** Before the first mutation this is a readonly candidate, not an owned
   * assignment; concurrent publication may select another slot. */
  get filePath(): string { return this.selectedPath; }
  private selectedPath: string;
  private registered: boolean;
  private locationCurrent: () => void;
  private locationParentsCurrent: () => void;
  private planReadCurrent: () => void = () => {};

  /**
   * Unix ms of this instance's last quarantine-directory scan. Zero means the
   * first read of the session sweeps, that read IS the recovery point.
   */
  private lastQuarantineSweepAt = 0;
  private lastUnverifiedQuarantines = 0;

  readonly homeDirectory: string;
  private readonly options: WorkPlanStoreOptions;
  private newPlanId: string | null;
  private unassignedPlanPaths: readonly string[];

  constructor(options: WorkPlanStoreOptions) {
    this.options = Object.freeze({ ...options });
    this.homeDirectory = options.homeDirectory;
    const directory = join(options.homeDirectory, '.goodvibes', requireSurfaceRoot(options.surfaceRoot), 'work-plans');
    const assigned = resolveWorkPlanLocation(directory, this.options, { readOnly: true });
    this.selectedPath = assigned.path; this.registered = assigned.registered; this.locationCurrent = assigned.assertCurrent; this.locationParentsCurrent = assigned.assertParentsCurrent;
    this.newPlanId = assigned.planId;
    this.unassignedPlanPaths = Object.freeze([...assigned.unassignedPaths]);
    nativeApply(nativeStoreAdd, nativeWorkPlanStores, [this]);
  }

  getActivePlan(options: WorkPlanReadOptions = {}): WorkPlan {
    return this.readPlan(undefined, options.readOnly);
  }

  listItems(options: WorkPlanReadOptions = {}): readonly WorkPlanItem[] {
    return this.getActivePlan(options).items;
  }

  addItem(title: string, options: AddWorkPlanItemOptions = {}, effects?: WorkPlanEffectOptions): WorkPlanItem {
    effects = retainEffects(effects);
    const normalizedTitle = title.trim();
    if (!normalizedTitle) throw new Error('Work plan item title is required.');
    const plan = this.readPlan(effects);
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
  }

  updateItem(idOrPrefix: string, patch: UpdateWorkPlanItemPatch, effects?: WorkPlanEffectOptions): WorkPlanItem {
    effects = retainEffects(effects);
    const plan = this.readPlan(effects);
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

  setItemStatus(idOrPrefix: string, status: WorkPlanItemStatus, effects?: WorkPlanEffectOptions): WorkPlanItem {
    return this.updateItem(idOrPrefix, { status }, effects);
  }

  cycleItemStatus(idOrPrefix: string): WorkPlanItem {
    const item = this.resolveItem(this.readPlan(), idOrPrefix);
    return this.setItemStatus(item.id, nextWorkPlanStatus(item.status));
  }

  removeItem(idOrPrefix: string, effects?: WorkPlanEffectOptions): WorkPlanItem {
    effects = retainEffects(effects);
    const plan = this.readPlan(effects);
    const item = this.resolveItem(plan, idOrPrefix);
    const time = nowMs();
    const remaining = plan.items.filter((candidate) => candidate.id !== item.id);
    this.writePlan({
      ...plan,
      items: remaining,
      activeItemId: remaining[0]?.id,
      updatedAt: time,
    }, effects);
    return item;
  }

  clearCompleted(effects?: WorkPlanEffectOptions): number {
    effects = retainEffects(effects);
    const plan = this.readPlan(effects);
    const remaining = plan.items.filter((item) => item.status !== 'done' && item.status !== 'cancelled');
    const removed = plan.items.length - remaining.length;
    if (removed === 0) return 0;
    this.writePlan({
      ...plan,
      items: remaining,
      activeItemId: remaining[0]?.id,
      updatedAt: nowMs(),
    }, effects);
    return removed;
  }

  /**
   * Writes the current plan's `toMarkdown()` output to a sibling `.md` file
   * next to the JSON store file, so the checklist can be opened outside the
   * product that wrote it. Returns the written path alongside the markdown that
   * was written.
   */
  exportMarkdown(): { readonly path: string; readonly markdown: string } {
    const plan = this.readPlan();
    const markdown = this.toMarkdown(plan);
    const path = this.filePath.replace(/\.json$/, '.md');
    atomicWriteFileSync(path, `${markdown}\n`, { mkdirp: true });
    return { path, markdown };
  }

  toMarkdown(plan: WorkPlan = this.readPlan()): string {
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

  /**
   * The plan as callers see it: loaded from disk (content-validated), then put
   * through the recovery/bounding sweep. When the sweep reclaimed anything the
   * bounded plan, carrying its housekeeping disclosure, is written back
   * immediately, so the disclosure survives even if the caller only reads.
   */
  private readPlan(effects?: WorkPlanEffectOptions, readOnly = false): WorkPlan {
    effects?.assertCurrent?.(); this.locationParentsCurrent(); if (this.registered) this.locationCurrent();
    const directory = join(this.options.homeDirectory, '.goodvibes', requireSurfaceRoot(this.options.surfaceRoot), 'work-plans');
    // The retained location owns native source facts, not the invocation that
    // happened to select it. Keep that invocation restriction through adoption,
    // then retire only this wrapper. The operation's read/write effects still
    // check their original restriction separately at every actual effect.
    let selectionEffects = effects;
    let selected: ReturnType<typeof resolveWorkPlanLocation>;
    try {
      selected = resolveWorkPlanLocation(directory, this.options, { readOnly, assertCurrent: () => { selectionEffects?.assertCurrent?.(); }, onEffect: flag => { selectionEffects?.onEffect?.(flag); } });
      effects?.assertCurrent?.(); selected.assertCurrent();
      this.selectedPath = selected.path; this.newPlanId = selected.planId; this.registered = selected.registered; this.locationCurrent = selected.assertCurrent; this.locationParentsCurrent = selected.assertParentsCurrent; this.locationCurrent();
    } finally { selectionEffects = undefined; }
    this.unassignedPlanPaths = Object.freeze([...selected.unassignedPaths]);
    const loaded = this.loadFromDisk(effects, readOnly);
    const unassigned = this.unassignedPlanPaths.filter(path => existsSync(path));
    const plan = unassigned.length ? { ...loaded.plan, unassignedPlanPaths: unassigned } : loaded.plan;
    if (readOnly) return loaded.recovery?.recoveryRequired ? { ...plan, housekeeping: loaded.recovery } : plan;
    const swept = this.sweep(plan, loaded.recovery, effects);
    if (swept.changed) this.writePlan(swept.plan, effects);
    return swept.plan;
  }

  /**
   * Read and validate the plan file's CONTENT. A missing file is the ordinary
   * empty case. A file that exists but does not parse into a plan object is
   * moved aside (never overwritten in place) and reported as a recovery.
   */
  private loadFromDisk(effects?: WorkPlanEffectOptions, readOnly = false): { plan: WorkPlan; recovery: WorkPlanHousekeeping | null } {
    const heldSource = captureQuarantineSource(this.filePath);
    if (!heldSource) {
      this.planReadCurrent = () => { this.locationCurrent(); if (lstatSync(this.filePath, { throwIfNoEntry: false })) throw new Error('An unowned work plan appeared before publication.'); };
      this.planReadCurrent(); return { plan: this.createEmptyPlan(), recovery: null };
    }
    this.planReadCurrent = () => { this.locationCurrent(); heldSource.assertCurrent(); };
    try {
    let raw: string, invalidEncoding = false;
    try { raw = readCapturedQuarantineSource(this.filePath, heldSource); } catch (error) { if (!(error instanceof QuarantineEncodingError)) throw error; raw = ''; invalidEncoding = true; } this.planReadCurrent();
    const parsed = invalidEncoding ? null : parsePlanDocument(raw);
    if (parsed && (('projectId' in parsed && parsed.projectId !== this.options.projectId)
      || ('projectRoot' in parsed && parsed.projectRoot !== this.options.projectRoot))) {
      throw new Error('Saved work plan belongs to a different project; its contents were left untouched.');
    }
    if (parsed === null) {
      // The file EXISTED but its contents are not a usable plan: zero-byte,
      // truncated mid-write, or otherwise torn. Existence is not validity.
      const recovery = !readOnly && (invalidEncoding || raw.trim().length > 0) ? this.quarantineUnreadableFile(heldSource, effects) : undefined;
      return {
        plan: this.createEmptyPlan(),
        recovery: {
          at: nowMs(),
          expiredItems: 0,
          cappedItems: 0,
          ...(readOnly ? { recoveryRequired: true } : { resetFromUnreadableFile: true }),
          ...(recovery ? { quarantinePath: recovery.path, quarantinesRemoved: recovery.reaped, preservedUnverifiedQuarantines: recovery.unknown } : {}),
        },
      };
    }
    const time = nowMs();
    const createdAt = typeof parsed.createdAt === 'number' ? parsed.createdAt : time;
    const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : createdAt;
    const items = Array.isArray(parsed.items)
      ? parsed.items.map((item) => normalizeItem(item, createdAt)).filter((item): item is WorkPlanItem => item !== null)
      : [];
    const activeItemId = readString(parsed.activeItemId);
    const source = readString(parsed.source);
    const housekeeping = normalizeHousekeeping(parsed.housekeeping);
    return {
      plan: {
        id: readString(parsed.id) ?? this.newPlanId ?? '',
        projectId: readString(parsed.projectId) ?? this.options.projectId,
        projectRoot: readString(parsed.projectRoot) ?? this.options.projectRoot,
        title: readString(parsed.title) ?? 'Work Plan',
        items,
        ...(activeItemId && items.some((item) => item.id === activeItemId) ? { activeItemId } : {}),
        ...(source ? { source } : {}),
        createdAt,
        updatedAt,
        ...(housekeeping ? { housekeeping } : {}),
      },
      recovery: null,
    };
    } finally { heldSource.close(); }
  }

  /**
   * Apply both bounds (age TTL, then count cap) over TERMINAL items only, plus
   * the throttled quarantine-file sweep. Pure with respect to disk except for
   * quarantine deletions; the caller persists the result when `changed`.
   *
   * Idempotent: re-running it on the returned plan reclaims nothing further,
   * which is what makes it safe to run concurrently from several processes.
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

    const changed = expired.size > 0 || capped.size > 0 || recovery !== null || quarantinesRemoved > 0 || unknownChanged;
    if (!changed) return { plan, changed: false };

    const housekeeping: WorkPlanHousekeeping = {
      at: now,
      expiredItems: expired.size,
      cappedItems: capped.size,
      ...(recovery?.resetFromUnreadableFile ? { resetFromUnreadableFile: true } : {}),
      ...(recovery?.quarantinePath ? { quarantinePath: recovery.quarantinePath } : {}),
      ...(quarantinesRemoved > 0 ? { quarantinesRemoved } : {}),
      ...(sweep.unknown > 0 ? { preservedUnverifiedQuarantines: sweep.unknown } : {}),
    };
    const activeItemId = plan.activeItemId && kept.some((item) => item.id === plan.activeItemId)
      ? plan.activeItemId
      : undefined;
    return {
      plan: {
        id: plan.id,
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
        ...(plan.unassignedPlanPaths ? { unassignedPlanPaths: plan.unassignedPlanPaths } : {}),
      },
      changed: true,
    };
  }

  /**
   * Move an unparseable plan file aside so the user can still recover it.
   * The shared original-source reader publishes an exclusive archive and an
   * owned receipt; a failed preservation propagates before any reset.
   */
  private quarantineUnreadableFile(source: QuarantineSource, effects?: WorkPlanEffectOptions): { path: string; reaped: number; unknown: number } {
    let published = false;
    const current = () => { effects?.assertCurrent?.(); this.locationCurrent(); if (!published) source.assertCurrent(); };
    const outcome = quarantineCorruptFile(this.filePath, { source, label: 'workflow/work-plan', reason: 'saved work plan is not a usable JSON document',
      recovery: 'The local plan is rebuilt empty; the original bytes remain at the reported recovery path.',
      maxFiles: WORK_PLAN_QUARANTINE_CAP, maximumAgeMs: WORK_PLAN_QUARANTINE_TTL_MS,
      assertCurrent: current, onEffect: flag => { if (flag) published = true; effects?.onEffect?.(flag); },
    });
    this.lastQuarantineSweepAt = nowMs(); this.lastUnverifiedQuarantines = outcome.preservedUnknown;
    const parent = captureExistingDirectory(dirname(this.filePath));
    this.planReadCurrent = () => { this.locationCurrent(); parent.assertCurrent(); if (lstatSync(this.filePath, { throwIfNoEntry: false })) throw new Error('An unowned work plan appeared before publication.'); };
    this.planReadCurrent(); return { path: outcome.quarantinePath, reaped: outcome.reaped, unknown: outcome.preservedUnknown };
  }

  /** Only persisted native receipt/payload pairs participate in these bounds.
   * Unverified historical copies and orphan receipts remain disclosed/intact. */
  private sweepQuarantines(now: number, effects?: WorkPlanEffectOptions): { removed: number; unknown: number } {
    if (now - this.lastQuarantineSweepAt < WORK_PLAN_QUARANTINE_SWEEP_INTERVAL_MS) return { removed: 0, unknown: this.lastUnverifiedQuarantines };
    const result = reapOwnedQuarantines(this.filePath, { now, maxFiles: WORK_PLAN_QUARANTINE_CAP, maximumAgeMs: WORK_PLAN_QUARANTINE_TTL_MS,
      assertCurrent: () => { effects?.assertCurrent?.(); this.locationCurrent(); this.planReadCurrent(); }, onEffect: effects?.onEffect,
    });
    this.lastQuarantineSweepAt = now; this.lastUnverifiedQuarantines = result.preservedUnknown;
    return { removed: result.reaped, unknown: result.preservedUnknown };
  }

  private createEmptyPlan(): WorkPlan {
    const time = nowMs();
    return {
      id: this.newPlanId ?? '',
      registration: this.registered ? 'registered' : 'unregistered',
      projectId: this.options.projectId,
      projectRoot: this.options.projectRoot,
      title: 'Work Plan',
      items: [],
      ...(this.options.source ? { source: this.options.source } : {}),
      createdAt: time,
      updatedAt: time,
    };
  }

  private writePlan(plan: WorkPlan, effects?: WorkPlanEffectOptions): void {
    let published = false;
    const assertCurrent = () => { effects?.assertCurrent?.(); this.locationCurrent(); if (!published) this.planReadCurrent(); };
    assertCurrent();
    atomicWriteFileSync(this.filePath, `${JSON.stringify(plan, null, 2)}\n`, { mkdirp: true, assertCurrent,
      onEffect: flag => { if (flag) published = true; effects?.onEffect?.(flag); },
    });
    // Only a fully confirmed publication becomes our reusable read frame. A
    // failed fsync/observer retains the old frame and propagates uncertainty.
    const physical = fileObservationIdentity(this.filePath);
    this.planReadCurrent = () => { this.locationCurrent(); if (fileObservationIdentity(this.filePath) !== physical) throw new Error('Original work plan changed before publication.'); };
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

const workPlanPrototype = WorkPlanStore.prototype;
const nativeReadActivePlan = workPlanPrototype.getActivePlan;
const nativePathDescriptor = ownDescriptor(workPlanPrototype, 'filePath');
const nativePlanDescriptors = Object.getOwnPropertyDescriptors(workPlanPrototype);
const nativePlanKeys = Object.freeze(ownKeys(nativePlanDescriptors));

export interface WorkPlanItemsObservation {
  readonly items: readonly WorkPlanItem[];
  assertCurrent(): void;
}

/** One readonly native read for a caller-owned operation. Rechecks retain the
 * original assignment, ancestry and complete file incarnation without opening,
 * reparsing or durably publishing the plan again. Custom stores keep their own
 * ordinary read path; a copied object cannot mint a native observation. */
export function captureWorkPlanItems(store: object): WorkPlanItemsObservation | undefined {
  if (!nativeApply(nativeStoreHas, nativeWorkPlanStores, [store]) || prototypeOf(store) !== workPlanPrototype) return undefined;
  const methodsMatch = () => {
    if (ownKeys(workPlanPrototype).length !== nativePlanKeys.length) return false;
    for (let index = 0; index < nativePlanKeys.length; index++) {
      const key = nativePlanKeys[index];
      if (key === undefined) return false;
      if (key !== 'constructor' && (ownDescriptor(store, key)
        || !sameDescriptor(ownDescriptor(workPlanPrototype, key), nativePlanDescriptors[key as keyof typeof nativePlanDescriptors]))) return false;
    }
    return true;
  };
  if (!methodsMatch()) return undefined;
  const plan = nativeApply(nativeReadActivePlan, store, [{ readOnly: true }]) as WorkPlan;
  const location = captureWorkPlanLocation(store);
  const assignment = ownDescriptor(store, 'locationCurrent')?.value as unknown;
  const source = ownDescriptor(store, 'planReadCurrent')?.value as unknown;
  if (typeof assignment !== 'function' || typeof source !== 'function') throw new ToolInputProjectionError('held');
  for (const item of plan.items) { if (item.linked) Object.freeze(item.linked); Object.freeze(item); }
  const items = Object.freeze(plan.items);
  const assertCurrent = () => {
    if (!methodsMatch()) throw new ToolInputProjectionError('held');
    location(); nativeApply(assignment, undefined, []); nativeApply(source, undefined, []); location();
  };
  assertCurrent(); return Object.freeze({ items, assertCurrent });
}

/** Retain the original path descriptor without invoking an unknown getter.
 * This observes a location; it grants neither filesystem ownership nor writes.
 * Only an actual constructed store may use the native filePath getter. Other
 * implementations may omit a location or supply an ordinary string data property. */
export function captureWorkPlanLocation(store: object): () => void {
  const fail = (): never => { throw new ToolInputProjectionError('held'); };
  const chain: object[] = [];
  for (let owner: object | null = store; owner; owner = prototypeOf(owner)) {
    if (nodeTypes.isProxy(owner) || chain.length >= 64) fail();
    chain.push(owner);
  }
  const native = nativeApply(nativeStoreHas, nativeWorkPlanStores, [store]) as boolean;
  const pathOwner = chain.find(owner => ownDescriptor(owner, 'filePath'));
  const path = pathOwner && ownDescriptor(pathOwner, 'filePath');
  const backing = native ? ownDescriptor(store, 'selectedPath') : path;
  if ((native || path) && (!backing || !('value' in backing) || typeof backing.value !== 'string')) fail();
  if (native && (pathOwner !== workPlanPrototype || !nativePathDescriptor?.get || nativePathDescriptor.set
    || !sameDescriptor(path, nativePathDescriptor))) fail();
  const assertCurrent = () => {
    let owner: object | null = store;
    for (const original of chain) {
      if (owner !== original || nodeTypes.isProxy(owner)) fail();
      owner = prototypeOf(owner);
    }
    if (owner !== null || chain.find(entry => ownDescriptor(entry, 'filePath')) !== pathOwner
      || !sameDescriptor(pathOwner && ownDescriptor(pathOwner, 'filePath'), path)
      || native && !sameDescriptor(ownDescriptor(store, 'selectedPath'), backing)) fail();
  };
  assertCurrent(); return assertCurrent;
}

function sameDescriptor(current: PropertyDescriptor | undefined, original: PropertyDescriptor | undefined): boolean {
  if (!current || !original) return current === original;
  return current.configurable === original.configurable && current.enumerable === original.enumerable
    && ('value' in current) === ('value' in original) && current.value === original.value
    && current.writable === original.writable && current.get === original.get && current.set === original.set;
}
