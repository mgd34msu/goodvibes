/**
 * observed/source.ts, the ObservedAgentSource: the fleet's read-only view of
 * externally-launched coding-agent sessions on this host, plus the one genuine
 * steer channel (tmux send-keys) where a foreign session exposes it.
 *
 * Responsibility boundary (owner ruling): these rows are OBSERVED, not owned.
 * The source is composed as an OPTIONAL registry dep and is deliberately NOT a
 * source in fleet-count.ts, so an observed row can never count against
 * fleet.maxSize (proven structurally, not by a filter). Stop is never offered.
 * Steering rides whatever channel the foreign session genuinely exposes and
 * honestly says when there is none.
 *
 * Cost: detection runs at most once per `refreshIntervalMs` (a lazy TTL over the
 * injected clock), and only while something reads the rows (the fleet view or a
 * needs-input push). A read never waits for it: it returns the rows of the last
 * scan and starts the next one in the background, which walks `/proc` without
 * blocking the event loop and tells `onRefresh` listeners when it lands. tmux
 * is asked for its panes only when a session appears on a terminal not seen
 * before, and again, synchronously, right before a steer types. The CPU-delta
 * that drives liveness is measured across scan boundaries, so `active`/`quiet`
 * reflects CPU burned since the last scan, not per-query noise.
 */
import type { ObservedAgentKind, ObservedLiveness, ObservedSteerChannel, SteerOptions, SteerResult, SteerStep } from '../types.js';
import {
  classifyObservedProcesses,
  defaultProcessTableReader,
  defaultTmuxPaneReader,
  paneForTty,
  type ClassifiedObservedProcess,
  type ObservedRawProcess,
  type ProcessTableReader,
  type TmuxPaneReader,
  type TmuxPaneRow,
} from './detect.js';
import { spawnSync } from 'node:child_process';

/** One observed foreign coding-agent session, assembled read-only. The adapter turns this into a ProcessNode. */
export interface ObservedAgentRow {
  readonly externalKind: ObservedAgentKind;
  readonly pid: number;
  readonly ppid: number;
  /** Full command line, the adapter derives the row label from it. */
  readonly args: string;
  readonly cwd?: string | undefined;
  readonly startedAt?: number | undefined;
  readonly liveness: ObservedLiveness;
  readonly steer: ObservedSteerChannel;
}

/** Injectable tmux command runner for the steer send-keys, read/write to the pane only, never a shell. */
export interface TmuxCommandRunner {
  run(args: readonly string[]): { readonly status: number | null; readonly stderr: string };
}

const STEER_TIMEOUT_MS = 5_000;

/** Real send-keys runner: spawnSync tmux, hard timeout, never a shell. */
export function defaultTmuxCommandRunner(): TmuxCommandRunner {
  return {
    run(args) {
      try {
        const result = spawnSync('tmux', [...args], { encoding: 'utf-8', timeout: STEER_TIMEOUT_MS });
        return { status: result.status, stderr: result.stderr ?? '' };
      } catch (error) {
        return { status: null, stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export interface ObservedAgentSourceDeps {
  readonly processReader?: ProcessTableReader | undefined;
  readonly paneReader?: TmuxPaneReader | undefined;
  readonly steerRunner?: TmuxCommandRunner | undefined;
  readonly now?: (() => number) | undefined;
  /** Detection cadence, at most one scan per this many ms (default 10000). */
  readonly refreshIntervalMs?: number | undefined;
  /**
   * The pid whose process tree this runtime owns (default: this process).
   * Sessions it spawned or hosts, an ACP-hosted `codex acp` for one, have
   * their own fleet rows and are never reported as observed.
   */
  readonly ownPid?: number | undefined;
}

const DEFAULT_REFRESH_INTERVAL_MS = 10_000;

/** What a fleet row shows of the observed sessions, to tell a scan that changed nothing. */
function rowsSignature(rows: readonly ObservedAgentRow[]): string {
  return rows.map((row) => `${row.pid}:${row.liveness.state}:${row.steer.kind}`).join('|');
}

function livenessDetail(state: 'active' | 'quiet', firstSighting: boolean): string {
  if (firstSighting) return 'first observation, no prior CPU sample to compare yet';
  return state === 'active'
    ? 'CPU advanced since the last sample, the session is doing work'
    : 'no CPU burned since the last sample, quiet, but this is not proof it is idle (it may be waiting on the network or on a human)';
}

/**
 * The observed-agent source. `list()` returns the current observed rows,
 * refreshing the read-only scan at most once per `refreshIntervalMs`. `steer()`
 * drives a tmux-hosted foreign session with the exact three-send recipe.
 */
export class ObservedAgentSource {
  private readonly processReader: ProcessTableReader;
  private readonly paneReader: TmuxPaneReader;
  private readonly steerRunner: TmuxCommandRunner;
  private readonly now: () => number;
  private readonly refreshIntervalMs: number;
  private readonly ownPid: number;

  /** pid → cumulative CPU seconds at the previous refresh (the liveness delta baseline). */
  private readonly cpuByPid = new Map<number, number>();
  private cached: readonly ObservedAgentRow[] = [];
  private lastScanAt = 0;
  private scanned = false;
  private scanning: Promise<void> | undefined;
  /** tty → the tmux pane hosting it (or none), from the last pane read. */
  private readonly paneByTty = new Map<string, TmuxPaneRow | null>();
  private readonly refreshListeners = new Set<() => void>();

  constructor(deps: ObservedAgentSourceDeps = {}) {
    this.processReader = deps.processReader ?? defaultProcessTableReader();
    this.paneReader = deps.paneReader ?? defaultTmuxPaneReader();
    this.steerRunner = deps.steerRunner ?? defaultTmuxCommandRunner();
    this.now = deps.now ?? ((): number => Date.now());
    this.refreshIntervalMs = deps.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.ownPid = deps.ownPid ?? process.pid;
  }

  /**
   * Current observed rows. Re-scans (read-only) at most once per refresh
   * interval; with an asynchronous reader the scan runs in the background and
   * this returns the last scan's rows at once.
   */
  list(): readonly ObservedAgentRow[] {
    const at = this.now();
    if (this.scanned && at - this.lastScanAt < this.refreshIntervalMs) return this.cached;
    this.lastScanAt = at;
    const readAsync = this.processReader.readAsync?.bind(this.processReader);
    if (!readAsync) {
      const processes = this.processReader.read();
      this.cached = this.rowsFrom(this.panesFor(processes, () => this.paneReader.listPanes()));
      this.scanned = true;
      return this.cached;
    }
    this.scanning ??= (async () => {
      try {
        const processes = await readAsync();
        const listAsync = this.paneReader.listPanesAsync?.bind(this.paneReader);
        const classified = await this.panesForAsync(processes, listAsync ?? (async () => this.paneReader.listPanes()));
        const before = rowsSignature(this.cached);
        this.cached = this.rowsFrom(classified);
        const firstScan = !this.scanned;
        this.scanned = true;
        if (!firstScan && rowsSignature(this.cached) === before) return;
        for (const listener of this.refreshListeners) {
          try { listener(); } catch { /* A listener cannot stop the next one being told. */ }
        }
      } catch {
        // An unreadable process table leaves the last rows in place until the next scan.
      } finally {
        this.scanning = undefined;
      }
    })();
    return this.cached;
  }

  /** Be told when a background scan lands new rows. Returns the unsubscribe. */
  onRefresh(listener: () => void): () => void {
    this.refreshListeners.add(listener);
    return () => { this.refreshListeners.delete(listener); };
  }

  /** The terminals of the agent sessions in `processes` that the pane cache has not seen. */
  private unseenTtys(processes: readonly ObservedRawProcess[]): { classified: ClassifiedObservedProcess[]; unseen: boolean } {
    const classified = classifyObservedProcesses(processes, new Set([this.ownPid]));
    return { classified, unseen: classified.some((proc) => proc.tty !== undefined && !this.paneByTty.has(proc.tty)) };
  }

  /**
   * Keep the pane of each live session's terminal: a fresh pane read replaces
   * it, otherwise the cached mapping stands (a steer reads the panes again
   * before it types). Terminals no session uses any more are forgotten.
   */
  private rememberPanes(classified: readonly ClassifiedObservedProcess[], panes: readonly TmuxPaneRow[] | undefined): readonly ClassifiedObservedProcess[] {
    const live = new Set(classified.flatMap((proc) => (proc.tty ? [proc.tty] : [])));
    for (const tty of [...this.paneByTty.keys()]) if (!live.has(tty)) this.paneByTty.delete(tty);
    if (panes) for (const tty of live) this.paneByTty.set(tty, paneForTty(panes, tty) ?? null);
    return classified;
  }

  private panesFor(processes: readonly ObservedRawProcess[], listPanes: () => readonly TmuxPaneRow[]): readonly ClassifiedObservedProcess[] {
    const { classified, unseen } = this.unseenTtys(processes);
    return this.rememberPanes(classified, unseen ? listPanes() : undefined);
  }

  private async panesForAsync(processes: readonly ObservedRawProcess[], listPanes: () => Promise<readonly TmuxPaneRow[]>): Promise<readonly ClassifiedObservedProcess[]> {
    const { classified, unseen } = this.unseenTtys(processes);
    return this.rememberPanes(classified, unseen ? await listPanes() : undefined);
  }

  private rowsFrom(classified: readonly ClassifiedObservedProcess[]): readonly ObservedAgentRow[] {
    const rows: ObservedAgentRow[] = [];
    const seenPids = new Set<number>();
    for (const proc of classified) {
      seenPids.add(proc.pid);
      const prior = this.cpuByPid.get(proc.pid);
      const firstSighting = prior === undefined;
      const state: 'active' | 'quiet' = !firstSighting && proc.cpuSeconds > prior ? 'active' : 'quiet';
      this.cpuByPid.set(proc.pid, proc.cpuSeconds);
      const pane = proc.tty ? this.paneByTty.get(proc.tty) ?? undefined : undefined;
      const steer: ObservedSteerChannel = pane
        ? { kind: 'tmux', paneId: pane.paneId, tty: pane.tty }
        : {
            kind: 'none',
            reason: proc.tty
              ? `no tmux pane maps to this session's terminal (${proc.tty})`
              : 'the session has no controlling terminal to steer through',
          };
      rows.push({
        externalKind: proc.externalKind,
        pid: proc.pid,
        ppid: proc.ppid,
        args: proc.args,
        cwd: proc.cwd,
        startedAt: proc.startedAt,
        liveness: { state, cpuSeconds: proc.cpuSeconds, detail: livenessDetail(state, firstSighting) },
        steer,
      });
    }
    // Prune CPU baselines for pids that are gone so the map cannot grow unbounded.
    for (const pid of [...this.cpuByPid.keys()]) {
      if (!seenPids.has(pid)) this.cpuByPid.delete(pid);
    }
    return rows;
  }

  /**
   * Type text into a tmux-hosted foreign session: one send carries the literal
   * text and, only when `submit` is true, two separate Enter sends follow.
   * Without submit the text waits in the pane for the person there, so a
   * pending dialog where Enter means "yes" is never answered by this call. An
   * honest refusal (queued:false, nothing sent) when the row exposes no tmux
   * channel, when the session is no longer there, or when the first send-keys
   * call fails; `queued: 'partial'` with the steps that went out when a later
   * one fails. STOP is never offered here, this is steer only.
   *
   * The row is up to a refresh interval old, and text typed into a pane whose
   * agent has exited would land in whatever has the terminal now, so the
   * process table and the pane list are read again first: the same process
   * must still be running on the same terminal, and that terminal must still be
   * the pane the row names.
   */
  steer(row: ObservedAgentRow, text: string, options?: SteerOptions): SteerResult {
    if (row.steer.kind !== 'tmux') {
      return { queued: false, reason: `this session cannot be steered: ${row.steer.reason}` };
    }
    const pane = row.steer.paneId;
    const current = classifyObservedProcesses(this.processReader.read(), new Set([this.ownPid])).find((proc) => proc.pid === row.pid);
    if (!current || current.externalKind !== row.externalKind || (row.startedAt !== undefined && current.startedAt !== row.startedAt)) {
      return { queued: false, reason: `nothing was sent: the observed session (pid ${row.pid}) is no longer running` };
    }
    if (paneForTty(this.paneReader.listPanes(), current.tty)?.paneId !== pane) {
      return { queued: false, reason: `nothing was sent: the session (pid ${row.pid}) is no longer on tmux pane ${pane}` };
    }
    const sends: readonly { readonly step: SteerStep; readonly args: readonly string[] }[] = [
      { step: 'text', args: ['send-keys', '-t', pane, '-l', '--', text] },
      ...(options?.submit === true ? [
        { step: 'Enter' as const, args: ['send-keys', '-t', pane, 'Enter'] },
        { step: 'Enter' as const, args: ['send-keys', '-t', pane, 'Enter'] },
      ] : []),
    ];
    const sent: SteerStep[] = [];
    for (const { step, args } of sends) {
      const result = this.steerRunner.run(args);
      if (result.status !== 0) {
        const detail = result.stderr.trim() || 'tmux send-keys failed';
        // A failure after a step went out is not "nothing was sent": the pane already holds what was typed.
        if (sent.length > 0) {
          return { queued: 'partial', sent, failed: step, reason: `steering ${pane} stopped part way: ${sent.join(' and ')} reached the pane, then sending ${step} failed: ${detail}` };
        }
        return { queued: false, reason: `nothing was sent: steering ${pane} failed: ${detail}` };
      }
      sent.push(step);
    }
    return { queued: true, messageId: crypto.randomUUID() };
  }
}
