/**
 * How a contract checkpoint is kept on disk by this build: one directory per
 * contract, `.goodvibes/contracts/checkpoints-v7/<id>/`, holding
 *
 * - `base.json`: the whole envelope (the version-6 single-file format) as the
 *   contract was first saved. It is never rewritten. A version-6 file is moved
 *   here unchanged, by one rename, the first time its contract is saved.
 * - `progress.log`: one line per save holding only what that save changed (a
 *   unit's state, an appended decision or check, a usage figure), or, after a
 *   compaction, one snapshot of the state that changes. A line is one write.
 * - `<field>.<tag>.json`: a captured input (the file manifest, the review
 *   inventory) set after the base was written. Written once; the log names it,
 *   and a compaction names it again rather than copying it.
 *
 * Reading puts the base and the log back together into the same envelope text a
 * version-6 file holds, so parsing, validation and native provenance are the
 * same for both. A last line without its newline is a save that never finished
 * and is ignored. Saving compares the held contract with what was last written:
 * values that are replaced whole and never edited in place (captured inputs,
 * evidence, decisions, checks) are compared by reference, small fields by
 * value, so a save does not serialise what did not change.
 */
import { closeSync, constants, fdatasyncSync, fstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { currentFileLabelEntries, storedCurrentFileLabels } from './current-file-observations.js';
import { storedAdmissionReference, syncContractDirectory } from './durable-admission.js';
import { storedReviewCheck } from './review-file-observations.js';
import { storedTreeBaselineOrigins } from './tree-baseline.js';
import { CURRENT_CONTRACT_SCHEMA_VERSION, type Contract } from './types.js';

export const CHECKPOINT_BASE_FILE = 'base.json';
export const CHECKPOINT_LOG_FILE = 'progress.log';
const RECORD_FORMAT = 1;
/** A replaced captured input at least this long goes to its own file, so a compaction never copies it. */
const SIDE_FILE_MIN_CHARS = 8 * 1024;
const SIDE_FILE_NAME = /^[A-Za-z]+\.[0-9a-f]{16}\.json$/;
/** The log is rewritten as one snapshot once what was appended after the last one exceeds this and four times that snapshot. */
const COMPACT_MIN_BYTES = 1024 * 1024;
const COMPACT_RATIO = 4;
const NEWLINE = 0x0a;

/** The log holds a record written by a newer build. */
export class CheckpointFormatError extends Error {
  override readonly name = 'CheckpointFormatError';
}

type StoredForm = (value: never) => unknown;
const same: StoredForm = (value: never) => value;
interface NodeSchema {
  /** Arrays of objects with an `id`, compared element by element and field by field. */
  readonly entities?: Readonly<Record<string, NodeSchema>>;
  /** Objects whose keys are compared one by one (usage by agent, native decision maps). */
  readonly objects?: Readonly<Record<string, NodeSchema>>;
  /** Arrays whose elements are appended or replaced, never edited in place: compared by reference. */
  readonly records?: Readonly<Record<string, StoredForm>>;
  /** Values replaced whole, never edited in place: compared by reference. */
  readonly fixed?: Readonly<Record<string, StoredForm>>;
}
const PLAIN: NodeSchema = {};
const GROUP: NodeSchema = { entities: { criteria: PLAIN }, records: { checks: same, unitIds: same }, fixed: { dependsOn: same, repairs: same } };
const unitEntities: Record<string, NodeSchema> = { criteria: PLAIN, nudges: PLAIN };
const UNIT: NodeSchema = {
  entities: unitEntities,
  records: { checks: storedReviewCheck as StoredForm, agentIds: same, touchedPaths: same },
  fixed: { readEvidence: same, commandEvidence: same, lastReport: same, files: same, dependsOn: same },
};
unitEntities['attemptUnits'] = UNIT;
const NATIVE_DECISIONS: NodeSchema = {
  records: { history: same },
  objects: { pending: PLAIN, spent: PLAIN, plannerOutputs: PLAIN, attemptChoices: PLAIN, attemptedChoices: PLAIN },
};
/**
 * Contract fields that are set once and replaced whole, never edited in place.
 * At the top level a large one is kept in its own file when it is replaced.
 */
const FIXED_CONTRACT_FIELDS: Readonly<Record<string, StoredForm>> = {
  ask: same, taskEvidence: same, inputSnapshot: same, reviewInventory: same, reviewExclusions: same,
  nativeSource: same, draftPlan: same, proposedUnits: same, originalSource: same, selectedModel: same, budget: same,
  durableAdmission: storedAdmissionReference as StoredForm,
};
const CONTRACT: NodeSchema = {
  entities: { units: UNIT, groups: GROUP, criteria: PLAIN, escalations: PLAIN },
  objects: { agentUsage: PLAIN, nativeDecisions: NATIVE_DECISIONS },
  records: { decisions: same, checks: same, plannerAgentIds: same },
  fixed: FIXED_CONTRACT_FIELDS,
};

/** Where a contract's captured input lives now: in the base, inline in the log, or in its own file. */
export type FixedSource = 'base' | 'log' | `file:${string}`;
type Path = readonly (string | number)[];
/** One change: set (`v`), set from a side file (`file`), shorten an array (`n`), or remove a key (none). */
interface ProgressOp { readonly p: Path; readonly v?: unknown; readonly n?: number; readonly file?: string }

type FieldState =
  | { readonly kind: 'value'; readonly value: string | number | boolean | null }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'fixed'; readonly ref: unknown; readonly source: FixedSource }
  | { readonly kind: 'records'; readonly refs: readonly unknown[] }
  | { readonly kind: 'entities'; readonly items: readonly NodeState[] }
  | { readonly kind: 'object'; readonly node: NodeState };
type NodeState = ReadonlyMap<string, FieldState>;

interface DiffContext {
  /** Null while only the state is being built (nothing is written). */
  readonly ops: ProgressOp[] | null;
  readonly sideFile: ((field: string, text: string) => string) | null;
  readonly sources: ReadonlyMap<string, FixedSource> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function absent(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

/** A node as a checkpoint stores it (reviewed files with their facts, the admission as its reference). */
function storedNode(schema: NodeSchema, value: unknown): unknown {
  if (!isRecord(value)) return value;
  const copy: Record<string, unknown> = { ...value };
  for (const [key, form] of Object.entries(schema.records ?? {})) {
    const list = value[key];
    if (form !== same && Array.isArray(list)) copy[key] = list.map(item => (form as (item: unknown) => unknown)(item));
  }
  for (const [key, form] of Object.entries(schema.fixed ?? {})) {
    if (form !== same && !absent(value[key])) copy[key] = (form as (item: unknown) => unknown)(value[key]);
  }
  for (const [key, child] of Object.entries(schema.entities ?? {})) {
    const list = value[key];
    if (Array.isArray(list)) copy[key] = list.map(item => storedNode(child, item));
  }
  for (const [key, child] of Object.entries(schema.objects ?? {})) {
    if (isRecord(value[key])) copy[key] = storedNode(child, value[key]);
  }
  return copy;
}

function emit(ctx: DiffContext, path: Path, op: Omit<ProgressOp, 'p'>): void {
  ctx.ops?.push({ p: path, ...op });
}

function diffNode(schema: NodeSchema, value: Record<string, unknown>, prev: NodeState | undefined, path: Path, ctx: DiffContext): NodeState {
  const next = new Map<string, FieldState>();
  let changed = prev === undefined;
  for (const key of Object.keys(value)) {
    const before = prev?.get(key);
    const state = diffField(schema, key, value[key], before, path, ctx);
    if (state === undefined) continue;
    next.set(key, state);
    if (state !== before) changed = true;
  }
  if (prev !== undefined) {
    for (const key of prev.keys()) {
      if (next.has(key)) continue;
      changed = true;
      emit(ctx, [...path, key], {});
    }
  }
  return changed ? next : prev!;
}

function diffField(schema: NodeSchema, key: string, cur: unknown, prev: FieldState | undefined, parent: Path, ctx: DiffContext): FieldState | undefined {
  if (absent(cur)) return undefined;
  const fixed = schema.fixed?.[key];
  if (fixed !== undefined) return diffFixed(fixed as (value: unknown) => unknown, key, cur, prev, parent, ctx, schema === CONTRACT);
  const records = schema.records?.[key];
  if (records !== undefined && Array.isArray(cur)) return diffRecords(records as (value: unknown) => unknown, cur, prev, [...parent, key], ctx);
  const entities = schema.entities?.[key];
  if (entities !== undefined && Array.isArray(cur)) return diffEntities(entities, cur, prev, [...parent, key], ctx);
  const object = schema.objects?.[key];
  if (object !== undefined && isRecord(cur)) {
    const path = [...parent, key];
    if (prev?.kind === 'object') {
      const node = diffNode(object, cur, prev.node, path, ctx);
      return node === prev.node ? prev : { kind: 'object', node };
    }
    emit(ctx, path, { v: storedNode(object, cur) });
    return { kind: 'object', node: diffNode(object, cur, undefined, path, { ...ctx, ops: null }) };
  }
  if (cur === null || typeof cur !== 'object') {
    if (prev?.kind === 'value' && Object.is(prev.value, cur)) return prev;
    emit(ctx, [...parent, key], { v: cur });
    return { kind: 'value', value: cur as string | number | boolean | null };
  }
  const text = JSON.stringify(cur) as string | undefined;
  if (text === undefined) return undefined;
  if (prev?.kind === 'text' && prev.text === text) return prev;
  emit(ctx, [...parent, key], { v: cur });
  return { kind: 'text', text };
}

function diffFixed(form: (value: unknown) => unknown, key: string, cur: unknown, prev: FieldState | undefined, parent: Path, ctx: DiffContext, top: boolean): FieldState {
  if (prev?.kind === 'fixed' && prev.ref === cur) return prev;
  if (ctx.ops === null) return { kind: 'fixed', ref: cur, source: ctx.sources?.get(key) ?? 'log' };
  const stored = form(cur);
  const text = JSON.stringify(stored) as string | undefined;
  // A copy with the same content (a disposal checkpoint, an import) is not written again.
  if (prev?.kind === 'fixed' && text === JSON.stringify(form(prev.ref))) return { kind: 'fixed', ref: cur, source: prev.source };
  const path = [...parent, key];
  if (top && ctx.sideFile !== null && text !== undefined && text.length >= SIDE_FILE_MIN_CHARS) {
    const file = ctx.sideFile(key, text);
    ctx.ops.push({ p: path, file });
    return { kind: 'fixed', ref: cur, source: `file:${file}` };
  }
  ctx.ops.push({ p: path, v: stored });
  return { kind: 'fixed', ref: cur, source: 'log' };
}

function diffRecords(form: (value: unknown) => unknown, cur: readonly unknown[], prev: FieldState | undefined, path: Path, ctx: DiffContext): FieldState {
  if (ctx.ops === null) return { kind: 'records', refs: cur.slice() };
  if (prev?.kind !== 'records') {
    ctx.ops.push({ p: path, v: cur.map(form) });
    return { kind: 'records', refs: cur.slice() };
  }
  const refs = prev.refs;
  let changed = cur.length !== refs.length;
  for (let index = 0; index < cur.length; index++) {
    const item = cur[index];
    if (index < refs.length) {
      const old = refs[index];
      if (item === old) continue;
      changed = true;
      if (item !== null && typeof item === 'object' && JSON.stringify(form(item)) === JSON.stringify(form(old))) continue;
    }
    ctx.ops.push({ p: [...path, index], v: form(item) });
  }
  if (cur.length < refs.length) ctx.ops.push({ p: path, n: cur.length });
  return changed ? { kind: 'records', refs: cur.slice() } : prev;
}

function diffEntities(schema: NodeSchema, cur: readonly unknown[], prev: FieldState | undefined, path: Path, ctx: DiffContext): FieldState {
  const quiet: DiffContext = { ...ctx, ops: null };
  const build = (item: unknown): NodeState => isRecord(item) ? diffNode(schema, item, undefined, path, quiet) : new Map();
  if (prev?.kind !== 'entities') {
    emit(ctx, path, { v: cur.map(item => storedNode(schema, item)) });
    return { kind: 'entities', items: cur.map(build) };
  }
  if (ctx.ops === null) return { kind: 'entities', items: cur.map(build) };
  const items: NodeState[] = [];
  let changed = cur.length !== prev.items.length;
  for (let index = 0; index < cur.length; index++) {
    const item = cur[index], old = prev.items[index];
    const at = [...path, index];
    if (isRecord(item) && old !== undefined && sameEntity(old, item)) {
      const node = diffNode(schema, item, old, at, ctx);
      if (node !== old) changed = true;
      items.push(node);
      continue;
    }
    changed = true;
    ctx.ops.push({ p: at, v: storedNode(schema, item) });
    items.push(build(item));
  }
  if (cur.length < prev.items.length) ctx.ops.push({ p: path, n: cur.length });
  return changed ? { kind: 'entities', items } : prev;
}

function sameEntity(old: NodeState, item: Record<string, unknown>): boolean {
  const id = old.get('id');
  if (id === undefined) return item['id'] === undefined;
  return id.kind === 'value' && id.value === item['id'];
}

type LabelState = readonly (readonly [path: string, id: string])[] | null;

function diffLabels(owner: object, prev: LabelState, ctx: DiffContext): LabelState {
  const table = currentFileLabelEntries(owner);
  if (table === undefined || table.size === 0) {
    if (prev !== null) emit(ctx, ['nativeFileLabels'], {});
    return null;
  }
  const next: (readonly [string, string])[] = [];
  for (const [path, label] of table) next.push([path, label.id]);
  if (prev === null) {
    emit(ctx, ['nativeFileLabels'], { v: storedCurrentFileLabels(owner) });
    return next;
  }
  let changed = next.length !== prev.length, index = 0;
  for (const [path, label] of table) {
    const old = prev[index];
    if (old === undefined || old[0] !== path || old[1] !== label.id) {
      changed = true;
      emit(ctx, ['nativeFileLabels', 'entries', index], { v: { path, id: label.id, facts: label.facts } });
    }
    index += 1;
  }
  if (next.length < prev.length) emit(ctx, ['nativeFileLabels', 'entries'], { n: next.length });
  return changed ? next : prev;
}

/** What one save would write, and the state to keep once it is written. */
export interface ProgressChange {
  /** The log line, without its newline; null when nothing changed. */
  readonly line: string | null;
  readonly state: TrackedState;
}

interface TrackedState {
  readonly contract: NodeState;
  readonly labels: LabelState;
  readonly origins: string;
}

/** The disk layout a contract was read from, which decides what its next save does. */
export type CheckpointLayout =
  /** The directory format: the next save appends. */
  | 'progress'
  /** A version-6 single file: the next save moves it into the directory, then appends. */
  | 'single-file'
  /** A schema 1-5 file in the old flat directory, which is never modified: the next save writes a new base. */
  | 'historical'
  /** Nothing on disk: the next save writes a new base. */
  | 'none';

/** Identity of the progress log as last read or written: inode and size, or absent. */
export interface LogIdentity { readonly ino: number; readonly size: number }

/**
 * What this process last read from or wrote to one contract's checkpoint. A
 * save writes the difference between the held contract and this.
 */
export class ContractProgressTracker {
  private state: TrackedState;
  /** For a single-file layout: the file's identity when read, and the schema it was written with. */
  sourceIdentity: string | null = null;
  sourceSchemaVersion = 0;
  log: LogIdentity | null;
  /** Bytes of the last snapshot record (0 when the log holds none) and of the records after it. */
  snapshotBytes: number;
  appendedBytes: number;
  /** Replay stopped at a record it could not apply: the next save rewrites the log, keeping the old one aside. */
  damaged: boolean;

  private constructor(readonly layout: CheckpointLayout, state: TrackedState, log: LogIdentity | null, meta: { snapshotBytes: number; appendedBytes: number; damaged: boolean }) {
    this.state = state;
    this.log = log;
    this.snapshotBytes = meta.snapshotBytes;
    this.appendedBytes = meta.appendedBytes;
    this.damaged = meta.damaged;
  }

  /** The state of `contract` as it stands, taken as what is on disk now. */
  static of(contract: Contract, layout: CheckpointLayout, options: {
    readonly sources?: ReadonlyMap<string, FixedSource>;
    readonly log?: LogIdentity | null;
    readonly snapshotBytes?: number;
    readonly appendedBytes?: number;
    readonly damaged?: boolean;
  } = {}): ContractProgressTracker {
    const sources = options.sources ?? new Map(Object.keys(FIXED_CONTRACT_FIELDS).filter(field => !absent((contract as unknown as Record<string, unknown>)[field])).map(field => [field, 'base' as const]));
    const ctx: DiffContext = { ops: null, sideFile: null, sources };
    const state: TrackedState = {
      contract: diffNode(CONTRACT, contract as unknown as Record<string, unknown>, undefined, ['contract'], ctx),
      labels: diffLabels(contract, null, ctx),
      origins: JSON.stringify(storedTreeBaselineOrigins(contract)),
    };
    return new ContractProgressTracker(layout, state, options.log ?? null, {
      snapshotBytes: options.snapshotBytes ?? 0, appendedBytes: options.appendedBytes ?? 0, damaged: options.damaged ?? false,
    });
  }

  /** A tracker for the same state after the checkpoint moved to the directory format. */
  moved(): ContractProgressTracker {
    return new ContractProgressTracker('progress', this.state, null, { snapshotBytes: 0, appendedBytes: 0, damaged: false });
  }

  /**
   * The difference between `contract` and what was last written, as one log
   * line. A large replaced captured input is written to its own file through
   * `sideFile` first. Nothing is kept until `commit`.
   */
  diff(contract: Contract, at: number, sideFile: (field: string, text: string) => string): ProgressChange {
    const ops: ProgressOp[] = [];
    const ctx: DiffContext = { ops, sideFile, sources: null };
    const state: TrackedState = {
      contract: diffNode(CONTRACT, contract as unknown as Record<string, unknown>, this.state.contract, ['contract'], ctx),
      labels: diffLabels(contract, this.state.labels, ctx),
      origins: JSON.stringify(storedTreeBaselineOrigins(contract)),
    };
    if (state.origins !== this.state.origins) ops.push({ p: ['treeBaselineOrigins'], v: JSON.parse(state.origins) as unknown });
    const line = ops.length === 0 ? null : JSON.stringify({ v: RECORD_FORMAT, s: CURRENT_CONTRACT_SCHEMA_VERSION, at, ops });
    return { line, state };
  }

  /** Whether appending `bytes` more should instead rewrite the log as one snapshot. */
  shouldCompact(bytes: number): boolean {
    if (this.damaged) return true;
    const appended = this.appendedBytes + bytes;
    return appended > COMPACT_MIN_BYTES && appended > COMPACT_RATIO * this.snapshotBytes;
  }

  /**
   * One snapshot line holding the whole state that changes. Captured inputs in
   * the base or in their own files are named, not copied.
   */
  snapshot(contract: Contract, change: ProgressChange, at: number, serialize: (contract: Contract) => Record<string, unknown>): string {
    const body = serialize(contract);
    const base: string[] = [], files: Record<string, string> = {};
    for (const [field, state] of fixedFields(change.state.contract)) {
      if (state.source === 'base') { base.push(field); delete body[field]; }
      else if (state.source.startsWith('file:')) { files[field] = state.source.slice('file:'.length); delete body[field]; }
    }
    const labels = storedCurrentFileLabels(contract);
    const snap = { contract: body, ...(labels === undefined ? {} : { nativeFileLabels: labels }), treeBaselineOrigins: JSON.parse(change.state.origins) as unknown };
    return JSON.stringify({ v: RECORD_FORMAT, s: CURRENT_CONTRACT_SCHEMA_VERSION, at, snap, base, files });
  }

  commitAppend(change: ProgressChange, bytes: number): void {
    this.state = change.state;
    this.appendedBytes += bytes;
  }

  commitSnapshot(change: ProgressChange, bytes: number): void {
    this.state = change.state;
    this.snapshotBytes = bytes;
    this.appendedBytes = 0;
    this.damaged = false;
  }

  /** Side files the current state names; any other side file in the directory is unused. */
  referencedFiles(): Set<string> {
    const names = new Set<string>();
    for (const [, state] of fixedFields(this.state.contract)) if (state.source.startsWith('file:')) names.add(state.source.slice('file:'.length));
    return names;
  }
}

function* fixedFields(node: NodeState): Generator<[string, Extract<FieldState, { kind: 'fixed' }>]> {
  for (const field of Object.keys(FIXED_CONTRACT_FIELDS)) {
    const state = node.get(field);
    if (state?.kind === 'fixed') yield [field, state];
  }
}

/** Writes a replaced captured input to its own new file in `dir` (synced, with its directory entry) and returns its name. */
export function writeCheckpointSideFile(dir: string, field: string, text: string): string {
  const name = `${field}.${randomBytes(8).toString('hex')}.json`;
  const fd = openSync(join(dir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(text, 'utf8');
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    fdatasyncSync(fd);
  } finally { closeSync(fd); }
  // The log line naming this file must never survive a crash that loses the file.
  syncContractDirectory(dir);
  return name;
}

export function isCheckpointSideFileName(name: string): boolean {
  return SIDE_FILE_NAME.test(name);
}

/** The progress log's bytes and identity, or null when there is none. */
export function readCheckpointLog(dir: string): { readonly bytes: Buffer; readonly identity: LogIdentity } | null {
  let fd: number;
  try { fd = openSync(join(dir, CHECKPOINT_LOG_FILE), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const stat = fstatSync(fd);
    const bytes = readFileSync(fd);
    return { bytes, identity: { ino: stat.ino, size: bytes.length } };
  } finally { closeSync(fd); }
}

/** The contract envelope text from the base and the log, and what the next save needs to know about them. */
export interface AssembledCheckpoint {
  readonly text: string;
  readonly sources: ReadonlyMap<string, FixedSource>;
  readonly snapshotBytes: number;
  readonly appendedBytes: number;
  readonly damaged: boolean;
}

interface LogRecord {
  readonly bytes: number;
  readonly s: number;
  readonly at: number;
  readonly ops?: readonly ProgressOp[];
  readonly snap?: Record<string, unknown>;
  readonly base?: readonly string[];
  readonly files?: Readonly<Record<string, string>>;
}

function parseRecord(line: string): LogRecord | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!isRecord(value) || typeof value['v'] !== 'number') return null;
  if (value['v'] > RECORD_FORMAT || (typeof value['s'] === 'number' && value['s'] > CURRENT_CONTRACT_SCHEMA_VERSION)) {
    throw new CheckpointFormatError('The contract progress log holds a record written by a newer build.');
  }
  if (value['v'] !== RECORD_FORMAT || typeof value['s'] !== 'number' || typeof value['at'] !== 'number') return null;
  const bytes = Buffer.byteLength(line) + 1;
  if (Array.isArray(value['ops'])) return { bytes, s: value['s'], at: value['at'], ops: value['ops'] as ProgressOp[] };
  if (isRecord(value['snap']) && Array.isArray(value['base']) && isRecord(value['files'])) {
    return { bytes, s: value['s'], at: value['at'], snap: value['snap'], base: value['base'] as string[], files: value['files'] as Record<string, string> };
  }
  return null;
}

function applyOp(root: Record<string, unknown>, op: ProgressOp, readSideFile: (name: string) => unknown): void {
  const path = op.p;
  if (!Array.isArray(path) || path.length === 0) throw new Error('invalid path');
  let node: unknown = root;
  for (let index = 0; index < path.length - 1; index++) {
    const key = path[index];
    if (key === '__proto__' || node === null || typeof node !== 'object') throw new Error('invalid path');
    node = (node as Record<string | number, unknown>)[key as string | number];
  }
  if (node === null || typeof node !== 'object') throw new Error('invalid path');
  const key = path[path.length - 1];
  const target = node as Record<string | number, unknown>;
  if (key === '__proto__') throw new Error('invalid path');
  if ('n' in op) {
    const list = target[key as string | number];
    if (!Array.isArray(list) || !Number.isSafeInteger(op.n) || op.n! < 0 || op.n! > list.length) throw new Error('invalid length');
    list.length = op.n!;
    return;
  }
  if (Array.isArray(target)) {
    if (typeof key !== 'number' || !Number.isSafeInteger(key) || key < 0 || key > target.length) throw new Error('invalid index');
  } else if (typeof key !== 'string') throw new Error('invalid key');
  if ('v' in op) target[key as string | number] = op.v;
  else if (typeof op.file === 'string') target[key as string | number] = readSideFile(op.file);
  else {
    if (Array.isArray(target)) throw new Error('invalid removal');
    delete target[key as string];
  }
}

/**
 * The envelope a version-6 file would hold for this base and log. A torn last
 * line is ignored; a damaged line is skipped and logged. A record that cannot
 * be applied (a missing side file) ends the replay there: the state is the one
 * the saves before it left, and the next save rewrites the log.
 */
export function assembleCheckpoint(dir: string, baseText: string, log: Buffer | null): AssembledCheckpoint {
  const records: LogRecord[] = [];
  let damagedLines = 0;
  if (log !== null && log.length > 0) {
    let start = 0;
    for (;;) {
      const end = log.indexOf(NEWLINE, start);
      if (end === -1) break; // A torn last line: its save never finished.
      const record = parseRecord(log.toString('utf8', start, end));
      if (record === null) damagedLines += 1;
      else records.push(record);
      start = end + 1;
    }
  }
  if (damagedLines > 0) logger.warn('contract store: skipped damaged progress records', { dir, damagedLines });
  const readSideFile = (name: string): unknown => {
    if (!SIDE_FILE_NAME.test(name)) throw new Error('invalid side file name');
    return JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown;
  };
  let limit = records.length;
  for (;;) {
    const result = replay(baseText, records, limit, readSideFile);
    if (typeof result !== 'number') {
      if (limit < records.length) logger.warn('contract store: a progress record could not be applied; the contract reads as saved before it', { dir, record: limit, of: records.length });
      return { ...result, damaged: limit < records.length };
    }
    limit = result;
  }
}

/** The assembled checkpoint from the first `limit` records, or the index of the record that could not be applied. */
function replay(baseText: string, records: readonly LogRecord[], limit: number, readSideFile: (name: string) => unknown): Omit<AssembledCheckpoint, 'damaged'> | number {
  const sources = new Map<string, FixedSource>();
  if (limit === 0) {
    let base: unknown;
    try { base = JSON.parse(baseText); } catch { base = null; }
    const contract = isRecord(base) ? base['contract'] : undefined;
    if (isRecord(contract)) for (const field of Object.keys(FIXED_CONTRACT_FIELDS)) if (!absent(contract[field])) sources.set(field, 'base');
    return { text: baseText, sources, snapshotBytes: 0, appendedBytes: 0 };
  }
  const envelope = JSON.parse(baseText) as unknown;
  if (!isRecord(envelope) || !isRecord(envelope['contract'])) return { text: baseText, sources, snapshotBytes: 0, appendedBytes: 0 };
  const baseContract = envelope['contract'];
  const baseFixed = new Map<string, unknown>();
  for (const field of Object.keys(FIXED_CONTRACT_FIELDS)) {
    if (!absent(baseContract[field])) { baseFixed.set(field, baseContract[field]); sources.set(field, 'base'); }
  }
  let current: Record<string, unknown> = envelope, snapshotBytes = 0, appendedBytes = 0, schemaVersion: number | undefined, writtenAt: number | undefined;
  for (let index = 0; index < limit; index++) {
    const record = records[index]!;
    try {
      if (record.snap !== undefined) {
        const next: Record<string, unknown> = { ...record.snap };
        const contract = next['contract'];
        if (!isRecord(contract)) throw new Error('invalid snapshot');
        sources.clear();
        for (const field of record.base ?? []) {
          if (!baseFixed.has(field)) throw new Error('snapshot names a base field the base lacks');
          contract[field] = baseFixed.get(field); sources.set(field, 'base');
        }
        for (const [field, name] of Object.entries(record.files ?? {})) { contract[field] = readSideFile(name); sources.set(field, `file:${name}`); }
        for (const field of Object.keys(FIXED_CONTRACT_FIELDS)) if (!sources.has(field) && !absent(contract[field])) sources.set(field, 'log');
        current = next; snapshotBytes = record.bytes; appendedBytes = 0;
      } else {
        for (const op of record.ops ?? []) {
          applyOp(current, op, readSideFile);
          if (op.p.length === 2 && op.p[0] === 'contract' && typeof op.p[1] === 'string' && op.p[1] in FIXED_CONTRACT_FIELDS) {
            const field = op.p[1];
            if ('v' in op) sources.set(field, 'log');
            else if (typeof op.file === 'string') sources.set(field, `file:${op.file}`);
            else sources.delete(field);
          }
        }
        appendedBytes += record.bytes;
      }
    } catch {
      return index;
    }
    schemaVersion = record.s; writtenAt = record.at;
  }
  if (schemaVersion !== undefined) current['schemaVersion'] = schemaVersion;
  if (writtenAt !== undefined) current['writtenAt'] = writtenAt;
  return { text: JSON.stringify(current), sources, snapshotBytes, appendedBytes };
}

/** The stored contract body a snapshot holds (the version-6 envelope's `contract`), before captured inputs are named instead of copied. */
export function storedContractBody(contract: Contract, stored: (contract: Contract) => Contract): Record<string, unknown> {
  const body = { ...stored(contract) } as unknown as Record<string, unknown>;
  if (contract.durableAdmission !== undefined) body['durableAdmission'] = storedAdmissionReference(contract.durableAdmission);
  return body;
}

