import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import {
  AutomationJobStore,
  formatEveryInterval,
  normalizeAtSchedule,
  normalizeCronSchedule,
  normalizeCronStaggerMs,
  normalizeEverySchedule,
  readNaturalLanguageSchedule,
} from '@goodvibes-jev/engine/platform/platform/automation';
import type {
  AutomationExecutionPolicy,
  AutomationExternalContentSource,
  AutomationJob,
  AutomationScheduleDefinition,
  AutomationSessionTarget,
  AutomationWakeMode,
  CreateAutomationJobInput,
} from '@goodvibes-jev/engine/platform/platform/automation';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/platform';
import { resolveDaemonEnabled } from '@goodvibes-jev/engine/platform/platform/config';
import { deliveryChannelProblem, parseChannelDeliveryTarget } from '@goodvibes-jev/engine/platform/platform/channels';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { REASONING_EFFORT_SEVERITY, reasoningEffortRank } from '@goodvibes-jev/engine/platform/platform/providers';
import { describeOperatorRpcError, getOperatorRpc, type OperatorRpcAvailable } from './operator-rpc.ts';
import {
  daemonCreateInput,
  daemonScheduleFields,
  localRoutineRunnerFor,
  moveTerminalRoutinesToDaemon,
  terminalRoutineStorePath,
} from '../../runtime/terminal-routines.ts';

/**
 * `/schedule` manages routines where they run (runtime/terminal-routines.ts).
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

const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** One zone for every time this command prints: this machine's, named. */
function formatTime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return 'n/a';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: LOCAL_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} ${LOCAL_ZONE}`;
}

function formatSchedule(schedule: AutomationScheduleDefinition): string {
  switch (schedule.kind) {
    case 'cron':
      return [
        schedule.expression,
        schedule.timezone ? `[${schedule.timezone}]` : '',
        schedule.staggerMs !== undefined ? `[stagger ${schedule.staggerMs}ms]` : '',
      ].filter(Boolean).join(' ');
    case 'every':
      return `every ${formatEveryInterval(schedule.intervalMs)}`;
    case 'at':
      return `once at ${formatTime(schedule.at)}`;
  }
}

function parseAutomationTarget(raw: string): AutomationSessionTarget {
  const value = raw.trim();
  if (value.startsWith('session:')) return { kind: 'session', sessionId: value.slice('session:'.length), createIfMissing: true };
  if (value.startsWith('route:')) return { kind: 'route', routeId: value.slice('route:'.length), preserveThread: true };
  if (value === 'main' || value === 'current' || value === 'isolated' || value === 'pinned' || value === 'background') {
    return { kind: value, createIfMissing: true };
  }
  return { kind: 'session', sessionId: value, createIfMissing: true };
}

/** Flags `/schedule add` takes with a value, and the switches it takes alone. Anything else is refused. */
const VALUE_FLAGS = new Set(['--name', '--model', '--provider', '--template', '--tz', '--timezone', '--stagger', '--target',
  '--reasoning', '--thinking', '--wake', '--fallback', '--fallbacks', '--tool', '--external-source', '--deliver']);
const SWITCH_FLAGS = new Set(['--allow-unsafe-external-content', '--light-context']);

/** A routine's fields apart from its schedule, in the shape both owners take. */
type RoutineFields = Omit<CreateAutomationJobInput, 'schedule' | 'name' | 'prompt'> & { readonly name?: string | undefined };

interface AddOptions {
  readonly fields: RoutineFields;
  readonly timezone?: string | undefined;
  readonly staggerMs?: number | undefined;
  readonly prompt: string;
}

/** Reads the words after the schedule value: flags with their values, the rest is the prompt. Throws a refusal sentence. */
function readAddOptions(words: readonly string[]): AddOptions {
  const values = new Map<string, string>();
  const tools: string[] = [];
  const switches = new Set<string>();
  const promptWords: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const token = words[i]!;
    if (!token.startsWith('--')) { promptWords.push(token); continue; }
    if (SWITCH_FLAGS.has(token)) { switches.add(token); continue; }
    if (!VALUE_FLAGS.has(token)) {
      throw new Error(`Unknown option ${token}. Options: ${[...VALUE_FLAGS, ...SWITCH_FLAGS].join(', ')}. A prompt word that starts with "--" goes inside quotes.`);
    }
    const value = words[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value.`);
    i++;
    if (token === '--tool') tools.push(value);
    else values.set(token === '--timezone' ? '--tz' : token === '--fallbacks' ? '--fallback' : token, value);
  }
  const stagger = values.get('--stagger');
  const staggerMs = stagger === undefined ? undefined : normalizeCronStaggerMs(stagger);
  if (stagger !== undefined && staggerMs === undefined) throw new Error(`Invalid stagger window: "${stagger}".`);
  const reasoning = values.get('--reasoning');
  if (reasoning !== undefined && reasoningEffortRank(reasoning) === -1) {
    throw new Error(`Invalid reasoning effort: "${reasoning}". Known levels: ${REASONING_EFFORT_SEVERITY.join(', ')}.`);
  }
  const wake = values.get('--wake');
  if (wake !== undefined && wake !== 'now' && wake !== 'next-heartbeat') throw new Error(`Invalid wake mode: "${wake}". Use now or next-heartbeat.`);
  const target = values.get('--target');
  const fallback = values.get('--fallback')?.split(',').map((entry) => entry.trim()).filter(Boolean);
  const name = values.get('--name');
  const model = values.get('--model');
  const provider = values.get('--provider');
  const template = values.get('--template');
  const thinking = values.get('--thinking');
  const externalContentSource = values.get('--external-source');
  // Where each run's answer goes: a channel as configuration writes one. Without it, the owner inbox.
  const deliver = values.get('--deliver')?.trim();
  const deliverProblem = deliver ? deliveryChannelProblem(deliver) : undefined;
  if (deliverProblem) throw new Error(`--deliver ${deliverProblem}. Write a channel such as telegram or slack:C123, or leave --deliver out to get the answer in the owner inbox.`);
  return {
    prompt: promptWords.join(' ').trim(),
    timezone: values.get('--tz'),
    staggerMs,
    fields: {
      ...(name ? { name } : {}),
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(template ? { template } : {}),
      ...(reasoning ? { reasoningEffort: reasoning as AutomationExecutionPolicy['reasoningEffort'] } : {}),
      ...(thinking ? { thinking } : {}),
      ...(wake ? { wakeMode: wake as AutomationWakeMode } : {}),
      ...(externalContentSource ? { externalContentSource: externalContentSource as AutomationExternalContentSource } : {}),
      ...(target ? { target: parseAutomationTarget(target) } : {}),
      ...(fallback && fallback.length > 0 ? { fallbackModels: fallback } : {}),
      ...(tools.length > 0 ? { toolAllowlist: tools } : {}),
      ...(switches.has('--allow-unsafe-external-content') ? { allowUnsafeExternalContent: true } : {}),
      ...(switches.has('--light-context') ? { lightContext: true } : {}),
      ...(deliver ? { delivery: { mode: 'surface' as const, targets: [parseChannelDeliveryTarget(deliver)] } } : {}),
      enabled: true,
    },
  };
}

function shortPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}...` : trimmed;
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
  return ('jobs' in output ? output.jobs : output.items) as readonly DaemonJob[];
}

/**
 * An exact id wins; otherwise a prefix must name exactly one routine. `remove`,
 * `disable` and `run` act on the result, so an ambiguous prefix is refused with
 * the candidates instead of acting on whichever routine is listed first.
 */
function resolveJob(jobs: readonly RoutineView[], id: string, ctx: CommandContext): RoutineView | undefined {
  const exact = jobs.find((job) => job.id === id);
  if (exact) return exact;
  const matches = jobs.filter((job) => job.id.startsWith(id));
  if (matches.length === 0) {
    ctx.print(`No routine with id ${id}. Run /schedule list to see routine ids.`);
    return undefined;
  }
  if (matches.length > 1) {
    ctx.print(
      `Ambiguous routine id "${id}": ${matches.length} routines start with it. Nothing was changed. Use a longer id:\n`
      + matches.map((job) => `  ${job.id}  ${job.name}`).join('\n'),
    );
    return undefined;
  }
  return matches[0];
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
  create(schedule: AutomationScheduleDefinition, name: string, prompt: string, fields: RoutineFields): Promise<RoutineView>;
  remove(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
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
    run: refuse,
  };
}

/** Reads `/schedule add <kind> <value>` into a schedule; throws a refusal sentence. */
function readSchedule(kind: 'cron' | 'every' | 'at', value: string, options: AddOptions): AutomationScheduleDefinition {
  if (kind === 'cron') return normalizeCronSchedule(value, options.timezone, options.staggerMs);
  if (kind === 'every') return normalizeEverySchedule(value);
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new Error(`"${value}" is not a date and time. Use an ISO timestamp such as 2026-04-10T09:00 (read in ${LOCAL_ZONE} when it has no zone).`);
  if (at <= Date.now()) throw new Error(`${formatTime(at)} has already passed.`);
  return normalizeAtSchedule(at);
}

const USAGE = [
  'Usage:',
  '  /schedule add cron "<expr>" <prompt...> [--tz <zone>] [--stagger <ms>] [options]',
  '  /schedule add every <interval> <prompt...> [options]',
  '  /schedule add at <timestamp> <prompt...> [options]',
  '  /schedule add when "<natural language, e.g. every weekday at 9am>" <prompt...> [options]',
  '  /schedule list | remove <id> | enable <id> | disable <id> | run <id>',
  '  options: --name <name> --model <model> --provider <provider> --template <tmpl> --target main|current|isolated|pinned|background|session:<id>',
  '           --reasoning <level> --thinking <mode> --wake now|next-heartbeat --fallback <a,b> --tool <name> --external-source <kind>',
  '           --deliver <channel, e.g. telegram or slack:C123> (without it, each answer goes to the owner inbox)',
  '           --allow-unsafe-external-content --light-context',
].join('\n');

export function registerScheduleRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'schedule',
    // Its words are fields (kind, value, prompt), so an unclosed quote is refused, not shifted.
    strictArgs: true,
    aliases: ['sched'],
    description: 'Manage scheduled routines (kept by the daemon, so each runs once, with or without a terminal open)',
    usage: 'add <cron|every|at|when> <value> <prompt...> | list | remove <id> | enable <id> | disable <id> | run <id>',
    argsHint: 'add cron <expr> | add every <interval> | add at <timestamp> | add when "<natural language>" | list | remove | enable | disable | run',
    async handler(rawArgs, ctx) {
      const args = [...rawArgs];
      const sub = args[0] ?? 'list';
      if (!['list', 'add', 'remove', 'enable', 'disable', 'run'].includes(sub)) {
        ctx.print(USAGE);
        return;
      }
      const rpc = resolveDaemonEnabled(ctx.platform.configManager) ? getOperatorRpc(ctx) : undefined;
      if (rpc && !rpc.available) {
        ctx.print(`Routines are kept and run by the GoodVibes daemon, so each runs once with or without a terminal open; it cannot be reached: ${rpc.reason} Nothing was scheduled or changed.`);
        return;
      }
      const isWhen = sub === 'add' && args[1] === 'when';
      if (sub === 'add' && !isWhen) ctx.commandReadings?.cancel('schedule');
      // Captured before the first await: a repeat of the same line while the
      // phrase is still being read must not start a second reading or a second routine.
      const begun = isWhen ? ctx.commandReadings?.begin('schedule', JSON.stringify(args)) : undefined;
      if (isWhen && !begun?.ok) {
        if (begun?.reason === 'pending') {
          ctx.print('This schedule is already being read; the routine is created when the reading finishes. Nothing new was started.');
        } else {
          ctx.print('Schedule reading is not available while the terminal is closing. Nothing was created; your text is back in the prompt.');
          ctx.restoreDraft?.(`/schedule ${args.join(' ')}`);
        }
        return;
      }
      const reading = begun?.ok ? begun : undefined;
      try {
        const owner = rpc ? await daemonOwner(ctx, rpc) : await localOwner(ctx);
        if (typeof owner === 'string') {
          ctx.print(owner);
          return;
        }
        if (owner.notices.length > 0) ctx.print(owner.notices.join('\n'));
        if (reading && !reading.current()) return;

        if (sub === 'list') {
          const jobs = await owner.list();
          if (jobs.length === 0) {
            ctx.print([
              `No scheduled routines (${owner.where}).`,
              'Create your first routine with:',
              '  /schedule add cron "*/30 * * * *" "check build status"',
              '  /schedule add every 15m "summarize open PRs"',
              '  /schedule add at 2026-04-10T09:00:00 "send release reminder"',
            ].join('\n'));
            return;
          }
          const lines = [`Scheduled routines (${jobs.length}, ${owner.where}; times in ${LOCAL_ZONE}):`, ''];
          for (const job of jobs) {
            const status = job.enabled ? '● enabled ' : '○ paused  ';
            lines.push(`  ${job.id.slice(0, 12)}  ${status} runs:${job.runCount}  next:${formatTime(job.nextRunAt)}  last:${job.lastRunAt ? formatTime(job.lastRunAt) : 'never'}`);
            lines.push(`    name: ${job.name}  schedule: ${formatSchedule(job.schedule)}`);
            lines.push(`    prompt: ${shortPrompt(job.prompt)}`);
          }
          ctx.print(lines.join('\n'));
          return;
        }

        if (owner.readOnly) {
          ctx.print(owner.readOnly);
          return;
        }

        if (sub === 'add') {
          const scheduleKind = args[1];
          const scheduleArg = args[2];
          if ((scheduleKind !== 'cron' && scheduleKind !== 'every' && scheduleKind !== 'at' && scheduleKind !== 'when') || !scheduleArg) {
            ctx.print(USAGE);
            return;
          }
          let options: AddOptions;
          let schedule: AutomationScheduleDefinition;
          try {
            options = readAddOptions(args.slice(3));
            if (!options.prompt) throw new Error('the routine needs prompt text after the schedule value.');
            if (scheduleKind === 'when') {
              ctx.print('Reading schedule with Jev…');
              const parsed = await readNaturalLanguageSchedule({ phrase: scheduleArg, now: Date.now(), timezone: options.timezone ?? LOCAL_ZONE, staggerMs: options.staggerMs }, {
                signal: reading!.signal,
                beforeAttempt: reading!.assertCurrent,
                onRetry: () => { if (reading!.current()) ctx.print('Waiting for Jev to read the schedule…'); },
              });
              if (!reading!.current()) return;
              if (parsed.kind === 'unknown') throw new Error(`the timing is ${parsed.reason}; give it as cron, every or at instead.`);
              if (parsed.schedule.kind === 'at' && parsed.schedule.at <= Date.now()) throw new Error('the interpreted time has already passed.');
              ctx.print(`Interpreted "${scheduleArg}" as: ${formatSchedule(parsed.schedule)}`);
              schedule = parsed.schedule;
            } else {
              schedule = readSchedule(scheduleKind, scheduleArg, options);
            }
          } catch (error) {
            if (!reading || reading.current()) ctx.print(`Not scheduled: ${summarizeError(error)}`);
            return;
          }
          // No await between this check and the request.
          if (reading && !reading.current()) return;
          const job = await owner.create(schedule, options.fields.name ?? options.prompt.slice(0, 40), options.prompt, options.fields);
          if (reading && !reading.current()) return;
          ctx.print([
            `Routine created: ${job.id}`,
            `  name: ${job.name}`,
            `  schedule: ${formatSchedule(job.schedule)}`,
            `  next run: ${formatTime(job.nextRunAt)} (${owner.runsNote})`,
            `  answer goes to: ${options.fields.delivery?.targets?.[0]?.surfaceKind ? `${options.fields.delivery.targets[0].surfaceKind}${options.fields.delivery.targets[0].address ? `:${options.fields.delivery.targets[0].address}` : ''}` : 'the owner inbox'}`,
          ].join('\n'));
          return;
        }

        const id = args[1];
        if (!id) {
          ctx.print(`Usage: /schedule ${sub} <id>`);
          return;
        }
        const job = resolveJob(await owner.list(), id, ctx);
        if (!job) return;
        if (sub === 'remove') {
          await owner.remove(job.id);
          ctx.print(`Removed routine ${job.id} (${job.name}).`);
          return;
        }
        if (sub === 'enable' || sub === 'disable') {
          await owner.setEnabled(job.id, sub === 'enable');
          ctx.print(`${sub === 'enable' ? 'Enabled' : 'Paused'} routine ${job.id} (${job.name}).`);
          return;
        }
        ctx.print(`Running routine ${job.id} (${job.name}) now\n  ${await owner.run(job.id)}`);
      } catch (error) {
        if (!reading || reading.current()) ctx.print(`/schedule ${sub}: ${rpc ? describeOperatorRpcError(error) : summarizeError(error)}`);
      } finally {
        reading?.finish();
      }
    },
  });
}
