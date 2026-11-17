import type { AutomationManager } from '../../automation/manager.js';
import type { ManagedAutomationJob } from '../../automation/jobs.js';
import type { AutomationScheduleDefinition } from '../../automation/schedules.js';
import { AutomationJobCommitIndeterminateError, AutomationJobMutationStaleError } from '../../automation/job-mutations.js';
import type { GatewayMethodCatalog } from '../../control-plane/method-catalog.js';
import { HandlerError, registerCatalogHandler } from '../../control-plane/host-handlers.js';
import { isDelegatedCaller, runNativeMutation, type NativeMutationHost } from '../../control-plane/native-mutation.js';
import { isRecord } from '../../utils/record-coerce.js';
import { normalizeAtSchedule, normalizeCronSchedule, normalizeEverySchedule } from '../../automation/schedules.js';
import { parseCreateAutomationJobInput, parseUpdateAutomationJobInput } from './runtime-routes.js';

function nativeClockMeaning(value: number | undefined): string | { readonly iso: string; readonly fractionalMillisecond: number } | undefined {
  if (value === undefined) return undefined;
  const iso = new Date(value).toISOString(), whole = Date.parse(iso);
  return whole === value ? iso : { iso, fractionalMillisecond: value - whole };
}

function nativeScheduleMeaning(schedule: AutomationScheduleDefinition) {
  return schedule.kind === 'at' ? { ...schedule, at: nativeClockMeaning(schedule.at) }
    : schedule.kind === 'every' ? { ...schedule, anchorAt: nativeClockMeaning(schedule.anchorAt) }
    : schedule;
}

function nativeJobMeaning(job: ManagedAutomationJob) {
  const { id, mutationRevision, lastRunId, ...meaning } = job;
  const { id: sourceId, ...source } = job.source;
  return { ...meaning, schedule: nativeScheduleMeaning(job.schedule),
    createdAt: nativeClockMeaning(job.createdAt), updatedAt: nativeClockMeaning(job.updatedAt),
    nextRunAt: nativeClockMeaning(job.nextRunAt), lastRunAt: nativeClockMeaning(job.lastRunAt), archivedAt: nativeClockMeaning(job.archivedAt),
    source: { ...source, createdAt: nativeClockMeaning(source.createdAt), updatedAt: nativeClockMeaning(source.updatedAt), lastSeenAt: nativeClockMeaning(source.lastSeenAt) },
  };
}

type ScheduleKind = 'cron' | 'every' | 'at';

/**
 * The schedule a create body names. `kind` is optional (the published schema
 * accepts `{ prompt, every }` and `{ prompt, at }` alone): without it the field
 * present decides, `every`, then `at`, then `cron`/`schedule.expression`. A
 * value the normalizer refuses is a 400 naming that field, never a cron error
 * for an interval.
 */
function readCreateSchedule(body: Record<string, unknown>): unknown {
  if (isRecord(body.schedule) && body.schedule.kind !== undefined) return body.schedule;
  const declared = body.kind, every = body.every, at = body.at, cron = body.cron, scheduleBody = body.schedule;
  const kind: ScheduleKind | undefined = declared === 'cron' || declared === 'every' || declared === 'at' ? declared
    : declared !== undefined ? undefined
    : every !== undefined ? 'every'
    : at !== undefined ? 'at'
    : 'cron';
  if (kind === undefined) {
    throw new HandlerError(`kind must be "cron", "every" or "at"; got ${JSON.stringify(declared)}. Nothing was changed.`, 'INVALID_ARGUMENT', 400, 'kind');
  }
  const field = kind === 'cron' ? (typeof cron === 'string' || !isRecord(scheduleBody) ? 'cron' : 'schedule.expression') : kind;
  try {
    if (kind === 'every') return normalizeEverySchedule(typeof every === 'string' || typeof every === 'number' ? every : '');
    if (kind === 'at') return normalizeAtSchedule(typeof at === 'number' ? at : Date.parse(String(at)));
    const expression = typeof cron === 'string' ? cron : isRecord(scheduleBody) && typeof scheduleBody.expression === 'string' ? scheduleBody.expression : '';
    return normalizeCronSchedule(expression, typeof body.timezone === 'string' ? body.timezone : undefined, body.staggerMs ?? body.stagger);
  } catch (error) {
    if (error instanceof HandlerError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new HandlerError(`${field} is not an accepted ${kind} schedule: ${reason}. Nothing was changed.`, 'INVALID_ARGUMENT', 400, field);
  }
}

/** Bind the authentic gateway invocation before REST's legacy route fallback. */
export function registerNativeAutomationGatewayMethods(catalog: GatewayMethodCatalog, input: {
  readonly manager: AutomationManager;
  readonly host: NativeMutationHost;
}): () => void {
  const disposals = [registerCatalogHandler<unknown, unknown>(catalog, 'automation.jobs.update', async ({ body, context }) => {
    if (!isRecord(body) || typeof body.jobId !== 'string' || !body.jobId.trim()) throw new HandlerError('An automation job id is required.', 'INVALID_ARGUMENT', 400);
    if (body.expectedMutationRevision !== undefined && (typeof body.expectedMutationRevision !== 'string' || !body.expectedMutationRevision.trim())) throw new HandlerError('expectedMutationRevision must be a nonempty string.', 'INVALID_ARGUMENT', 400);
    if (isDelegatedCaller(context) && typeof body.expectedMutationRevision !== 'string') throw new HandlerError('An update the Agent makes on your behalf needs the selected job revision (expectedMutationRevision from automation.schedules.list).', 'AUTOMATION_JOB_REVISION_REQUIRED', 409);
    const jobId = body.jobId;
    const { manager, host } = input;
    const current = () => { context.signal?.throwIfAborted(); };
    try {
      current();
      // A wrong field is the parser's 400 INVALID_ARGUMENT naming it, nested fields included.
      const patch = parseUpdateAutomationJobInput(body);
      const expected = patch.expectedMutationRevision;
      const selected = expected ? manager.retainJobTarget(jobId, expected) : undefined;
      const updated = await runNativeMutation({ host, method: 'automation.jobs.update', body, context,
        automationTarget: selected,
        target: selected ? nativeJobMeaning(selected.job) : { jobId },
        scopes: ['write:automation'], confirmation: 'none',
        assertTargetCurrent: () => { current(); selected?.assertCurrent(); },
        mutate: (assertCurrent, _admission, withPublication) => manager.updateJob(jobId, patch, { signal: context.signal, assertCurrent: () => { current(); assertCurrent(); }, withPublication }),
      });
      if (!updated) throw new HandlerError('Automation job not found.', 'NOT_FOUND', 404);
      return updated;
    } catch (error) {
      if (error instanceof AutomationJobMutationStaleError || error instanceof AutomationJobCommitIndeterminateError) throw new HandlerError(error.message, error.code, error.status);
      throw error;
    }
  })];
  for (const method of ['automation.jobs.create', 'automation.schedules.create']) {
    disposals.push(registerCatalogHandler<unknown, unknown>(catalog, method, async ({ body, context }) => {
      if (!isRecord(body) || typeof body.prompt !== 'string' || !body.prompt.trim()) throw new HandlerError('An automation prompt is required.', 'INVALID_ARGUMENT', 400);
      const { manager, host } = input;
      const current = () => { context.signal?.throwIfAborted(); };
      current();
      const schedule = readCreateSchedule(body);
      const patch = parseCreateAutomationJobInput({ ...body, name: typeof body.name === 'string' ? body.name : body.prompt.slice(0, 40), schedule });
      try {
        const created = await runNativeMutation({ host, method, body, context, target: { schedule: nativeScheduleMeaning(patch.schedule) }, scopes: ['write:automation'], confirmation: 'none', assertTargetCurrent: current,
          mutate: (assertCurrent, _admission, withPublication) => manager.createJob(patch, { signal: context.signal, assertCurrent: () => { current(); assertCurrent(); }, withPublication }),
        });
        return Response.json(created, { status: 201 });
      } catch (error) {
        if (error instanceof AutomationJobMutationStaleError || error instanceof AutomationJobCommitIndeterminateError) throw new HandlerError(error.message, error.code, error.status);
        throw error;
      }
    }));
  }
  for (const method of ['automation.jobs.enable', 'automation.jobs.disable', 'automation.jobs.delete', 'automation.schedules.enable', 'automation.schedules.disable', 'automation.schedules.delete']) {
    disposals.push(registerCatalogHandler<unknown, unknown>(catalog, method, async ({ body, context }) => {
      const key = method.startsWith('automation.jobs.') ? 'jobId' : 'scheduleId';
      if (!isRecord(body) || typeof body[key] !== 'string' || !body[key].trim()) throw new HandlerError('An automation job id is required.', 'INVALID_ARGUMENT', 400);
      const jobId = body[key], revision = body.expectedMutationRevision;
      if (revision !== undefined && (typeof revision !== 'string' || !revision.trim())) throw new HandlerError('expectedMutationRevision must be a nonempty string.', 'INVALID_ARGUMENT', 400);
      if (isDelegatedCaller(context) && typeof revision !== 'string') throw new HandlerError('A change the Agent makes on your behalf needs the selected job revision (expectedMutationRevision from automation.schedules.list).', 'AUTOMATION_JOB_REVISION_REQUIRED', 409);
      const { manager, host } = input;
      const current = () => { context.signal?.throwIfAborted(); };
      try {
        current();
        const selected = typeof revision === 'string' ? manager.retainJobTarget(jobId, revision) : undefined;
        return await runNativeMutation({ host, method, body, context, target: selected ? nativeJobMeaning(selected.job) : { jobId }, scopes: ['write:automation'], confirmation: 'none',
          automationTarget: selected,
          assertTargetCurrent: () => { current(); selected?.assertCurrent(); },
          mutate: async (assertCurrent, _admission, withPublication) => {
            const options = { signal: context.signal, assertCurrent: () => { current(); assertCurrent(); }, withPublication };
            if (method.endsWith('.delete')) {
              const removed = await manager.removeJob(jobId, options);
              if (!removed) throw new HandlerError('Automation job not found.', 'NOT_FOUND', 404);
              return { id: jobId, removed };
            }
            const enabled = method.endsWith('.enable');
            const updated = await manager.setEnabled(jobId, enabled, options);
            if (!updated) throw new HandlerError('Automation job not found.', 'NOT_FOUND', 404);
            return { id: jobId, enabled };
          },
        });
      } catch (error) {
        if (error instanceof AutomationJobMutationStaleError || error instanceof AutomationJobCommitIndeterminateError) throw new HandlerError(error.message, error.code, error.status);
        throw error;
      }
    }));
  }
  return () => { for (const dispose of disposals.reverse()) dispose(); };
}
