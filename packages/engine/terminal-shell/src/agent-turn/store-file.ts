/**
 * Atomic JSON publication and transaction serialization for agent stores.
 * writeStoreFile prevents torn files; runStoreFileUpdate and
 * runStoreFileUpdateSync hold the store's process lock for the whole
 * transaction, so a CLI process and a running agent updating one store take
 * turns, and updates within one process run in the order they were made.
 * readJsonStore / writeJsonStore / updateJsonStore are the one way an entry
 * store reads, keeps what it cannot parse, and writes.
 */
import { atomicWriteFileSync, type AtomicWriteOptions } from '@goodvibes/engine/platform/platform/config';
import { withProcessLock, withProcessLockSync } from '@goodvibes/engine/platform/platform/utils/process-lock';
import { copyFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Atomic single-file writes
// ---------------------------------------------------------------------------

/**
 * Write `contents` to `path` through the platform's atomic-write primitive
 * (private temp file, fsync, then rename), creating the parent directory if
 * needed. A failed write leaves `path` holding its previous contents; the platform
 * primitive removes its own temp file on failure.
 */
export function writeStoreFile(path: string, contents: string, options: Pick<AtomicWriteOptions, 'assertCurrent' | 'onEffect'> = {}): void {
  atomicWriteFileSync(path, contents, { ...options, mkdirp: true });
}

/** {@link writeStoreFile} for the pretty-printed-JSON-plus-newline shape most stores use. */
export function writeStoreJson(path: string, data: unknown, options: Pick<AtomicWriteOptions, 'assertCurrent' | 'onEffect'> = {}): void {
  writeStoreFile(path, `${JSON.stringify(data, null, 2)}\n`, options);
}

// ---------------------------------------------------------------------------
// Serializing read-modify-write cycles
// ---------------------------------------------------------------------------

/** The store's lock file, next to it; created on first use and never removed. */
function storeLockPath(path: string): string {
  return `${resolve(path)}.writer.sqlite`;
}

/** Serialize a synchronous read-modify-write transaction across CLI and agent processes. */
export function runStoreFileUpdateSync<T>(path: string, update: () => T): T {
  return withProcessLockSync(storeLockPath(path), update);
}

/**
 * Run `update` once every earlier update of `path` in this process has
 * settled and no other process holds the store's lock. A failed update never
 * wedges the ones behind it; `update`'s own result or rejection is returned.
 */
export function runStoreFileUpdate<T>(path: string, update: () => Promise<T> | T): Promise<T> {
  return withProcessLock(storeLockPath(path), update);
}

// ---------------------------------------------------------------------------
// JSON entry stores
// ---------------------------------------------------------------------------

/**
 * A JSON store file shaped `{ version, <entriesKey>: [...], ...other fields }`.
 *
 * Every such store reads the file once per operation and writes it once. An
 * entry this build cannot parse (a hand edit, a field a newer build added) is
 * kept as found and written back unchanged, so no store refuses a write over it
 * and none drops it. Two cases stop a write: a file a newer build wrote (its
 * version is higher), and nothing else; a file that is not JSON at all is copied
 * aside verbatim before it is replaced, and the copy's path is reported.
 */
export interface JsonStoreSpec<E> {
  /** What the store holds, for messages: "calendar store". */
  readonly label: string;
  readonly entriesKey: string;
  /** The file version this build writes. */
  readonly version: number;
  readonly parseEntry: (value: unknown) => E | null;
}

export interface JsonStoreContents<E> {
  readonly path: string;
  readonly exists: boolean;
  readonly entries: readonly E[];
  /** Top-level fields other than `version` and the entries, as found. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Entries this build cannot read, written back exactly as found. */
  readonly keptAsFound: readonly unknown[];
  /** Why the file could not be read at all; its bytes are copied aside before the next write. */
  readonly unreadable?: string | undefined;
  /** Set when a newer build wrote the file; writes are refused while it is. */
  readonly newerVersion?: number | undefined;
}

export interface JsonStoreWriteReport {
  /** Entries this build could not read, left in the file as they were found. */
  readonly keptAsFound: number;
  /** Where the previous bytes were copied when the file could not be read at all. */
  readonly copyPath?: string | undefined;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One read and one parse of a JSON entry store. Never throws for a damaged file; the result says what was found. */
export function readJsonStore<E>(path: string, spec: JsonStoreSpec<E>): JsonStoreContents<E> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { path, exists: false, entries: [], fields: {}, keptAsFound: [] };
    }
    throw new Error(`The ${spec.label} at ${path} cannot be read: ${error instanceof Error ? error.message : String(error)}. Check the file's permissions, then retry.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { path, exists: true, entries: [], fields: {}, keptAsFound: [], unreadable: `not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!isJsonObject(parsed)) {
    return { path, exists: true, entries: [], fields: {}, keptAsFound: [], unreadable: 'not a JSON object' };
  }
  const { version, [spec.entriesKey]: rawEntries, ...fields } = parsed;
  const entries: E[] = [];
  const keptAsFound: unknown[] = [];
  if (Array.isArray(rawEntries)) {
    for (const value of rawEntries) {
      const entry = spec.parseEntry(value);
      if (entry === null) keptAsFound.push(value);
      else entries.push(entry);
    }
  } else if (rawEntries !== undefined) {
    keptAsFound.push(rawEntries);
  }
  return {
    path,
    exists: true,
    entries,
    fields,
    keptAsFound,
    ...(typeof version === 'number' && version > spec.version ? { newerVersion: version } : {}),
  };
}

/**
 * Write `entries` (and the store's other fields) over what `read` found: the
 * unreadable entries `read` kept go back in unchanged, a newer file is refused,
 * and a file that was not JSON is copied aside first.
 */
export function writeJsonStore<E>(
  read: JsonStoreContents<E>,
  spec: JsonStoreSpec<E>,
  next: { readonly entries: readonly E[]; readonly fields?: Readonly<Record<string, unknown>> },
  options: Pick<AtomicWriteOptions, 'assertCurrent' | 'onEffect'> = {},
): JsonStoreWriteReport {
  const prepared = prepareJsonStoreWrite(read, spec, next);
  writeStoreFile(read.path, prepared.text, options);
  return prepared.report;
}

/**
 * The bytes {@link writeJsonStore} would write, for a store that publishes them
 * itself. Refuses a newer file and copies an unreadable one aside, as the write does.
 */
export function prepareJsonStoreWrite<E>(
  read: JsonStoreContents<E>,
  spec: JsonStoreSpec<E>,
  next: { readonly entries: readonly E[]; readonly fields?: Readonly<Record<string, unknown>> },
): { readonly text: string; readonly report: JsonStoreWriteReport } {
  if (read.newerVersion !== undefined) {
    throw new Error(`The ${spec.label} at ${read.path} was written by a newer GoodVibes (file version ${read.newerVersion}, this build writes ${spec.version}), so it was not changed. Update GoodVibes, then retry.`);
  }
  let copyPath: string | undefined;
  if (read.exists && read.unreadable !== undefined) {
    copyPath = `${read.path}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      copyFileSync(read.path, copyPath);
    } catch (error) {
      throw new Error(`The ${spec.label} at ${read.path} is ${read.unreadable} and could not be copied aside (${error instanceof Error ? error.message : String(error)}), so it was not replaced. Repair or move the file, then retry.`);
    }
  }
  const text = `${JSON.stringify({
    version: spec.version,
    ...(next.fields ?? read.fields),
    [spec.entriesKey]: [...next.entries, ...read.keptAsFound],
  }, null, 2)}\n`;
  return { text, report: { keptAsFound: read.keptAsFound.length, ...(copyPath === undefined ? {} : { copyPath }) } };
}

/** What a mutation of a JSON entry store decided: the value to return and, when something changed, what to write. */
export interface JsonStoreChange<E, T> {
  readonly value: T;
  /** Omit to write nothing. */
  readonly entries?: readonly E[] | undefined;
  readonly fields?: Readonly<Record<string, unknown>> | undefined;
}

export interface JsonStoreUpdate<T> {
  readonly value: T;
  /** Present when the file was written. */
  readonly write?: JsonStoreWriteReport | undefined;
}

/** One locked read-modify-write of a JSON entry store: one read, one parse, at most one write. */
export function updateJsonStore<E, T>(
  path: string,
  spec: JsonStoreSpec<E>,
  mutate: (store: JsonStoreContents<E>) => JsonStoreChange<E, T>,
  options: Pick<AtomicWriteOptions, 'assertCurrent' | 'onEffect'> = {},
): JsonStoreUpdate<T> {
  return runStoreFileUpdateSync(path, () => {
    const read = readJsonStore(path, spec);
    const change = mutate(read);
    if (change.entries === undefined) return { value: change.value };
    const write = writeJsonStore(read, spec, { entries: change.entries, ...(change.fields ? { fields: change.fields } : {}) }, options);
    return { value: change.value, write };
  });
}

/** {@link updateJsonStore} for a mutation that awaits (a secret-store call) while the lock is held. */
export function updateJsonStoreAsync<E, T>(
  path: string,
  spec: JsonStoreSpec<E>,
  mutate: (store: JsonStoreContents<E>) => Promise<JsonStoreChange<E, T>>,
): Promise<JsonStoreUpdate<T>> {
  return runStoreFileUpdate(path, async () => {
    const read = readJsonStore(path, spec);
    const change = await mutate(read);
    if (change.entries === undefined) return { value: change.value };
    const write = writeJsonStore(read, spec, { entries: change.entries, ...(change.fields ? { fields: change.fields } : {}) });
    return { value: change.value, write };
  });
}

/** One line for a write report, or '' when nothing needs saying. */
export function formatJsonStoreWriteReport(report: JsonStoreWriteReport | undefined, label: string): string {
  if (!report) return '';
  const lines = [
    report.keptAsFound > 0 ? `${report.keptAsFound} ${label} entr${report.keptAsFound === 1 ? 'y' : 'ies'} this version cannot read ${report.keptAsFound === 1 ? 'was' : 'were'} left as found.` : '',
    report.copyPath ? `The previous ${label} file could not be read; its contents were kept at ${report.copyPath}.` : '',
  ];
  return lines.filter(Boolean).join(' ');
}
