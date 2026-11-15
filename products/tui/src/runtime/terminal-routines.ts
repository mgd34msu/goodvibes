/**
 * Where this terminal's scheduled routines are kept and run.
 *
 * With the daemon on (`daemon.enabled`, the default) the daemon's automation
 * owner keeps and runs every routine: it runs once however many terminals are
 * open, and it runs when none is. The terminal arms no timers; `/schedule` is a
 * client of `automation.jobs.*`, and routines an older terminal kept in its own
 * store are moved to the daemon once.
 *
 * With the daemon off there is nothing that is always there, so the terminal's
 * own manager runs the routines, in exactly one terminal on this machine: the
 * one holding the store's process lock. The kernel releases that lock when the
 * holder exits, however it exits, and another open terminal takes it over on
 * its next try.
 */
import { existsSync, renameSync } from 'node:fs';
import {
  AutomationJobStore,
  formatEveryInterval,
  resolveAutomationStorePath,
  type AutomationJob,
  type AutomationManager,
  type AutomationScheduleDefinition,
} from '@goodvibes-jev/engine/platform/platform/automation';
import { GoodVibesError, type OperatorMethodInput } from '@goodvibes-jev/engine/platform';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { resolveDaemonEnabled } from '@goodvibes-jev/engine/platform/platform/config';
import { writeJsonFileAtomic } from '@goodvibes-jev/engine/platform/platform/state/durable-file-io';
import { holdProcessLock, logger, summarizeError, type HeldProcessLock } from '@goodvibes-jev/engine/platform/platform/utils';
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
  switch (schedule.kind) {
    case 'cron':
      return {
        kind: 'cron', cron: schedule.expression,
        ...(schedule.timezone ? { timezone: schedule.timezone } : {}),
        ...(schedule.staggerMs !== undefined ? { staggerMs: schedule.staggerMs } : {}),
      };
    case 'every':
      return { kind: 'every', every: formatEveryInterval(schedule.intervalMs) };
    case 'at':
      return { kind: 'at', at: new Date(schedule.at).toISOString() };
  }
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

/** The daemon create input for a routine this terminal kept in its own store. */
function moveInput(job: AutomationJob): CreateJobInput {
  const execution = job.execution;
  return daemonCreateInput({
    ...daemonScheduleFields(job.schedule),
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
}

const NOTHING_MOVED: TerminalRoutineMove = { moved: 0, lines: [] };

/**
 * Moves routines this terminal kept in its own store (they ran only while a
 * terminal was open, once per open terminal) to the daemon, once. The file is
 * claimed by renaming it first, so two terminals starting together cannot both
 * create the same routine on the daemon. A routine the daemon refused, or one
 * not sent because the daemon stopped answering, goes back to the file and is
 * tried again by the next `/schedule` or start. The local runner, if this
 * terminal ran routines while the daemon was off, stops first.
 * Cost once moved: one `existsSync` per call.
 */
export async function moveTerminalRoutinesToDaemon(
  configManager: Pick<ConfigManager, 'getControlPlaneConfigDir'>,
  rpc: OperatorRpcAvailable,
  automationManager?: object,
): Promise<TerminalRoutineMove> {
  const path = terminalRoutineStorePath(configManager);
  if (!path || !existsSync(path)) return NOTHING_MOVED;
  if (automationManager) runners.get(automationManager)?.release();
  const now = Date.now();
  const claimed = `${path}.moving-${process.pid}-${now}`;
  try {
    renameSync(path, claimed);
  } catch {
    // Another terminal claimed it a moment ago, or it is gone.
    return NOTHING_MOVED;
  }
  let jobs: readonly AutomationJob[];
  try {
    jobs = (await new AutomationJobStore({ path: claimed }).load()).jobs;
  } catch (error) {
    if (!existsSync(path)) renameSync(claimed, path);
    return { moved: 0, lines: [`This terminal's old routine file ${path} could not be read (${summarizeError(error)}); its routines were not moved to the daemon. Fix or remove the file, then run /schedule list.`] };
  }
  const moved: string[] = [];
  const skipped: string[] = [];
  const kept: AutomationJob[] = [];
  const failures: string[] = [];
  let daemonStopped = false;
  for (const job of jobs) {
    if (job.archivedAt !== undefined || (job.schedule.kind === 'at' && job.schedule.at <= now)) {
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
    } catch (error) {
      kept.push(job);
      failures.push(`${job.name}: ${describeOperatorRpcError(error)}`);
      daemonStopped = !refusedOnlyThisRoutine(error);
    }
  }
  let keptAt = path;
  if (kept.length > 0) {
    // A file at the old path now holds routines made since (daemon off in between); never overwrite it.
    if (existsSync(path)) keptAt = `${path}.not-moved-${now}`;
    writeJsonFileAtomic(keptAt, { version: 1, jobs: kept }, { durable: true, mode: 0o600 });
  }
  renameSync(claimed, `${path}.moved-to-daemon-${now}`);
  if (moved.length === 0 && skipped.length === 0 && failures.length === 0) return NOTHING_MOVED;
  const lines: string[] = [];
  if (moved.length > 0) {
    lines.push(`Moved ${moved.length} routine(s) from this terminal's own store to the daemon, where each runs once, with or without a terminal open:`);
    lines.push(...moved.map((entry) => `  ${entry}`));
  }
  if (skipped.length > 0) lines.push(`Not moved (finished or past their time): ${skipped.join(', ')}.`);
  if (kept.length > 0) {
    lines.push(`Not moved yet (${kept.length}), kept in ${keptAt}${keptAt === path ? ' and tried again by the next /schedule' : '; move that file to the old name to try again'}:`);
    lines.push(...(failures.length > 0 ? failures.map((entry) => `  ${entry}`) : []));
  }
  return { moved: moved.length, lines };
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
      if (this.#retry === null) {
        const retry = setInterval(() => { void this.ensure(); }, TAKEOVER_RETRY_MS);
        retry.unref?.();
        this.#retry = retry;
      }
      return false;
    }
    this.#lock = lock;
    if (this.#retry) clearInterval(this.#retry);
    this.#retry = null;
    try {
      await this.manager.start();
    } catch (error) {
      this.release();
      throw error;
    }
    return true;
  }

  /** Stops the manager's timers and hands the lock back (the daemon took over, or the terminal is closing). */
  release(): void {
    if (this.#retry) clearInterval(this.#retry);
    this.#retry = null;
    if (!this.#lock) return;
    this.manager.stop();
    this.#lock.release();
    this.#lock = null;
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

/**
 * Start-up step, run when automation is on: with the daemon on, move any routines this terminal kept to
 * it (nothing runs here); with it off, run them here when this terminal holds
 * the lock. Returns lines worth showing (only when something was moved).
 */
export async function startTerminalRoutines(deps: {
  readonly configManager: ConfigManager;
  readonly automationManager: Pick<AutomationManager, 'start' | 'stop'>;
  readonly homeDirectory: string;
}): Promise<readonly string[]> {
  const { configManager, automationManager } = deps;
  if (resolveDaemonEnabled(configManager)) {
    const rpc = resolveOperatorRpc({ configManager, homeDirectory: deps.homeDirectory });
    if (!rpc.available) return [];
    const move = await moveTerminalRoutinesToDaemon(configManager, rpc, automationManager);
    if (move.moved === 0) {
      if (move.lines.length > 0) logger.warn('Terminal routines were not moved to the daemon at start', { detail: move.lines.join(' ') });
      return [];
    }
    return move.lines;
  }
  await localRoutineRunnerFor(automationManager, configManager)?.ensure();
  return [];
}
