import type { UnionTask } from '@goodvibes-jev/engine/platform/platform/runtime/client';
type TaskLifecycleState = UnionTask['task']['status'];
type RuntimeTask = Pick<UnionTask['task'], 'result' | 'error' | 'description' | 'title'>;
export function sortUnionTasks(tasks: readonly UnionTask[]): UnionTask[] {
  const statusOrder: TaskLifecycleState[] = ['running', 'queued', 'blocked', 'failed', 'completed', 'cancelled'];
  const ranking = new Map(statusOrder.map((status, index) => [status, index] as const));
  return [...tasks].sort((a, b) => {
    const rankDelta = (ranking.get(a.task.status) ?? 99) - (ranking.get(b.task.status) ?? 99);
    if (rankDelta !== 0) return rankDelta;
    const aWhen = a.task.startedAt ?? a.task.queuedAt;
    const bWhen = b.task.startedAt ?? b.task.queuedAt;
    return bWhen - aWhen;
  });
}
export function summarizeTaskResult(task: RuntimeTask): string {
  const payload =
    typeof task.result === 'string'
      ? task.result
      : (task.error ?? (task.result !== undefined ? JSON.stringify(task.result) : task.description) ?? task.title);
  const normalized = String(payload).replace(/\s+/g, ' ').trim();
  return normalized.length <= 140 ? normalized : `${normalized.slice(0, 137)}...`;
}
export function statusBadge(status: string): string {
  switch (status) {
    case 'queued':
      return '[ ]';
    case 'running':
      return '[>]';
    case 'blocked':
      return '[~]';
    case 'completed':
      return '[+]';
    case 'failed':
      return '[!]';
    case 'cancelled':
      return '[x]';
    default:
      return '[?]';
  }
}

/** Canonical task fields with per-surface labels; attachments are supplied by the owner. */
export function taskDetailLines(
  entry: UnionTask,
  labels: {
    readonly title: string;
    readonly status: string;
    readonly owner: string;
    readonly runsOn: string;
    readonly localOrigin: string;
    readonly cancellable: string;
    readonly queued: string;
    readonly started: string;
    readonly ended: string;
    readonly parent: string;
    readonly children: string;
    readonly correlation: string;
    readonly summary: string;
  },
  attachments: readonly string[] = [],
): string[] {
  const { task, origin } = entry;
  return [
    `Task ${task.id}`,
    labels.title + task.title,
    `  kind: ${task.kind}`,
    labels.status + task.status,
    labels.owner + task.owner,
    labels.runsOn + (origin === 'local' ? labels.localOrigin : 'the daemon'),
    labels.cancellable + (task.cancellable ? 'yes' : 'no'),
    labels.queued + new Date(task.queuedAt).toISOString(),
    labels.started + (task.startedAt ? new Date(task.startedAt).toISOString() : 'n/a'),
    labels.ended + (task.endedAt ? new Date(task.endedAt).toISOString() : 'n/a'),
    labels.parent + (task.parentTaskId ?? 'none'),
    labels.children + (task.childTaskIds.join(', ') || '(none)'),
    labels.correlation + (task.correlationId ?? 'n/a'),
    ...attachments,
    labels.summary + summarizeTaskResult(task),
  ];
}
