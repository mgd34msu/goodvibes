import type { UnionTask } from '@goodvibes-jev/engine/sdk/platform/runtime/client';
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
