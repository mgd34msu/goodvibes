import { ensureAutomationCronPhase, ownerTimezone, withCronTimezone, type AutomationScheduleDefinition } from './schedules.js';
import { randomUUID } from 'node:crypto';
import type { ConfigManager } from '../config/manager.js';
import type { AutomationJob, ManagedAutomationJob } from './jobs.js';
import type { AutomationJobMutationOptions } from './job-mutations.js';
import type { CreateAutomationJobInput, UpdateAutomationJobInput } from './manager-runtime-helpers.js';
import type { ModelIdCandidate } from '../providers/model-id-resolution.js';
import {
  buildDefaultDelivery,
  buildDefaultExecution,
  buildDefaultFailurePolicy,
  assertProviderMatchesModel,
  assertProviderHasModel,
  buildDefaultSource,
  nextJobEnablement,
  normalizeOptionalString,
  normalizeProviderQualifiedModel,
  normalizeProviderQualifiedModelList,
  normalizeProviderRoutingPolicy,
} from './manager-runtime-helpers.js';

interface AutomationJobMutationContext {
  readonly configManager: ConfigManager;
  readonly jobs: Map<string, AutomationJob>;
  readonly commitJob: (previous: AutomationJob | undefined, next: AutomationJob, options?: AutomationJobMutationOptions) => Promise<ManagedAutomationJob>;
  readonly scheduleJob: (job: AutomationJob) => void;
  readonly syncJobToRuntime: (job: AutomationJob, source: string) => void;
  readonly emitJobCreated: (job: AutomationJob) => void;
  readonly emitJobUpdated: (job: AutomationJob, changedFields: string[]) => void;
  /**
   * The live provider registry's model candidates, when the caller has one
   * wired up. Enables bare model id resolution (unique -> auto-qualify;
   * ambiguous/unknown -> a rich error) for `model`/`fallbackModels` fields.
   * Omitted callers keep the prior format-only validation.
   */
  readonly listModels?: () => readonly ModelIdCandidate[];
}

/**
 * An interval counts from when it was set, not from whenever the next run is
 * computed: the anchor is stamped once, so later edits and restarts keep the
 * same rhythm.
 */
function anchoredSchedule(schedule: AutomationScheduleDefinition, now: number): AutomationScheduleDefinition {
  return schedule.kind === 'every' && schedule.anchorAt === undefined ? { ...schedule, anchorAt: now } : schedule;
}

const UPDATE_FIELDS = ['kind', 'name', 'description', 'enabled', 'schedule', 'execution', 'delivery', 'failure', 'deleteAfterRun'] as const;

/** The definition fields that differ between two records of one job. */
function changedJobFields(previous: AutomationJob, next: AutomationJob): string[] {
  return UPDATE_FIELDS.filter(field => JSON.stringify(previous[field]) !== JSON.stringify(next[field]));
}

export async function createAutomationJobRecord(
  context: AutomationJobMutationContext,
  input: CreateAutomationJobInput,
  options: AutomationJobMutationOptions = {},
): Promise<ManagedAutomationJob> {
  const now = Date.now();
  const jobId = input.id?.trim() || `auto-${randomUUID().slice(0, 8)}`;
  const schedule = anchoredSchedule(ensureAutomationCronPhase(withCronTimezone(input.schedule, ownerTimezone(context.configManager))), now);
  const enablement = nextJobEnablement(undefined, input.enabled ?? true, schedule, now, 'created-disabled');
  const job: AutomationJob = {
    id: jobId,
    labels: [],
    createdAt: now,
    updatedAt: now,
    createdBy: 'automation-manager',
    updatedBy: 'automation-manager',
    ...(input.kind ? { kind: input.kind } : {}),
    name: input.name.trim() || input.prompt.slice(0, 40),
    description: input.description ?? input.prompt,
    enabled: enablement.enabled,
    status: enablement.status,
    schedule,
    execution: buildDefaultExecution(input, context.listModels?.()),
    delivery: buildDefaultDelivery(input.delivery),
    failure: buildDefaultFailurePolicy(context.configManager, input.failure),
    source: buildDefaultSource(enablement.enabled, now),
    nextRunAt: enablement.nextRunAt,
    lastRunAt: undefined,
    lastRunId: undefined,
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    pausedReason: enablement.pausedReason,
    // The setting is a default for one-shot jobs only: a recurring job deleted after its first run would silently stop recurring.
    deleteAfterRun: input.deleteAfterRun ?? (schedule.kind === 'at' && Boolean(context.configManager.get('automation.deleteAfterRun'))),
    archivedAt: undefined,
  };
  const committed = await context.commitJob(undefined, job, options);
  context.scheduleJob(committed);
  context.syncJobToRuntime(committed, 'automation.create');
  context.emitJobCreated(committed);
  return committed;
}

export async function toggleAutomationJobEnabled(
  context: AutomationJobMutationContext,
  jobId: string,
  enabled: boolean,
  options: AutomationJobMutationOptions = {},
): Promise<ManagedAutomationJob | null> {
  const job = context.jobs.get(jobId);
  if (!job) return null;
  const now = Date.now();
  const updated: AutomationJob = {
    ...job,
    ...nextJobEnablement(job, enabled, job.schedule, now),
    updatedAt: now,
  };
  const committed = await context.commitJob(job, updated, options);
  context.scheduleJob(committed);
  context.syncJobToRuntime(committed, 'automation.toggle');
  context.emitJobUpdated(committed, changedJobFields(job, committed));
  return committed;
}

export async function updateAutomationJobRecord(
  context: AutomationJobMutationContext,
  jobId: string,
  patch: UpdateAutomationJobInput,
  options: AutomationJobMutationOptions = {},
): Promise<ManagedAutomationJob | null> {
  const job = context.jobs.get(jobId);
  if (!job) return null;

  const prompt = patch.prompt ?? job.execution.prompt ?? job.description ?? job.name;
  const updatedAt = Date.now();
  const models = context.listModels?.();
  const fallbackModelsPatch = patch.fallbackModels !== undefined
    ? normalizeProviderQualifiedModelList(patch.fallbackModels, 'Automation fallback models', models)
    : undefined;
  const thinkingPatch = normalizeOptionalString(patch.thinking);
  const nextSchedule = patch.schedule
    ? anchoredSchedule(ensureAutomationCronPhase(withCronTimezone(patch.schedule, ownerTimezone(context.configManager)), job.schedule), updatedAt)
    : job.schedule;
  // The next run moves only when what decides it moved: the schedule, or
  // whether the job is enabled. A rename or a prompt fix keeps it.
  const enablement = nextJobEnablement(job, patch.enabled ?? job.enabled, nextSchedule, updatedAt);
  const nextModelProvider = patch.provider !== undefined
    ? normalizeOptionalString(patch.provider)
    : job.execution.modelProvider;
  const nextModelId = patch.model !== undefined
    ? normalizeProviderQualifiedModel(patch.model, 'Automation model', models, nextModelProvider)
    : job.execution.modelId;
  assertProviderHasModel(nextModelId, nextModelProvider, 'Automation model routing');
  assertProviderMatchesModel(nextModelId, nextModelProvider, 'Automation model');
  const routingFallbackModelsPatch = patch.routing?.fallbackModels !== undefined
    ? normalizeProviderQualifiedModelList(patch.routing.fallbackModels, 'Automation fallback models', models)
    : undefined;
  const nextFallbackModels = routingFallbackModelsPatch
    ?? fallbackModelsPatch
    ?? (patch.routing?.providerFailurePolicy === 'fail'
      ? undefined
      : job.execution.fallbackModels ?? job.execution.routing?.fallbackModels);
  const updated: AutomationJob = {
    ...job,
    ...(patch.kind ? { kind: patch.kind } : {}),
    name: patch.name ?? job.name,
    description: patch.description ?? (patch.prompt ? patch.prompt : job.description),
    schedule: nextSchedule,
    execution: {
      ...job.execution,
      prompt,
      template: patch.template ?? job.execution.template,
      target: patch.target ?? job.execution.target,
      modelId: nextModelId,
      modelProvider: nextModelProvider,
      fallbackModels: nextFallbackModels,
      routing: normalizeProviderRoutingPolicy({
        modelProvider: nextModelProvider,
        fallbackModels: nextFallbackModels,
        routing: patch.routing ?? job.execution.routing,
      }, models),
      reasoningEffort: patch.reasoningEffort ?? job.execution.reasoningEffort,
      thinking: thinkingPatch ?? job.execution.thinking,
      wakeMode: patch.wakeMode ?? job.execution.wakeMode,
      timeoutMs: patch.timeoutMs ?? job.execution.timeoutMs,
      // An empty list clears the allowlist (no restriction), as on create.
      toolAllowlist: patch.toolAllowlist === undefined ? job.execution.toolAllowlist : patch.toolAllowlist.length ? patch.toolAllowlist : undefined,
      allowUnsafeExternalContent: patch.allowUnsafeExternalContent ?? job.execution.allowUnsafeExternalContent,
      externalContentSource: patch.externalContentSource ?? job.execution.externalContentSource,
      lightContext: patch.lightContext ?? job.execution.lightContext,
    },
    delivery: buildDefaultDelivery({
      ...job.delivery,
      ...(patch.delivery ?? {}),
    }),
    failure: buildDefaultFailurePolicy(context.configManager, {
      ...job.failure,
      ...(patch.failure ?? {}),
      retryPolicy: {
        ...job.failure.retryPolicy,
        ...(patch.failure?.retryPolicy ?? {}),
      },
    }),
    deleteAfterRun: patch.deleteAfterRun ?? job.deleteAfterRun,
    ...enablement,
    updatedAt,
  };

  const committed = await context.commitJob(job, updated, options);
  context.scheduleJob(committed);
  context.syncJobToRuntime(committed, 'automation.update');
  context.emitJobUpdated(committed, changedJobFields(job, committed));
  return committed;
}
