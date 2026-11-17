/**
 * Background processes started with `lifetime: "detached"` outlive the Agent.
 * Each one is recorded here when it starts (id, pid, command, log file), so a
 * later session can list it, read its log and stop it. A record whose process
 * is gone is dropped the next time the list is read.
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import type { ShellPathService } from '@/runtime/index.ts';
import { redactSensitiveData } from '@goodvibes-jev/engine/platform/platform/utils';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { runStoreFileUpdateSync, writeStoreJson } from '@goodvibes-jev/engine/terminal-shell/agent-turn';

export interface DetachedProcessRecord {
  readonly processId: string;
  readonly pid: number;
  /** The command as started, with credential-shaped spans masked. */
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: string;
  /** Where the process's stdout and stderr go; it keeps writing there after the Agent exits. */
  readonly logPath: string;
}

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
  const { processId, pid, command, cwd, startedAt, logPath } = row;
  if (typeof processId !== 'string' || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1
    || typeof command !== 'string' || typeof cwd !== 'string' || typeof startedAt !== 'string' || typeof logPath !== 'string') return null;
  return { processId, pid, command, cwd, startedAt, logPath };
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

/** The detached process's group is still there (its leader or any child it left). */
function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Records whose process group still runs; the rest are dropped from the file. */
export function listDetachedProcesses(shellPaths: DetachedPaths): readonly DetachedProcessRecord[] {
  const path = storePath(shellPaths);
  const records = readRecords(path);
  const alive = records.filter(record => groupAlive(record.pid));
  if (alive.length !== records.length) {
    try { runStoreFileUpdateSync(path, () => writeStoreJson(path, { version: 1, processes: readRecords(path).filter(record => groupAlive(record.pid)) })); }
    catch { /* A record of a finished process is harmless; the next read drops it. */ }
  }
  return alive;
}

export function findDetachedProcess(shellPaths: DetachedPaths, processId: string): DetachedProcessRecord | undefined {
  return listDetachedProcesses(shellPaths).find(record => record.processId === processId);
}

export function recordDetachedProcess(shellPaths: DetachedPaths, record: DetachedProcessRecord): void {
  const path = storePath(shellPaths);
  runStoreFileUpdateSync(path, () => {
    const kept = readRecords(path).filter(row => row.processId !== record.processId && groupAlive(row.pid));
    writeStoreJson(path, { version: 1, processes: [...kept, { ...record, command: redactSensitiveData(record.command) }] });
  });
}

export function forgetDetachedProcess(shellPaths: DetachedPaths, processId: string): void {
  const path = storePath(shellPaths);
  runStoreFileUpdateSync(path, () => {
    const records = readRecords(path);
    if (records.some(row => row.processId === processId)) writeStoreJson(path, { version: 1, processes: records.filter(row => row.processId !== processId) });
  });
}

/** SIGTERM to the detached process's whole group; `false` when it was already gone. */
export function stopDetachedProcess(shellPaths: DetachedPaths, record: DetachedProcessRecord): boolean {
  let signalled = false;
  try { process.kill(-record.pid, 'SIGTERM'); signalled = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
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
