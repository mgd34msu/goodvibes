import { formatEveryInterval } from '@goodvibes-jev/engine/platform/platform/automation';
import type {
  ScheduleEditFailure,
  ScheduleEditPreview,
  ScheduleEditSuccess,
} from './schedule-edit.ts';
import { scheduleConfirmationRouteLines, scheduleNextRouteLines, scheduleRouteArg } from '@goodvibes-jev/engine/terminal-shell/agent-turn';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function scheduleValue(schedule: unknown): string {
  if (!isRecord(schedule)) return 'unchanged';
  if (schedule.kind === 'cron') {
    return [
      readString(schedule, 'expression') ?? '',
      readString(schedule, 'timezone') ? `[${readString(schedule, 'timezone')}]` : '',
      typeof schedule.staggerMs === 'number' ? `[stagger ${schedule.staggerMs}ms]` : '',
    ].filter(Boolean).join(' ');
  }
  if (schedule.kind === 'every' && typeof schedule.intervalMs === 'number') return formatEveryInterval(schedule.intervalMs);
  if (schedule.kind === 'at' && typeof schedule.at === 'number') return new Date(schedule.at).toISOString();
  return String(schedule.kind ?? 'unknown');
}

function patchScheduleValue(preview: ScheduleEditPreview): string {
  return scheduleValue(preview.payload.schedule);
}

/** The value the schedule tool parses for this schedule kind: the raw cron expression, interval or timestamp. */
function routeScheduleValue(schedule: Record<string, unknown>): string {
  if (schedule.kind === 'cron') return readString(schedule, 'expression') ?? '';
  return scheduleValue(schedule);
}

function scheduleEditConfirmationRoute(preview: ScheduleEditPreview): string {
  const args = [
    'schedule action:"edit"',
    `scheduleId:${scheduleRouteArg(preview.scheduleId)}`,
  ];
  if (preview.payload.name) args.push(`name:${scheduleRouteArg(String(preview.payload.name))}`);
  if (preview.payload.schedule) {
    const schedule = preview.payload.schedule;
    if (isRecord(schedule) && typeof schedule.kind === 'string') {
      args.push(`scheduleKind:${scheduleRouteArg(schedule.kind)}`);
      // The tool takes the bare expression, and timezone and stagger as their own
      // arguments; the preview's display string ("0 9 * * * [UTC]") is not a value.
      args.push(`scheduleValue:${scheduleRouteArg(routeScheduleValue(schedule))}`);
      const timezone = readString(schedule, 'timezone');
      if (schedule.kind === 'cron' && timezone) args.push(`timezone:${scheduleRouteArg(timezone)}`);
      if (schedule.kind === 'cron' && typeof schedule.staggerMs === 'number') args.push(`staggerMs:${schedule.staggerMs}`);
    }
  }
  // The prompt is the caller's own input, so the route carries it as given; a
  // rebuilt autonomous prompt is carried by the task and criteria it came from.
  const task = taskArgs(preview);
  if (task) args.push(`task:${scheduleRouteArg(task.task)}`, `successCriteria:${scheduleRouteArg(task.successCriteria)}`);
  else if (preview.payload.prompt) args.push(`prompt:${scheduleRouteArg(preview.payload.prompt)}`);
  return args.join(' ');
}

function taskArgs(preview: ScheduleEditPreview): { readonly task: string; readonly successCriteria: string } | null {
  const at = (flag: string) => {
    const index = preview.commandArgs.indexOf(flag);
    return index >= 0 ? preview.commandArgs[index + 1] : undefined;
  };
  const task = at('--task'), successCriteria = at('--success-criteria');
  return task && successCriteria ? { task, successCriteria } : null;
}

/** The terminal command that applies exactly this preview, bound to the revision it read. */
function scheduleEditConfirmCommand(preview: ScheduleEditPreview): string {
  const [id = '', ...rest] = preview.commandArgs;
  const args = ['/schedule edit', scheduleRouteArg(id)];
  for (const arg of rest) args.push(arg.startsWith('--') ? arg : scheduleRouteArg(arg));
  if (preview.revision) args.push('--revision', scheduleRouteArg(preview.revision));
  args.push('--yes');
  return args.join(' ');
}

function formatCurrentScheduleDiff(preview: ScheduleEditPreview): readonly string[] {
  const current = preview.current;
  if (!current) return [];
  const lines = [
    `  current source ${current.method} GET ${current.route}`,
    current.found
      ? `  current status ${current.status ?? 'unknown'}`
      : `  current schedule not found`,
    current.note ? `  current note ${current.note}` : '',
  ];
  for (const diff of current.diffs) {
    lines.push(`  ${diff.field} ${diff.before} -> ${diff.after}${diff.changed ? '' : ' (unchanged)'}`);
  }
  return lines.filter((line) => line !== '');
}

function responseRecord(result: ScheduleEditSuccess): Record<string, unknown> {
  return isRecord(result.schedule) ? result.schedule : {};
}

function formatScheduleEditFailureKind(kind: ScheduleEditFailure['kind']): string {
  if (kind === 'stale') return 'schedule changed since the preview';
  if (kind === 'auth_required') return 'authorization required';
  if (kind === 'connected_host_unavailable') return 'connected host unavailable';
  if (kind === 'connected_host_incompatible') return 'connected host incompatible';
  if (kind === 'connected_host_route_unavailable') return 'connected host route unavailable';
  return 'connected host error';
}

export function formatScheduleEditPreview(preview: ScheduleEditPreview): string {
  return [
    'GoodVibes schedule edit preview',
    `  method ${preview.method}`,
    `  route ${preview.route.replace('{jobId}', preview.scheduleId)}`,
    `  schedule ${preview.scheduleId}`,
    `  changes ${preview.changes.join(', ')}`,
    ...formatCurrentScheduleDiff(preview),
    preview.payload.name ? `  name ${preview.payload.name}` : '',
    preview.payload.schedule ? `  schedule ${patchScheduleValue(preview)}` : '',
    preview.payload.prompt ? '  prompt replacement prepared' : '',
    preview.revision ? `  revision ${preview.revision}` : '',
    '',
    preview.revision
      ? 'To apply it, run the command below. It applies only while the schedule is still at this revision; if it changed, the host refuses and nothing is overwritten.'
      : 'To apply it, run the command below. The current schedule could not be read, so the edit is not bound to a revision.',
    `  ${scheduleEditConfirmCommand(preview)}`,
    ...scheduleConfirmationRouteLines({ model: scheduleEditConfirmationRoute(preview) }),
  ].filter((line) => line !== '').join('\n');
}

export function formatScheduleEditSuccess(result: ScheduleEditSuccess): string {
  const record = responseRecord(result);
  const id = readString(record, 'id') ?? result.scheduleId;
  const status = readString(record, 'status') ?? (record.enabled === false ? 'paused' : record.enabled === true ? 'enabled' : 'ok');
  return [
    'Updated GoodVibes schedule',
    `  schedule ${id}`,
    `  method ${result.kind}`,
    `  route ${result.route.replace('{jobId}', result.scheduleId)}`,
    `  status ${status}`,
    isRecord(record.schedule) ? `  schedule ${scheduleValue(record.schedule)}` : '',
    ...scheduleNextRouteLines(id),
  ].filter((line) => line !== '').join('\n');
}

export function formatScheduleEditFailure(failure: ScheduleEditFailure): string {
  return [
    `GoodVibes schedule edit error ${formatScheduleEditFailureKind(failure.kind)}`,
    `  route ${failure.route}`,
    failure.baseUrl ? `  connected host ${failure.baseUrl}` : '',
    `  error ${failure.error}`,
    failure.kind === 'auth_required'
      ? '  next pair or start the connected GoodVibes host so an operator token is available.'
      : '',
    failure.kind === 'connected_host_incompatible'
      ? '  next update the connected GoodVibes host so automation.jobs.update is available.'
      : '',
  ].filter((line) => line !== '').join('\n');
}
