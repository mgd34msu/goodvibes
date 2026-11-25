/**
 * The routines (schedules) an earlier terminal app kept in its own store,
 * carried to the daemon once.
 *
 * The daemon keeps and runs every schedule: each runs once however many
 * programs are open, and it runs when none is. The terminal app keeps and
 * runs none of its own (its own scheduler, for when no daemon ran, is gone);
 * the Automation place and every other door reach the daemon's schedules.
 * On one machine under one home the terminal app and the daemon keep
 * schedules in the same file, so the daemon already holds what an earlier
 * terminal app kept; only schedules in a file the daemon does not read (a
 * daemon on another machine or under another home) are moved to it, once.
 */
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  AutomationJobStore,
  resolveAutomationStorePath,
  scheduleCreateTimingFields,
  type AutomationJob,
  type AutomationScheduleDefinition,
} from '@goodvibes/engine/platform/platform/automation';
import { GoodVibesError } from '@goodvibes/engine/errors';
import type { OperatorMethodInput } from '@goodvibes/engine/platform';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { describeOperatorRpcError, resolveOperatorRpc, type OperatorRpcAvailable } from './client/operator-endpoint.ts';

type CreateJobInput = OperatorMethodInput<'automation.jobs.create'>;

/** The schedule fields `automation.jobs.create` takes; `kind` names which one carries it. */
export type DaemonScheduleFields =
  | { readonly kind: 'cron'; readonly cron: string; readonly timezone?: string; readonly staggerMs?: number }
  | { readonly kind: 'every'; readonly every: string }
  | { readonly kind: 'at'; readonly at: string };

/** The daemon's create fields for a schedule this terminal held. */
export function daemonScheduleFields(schedule: AutomationScheduleDefinition): DaemonScheduleFields {
  // One mapping for every door: the automation module's own.
  return scheduleCreateTimingFields(schedule) as DaemonScheduleFields;
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

/** One move per routine file at a time in this process (start-up and an attach can overlap). */
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
  return `${count} schedule(s) in ${path} are not running: the daemon, which runs every schedule, could not be reached (${reason}). `
    + 'Start the daemon (goodvibes service start); this terminal hands them to it as soon as it reaches it.';
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
 * again by the next attach to the daemon or start.
 * Cost: one file read and one `automation.jobs.list` the first time in a
 * process; nothing after that once the file is settled.
 */
export async function moveTerminalRoutinesToDaemon(
  configManager: Pick<ConfigManager, 'getControlPlaneConfigDir'>,
  rpc: OperatorRpcAvailable,
): Promise<TerminalRoutineMove> {
  const path = terminalRoutineStorePath(configManager);
  if (!path) return NOTHING_MOVED;
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
  return { moved: 0, waiting: false, lines: [`This terminal's schedule file ${path} could not be read (${summarizeError(error)}); its schedules were not moved to the daemon. Fix or remove the file; they are moved at the next start.`] };
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
      : `still in ${path} and tried again at the next start`;
    return { moved: sent.moved.length, waiting: sent.daemonStopped, lines: moveLines({ ...sent, skipped: [] }, keptNote) };
  }
  retireMovedStore(path, now, new Set([...held, ...sent.movedIds]));
  if (sent.moved.length === 0 && sent.skipped.length === 0) return NOTHING_MOVED;
  return { moved: sent.moved.length, waiting: false, lines: moveLines(sent, '') };
}

/**
 * Renames a routine file whose routines are all on the daemon, so an earlier
 * terminal app put back by a rollback never runs them as well. A routine added
 * to the file since it was read (an earlier terminal app wrote it in between)
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

/** What this terminal does with its schedule file now: hand what is in it to the daemon, or say why it waits. */
async function moveForStart(deps: {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string;
}): Promise<TerminalRoutineMove> {
  const { configManager } = deps;
  const rpc = resolveOperatorRpc({ configManager, homeDirectory: deps.homeDirectory });
  if (rpc.available) return moveTerminalRoutinesToDaemon(configManager, rpc);
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
 * Start-up step, run when automation is on: move any schedules an earlier
 * terminal app kept to the daemon (nothing runs here), and say so when they
 * could not be moved, since then they run nowhere. Returns lines worth showing.
 */
export async function startTerminalRoutines(deps: {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string;
}): Promise<readonly string[]> {
  return (await moveForStart(deps)).lines;
}

/**
 * Run after this terminal attaches to the daemon: when an earlier try left
 * routines running nowhere because the daemon could not be reached, try the
 * move again. Lines are returned only when something changed; the person was
 * already told the routines were waiting. Free when nothing is waiting.
 */
export async function retryTerminalRoutineMove(deps: {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string;
}): Promise<readonly string[]> {
  const path = terminalRoutineStorePath(deps.configManager);
  if (!path || !waitingStores.has(path)) return [];
  const move = await moveForStart(deps);
  return move.waiting ? [] : move.lines;
}
