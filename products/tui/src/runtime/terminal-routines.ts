/**
 * Where this terminal's scheduled routines are kept and run.
 *
 * With the daemon on (`daemon.enabled`, the default) the daemon's automation
 * owner keeps and runs every routine: it runs once however many terminals are
 * open, and it runs when none is. The terminal arms no timers; `/schedule` is a
 * client of `automation.jobs.*`. On one machine under one home the terminal and
 * the daemon keep routines in the same file, so the daemon already runs what the
 * terminal kept; only routines in a file the daemon does not read (a daemon on
 * another machine or under another home) are moved to it, once.
 *
 * With the daemon off there is nothing that is always there, so the terminal's
 * own manager runs the routines, in exactly one terminal on this machine: the
 * one holding the store's process lock. The kernel releases that lock when the
 * holder exits, however it exits, and another open terminal takes it over on
 * its next try.
 */
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  AutomationJobStore,
  resolveAutomationStorePath,
  type AutomationJob,
  type AutomationManager,
  type AutomationScheduleDefinition,
} from '@goodvibes/engine/platform/platform/automation';
import { GoodVibesError } from '@goodvibes/engine/errors';
import type { OperatorMethodInput } from '@goodvibes/engine/platform';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { scheduleTimingFields } from '@goodvibes/engine/terminal-shell/schedule-command';
import { resolveDaemonEnabled } from '@goodvibes/engine/platform/platform/config';
import { writeJsonFileAtomic } from '@goodvibes/engine/platform/platform/state/durable-file-io';
import { holdProcessLock, logger, summarizeError, type HeldProcessLock } from '@goodvibes/engine/platform/platform/utils';
import { describeOperatorRpcError, resolveOperatorRpc, type OperatorRpcAvailable } from './client/operator-endpoint.ts';

type CreateJobInput = OperatorMethodInput<'automation.jobs.create'>;

/** The schedule fields `automation.jobs.create` takes; `kind` names which one carries it. */
export type DaemonScheduleFields =
  | { readonly kind: 'cron'; readonly cron: string; readonly timezone?: string; readonly staggerMs?: number }
  | { readonly kind: 'every'; readonly every: string }
  | { readonly kind: 'at'; readonly at: string };

/** How often a terminal that does not hold the routine lock (daemon off) tries to take it over. */
const TAKEOVER_RETRY_MS = 60_000;

/** The daemon's create fields for a schedule this terminal read or held. */
export function daemonScheduleFields(schedule: AutomationScheduleDefinition): DaemonScheduleFields {
  // One mapping for both terminal apps: /schedule's own (terminal-shell/schedule-command.ts).
  return scheduleTimingFields(schedule) as DaemonScheduleFields;
}

/** This terminal's own routine file, or null when the config manager names no control-plane directory. */
export function terminalRoutineStorePath(configManager: Pick<ConfigManager, 'getControlPlaneConfigDir'>): string | null {
  try {
    return resolveAutomationStorePath('automation-jobs.json', configManager);
  } catch {
    return null;
  }
}

/**
 * The create body as sent. Its fields are built from typed values; the daemon's
 * create schema checks it again and names any field it refuses.
 */
export function daemonCreateInput(body: Record<string, unknown>): CreateJobInput {
  return body as unknown as CreateJobInput;
}

/**
 * The daemon create input for a routine this terminal kept in its own store.
 * It keeps the routine's id, so the routine is listed under the same id after
 * the move and a create sent again (its reply was lost) returns the first one.
 */
function moveInput(job: AutomationJob): CreateJobInput {
  const execution = job.execution;
  return daemonCreateInput({
    ...daemonScheduleFields(job.schedule),
    id: job.id,
    name: job.name,
    prompt: execution.prompt ?? job.description ?? job.name,
    ...(job.description ? { description: job.description } : {}),
    ...(execution.modelId ? { model: execution.modelId } : {}),
    ...(execution.modelProvider ? { provider: execution.modelProvider } : {}),
    ...(execution.fallbackModels?.length ? { fallbackModels: [...execution.fallbackModels] } : {}),
    ...(execution.template ? { template: execution.template } : {}),
    target: execution.target,
    ...(execution.reasoningEffort ? { reasoningEffort: execution.reasoningEffort } : {}),
    ...(execution.thinking ? { thinking: execution.thinking } : {}),
    ...(execution.wakeMode ? { wakeMode: execution.wakeMode } : {}),
    ...(execution.timeoutMs !== undefined ? { timeoutMs: execution.timeoutMs } : {}),
    ...(execution.toolAllowlist?.length ? { toolAllowlist: [...execution.toolAllowlist] } : {}),
    ...(execution.allowUnsafeExternalContent !== undefined ? { allowUnsafeExternalContent: execution.allowUnsafeExternalContent } : {}),
    ...(execution.externalContentSource ? { externalContentSource: execution.externalContentSource } : {}),
    ...(execution.lightContext !== undefined ? { lightContext: execution.lightContext } : {}),
    enabled: job.enabled,
    deleteAfterRun: job.deleteAfterRun,
  });
}

/** A refusal of that one routine (4xx); anything else means the daemon could not take routines now. */
function refusedOnlyThisRoutine(error: unknown): boolean {
  return error instanceof GoodVibesError && typeof error.status === 'number' && error.status >= 400 && error.status < 500
    && error.status !== 401 && error.status !== 403 && error.status !== 404 && error.status !== 408 && error.status !== 429;
}

export interface TerminalRoutineMove {
  readonly moved: number;
  /** Lines for the person; empty when there was nothing to move. */
  readonly lines: readonly string[];
  /**
   * True while routines in this terminal's store run nowhere because the
   * daemon could not be reached; the next attach to the daemon tries again.
   */
  readonly waiting: boolean;
}

const NOTHING_MOVED: TerminalRoutineMove = { moved: 0, lines: [], waiting: false };

/**
 * Routine files this process found nothing to move from: the daemon already
 * holds their routines (it reads the same file: same home on this machine, the
 * default setup), or none is left to move. Later calls skip them at no cost.
 */
const settledStores = new Set<string>();

/** Routine files whose routines were left running nowhere because the daemon could not be reached. */
const waitingStores = new Set<string>();

/** One move per routine file at a time in this process (start-up, an attach and /schedule can overlap). */
const movesInFlight = new Map<string, Promise<TerminalRoutineMove>>();

/** Routine files this process found no claimed copy of (see recoverClaimedStore). */
const recoveredStores = new Set<string>();

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Earlier builds renamed the routine file to `<path>.moving-<pid>-<ts>` before
 * sending its routines, so a terminal that exited mid-move left them in a file
 * nothing read. When the store path is free and the process that claimed such
 * a file is gone, the newest one is put back so its routines are moved (or run)
 * again. Cost: one directory read per process, and only while the store path
 * is absent.
 */
function recoverClaimedStore(path: string): void {
  if (recoveredStores.has(path) || existsSync(path)) return;
  const prefix = `${basename(path)}.moving-`;
  let claimed: { readonly name: string; readonly at: number } | null = null;
  try {
    for (const name of readdirSync(dirname(path))) {
      if (!name.startsWith(prefix)) continue;
      const [pid, at] = name.slice(prefix.length).split('-').map(Number);
      if (!Number.isInteger(pid) || !Number.isFinite(at) || !processIsGone(pid!)) continue;
      if (!claimed || at! > claimed.at) claimed = { name, at: at! };
    }
  } catch {
    recoveredStores.add(path);
    return;
  }
  if (!claimed) {
    recoveredStores.add(path);
    return;
  }
  try {
    renameSync(join(dirname(path), claimed.name), path);
    logger.info('Terminal routines: put back a routine file an interrupted move left claimed', { path, from: claimed.name });
  } catch (error) {
    logger.warn('Terminal routines: a routine file an interrupted move left claimed could not be put back', { path, from: claimed.name, error: summarizeError(error) });
    recoveredStores.add(path);
  }
}

/** The line for routines that run nowhere because the daemon could not be reached. */
function notRunningLine(path: string, count: number, reason: string): string {
  return `${count} routine(s) in ${path} are not running: the daemon could not be reached (${reason}). `
    + 'Start the daemon (goodvibes service start), or set daemon.enabled to false to run them in this terminal; '
    + 'this terminal hands them to the daemon as soon as it reaches it.';
}

/** A routine that is archived or whose one run time has passed is not moved. */
function finishedRoutine(job: { readonly archivedAt?: unknown; readonly schedule?: unknown }, now: number): boolean {
  if (job.archivedAt !== undefined && job.archivedAt !== null) return true;
  const schedule = job.schedule;
  return typeof schedule === 'object' && schedule !== null
    && (schedule as { kind?: unknown }).kind === 'at'
    && typeof (schedule as { at?: unknown }).at === 'number'
    && (schedule as { at: number }).at <= now;
}

/**
 * The ids in a routine file and those still worth moving, read without the
 * job store: reading through it can write the file (a schedule-phase
 * migration), and this file may be the daemon's live store.
 */
function readRoutineIds(path: string, now: number): { readonly all: readonly string[]; readonly movable: readonly string[] } {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  const rows = typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { jobs?: unknown }).jobs)
    ? (parsed as { jobs: readonly unknown[] }).jobs : [];
  const all: string[] = [];
  const movable: string[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const id = (row as { id?: unknown }).id;
    if (typeof id !== 'string' || !id) continue;
    all.push(id);
    if (!finishedRoutine(row as { archivedAt?: unknown; schedule?: unknown }, now)) movable.push(id);
  }
  return { all, movable };
}

/** The ids of the routines the daemon holds now. */
async function daemonRoutineIds(rpc: OperatorRpcAvailable): Promise<ReadonlySet<string>> {
  const output = await rpc.platformClient.operator.invoke('automation.jobs.list', {});
  const jobs = output.items as readonly { readonly id: string }[];
  return new Set(jobs.map((job) => job.id));
}

interface SentRoutines {
  readonly moved: readonly string[];
  readonly movedIds: readonly string[];
  readonly skipped: readonly string[];
  readonly kept: readonly AutomationJob[];
  readonly failures: readonly string[];
  /** The daemon stopped answering part way; the kept routines were not refused, only not sent. */
  readonly daemonStopped: boolean;
}

/**
 * Sends each routine to the daemon under its own id, stopping at the first
 * failure that is not a refusal of that one routine (the daemon stopped
 * answering); the rest are kept to be tried again.
 */
async function sendRoutines(rpc: OperatorRpcAvailable, jobs: readonly AutomationJob[], now: number, held: ReadonlySet<string>): Promise<SentRoutines> {
  const moved: string[] = [];
  const movedIds: string[] = [];
  const skipped: string[] = [];
  const kept: AutomationJob[] = [];
  const failures: string[] = [];
  let daemonStopped = false;
  for (const job of jobs) {
    if (held.has(job.id)) continue;
    if (finishedRoutine(job, now)) {
      skipped.push(job.name);
      continue;
    }
    if (daemonStopped) {
      kept.push(job);
      continue;
    }
    try {
      const created = await rpc.platformClient.operator.invoke('automation.jobs.create', moveInput(job));
      moved.push(`${created.id} (${job.name})`);
      movedIds.push(job.id);
    } catch (error) {
      kept.push(job);
      failures.push(`${job.name}: ${describeOperatorRpcError(error)}`);
      daemonStopped = !refusedOnlyThisRoutine(error);
    }
  }
  return { moved, movedIds, skipped, kept, failures, daemonStopped };
}

function moveLines(sent: SentRoutines, keptNote: string): readonly string[] {
  const lines: string[] = [];
  if (sent.moved.length > 0) {
    lines.push(`Moved ${sent.moved.length} routine(s) from this terminal's own store to the daemon, where each runs once, with or without a terminal open:`);
    lines.push(...sent.moved.map((entry) => `  ${entry}`));
  }
  if (sent.skipped.length > 0) lines.push(`Not moved (finished or past their time): ${sent.skipped.join(', ')}.`);
  if (sent.kept.length > 0) {
    lines.push(`Not moved yet (${sent.kept.length}), ${keptNote}:`);
    lines.push(...sent.failures.map((entry) => `  ${entry}`));
  }
  return lines;
}

/**
 * Moves routines this terminal kept in a store the daemon does not read (a
 * daemon on another machine or under another home) to the daemon, once.
 * Whether the daemon reads the file is decided from the ids: the daemon holds
 * every routine of its own store, so when it already holds every routine still
 * to run, the file is its own store (the default setup: the terminal and the
 * daemon keep routines in the same file) or was moved already, and it is left
 * alone. Otherwise the routines it does not hold are sent from the file where
 * it is: each keeps its id, so a create sent twice (two terminals starting
 * together, or a reply that was lost) returns the first one instead of a copy,
 * and a terminal that exits part way leaves every unsent routine in the file
 * for the next start. Only once every routine still to run is on the daemon is
 * the file renamed out of the way. A routine the daemon refused, or one not
 * sent because the daemon stopped answering, stays in the file and is tried
 * again by the next attach to the daemon, `/schedule` or start. The local
 * runner, if this terminal ran routines while the daemon was off, stops first.
 * Cost: one file read and one `automation.jobs.list` the first time in a
 * process; nothing after that once the file is settled.
 */
export async function moveTerminalRoutinesToDaemon(
  configManager: Pick<ConfigManager, 'getControlPlaneConfigDir'>,
  rpc: OperatorRpcAvailable,
  automationManager?: object,
): Promise<TerminalRoutineMove> {
  const path = terminalRoutineStorePath(configManager);
  if (!path) return NOTHING_MOVED;
  const runner = automationManager ? runners.get(automationManager) : undefined;
  // This terminal ran routines itself (daemon off) and may have added some since the file was settled.
  if (runner?.holdsLock) settledStores.delete(path);
  runner?.release();
  const running = movesInFlight.get(path);
  if (running) return running;
  const move = moveStore(path, rpc)
    .then((result) => {
      if (result.waiting) waitingStores.add(path);
      else waitingStores.delete(path);
      return result;
    })
    .finally(() => movesInFlight.delete(path));
  movesInFlight.set(path, move);
  return move;
}

function unreadableStore(path: string, error: unknown): TerminalRoutineMove {
  return { moved: 0, waiting: false, lines: [`This terminal's routine file ${path} could not be read (${summarizeError(error)}); its routines were not moved to the daemon. Fix or remove the file, then run /schedule list.`] };
}

async function moveStore(path: string, rpc: OperatorRpcAvailable): Promise<TerminalRoutineMove> {
  recoverClaimedStore(path);
  if (settledStores.has(path) || !existsSync(path)) return NOTHING_MOVED;
  const now = Date.now();
  let ids: { readonly all: readonly string[]; readonly movable: readonly string[] };
  try {
    ids = readRoutineIds(path, now);
  } catch (error) {
    return unreadableStore(path, error);
  }
  if (ids.movable.length === 0) {
    settledStores.add(path);
    return NOTHING_MOVED;
  }
  let held: ReadonlySet<string>;
  try {
    held = await daemonRoutineIds(rpc);
  } catch (error) {
    return { moved: 0, waiting: true, lines: [notRunningLine(path, ids.movable.length, describeOperatorRpcError(error))] };
  }
  if (ids.movable.every((id) => held.has(id))) {
    settledStores.add(path);
    return NOTHING_MOVED;
  }
  let jobs: readonly AutomationJob[];
  try {
    jobs = (await new AutomationJobStore({ path }).load()).jobs;
  } catch (error) {
    return unreadableStore(path, error);
  }
  const sent = await sendRoutines(rpc, jobs, now, held);
  if (sent.kept.length > 0) {
    // Finished routines are named once, when the file is retired, not on every retry.
    const keptNote = sent.daemonStopped
      ? `still in ${path}; they are not running until they reach the daemon, and this terminal tries again as soon as it reaches it`
      : `still in ${path} and tried again by the next /schedule`;
    return { moved: sent.moved.length, waiting: sent.daemonStopped, lines: moveLines({ ...sent, skipped: [] }, keptNote) };
  }
  retireMovedStore(path, now, new Set([...held, ...sent.movedIds]));
  if (sent.moved.length === 0 && sent.skipped.length === 0) return NOTHING_MOVED;
  return { moved: sent.moved.length, waiting: false, lines: moveLines(sent, '') };
}

/**
 * Renames a routine file whose routines are all on the daemon, so this terminal
 * never runs them as well if the daemon is turned off later. A routine added to
 * the file since it was read (this terminal ran with the daemon off in between)
 * keeps the file in place for the next start to send.
 */
function retireMovedStore(path: string, now: number, onDaemon: ReadonlySet<string>): void {
  try {
    if (!readRoutineIds(path, now).movable.every((id) => onDaemon.has(id))) return;
    renameSync(path, `${path}.moved-to-daemon-${now}`);
    settledStores.add(path);
  } catch (error) {
    // Left in place: the next start finds every routine on the daemon and leaves it alone.
    logger.warn('Terminal routines: a moved routine file could not be renamed', { path, error: summarizeError(error) });
  }
}

/**
 * Runs this terminal's own routines while the daemon is off, in one terminal
 * per machine. `ensure` takes the lock when it is free and starts the manager;
 * when another terminal holds it, it tries again once a minute (one SQLite open
 * per try, daemon off only) so routines keep running after that terminal exits.
 */
export class LocalRoutineRunner {
  #lock: HeldProcessLock | null = null;
  #retry: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly manager: Pick<AutomationManager, 'start' | 'stop'>,
    private readonly lockPath: string,
  ) {}

  /** True while this terminal holds the lock and its manager runs the routines. */
  get holdsLock(): boolean {
    return this.#lock !== null;
  }

  async ensure(): Promise<boolean> {
    if (this.#lock) return true;
    let lock: HeldProcessLock | null;
    try {
      lock = holdProcessLock(this.lockPath);
    } catch (error) {
      logger.warn('Local routines: the routine lock could not be opened', { lockPath: this.lockPath, error: summarizeError(error) });
      return false;
    }
    if (!lock) {
      this.#armRetry();
      return false;
    }
    this.#lock = lock;
    if (this.#retry) clearInterval(this.#retry);
    this.#retry = null;
    try {
      await this.manager.start();
    } catch (error) {
      // The lock is freed, and the takeover check stays armed so routines start
      // once the manager can; only shutdown or a daemon takeover ends the retry.
      this.#releaseLock();
      this.#armRetry();
      throw error;
    }
    return true;
  }

  /** Stops the manager's timers and hands the lock back (the daemon took over, or the terminal is closing). */
  release(): void {
    if (this.#retry) clearInterval(this.#retry);
    this.#retry = null;
    this.#releaseLock();
  }

  /** Stops the manager and frees the lock, leaving the takeover check as it is. */
  #releaseLock(): void {
    if (!this.#lock) return;
    this.manager.stop();
    this.#lock.release();
    this.#lock = null;
  }

  #armRetry(): void {
    if (this.#retry !== null) return;
    const retry = setInterval(() => { void this.#retryTick(); }, TAKEOVER_RETRY_MS);
    retry.unref?.();
    this.#retry = retry;
  }

  /** One takeover check; a manager that fails to start is logged and tried again at the next check, never thrown into nothing. */
  async #retryTick(): Promise<void> {
    try {
      await this.ensure();
    } catch (error) {
      logger.warn('Local routines: the routines could not be started; trying again at the next takeover check', { lockPath: this.lockPath, error: summarizeError(error) });
    }
  }
}

const runners = new WeakMap<object, LocalRoutineRunner>();

/**
 * True only while this terminal runs routines itself (daemon off, lock held).
 * A wake's catch-up heartbeat starts the manager, so it is sent only then:
 * otherwise every terminal would arm the routine timers on each wake.
 */
export function terminalRunsRoutines(manager: object): boolean {
  return runners.get(manager)?.holdsLock ?? false;
}

/** The one runner for this terminal's manager; null when its store has no path. */
export function localRoutineRunnerFor(
  manager: Pick<AutomationManager, 'start' | 'stop'>,
  configManager: Pick<ConfigManager, 'getControlPlaneConfigDir'>,
): LocalRoutineRunner | null {
  const existing = runners.get(manager);
  if (existing) return existing;
  const storePath = terminalRoutineStorePath(configManager);
  if (!storePath) return null;
  const runner = new LocalRoutineRunner(manager, `${storePath}.writer.sqlite`);
  runners.set(manager, runner);
  return runner;
}

/** What a terminal with the daemon setting on does with its routine file now. */
async function moveForStart(deps: {
  readonly configManager: ConfigManager;
  readonly automationManager: Pick<AutomationManager, 'start' | 'stop'>;
  readonly homeDirectory: string;
}): Promise<TerminalRoutineMove> {
  const { configManager, automationManager } = deps;
  const rpc = resolveOperatorRpc({ configManager, homeDirectory: deps.homeDirectory });
  if (rpc.available) return moveTerminalRoutinesToDaemon(configManager, rpc, automationManager);
  const path = terminalRoutineStorePath(configManager);
  if (!path) return NOTHING_MOVED;
  recoverClaimedStore(path);
  if (!existsSync(path)) return NOTHING_MOVED;
  let movable: number;
  try {
    movable = readRoutineIds(path, Date.now()).movable.length;
  } catch (error) {
    return unreadableStore(path, error);
  }
  if (movable === 0) return NOTHING_MOVED;
  waitingStores.add(path);
  return { moved: 0, waiting: true, lines: [notRunningLine(path, movable, rpc.reason)] };
}

/**
 * Start-up step, run when automation is on: with the daemon on, move any
 * routines this terminal kept to it (nothing runs here), and say so when they
 * could not be moved, since then they run nowhere; with it off, run them here
 * when this terminal holds the lock. Returns lines worth showing.
 */
export async function startTerminalRoutines(deps: {
  readonly configManager: ConfigManager;
  readonly automationManager: Pick<AutomationManager, 'start' | 'stop'>;
  readonly homeDirectory: string;
}): Promise<readonly string[]> {
  const { configManager, automationManager } = deps;
  if (resolveDaemonEnabled(configManager)) return (await moveForStart(deps)).lines;
  await localRoutineRunnerFor(automationManager, configManager)?.ensure();
  return [];
}

/**
 * Run after this terminal attaches to the daemon: when an earlier try left
 * routines running nowhere because the daemon could not be reached, try the
 * move again. Lines are returned only when something changed; the person was
 * already told the routines were waiting. Free when nothing is waiting.
 */
export async function retryTerminalRoutineMove(deps: {
  readonly configManager: ConfigManager;
  readonly automationManager: Pick<AutomationManager, 'start' | 'stop'>;
  readonly homeDirectory: string;
}): Promise<readonly string[]> {
  const path = terminalRoutineStorePath(deps.configManager);
  if (!path || !waitingStores.has(path) || !resolveDaemonEnabled(deps.configManager)) return [];
  const move = await moveForStart(deps);
  return move.waiting ? [] : move.lines;
}
