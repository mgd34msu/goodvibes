/**
 * Background processes started with `lifetime: "detached"` outlive the Agent.
 * Each one is recorded here when it starts (id, pid, command, log file), so a
 * later session can list it, read its log and stop it. Each record also holds
 * the boot it started in and its leader's start time, so a pid that a reboot
 * or a wrap-around gave to some other program is never listed or signalled as
 * this one. A record whose process is gone is dropped the next time the list
 * is read.
 *
 * The log files are owned here too: a log is removed with its record (the
 * process was stopped, or found ended), a running process's log is cut to its
 * last {@link DETACHED_LOG_KEEP_BYTES} once it passes
 * {@link DETACHED_LOG_CAP_BYTES} whenever the list is read, and a log left with
 * no record (its start could not be recorded) is removed once nothing has
 * written to it for a day.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync, truncateSync, unlinkSync } from 'node:fs';
import { uptime } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ShellPathService } from '@/runtime/index.ts';
import { redactSensitiveData } from '@goodvibes/engine/platform/platform/utils';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { runStoreFileUpdateSync, writeStoreJson } from '@goodvibes/engine/terminal-shell/agent-turn/store-file';

export interface DetachedProcessRecord {
  readonly processId: string;
  readonly pid: number;
  /** The command as started, with credential-shaped spans masked. */
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: string;
  /** Where the process's stdout and stderr go; it keeps writing there after the Agent exits. */
  readonly logPath: string;
  /** The boot it started in: the kernel's boot id on Linux, the boot time in seconds elsewhere. */
  readonly boot: string;
  /** Its group leader's start time as the kernel reports it; a later process given the same pid has another. */
  readonly leaderStart: string;
}

/** What `recordDetachedProcess` is given: the identity is read here, from the running process. */
export type DetachedProcessStart = Omit<DetachedProcessRecord, 'boot' | 'leaderStart'>;

type DetachedPaths = Pick<ShellPathService, 'resolveUserPath'>;

function storePath(shellPaths: DetachedPaths): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'processes', 'detached.json');
}

/** A fresh log file path for one detached start. */
export function detachedProcessLogPath(shellPaths: DetachedPaths): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'processes', `detached-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`);
}

/** A running detached process's log is cut once it is larger than this. */
export const DETACHED_LOG_CAP_BYTES = 8 * 1024 * 1024;
/** What a cut keeps: the newest output. */
export const DETACHED_LOG_KEEP_BYTES = 1024 * 1024;
/** A log no record names is removed once nothing has written to it for this long. */
const ORPHAN_LOG_AGE_MS = 24 * 60 * 60 * 1000;
const LOG_NAME = /^detached-\d+-[a-z0-9]+\.log$/;

/**
 * A log path this module made: one of its own names, in the processes
 * directory. A path read from the record file is checked before anything is
 * removed or cut, so an edited record cannot point a delete anywhere else.
 */
function ownedLogPath(shellPaths: DetachedPaths, path: string): boolean {
  return LOG_NAME.test(basename(path)) && dirname(path) === dirname(storePath(shellPaths));
}

function removeLog(shellPaths: DetachedPaths, path: string): void {
  if (!ownedLogPath(shellPaths, path)) return;
  try { unlinkSync(path); } catch { /* already gone */ }
}

/**
 * Cut a running process's log to its newest output once it passes the cap.
 * The process appends (`>>`), so it keeps writing at the new end; a line it
 * writes during the cut may land before the kept tail.
 */
function trimLog(shellPaths: DetachedPaths, path: string): void {
  if (!ownedLogPath(shellPaths, path)) return;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size <= DETACHED_LOG_CAP_BYTES) return;
    const start = size - DETACHED_LOG_KEEP_BYTES;
    const buffer = Buffer.alloc(DETACHED_LOG_KEEP_BYTES);
    let got = 0;
    while (got < buffer.length) { const n = readSync(fd, buffer, got, buffer.length - got, start + got); if (n === 0) break; got += n; }
    closeSync(fd); fd = undefined;
    let tail = buffer.subarray(0, got);
    const newline = tail.indexOf(0x0a);
    if (newline >= 0) tail = tail.subarray(newline + 1);
    truncateSync(path, 0);
    appendFileSync(path, Buffer.concat([Buffer.from(`[log cut at ${new Date().toISOString()}: ${size} bytes reached the ${DETACHED_LOG_CAP_BYTES}-byte cap; the newest output is kept]\n`), tail]));
  } catch {
    /* A log that cannot be cut now is cut on a later read. */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Remove logs no record names that nothing has written to for a day. One directory read, run when a detached process starts. */
function sweepOrphanLogs(shellPaths: DetachedPaths, records: readonly DetachedProcessRecord[]): void {
  const directory = dirname(storePath(shellPaths));
  const named = new Set(records.map(record => record.logPath));
  let names: string[];
  try { names = readdirSync(directory); } catch { return; }
  const cutoff = Date.now() - ORPHAN_LOG_AGE_MS;
  for (const name of names) {
    if (!LOG_NAME.test(name)) continue;
    const path = join(directory, name);
    if (named.has(path)) continue;
    try { if (statSync(path).mtimeMs < cutoff) unlinkSync(path); } catch { /* gone or unreadable */ }
  }
}

function parseRecord(value: unknown): DetachedProcessRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const { processId, pid, command, cwd, startedAt, logPath, boot, leaderStart } = row;
  // A record without its identity cannot be told apart from another program that got the same pid, so it is not kept.
  if (typeof processId !== 'string' || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1
    || typeof command !== 'string' || typeof cwd !== 'string' || typeof startedAt !== 'string' || typeof logPath !== 'string'
    || typeof boot !== 'string' || !boot || typeof leaderStart !== 'string' || !leaderStart) return null;
  return { processId, pid, command, cwd, startedAt, logPath, boot, leaderStart };
}

/**
 * The detached-process record file exists but cannot be read, or does not
 * hold a record list. Nothing is listed from it and nothing overwrites it: the
 * processes it names may still be running, and their logs are kept.
 */
export class DetachedRecordsUnreadableError extends Error {
  constructor(readonly path: string, readonly reason: string) {
    super(`The detached-process records at ${path} could not be read (${reason}).`);
    this.name = 'DetachedRecordsUnreadableError';
  }
}

/** The records in the file; none when there is no file. Throws DetachedRecordsUnreadableError for any other failure. */
function readRecords(path: string): DetachedProcessRecord[] {
  let raw: string;
  try { raw = readFileSync(path, 'utf-8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new DetachedRecordsUnreadableError(path, error instanceof Error ? error.message : String(error));
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) {
    throw new DetachedRecordsUnreadableError(path, `not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { processes?: unknown }).processes)) {
    throw new DetachedRecordsUnreadableError(path, 'it holds no list of processes');
  }
  return (parsed as { processes: unknown[] }).processes.flatMap(row => { const record = parseRecord(row); return record ? [record] : []; });
}

function unreadableReason(error: unknown): string {
  if (error instanceof DetachedRecordsUnreadableError) return error.reason;
  throw error;
}

let linuxBootId: string | null | undefined;

/** This boot. On Linux the kernel's boot id (it cannot change while this process runs, so it is read once). */
function currentBoot(): string {
  if (process.platform === 'linux') {
    if (linuxBootId === undefined) {
      try { linuxBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim() || null; } catch { linuxBootId = null; }
    }
    if (linuxBootId) return linuxBootId;
  }
  return `t:${Math.round(Date.now() / 1000 - uptime())}`;
}

/** Boot times derived from the clock and the uptime agree within clock adjustments; a boot id must match exactly. */
const BOOT_TIME_TOLERANCE_SECONDS = 120;

function sameBoot(recorded: string): boolean {
  const current = currentBoot();
  if (recorded.startsWith('t:') && current.startsWith('t:')) {
    return Math.abs(Number(recorded.slice(2)) - Number(current.slice(2))) <= BOOT_TIME_TOLERANCE_SECONDS;
  }
  return recorded === current;
}

/**
 * The start time of each live process among `pids`, as the kernel reports it:
 * field 22 of /proc/<pid>/stat on Linux (one small read per pid), `ps -o
 * lstart` elsewhere (one `ps` for all of them). A pid missing from the map has
 * no process. `null` when the start times could not be observed at all.
 */
function leaderStarts(pids: readonly number[]): ReadonlyMap<number, string> | null {
  const starts = new Map<number, string>();
  if (pids.length === 0) return starts;
  if (process.platform === 'linux') {
    for (const pid of pids) {
      let stat: string;
      try { stat = readFileSync(`/proc/${pid}/stat`, 'utf-8'); } catch { continue; }
      // The command name (field 2) is in parentheses and may hold spaces, so fields are counted after its closing one.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const start = fields[19];
      if (start && /^\d+$/.test(start)) starts.set(pid, start);
    }
    return starts;
  }
  if (process.platform === 'win32') return null;
  // A fixed locale and zone, so the same start reads the same in every session.
  const result = spawnSync('ps', ['-o', 'pid=', '-o', 'lstart=', ...pids.flatMap(pid => ['-p', String(pid)])],
    { encoding: 'utf-8', timeout: 2_000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  if (result.error || typeof result.stdout !== 'string') return null;
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) starts.set(Number(match[1]), match[2]!.replace(/\s+/g, ' '));
  }
  return starts;
}

/**
 * The detached process's group still exists and is reachable by this user.
 * EPERM means the group belongs to someone else, so it cannot be one this
 * Agent started.
 */
function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

/**
 * The record still names the process it started: same boot, and the leader
 * has the recorded start time. When the leader has exited but left children,
 * a live group is still this one: within one boot a pid is not given to a new
 * process while a group with that id exists.
 */
function stillOurs(record: DetachedProcessRecord, starts: ReadonlyMap<number, string>): boolean {
  if (!sameBoot(record.boot)) return false;
  const start = starts.get(record.pid);
  if (start !== undefined) return start === record.leaderStart;
  return groupAlive(record.pid);
}

/** The detached processes from earlier sessions, and why none could be read when the record file is unreadable. */
export interface DetachedProcessListing {
  readonly records: readonly DetachedProcessRecord[];
  /** Set when the record file exists but could not be read: the processes it names are not listed. */
  readonly unreadable?: string;
}

/**
 * Records that still name their running process. The rest are dropped from
 * the file, unless the start times could not be observed at all, in which
 * case nothing is listed or dropped (nothing can be shown to be ours). An
 * unreadable record file lists nothing and is left as it is, with the reason.
 */
export function listDetachedProcesses(shellPaths: DetachedPaths): DetachedProcessListing {
  const path = storePath(shellPaths);
  let records: DetachedProcessRecord[];
  try { records = readRecords(path); } catch (error) { return { records: [], unreadable: unreadableReason(error) }; }
  if (records.length === 0) return { records: [] };
  const starts = leaderStarts(records.map(record => record.pid));
  if (!starts) return { records: [] };
  const alive = records.filter(record => stillOurs(record, starts));
  if (alive.length !== records.length) {
    const goneRecords = records.filter(record => !alive.includes(record));
    const gone = new Set(goneRecords.map(record => record.processId));
    // Only the records seen gone here are removed; one another session added meanwhile stays.
    try {
      runStoreFileUpdateSync(path, () => writeStoreJson(path, { version: 1, processes: readRecords(path).filter(record => !gone.has(record.processId)) }));
      // The process ended, so nothing writes its log and nothing can reach it once the record is gone.
      for (const record of goneRecords) removeLog(shellPaths, record.logPath);
    } catch { /* A record of a finished process is harmless; the next read drops it with its log. */ }
  }
  for (const record of alive) trimLog(shellPaths, record.logPath);
  return { records: alive };
}

export function findDetachedProcess(shellPaths: DetachedPaths, processId: string): DetachedProcessRecord | undefined {
  return listDetachedProcesses(shellPaths).records.find(record => record.processId === processId);
}

/** Whether a detached start was recorded for later sessions, and why not when it was not. */
export type DetachedRecordOutcome = { readonly recorded: true } | { readonly recorded: false; readonly reason: string };

/**
 * Records a detached start with its identity, read from the running process.
 * Not recorded when the identity could not be read (the process already ended,
 * or this system reports no start times), or when the record file exists but
 * cannot be read: it is then neither overwritten nor are earlier logs swept.
 * Later sessions will not list an unrecorded start.
 */
export function recordDetachedProcess(shellPaths: DetachedPaths, start: DetachedProcessStart): DetachedRecordOutcome {
  const leaderStart = leaderStarts([start.pid])?.get(start.pid);
  if (!leaderStart) return { recorded: false, reason: 'its start time could not be read (it may already have ended)' };
  const record: DetachedProcessRecord = { ...start, command: redactSensitiveData(start.command), boot: currentBoot(), leaderStart };
  const path = storePath(shellPaths);
  const outcome = runStoreFileUpdateSync(path, () => {
    let current: DetachedProcessRecord[];
    try { current = readRecords(path); } catch (error) { return { unreadable: unreadableReason(error) }; }
    const others = current.filter(row => row.processId !== record.processId);
    const starts = leaderStarts(others.map(row => row.pid));
    const live = starts ? others.filter(row => stillOurs(row, starts)) : others;
    writeStoreJson(path, { version: 1, processes: [...live, record] });
    return { dropped: others.filter(row => !live.includes(row)), kept: [...live, record] };
  });
  if ('unreadable' in outcome) return { recorded: false, reason: `the detached-process records could not be read (${outcome.unreadable})` };
  for (const row of outcome.dropped) removeLog(shellPaths, row.logPath);
  sweepOrphanLogs(shellPaths, outcome.kept);
  return { recorded: true };
}

/**
 * Drop a stopped process's record and its log: once the record is gone nothing
 * in the product can reach the log. A process still finishing writes into the
 * removed file, which the system frees when it exits.
 */
export function forgetDetachedProcess(shellPaths: DetachedPaths, processId: string): void {
  const path = storePath(shellPaths);
  const forgotten = runStoreFileUpdateSync(path, () => {
    // An unreadable record file is left as it is; it cannot hold a record this session can reach.
    let records: DetachedProcessRecord[];
    try { records = readRecords(path); } catch (error) { unreadableReason(error); return undefined; }
    const record = records.find(row => row.processId === processId);
    if (record) writeStoreJson(path, { version: 1, processes: records.filter(row => row.processId !== processId) });
    return record;
  });
  if (forgotten) removeLog(shellPaths, forgotten.logPath);
}

/**
 * SIGTERM to the detached process's whole group; `false` when it was already
 * gone. Its identity is checked again right before the signal, so a pid that
 * now belongs to another program is never signalled.
 */
export function stopDetachedProcess(shellPaths: DetachedPaths, record: DetachedProcessRecord): boolean {
  let signalled = false;
  const starts = leaderStarts([record.pid]);
  if (starts && stillOurs(record, starts)) {
    try { process.kill(-record.pid, 'SIGTERM'); signalled = true; }
    catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code !== 'ESRCH' && code !== 'EPERM') throw error; }
  }
  forgetDetachedProcess(shellPaths, record.processId);
  return signalled;
}

/** The last `maxBytes` of a detached process's log, masked; empty when the log is gone. */
export function readDetachedProcessLog(record: DetachedProcessRecord, maxBytes: number): { readonly text: string; readonly bytes: number; readonly truncated: boolean } {
  let fd: number | undefined;
  try {
    fd = openSync(record.logPath, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    let got = 0;
    while (got < buffer.length) { const n = readSync(fd, buffer, got, buffer.length - got, start + got); if (n === 0) break; got += n; }
    let text = buffer.subarray(0, got).toString('utf-8');
    // Start at a line boundary so a credential cut in half is not shown half masked.
    if (start > 0) { const newline = text.indexOf('\n'); if (newline >= 0) text = text.slice(newline + 1); }
    return { text: redactSensitiveData(text), bytes: size, truncated: start > 0 };
  } catch {
    return { text: '', bytes: 0, truncated: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
