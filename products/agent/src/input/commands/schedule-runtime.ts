/**
 * The Agent's host for `/schedule` (terminal-shell/schedule-command.ts): the
 * Agent keeps no schedule of its own; every schedule lives on the connected
 * host, created with `automation.schedules.create` and changed with the host's
 * schedule methods, so it runs with or without this Agent open. The list is
 * the host's live schedules, each annotated with its latest run when that run
 * was missed or failed.
 */
import { formatScheduleTiming, registerScheduleCommand, scheduleTimingFields, type ScheduleHost, type ScheduleView } from '@goodvibes/engine/terminal-shell/schedule-command';
import { buildOperatorActionRequest, formatOperatorActionFailure, postOperatorAction, type OperatorActionId } from '@goodvibes/engine/terminal-shell/agent-turn/operator-actions';
import { buildScheduleEditPreview, parseScheduleEditArgs } from '@goodvibes/engine/terminal-shell/agent-turn/schedule-edit';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { resolveAgentConnectedHostConnection, type AgentConnectedHostConnection } from '../../agent/routine-schedule-promotion.ts';
import { fetchLiveSchedules } from '../../agent/routine-schedule-receipts.ts';
import { latestRunPerJob, listAutomationRunsSince } from '../../agent/automation-runs-source.ts';
import { createConnectedSchedule, type ScheduleCreateInput } from '../../agent/connected-schedule.ts';
import { editConnectedSchedule, enrichScheduleEditPreviewFromConnectedHost } from '../../agent/schedule-edit.ts';
import { formatScheduleEditFailure } from '../../agent/schedule-edit-format.ts';
import { requireShellPaths } from './runtime-services.ts';
import { commandRefusal } from './confirmation.ts';

/** Runs fetch window used to annotate the list with each schedule's latest outcome. */
const RECENT_RUN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function connectionOf(ctx: CommandContext): AgentConnectedHostConnection {
  return resolveAgentConnectedHostConnection(ctx.platform.configManager, requireShellPaths(ctx).homeDirectory);
}

async function hostAction(ctx: CommandContext, action: OperatorActionId, scheduleId: string, target: 'scheduleId' | 'runId' = 'scheduleId'): Promise<string> {
  const request = buildOperatorActionRequest({ action, [target]: scheduleId });
  if (!request.ok) throw commandRefusal(request.error, undefined, 'USAGE');
  const connection = connectionOf(ctx);
  const result = await postOperatorAction(connection, request);
  if (!result.ok) throw commandRefusal(formatOperatorActionFailure(result), undefined, 'COMMAND_FAILED');
  return `On ${connection.baseUrl}.`;
}

const CONNECTED_SCHEDULES: ScheduleHost<CommandContext> = {
  async list(ctx) {
    const connection = connectionOf(ctx);
    const fetched = await fetchLiveSchedules(connection);
    if (!fetched.ok) throw commandRefusal(`Could not reach the connected host for schedules: ${fetched.error ?? 'unknown error'}`);
    const notices: string[] = [];
    const runs = fetched.schedules.length > 0 ? await listAutomationRunsSince(connection, Date.now() - RECENT_RUN_WINDOW_MS) : undefined;
    // An empty run list from a host that did not answer is not "nothing failed".
    if (runs?.unavailable) notices.push(`Could not check recent run outcomes (failed or missed runs are not shown): ${runs.unavailable}`);
    const latest = latestRunPerJob(runs?.runs ?? []);
    return {
      where: `kept on the connected host ${connection.baseUrl}`,
      notices,
      schedules: fetched.schedules.map((schedule): ScheduleView => {
        const run = latest.get(schedule.id);
        return {
          id: schedule.id,
          name: schedule.name,
          enabled: schedule.enabled !== false,
          runCount: schedule.runCount ?? 0,
          nextRunAt: schedule.nextRunAt,
          lastRunAt: schedule.lastRunAt,
          timing: schedule.scheduleKind ? `${schedule.scheduleKind} ${schedule.scheduleValue ?? ''}${schedule.timezone ? ` [${schedule.timezone}]` : ''}`.trim() : 'not said',
          prompt: '',
          ...(run && (run.status === 'missed' || run.status === 'failed') ? { outcome: run.status } : {}),
        };
      }),
    };
  },
  async create(ctx, schedule, name, prompt, fields) {
    const timing = scheduleTimingFields(schedule);
    const payload = {
      ...(timing.cron ? { cron: timing.cron } : {}),
      ...(timing.every ? { every: timing.every } : {}),
      ...(timing.at ? { at: timing.at } : {}),
      ...(timing.timezone ? { timezone: timing.timezone } : {}),
      ...(timing.staggerMs !== undefined ? { staggerMs: timing.staggerMs } : {}),
      ...fields,
      name,
      prompt,
    } as unknown as ScheduleCreateInput;
    const connection = connectionOf(ctx);
    const result = await createConnectedSchedule(connection, payload);
    if (!result.ok) throw commandRefusal(`Not scheduled: ${result.error}`, undefined, 'COMMAND_FAILED');
    const kept = result.schedule as unknown as { readonly id: string; readonly name?: string; readonly enabled?: boolean; readonly nextRunAt?: number };
    return {
      schedule: { id: kept.id, name: kept.name ?? name, enabled: kept.enabled !== false, runCount: 0, nextRunAt: kept.nextRunAt, timing: formatScheduleTiming(schedule), prompt },
      runsNote: result.alreadyExisted ? `the same schedule was already on ${connection.baseUrl}; nothing new was made` : `kept on ${connection.baseUrl}, it runs with or without this Agent open`,
    };
  },
  async change(ctx, id, patch) {
    const timing = patch.schedule ? scheduleTimingFields(patch.schedule) : undefined;
    const args = [
      id,
      ...(timing?.cron ? ['--cron', timing.cron] : []),
      ...(timing?.every ? ['--every', timing.every] : []),
      ...(timing?.at ? ['--at', timing.at] : []),
      ...(timing?.timezone ? ['--timezone', timing.timezone] : []),
      ...(timing?.staggerMs !== undefined ? ['--stagger-ms', String(timing.staggerMs)] : []),
      ...(patch.name ? ['--name', patch.name] : []),
      ...(patch.prompt ? ['--prompt', patch.prompt] : []),
    ];
    const parsed = parseScheduleEditArgs(args, { defaultRequestProvenance: `/schedule change ${id}` });
    if (parsed.errors.length > 0) throw commandRefusal(parsed.errors.join('; '), undefined, 'USAGE');
    const connection = connectionOf(ctx);
    // Bound to the revision this read sees, so a schedule changed meanwhile is not overwritten.
    const preview = await enrichScheduleEditPreviewFromConnectedHost(connection, buildScheduleEditPreview(parsed));
    const result = await editConnectedSchedule(connection, preview);
    if (!result.ok) throw commandRefusal(formatScheduleEditFailure(result), undefined, 'COMMAND_FAILED');
    return patch.schedule ? `It runs ${formatScheduleTiming(patch.schedule)}.` : '';
  },
  async remove(ctx, id) { await hostAction(ctx, 'automation.schedules.delete', id); },
  async setPaused(ctx, id, paused) { await hostAction(ctx, paused ? 'automation.schedules.pause' : 'automation.schedules.resume', id); },
  async runNow(ctx, id) { return hostAction(ctx, 'automation.schedules.run', id); },
  async stopRun(ctx, runId) { return hostAction(ctx, 'automation.runs.cancel', runId, 'runId'); },
  async retryRun(ctx, runId) { return hostAction(ctx, 'automation.runs.retry', runId, 'runId'); },
};

export function registerScheduleRuntimeCommands(registry: CommandRegistry): void {
  registerScheduleCommand<CommandContext>(registry, CONNECTED_SCHEDULES);
}
