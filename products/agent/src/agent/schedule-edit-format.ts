import type { ScheduleEditFailure } from '@goodvibes/engine/terminal-shell/agent-turn/schedule-edit';

function formatScheduleEditFailureKind(kind: ScheduleEditFailure['kind']): string {
  if (kind === 'stale') return 'schedule changed since the preview';
  if (kind === 'auth_required') return 'authorization required';
  if (kind === 'connected_host_unavailable') return 'connected host unavailable';
  if (kind === 'connected_host_incompatible') return 'connected host incompatible';
  if (kind === 'connected_host_route_unavailable') return 'connected host route unavailable';
  return 'connected host error';
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
