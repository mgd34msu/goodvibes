import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { createDaemonOperatorInvoke } from './daemon-operator-client.ts';
import type { captureOperatorConnection } from './operator-connection-owner.ts';

const CREATED_METHODS = new Set(['automation.jobs.create', 'automation.schedules.create']);
const SELECTED_TARGETS: Readonly<Record<string, 'jobId' | 'scheduleId'>> = {
  'automation.jobs.update': 'jobId', 'automation.jobs.enable': 'jobId', 'automation.jobs.disable': 'jobId',
  'automation.jobs.delete': 'jobId', 'automation.schedules.enable': 'scheduleId',
  'automation.schedules.disable': 'scheduleId', 'automation.schedules.delete': 'scheduleId',
};
export interface OperatorAutomationTarget {
  readonly wireFields: Record<string, unknown>;
  /** Complete untouched native record stays in the registration's private scope. */
  readonly originalTarget?: Record<string, unknown> | undefined;
}

/**
 * The host's current revision of the job a mutation names, sent with the
 * mutation so the host refuses it if the job changed in between. Never taken
 * from model-supplied fields. The caller's currency check runs once, before the
 * read leaves; the mutation that follows is checked by its own sender.
 */
export async function captureOperatorAutomationTarget(methodId: string, input: Record<string, unknown>,
  connection: ReturnType<typeof captureOperatorConnection>, options: { readonly signal?: AbortSignal | undefined; readonly assertCurrent: () => void }): Promise<OperatorAutomationTarget> {
  if (CREATED_METHODS.has(methodId)) return { wireFields: { admission: 'autonomous' } };
  const targetKey = SELECTED_TARGETS[methodId];
  if (!targetKey) return { wireFields: {} };
  const targetId = input[targetKey];
  if (typeof targetId !== 'string' || !targetId.trim()) {
    throw new ToolInputProjectionError('invalid', `The method needs ${targetKey}, the id of the job to change; automation.schedules.list shows them.`);
  }
  const receipt = await createDaemonOperatorInvoke(() => connection)('automation.schedules.list', {}, { signal: options.signal, assertCurrent: options.assertCurrent });
  // The host's own failure text can echo the id, so only its classified kind is passed on.
  if (!receipt.ok) throw new ToolInputProjectionError('unavailable', `The job's current revision could not be read from the connected host (${receipt.kind}).`);
  const body = receipt.body;
  const jobs = body && typeof body === 'object' && !Array.isArray(body) && 'jobs' in body && Array.isArray(body.jobs) ? body.jobs as unknown[] : null;
  if (!jobs) throw new ToolInputProjectionError('unavailable', 'The connected host listed schedules in a shape this Agent cannot read; run the same GoodVibes version on both.');
  const targets = jobs.filter((entry: unknown): entry is Record<string, unknown> => entry !== null && typeof entry === 'object'
    && !Array.isArray(entry) && 'id' in entry && entry.id === targetId);
  const target = targets.length === 1 ? targets[0] : undefined;
  if (!target) throw new ToolInputProjectionError('invalid', `No job with that ${targetKey} is on the connected host; automation.schedules.list shows the ids.`);
  if (typeof target.mutationRevision !== 'string' || !target.mutationRevision) {
    throw new ToolInputProjectionError('unavailable', 'The connected host gave the job no revision, so the change was not sent; update GoodVibes on the host.');
  }
  // A native parent may already retain an older target. Never advance it to a changed target.
  if (input.expectedMutationRevision !== undefined && input.expectedMutationRevision !== target.mutationRevision) throw new ToolInputProjectionError('stale');
  return { originalTarget: target, wireFields: { admission: 'autonomous', expectedMutationRevision: target.mutationRevision } };
}
