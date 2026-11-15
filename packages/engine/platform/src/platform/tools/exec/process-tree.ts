/**
 * process-tree.ts, stop a whole process tree rather than one pid.
 *
 * A PTY run cannot be stopped by signalling a process group: `script(1)` puts
 * the command on a new pty in a new session, so the wrapper's group does not
 * contain it, and starting the wrapper in its own group would sever the very
 * terminal the prompt path depends on. Instead the descendants are collected
 * from the process table and signalled one by one.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sleep } from '../../utils/concurrency.js';
import { logger } from '../../utils/logger.js';
import { processStartTime } from '../../config/process-start-time.js';

/** `[pid, parent pid]` pairs of the host's processes. */
export type ProcessTable = ReadonlyArray<readonly [number, number]>;

/** Every descendant of `root` in `table`, children before their parents. Pure. */
export function descendantsOf(table: ProcessTable, root: number): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of table) {
    const list = children.get(ppid);
    if (list) list.push(pid); else children.set(ppid, [pid]);
  }
  const ordered: number[] = [];
  const seen = new Set<number>([root]);
  const visit = (pid: number): void => {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      visit(child);
      ordered.push(child);
    }
  };
  visit(root);
  return ordered;
}

/** Read the host process table; empty when the host offers no way to list it. */
export function readProcessTable(): ProcessTable {
  const rows: Array<readonly [number, number]> = [];
  if (process.platform === 'linux') {
    try {
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/u.test(name)) continue;
        try {
          const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
          // The command name is parenthesised and may contain spaces or ')'.
          const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          const ppid = Number(fields[1]);
          if (Number.isSafeInteger(ppid)) rows.push([Number(name), ppid]);
        } catch { /* the process exited while the table was read */ }
      }
      return rows;
    } catch { /* fall through to ps */ }
  }
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 });
  if (listed.status !== 0) return rows;
  for (const line of listed.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/u).map(Number);
    if (Number.isSafeInteger(pid) && Number.isSafeInteger(ppid)) rows.push([pid as number, ppid as number]);
  }
  return rows;
}

function signalAll(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    try { process.kill(pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') logger.debug('[ExecProcessTree] signal failed', { pid, signal, error: String(error) });
    }
  }
}

/** Seams for a test; production uses the host. */
export interface KillProcessTreeHost {
  readonly readTable?: () => ProcessTable;
  readonly startTime?: (pid: number) => string | null;
  readonly signal?: (pids: readonly number[], signal: NodeJS.Signals) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * SIGTERM, a short grace, then SIGKILL, for `root` and everything below it.
 * The tree is collected before the first signal; the second pass adds any
 * children spawned during the grace period, but only while the root is still
 * the process that was collected. A pid from the first collection is signalled
 * again only while it is still the process that was collected (same start
 * time): a number freed during the grace and reused by an unrelated program,
 * or its children, is left alone.
 */
export async function killProcessTree(root: number, graceMs = 200, host: KillProcessTreeHost = {}): Promise<void> {
  if (!Number.isSafeInteger(root) || root <= 1) return;
  const readTable = host.readTable ?? readProcessTable;
  const startTime = host.startTime ?? processStartTime;
  const signal = host.signal ?? signalAll;
  const first = [...descendantsOf(readTable(), root), root];
  const started = new Map(first.map((pid): [number, string | null] => [pid, startTime(pid)]));
  signal(first, 'SIGTERM');
  await (host.sleep ?? sleep)(graceMs);
  // Each pid is looked up once (the lookup can be a `ps` call). Children of a
  // root that already died are reparented and only the first collection still
  // names them; they are kept only when provably unchanged. A root whose pid
  // was freed and reused is not the root any more, so a fresh walk from that
  // number would reach an unrelated program's children and is not used.
  const now = new Map<number, string | null>();
  const unchanged = (pid: number): boolean => {
    if (!now.has(pid)) now.set(pid, startTime(pid));
    const before = started.get(pid);
    return before !== null && before !== undefined && now.get(pid) === before;
  };
  const stillTree = unchanged(root) ? descendantsOf(readTable(), root) : [];
  const survivors = first.filter(unchanged);
  signal([...new Set([...stillTree, ...survivors])], 'SIGKILL');
}
