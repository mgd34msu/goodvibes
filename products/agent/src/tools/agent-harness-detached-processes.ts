/**
 * Background processes started with `lifetime: "detached"` outlive the Agent.
 * Each one is recorded here when it starts (id, pid, command, log file), so a
 * later session can list it, read its log and stop it. Each record also holds
 * the boot it started in and its leader's start time, so a pid that a reboot
 * or a wrap-around gave to some other program is never listed or signalled as
 * this one. A record whose process is gone is dropped the next time the list
 * is read.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { uptime } from 'node:os';
import type { ShellPathService } from '@/runtime/index.ts';
import { redactSensitiveData } from '@goodvibes-jev/engine/platform/platform/utils';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { runStoreFileUpdateSync, writeStoreJson } from '@goodvibes-jev/engine/terminal-shell/agent-turn/store-file';

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

function readRecords(path: string): DetachedProcessRecord[] {
  let raw: string;
  try { raw = readFileSync(path, 'utf-8'); } catch { return []; }
  try {
    const parsed: unknown = JSON.parse(raw);
    const rows = parsed && typeof parsed === 'object' && Array.isArray((parsed as { processes?: unknown }).processes)
      ? (parsed as { processes: unknown[] }).processes : [];
    return rows.flatMap(row => { const record = parseRecord(row); return record ? [record] : []; });
  } catch { return []; }
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

/**
 * Records that still name their running process. The rest are dropped from
 * the file, unless the start times could not be observed at all, in which
 * case nothing is listed or dropped (nothing can be shown to be ours).
 */
export function listDetachedProcesses(shellPaths: DetachedPaths): readonly DetachedProcessRecord[] {
  const path = storePath(shellPaths);
  const records = readRecords(path);
  if (records.length === 0) return [];
  const starts = leaderStarts(records.map(record => record.pid));
  if (!starts) return [];
  const alive = records.filter(record => stillOurs(record, starts));
  if (alive.length !== records.length) {
    const gone = new Set(records.filter(record => !alive.includes(record)).map(record => record.processId));
    // Only the records seen gone here are removed; one another session added meanwhile stays.
    try { runStoreFileUpdateSync(path, () => writeStoreJson(path, { version: 1, processes: readRecords(path).filter(record => !gone.has(record.processId)) })); }
    catch { /* A record of a finished process is harmless; the next read drops it. */ }
  }
  return alive;
}

export function findDetachedProcess(shellPaths: DetachedPaths, processId: string): DetachedProcessRecord | undefined {
  return listDetachedProcesses(shellPaths).find(record => record.processId === processId);
}

/**
 * Records a detached start with its identity, read from the running process.
 * `false` when the identity could not be read (the process already ended, or
 * this system reports no start times): later sessions will not list it.
 */
export function recordDetachedProcess(shellPaths: DetachedPaths, start: DetachedProcessStart): boolean {
  const leaderStart = leaderStarts([start.pid])?.get(start.pid);
  if (!leaderStart) return false;
  const record: DetachedProcessRecord = { ...start, command: redactSensitiveData(start.command), boot: currentBoot(), leaderStart };
  const path = storePath(shellPaths);
  runStoreFileUpdateSync(path, () => {
    const others = readRecords(path).filter(row => row.processId !== record.processId);
    const starts = leaderStarts(others.map(row => row.pid));
    const kept = starts ? others.filter(row => stillOurs(row, starts)) : others;
    writeStoreJson(path, { version: 1, processes: [...kept, record] });
  });
  return true;
}

export function forgetDetachedProcess(shellPaths: DetachedPaths, processId: string): void {
  const path = storePath(shellPaths);
  runStoreFileUpdateSync(path, () => {
    const records = readRecords(path);
    if (records.some(row => row.processId === processId)) writeStoreJson(path, { version: 1, processes: records.filter(row => row.processId !== processId) });
  });
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
