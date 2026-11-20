import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { AutomationJobStore } from '@goodvibes-jev/engine/platform/platform/automation';
import type { AutomationJob, AutomationScheduleDefinition } from '@goodvibes-jev/engine/platform/platform/automation';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/platform';
import { resolveDaemonEnabled } from '@goodvibes-jev/engine/platform/platform/config';
import { formatScheduleTiming, registerScheduleCommand, type ScheduleFields, type ScheduleHost, type ScheduleView } from '@goodvibes-jev/engine/terminal-shell/schedule-command';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { describeOperatorRpcError, getOperatorRpc, type OperatorRpcAvailable } from './operator-rpc.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import {
  daemonCreateInput,
  daemonScheduleFields,
  localRoutineRunnerFor,
  moveTerminalRoutinesToDaemon,
  terminalRoutineStorePath,
} from '../../runtime/terminal-routines.ts';

/**
 * The terminal app's host for `/schedule` (terminal-shell/schedule-command.ts):
 * schedules are kept where they run (runtime/terminal-routines.ts).
 * With the daemon on, it is a client of the daemon's `automation.jobs.*`: a
 * routine runs once, with or without a terminal open, and the list is the one
 * the web UI, channels and agents see. With the daemon off, the terminal that
 * holds the routine lock runs and changes them; another terminal lists them.
 */

type JobsListOutput = OperatorMethodOutput<'automation.jobs.list'>;
type DaemonJob = OperatorMethodOutput<'automation.jobs.create'>;

/** The fields `/schedule` prints, the same for a daemon routine and a local one. */
interface RoutineView {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly runCount: number;
  readonly nextRunAt?: number | undefined;
  readonly lastRunAt?: number | undefined;
  readonly schedule: AutomationScheduleDefinition;
  readonly prompt: string;
}

function daemonView(job: DaemonJob): RoutineView {
  return {
    id: job.id, name: job.name, enabled: job.enabled, runCount: job.runCount, nextRunAt: job.nextRunAt, lastRunAt: job.lastRunAt,
    // The daemon returns the platform's schedule shape; its contract type is the looser JSON schema of it.
    schedule: job.schedule as unknown as AutomationScheduleDefinition,
    prompt: job.execution.prompt ?? job.description ?? '',
  };
}

function localView(job: AutomationJob): RoutineView {
  return {
    id: job.id, name: job.name, enabled: job.enabled, runCount: job.runCount, nextRunAt: job.nextRunAt, lastRunAt: job.lastRunAt,
    schedule: job.schedule, prompt: job.execution.prompt ?? job.description ?? '',
  };
}

function listedJobs(output: JobsListOutput): readonly DaemonJob[] {
  return output.items as readonly DaemonJob[];
}

/** Where the routines are kept and how each verb reaches them. */
interface RoutineOwner {
  /** Shown in the list header. */
  readonly where: string;
  /** Shown after a create, about when the routine runs. */
  readonly runsNote: string;
  /** Lines to show before the command's own output (routines moved to the daemon). */
  readonly notices: readonly string[];
  /** Set when this terminal may only read: the sentence that says why and what to do. */
  readonly readOnly?: string | undefined;
  list(): Promise<readonly RoutineView[]>;
  create(schedule: AutomationScheduleDefinition, name: string, prompt: string, fields: ScheduleFields): Promise<RoutineView>;
  remove(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  update(id: string, patch: { readonly schedule?: AutomationScheduleDefinition | undefined; readonly name?: string | undefined; readonly prompt?: string | undefined }): Promise<void>;
  run(id: string): Promise<string>;
}

async function daemonOwner(ctx: CommandContext, rpc: OperatorRpcAvailable): Promise<RoutineOwner> {
  const operator = rpc.platformClient.operator;
  const move = await moveTerminalRoutinesToDaemon(ctx.platform.configManager, rpc, ctx.ops.automationManager);
  return {
    where: 'kept and run by the daemon',
    runsNote: 'runs once, with or without a terminal open',
    notices: move.lines,
    list: async () => listedJobs(await operator.invoke('automation.jobs.list', {})).map(daemonView),
    create: async (schedule, name, prompt, fields) => daemonView(await operator.invoke('automation.jobs.create', daemonCreateInput({
      ...daemonScheduleFields(schedule), ...fields, name, prompt, description: prompt,
    }))),
    remove: async (jobId) => { await operator.invoke('automation.jobs.delete', { jobId }); },
    setEnabled: async (jobId, enabled) => {
      if (enabled) await operator.invoke('automation.jobs.enable', { jobId });
      else await operator.invoke('automation.jobs.disable', { jobId });
    },
    update: async (jobId, patch) => {
      await operator.invoke('automation.jobs.update', {
        jobId,
        ...(patch.schedule ? { schedule: patch.schedule as never } : {}),
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.prompt ? { prompt: patch.prompt, description: patch.prompt } : {}),
      });
    },
    run: async (jobId) => {
      const run = await operator.invoke('automation.jobs.run', { jobId });
      return `run: ${run.runId}  status: ${run.status}`;
    },
  };
}

/** Daemon off: this terminal's own manager, when it holds the routine lock; otherwise the store file, read only. */
async function localOwner(ctx: CommandContext): Promise<RoutineOwner | string> {
  const manager = ctx.ops.automationManager;
  const configManager = ctx.platform.configManager;
  const runner = manager ? localRoutineRunnerFor(manager, configManager) : null;
  if (!manager || !runner) return 'This terminal has no routine store, so routines cannot be kept here. Turn the daemon on (daemon.enabled in /settings) to keep them there.';
  if (await runner.ensure()) {
    return {
      where: 'kept and run by this terminal (daemon off)',
      runsNote: 'runs while this terminal is open; turn the daemon on to run it with every terminal closed',
      notices: [],
      list: async () => manager.listJobs().map(localView),
      create: async (schedule, name, prompt, fields) => localView(await manager.createJob({ ...fields, schedule, name, prompt, description: prompt })),
      remove: async (id) => { await manager.removeJob(id); },
      setEnabled: async (id, enabled) => { await manager.setEnabled(id, enabled); },
      update: async (id, patch) => {
        const updated = await manager.updateJob(id, {
          ...(patch.schedule ? { schedule: patch.schedule } : {}),
          ...(patch.name ? { name: patch.name } : {}),
          ...(patch.prompt ? { prompt: patch.prompt, description: patch.prompt } : {}),
        });
        if (!updated) throw new Error(`No routine ${id}.`);
      },
      run: async (id) => {
        const run = await manager.runNow(id);
        return `run: ${run.id}  agent: ${run.agentId ?? 'not started yet'}`;
      },
    };
  }
  const refusal = 'Another goodvibes terminal on this machine runs the routines while the daemon is off; change them there, or turn the daemon on (daemon.enabled in /settings) so every terminal shares one list. Nothing was changed.';
  const path = terminalRoutineStorePath(configManager);
  const refuse = async (): Promise<never> => { throw new Error(refusal); };
  return {
    where: 'run by another terminal on this machine (daemon off)',
    runsNote: '',
    notices: [],
    readOnly: refusal,
    list: async () => (path ? (await new AutomationJobStore({ path }).load()).jobs.filter((job) => job.archivedAt === undefined).map(localView) : []),
    create: refuse,
    remove: refuse,
    setEnabled: refuse,
    update: refuse,
    run: refuse,
  };
}

/** The routine owner for this line: the daemon when it is on, else this terminal or the one that runs them. */
async function ownerFor(ctx: CommandContext): Promise<RoutineOwner> {
  const rpc = resolveDaemonEnabled(ctx.platform.configManager) ? getOperatorRpc(ctx) : undefined;
  if (rpc && !rpc.available) {
    throw commandRefusal(`Schedules are kept and run by the GoodVibes daemon, so each runs once with or without a terminal open; it cannot be reached: ${rpc.reason} Nothing was scheduled or changed.`);
  }
  try {
    const owner = rpc ? await daemonOwner(ctx, rpc) : await localOwner(ctx);
    if (typeof owner === 'string') throw commandRefusal(owner);
    if (owner.notices.length > 0) ctx.print(owner.notices.join('\n'));
    return owner;
  } catch (error) {
    if (error instanceof Error && error.name === 'RefusalError') throw error;
    throw commandRefusal(rpc ? describeOperatorRpcError(error) : summarizeError(error));
  }
}

function asView(job: RoutineView): ScheduleView {
  return { id: job.id, name: job.name, enabled: job.enabled, runCount: job.runCount, nextRunAt: job.nextRunAt, lastRunAt: job.lastRunAt, timing: formatScheduleTiming(job.schedule), prompt: job.prompt };
}

/** Each change refused for a terminal that may only read, and every failure said in a sentence. */
async function changing<T>(ctx: CommandContext, work: (owner: RoutineOwner) => Promise<T>): Promise<T> {
  const owner = await ownerFor(ctx);
  if (owner.readOnly) throw commandRefusal(owner.readOnly);
  const rpc = resolveDaemonEnabled(ctx.platform.configManager);
  try { return await work(owner); } catch (error) { throw commandRefusal(rpc ? describeOperatorRpcError(error) : summarizeError(error)); }
}

const TERMINAL_SCHEDULES: ScheduleHost<CommandContext> = {
  async list(ctx) {
    const owner = await ownerFor(ctx);
    return { where: owner.where, schedules: (await owner.list()).map(asView) };
  },
  async create(ctx, schedule, name, prompt, fields) {
    return changing(ctx, async (owner) => ({ schedule: asView(await owner.create(schedule, name, prompt, fields)), runsNote: owner.runsNote }));
  },
  async change(ctx, id, patch) {
    await changing(ctx, (owner) => owner.update(id, patch));
    return patch.schedule ? `It runs ${formatScheduleTiming(patch.schedule)}.` : '';
  },
  async remove(ctx, id) { await changing(ctx, (owner) => owner.remove(id)); },
  async setPaused(ctx, id, paused) { await changing(ctx, (owner) => owner.setEnabled(id, !paused)); },
  async runNow(ctx, id) { return changing(ctx, (owner) => owner.run(id)); },
};

export function registerScheduleRuntimeCommands(registry: CommandRegistry): void {
  registerScheduleCommand<CommandContext>(registry, TERMINAL_SCHEDULES);
}
