/**
 * observed/detect.ts, read-only detection of externally-launched coding-agent
 * sessions this daemon did NOT spawn or host (someone's own Claude Code / Codex
 * process on the same host).
 *
 * Discipline (mirrors remote-access/tailscale.ts detectTailscale): STRICTLY
 * read-only. The process table and the tmux pane list are READ; the observed
 * processes are NEVER exec'd, signalled, or probed. Absence is a quiet empty
 * set, never an error and never a nag. Both readers are injectable so tests
 * never touch a real `/proc` or `tmux`.
 *
 * What is honestly derivable becomes an ObservedRawProcess: binary kind
 * (argv-shape match), pid, working directory, start time, controlling tty, and
 * cumulative CPU seconds (the liveness signal the source turns into
 * active/quiet). The tmux pane list maps a controlling tty to a pane id, which
 * is the one genuine steer channel a tmux-hosted foreign session exposes.
 */
import { execFile, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, existsSync } from 'node:fs';
import { readdir, readFile, readlink } from 'node:fs/promises';
import type { ObservedAgentKind } from '../types.js';

/** One live process as read from the process table, only read-only-derivable facts. */
export interface ObservedRawProcess {
  readonly pid: number;
  readonly ppid: number;
  /** Full command line (argv joined by spaces), for the argv-shape kind match. */
  readonly args: string;
  /** Controlling terminal path (e.g. `/dev/pts/11`), or undefined when the process has none. */
  readonly tty?: string | undefined;
  /** Working directory, when derivable read-only (Linux `/proc/<pid>/cwd`). */
  readonly cwd?: string | undefined;
  /** Epoch ms the process started, when derivable. */
  readonly startedAt?: number | undefined;
  /** Cumulative CPU seconds the OS reports for the process (monotonic per pid). */
  readonly cpuSeconds: number;
}

/**
 * Injectable process-table reader. The default reads Linux `/proc`; tests
 * substitute a stub. `readAsync`, when present, is what the periodic scan uses,
 * so the walk never blocks the event loop; `read` serves the one-off check a
 * steer makes before it types.
 */
export interface ProcessTableReader {
  read(): readonly ObservedRawProcess[];
  readAsync?(): Promise<readonly ObservedRawProcess[]>;
}

/** One tmux pane's tty → pane-id mapping row. */
export interface TmuxPaneRow {
  readonly paneId: string;
  /** The pane's controlling terminal path (tmux `#{pane_tty}`), e.g. `/dev/pts/11`. */
  readonly tty: string;
}

/**
 * Injectable tmux pane reader. The default runs `tmux list-panes -a`; tests
 * substitute a stub. `listPanesAsync` serves the scan. Each answers the pane
 * rows (empty when tmux is not installed or no tmux server runs), or undefined
 * when the list could not be read (tmux failed or did not answer in time), so
 * a failed read is never taken for "no pane".
 */
export interface TmuxPaneReader {
  listPanes(): readonly TmuxPaneRow[] | undefined;
  listPanesAsync?(): Promise<readonly TmuxPaneRow[] | undefined>;
}

const COMMAND_TIMEOUT_MS = 5_000;

/**
 * Classify a process's argv shape into an external coding-agent kind, or null
 * when it is not one of the known agents (so it is skipped entirely, not an
 * `unknown` row). The kind comes from the program the process executes, never
 * from its other arguments: the effective program is argv0, or argv1 when argv0
 * is a JS runtime launcher (`node /.../bin/codex ...`), and it names the agent
 * by its basename (`codex`, the vendored `codex-*` binaries, `claude`,
 * `claude.exe`, `opencode`) or by the npm package directory it runs from
 * (`@openai/codex`, `@anthropic-ai/claude-code`, `opencode-ai`). A process that
 * only mentions an agent in its arguments (`grep -r @openai/codex`, an editor
 * open on a file under an `opencode` directory) is not that agent.
 */
export function classifyExternalKind(args: string): ObservedAgentKind | null {
  if (!args) return null;
  const tokens = args.split(/\s+/).filter(Boolean);
  const basename = (token: string): string => token.split('/').pop() ?? token;
  const argv0base = basename(tokens[0] ?? '');
  const launcher = /^(node|node-MainThread|bun|deno|npx|bunx)$/.test(argv0base);
  const program = launcher && tokens[1] ? tokens[1] : (tokens[0] ?? '');
  const base = basename(program);
  const segments = program.split('/');
  const runsFromPackage = (...path: readonly string[]): boolean =>
    segments.some((_, index) => path.every((part, offset) => segments[index + offset] === part));
  if (base === 'codex' || base.startsWith('codex-') || runsFromPackage('@openai', 'codex')) {
    return 'codex';
  }
  if (base === 'claude' || base === 'claude.exe' || runsFromPackage('@anthropic-ai', 'claude-code')) {
    return 'claude-code';
  }
  if (base === 'opencode' || runsFromPackage('opencode-ai')) {
    return 'opencode';
  }
  return null;
}

/** A classified observed process: a raw row plus the external kind it matched. */
export interface ClassifiedObservedProcess extends ObservedRawProcess {
  readonly externalKind: ObservedAgentKind;
}

/**
 * Classify the process table into observed coding-agent rows, keeping ONE row
 * per session: a matched process whose parent is also a matched process of the
 * same kind is a child helper (e.g. the native `codex` binary under its `node`
 * launcher) and is dropped in favour of its root, so a single session never
 * lists twice.
 *
 * `ownedRoots` are pids this runtime owns (its own, and any child it hosts):
 * a match that is one of them or descends from one was spawned or hosted here,
 * it already has a fleet row of its own, and is not an observed session.
 */
export function classifyObservedProcesses(
  processes: readonly ObservedRawProcess[],
  ownedRoots: ReadonlySet<number> = new Set(),
): ClassifiedObservedProcess[] {
  const ppidByPid = new Map<number, number>();
  for (const proc of processes) ppidByPid.set(proc.pid, proc.ppid);
  const isOwned = (pid: number): boolean => {
    const visited = new Set<number>();
    let current = pid;
    while (current > 0 && !visited.has(current)) {
      if (ownedRoots.has(current)) return true;
      visited.add(current);
      current = ppidByPid.get(current) ?? 0;
    }
    return false;
  };
  const kindByPid = new Map<number, ObservedAgentKind>();
  const byPid = new Map<number, ObservedRawProcess>();
  for (const proc of processes) {
    const kind = classifyExternalKind(proc.args);
    if (kind && !isOwned(proc.pid)) {
      kindByPid.set(proc.pid, kind);
      byPid.set(proc.pid, proc);
    }
  }
  const rows: ClassifiedObservedProcess[] = [];
  for (const [pid, kind] of kindByPid) {
    const proc = byPid.get(pid)!;
    const parentKind = kindByPid.get(proc.ppid);
    // Drop a matched child of a same-kind matched parent (helper under launcher).
    if (parentKind === kind) continue;
    rows.push({ ...proc, externalKind: kind });
  }
  return rows;
}

/** Map a controlling tty to a tmux pane id, from the pane list. */
export function paneForTty(panes: readonly TmuxPaneRow[], tty: string | undefined): TmuxPaneRow | undefined {
  if (!tty) return undefined;
  return panes.find((pane) => pane.tty === tty);
}

// ── Default readers (Linux /proc + tmux), spawn-free where possible ──────────

const CLOCK_TICKS = 100; // SC_CLK_TCK on Linux; the /proc reader's fixed assumption.

function bootTimeFrom(stat: string): number | undefined {
  const match = /^btime\s+(\d+)/m.exec(stat);
  return match ? Number(match[1]) * 1000 : undefined;
}

function readBootTimeMs(): number | undefined {
  try {
    return bootTimeFrom(readFileSync('/proc/stat', 'utf-8'));
  } catch {
    return undefined;
  }
}

async function readBootTimeMsAsync(): Promise<number | undefined> {
  try {
    return bootTimeFrom(await readFile('/proc/stat', 'utf-8'));
  } catch {
    return undefined;
  }
}

function isTerminal(target: string): boolean {
  return target.startsWith('/dev/pts/') || (target.startsWith('/dev/tty') && target !== '/dev/tty');
}

function readControllingTty(pid: number): string | undefined {
  for (const fd of ['0', '1', '2']) {
    try {
      const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      if (isTerminal(target)) return target;
    } catch {
      // fd absent or not readable, try the next one.
    }
  }
  return undefined;
}

async function readControllingTtyAsync(pid: number): Promise<string | undefined> {
  for (const fd of ['0', '1', '2']) {
    try {
      const target = await readlink(`/proc/${pid}/fd/${fd}`);
      if (isTerminal(target)) return target;
    } catch {
      // fd absent or not readable, try the next one.
    }
  }
  return undefined;
}

/** The numeric facts of one `/proc/<pid>/stat` line, or null when it cannot be parsed. */
function parseStat(stat: string, bootMs: number | undefined): Pick<ObservedRawProcess, 'ppid' | 'startedAt' | 'cpuSeconds'> | null {
  // comm can contain spaces/parens; it is the substring between the first
  // '(' and the last ')'. Every numeric field follows the last ')'.
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const after = stat.slice(close + 2).split(' ');
  // after[0]=state, after[1]=ppid, after[11]=utime, after[12]=stime, after[19]=starttime (0-based).
  const ppid = Number(after[1] ?? 0);
  const utime = Number(after[11] ?? 0);
  const stime = Number(after[12] ?? 0);
  const starttime = Number(after[19] ?? 0);
  const cpuSeconds = (utime + stime) / CLOCK_TICKS;
  const startedAt = bootMs !== undefined && Number.isFinite(starttime)
    ? bootMs + (starttime / CLOCK_TICKS) * 1000
    : undefined;
  return { ppid, startedAt, cpuSeconds: Number.isFinite(cpuSeconds) ? cpuSeconds : 0 };
}

function joinCmdline(raw: string): string {
  return raw.replace(/\0+$/, '').split('\0').join(' ');
}

/** Processes read at once by the asynchronous walk. */
const PROC_READ_BATCH = 32;

/**
 * The real process-table reader over Linux `/proc`. Every field is read from a
 * pseudo-file or a symlink, no child process is spawned and no target process
 * is signalled or probed. Only a process whose command line is a coding agent
 * has its working directory and terminal read (the classifier reports nothing
 * else), so a walk costs two small reads per process. On a host without
 * `/proc` (non-Linux) it yields an empty set, so detection is honestly quiet
 * rather than wrong.
 */
export function defaultProcessTableReader(): ProcessTableReader {
  return {
    read(): readonly ObservedRawProcess[] {
      if (!existsSync('/proc')) return [];
      const bootMs = readBootTimeMs();
      const rows: ObservedRawProcess[] = [];
      let entries: string[];
      try {
        entries = readdirSync('/proc');
      } catch {
        return [];
      }
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        let facts: ReturnType<typeof parseStat>;
        let args: string;
        try {
          facts = parseStat(readFileSync(`/proc/${entry}/stat`, 'utf-8'), bootMs);
          args = joinCmdline(readFileSync(`/proc/${entry}/cmdline`, 'utf-8'));
        } catch {
          continue; // process exited between readdir and read, skip quietly.
        }
        if (!facts || !args) continue; // kernel threads have an empty cmdline, never agents.
        const agent = classifyExternalKind(args) !== null;
        let cwd: string | undefined;
        if (agent) {
          try { cwd = readlinkSync(`/proc/${entry}/cwd`); } catch { cwd = undefined; }
        }
        rows.push({ pid, ...facts, args, tty: agent ? readControllingTty(pid) : undefined, cwd });
      }
      return rows;
    },
    async readAsync(): Promise<readonly ObservedRawProcess[]> {
      if (!existsSync('/proc')) return [];
      const bootMs = await readBootTimeMsAsync();
      let entries: string[];
      try {
        entries = await readdir('/proc');
      } catch {
        return [];
      }
      const pids = entries.filter((entry) => /^\d+$/.test(entry));
      const readOne = async (entry: string): Promise<ObservedRawProcess | null> => {
        const pid = Number(entry);
        let facts: ReturnType<typeof parseStat>;
        let args: string;
        try {
          facts = parseStat(await readFile(`/proc/${entry}/stat`, 'utf-8'), bootMs);
          args = joinCmdline(await readFile(`/proc/${entry}/cmdline`, 'utf-8'));
        } catch {
          return null; // process exited between readdir and read, skip quietly.
        }
        if (!facts || !args) return null;
        if (classifyExternalKind(args) === null) return { pid, ...facts, args };
        let cwd: string | undefined;
        try { cwd = await readlink(`/proc/${entry}/cwd`); } catch { cwd = undefined; }
        return { pid, ...facts, args, tty: await readControllingTtyAsync(pid), cwd };
      };
      const rows: ObservedRawProcess[] = [];
      for (let start = 0; start < pids.length; start += PROC_READ_BATCH) {
        for (const row of await Promise.all(pids.slice(start, start + PROC_READ_BATCH).map(readOne))) {
          if (row) rows.push(row);
        }
      }
      return rows;
    },
  };
}

function parsePaneList(stdout: string): readonly TmuxPaneRow[] {
  const rows: TmuxPaneRow[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(' ');
    if (sep <= 0) continue;
    const tty = trimmed.slice(0, sep);
    const paneId = trimmed.slice(sep + 1).trim();
    if (tty && paneId) rows.push({ paneId, tty });
  }
  return rows;
}

const LIST_PANES_ARGS = ['list-panes', '-a', '-F', '#{pane_tty} #{pane_id}'] as const;

/** tmux's answer when no server runs: a real empty pane list, not a failed read. */
function isNoTmuxServer(stderr: string): boolean {
  return /no server running|error connecting to/i.test(stderr);
}

/** A spawn error that means tmux is not installed: no tmux, so no panes. */
function isMissingProgram(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * The pane list from one finished `tmux list-panes`, or undefined when the read
 * failed. No tmux installed and no tmux server are real empty lists.
 */
function readPaneResult(spawnError: unknown, status: number | null, stdout: string, stderr: string): readonly TmuxPaneRow[] | undefined {
  if (spawnError !== undefined && spawnError !== null) return isMissingProgram(spawnError) ? [] : undefined;
  if (status === 0) return parsePaneList(stdout);
  return isNoTmuxServer(stderr) ? [] : undefined;
}

/**
 * The real tmux pane reader. Runs `tmux list-panes -a -F '#{pane_tty} #{pane_id}'`
 * (read-only; never a state-changing tmux verb, never a shell). No tmux
 * installed, no tmux server, or no panes, yields an empty set, and detection
 * then honestly reports no steer channel for every tty; a read that failed
 * (tmux erred or did not answer in time) yields undefined.
 */
export function defaultTmuxPaneReader(): TmuxPaneReader {
  return {
    listPanes(): readonly TmuxPaneRow[] | undefined {
      let result;
      try {
        result = spawnSync('tmux', [...LIST_PANES_ARGS], {
          encoding: 'utf-8',
          timeout: COMMAND_TIMEOUT_MS,
        });
      } catch (error) {
        return isMissingProgram(error) ? [] : undefined;
      }
      return readPaneResult(result.error, result.status, result.stdout ?? '', result.stderr ?? '');
    },
    listPanesAsync(): Promise<readonly TmuxPaneRow[] | undefined> {
      return new Promise((resolve) => {
        try {
          execFile('tmux', [...LIST_PANES_ARGS], { encoding: 'utf-8', timeout: COMMAND_TIMEOUT_MS }, (error, stdout, stderr) => {
            // A non-zero exit arrives as an error carrying the exit code; tmux's own refusal is read from stderr.
            const exitCode = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null;
            if (exitCode !== null && !error?.killed) resolve(readPaneResult(undefined, exitCode, stdout, stderr));
            else resolve(readPaneResult(error ?? undefined, error ? null : 0, stdout, stderr));
          });
        } catch (error) {
          resolve(isMissingProgram(error) ? [] : undefined);
        }
      });
    },
  };
}
