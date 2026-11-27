import { ensureAutomationCronPhase, ownerTimezone, withCronTimezone, type AutomationScheduleDefinition } from './schedules.js';
import { createHash, randomUUID } from 'node:crypto';
import { projectIdentityOf } from '../workspace/project-identity.js';
import { recordedCauseInScope } from '../security/turn-input-party.js';
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

/** The project a job or a create works in, as one identity (the same folder however it is named), '' for none. */
function projectOf(folder: string | undefined): string {
  return folder && folder.trim() ? projectIdentityOf(folder.trim()) : '';
}

/**
 * The id a schedule whose id a person chose is stored under: the name they chose and a part made from their project and
 * that name alone (`<id>-<8 hex>`), the same for every create of it in that project and different in every other. It is
 * made the same way whatever any other project holds, so it never says whether another project has a schedule of that
 * name, and a create naming another project's schedule is never answered with that one.
 */
export function storedScheduleId(chosen: string, workingDirectory: string | undefined): string {
  const part = createHash('sha256').update(`${projectOf(workingDirectory)}\u0000${chosen}`).digest('hex').slice(0, 8);
  return `${chosen}-${part}`;
}

/**
 * This project's schedule of the id a create chose (a repeat after a lost reply), or undefined: the one stored under the
 * id made for it here, or one kept under the chosen id itself (made before ids were made this way) in this project.
 * Another project's schedule is never this one.
 */
export function sameProjectJobOfChosenId(jobs: ReadonlyMap<string, ManagedAutomationJob>, input: Pick<CreateAutomationJobInput, 'id' | 'workingDirectory'>): ManagedAutomationJob | undefined {
  const chosen = input.id?.trim();
  if (!chosen) return undefined;
  const here = projectOf(input.workingDirectory);
  for (const id of [storedScheduleId(chosen, input.workingDirectory), chosen]) {
    const job = jobs.get(id);
    if (job && projectOf(job.execution.workingDirectory) === here) return job;
  }
  return undefined;
}

/** A schedule's id: the one made from the name a person chose and their project (`storedScheduleId`), or a new one. */
function scheduleIdInProject(context: AutomationJobMutationContext, input: CreateAutomationJobInput): string {
  const chosen = input.id?.trim();
  if (!chosen) return `auto-${randomUUID().slice(0, 8)}`;
  const id = storedScheduleId(chosen, input.workingDirectory);
  // Held already (a schedule of another project whose made part is the same: never seen in practice): a new id, the
  // same shape, so nothing is said about the other.
  return context.jobs.has(id) ? `${chosen}-${randomUUID().replace(/-/g, '').slice(0, 8)}` : id;
}

export async function createAutomationJobRecord(
  context: AutomationJobMutationContext,
  input: CreateAutomationJobInput,
  options: AutomationJobMutationOptions = {},
): Promise<ManagedAutomationJob> {
  const now = Date.now();
  // Who made it, when not the owner: every run of it is then that caller's turn (jobs.ts `cause`).
  const cause = recordedCauseInScope();
  const jobId = scheduleIdInProject(context, input);
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
    ...(cause ? { cause } : {}),
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
  // Turned back on by someone else: its runs are that caller's from now on (pausing changes nobody's).
  const cause = enabled ? recordedCauseInScope() : undefined;
  const updated: AutomationJob = {
    ...job,
    ...nextJobEnablement(job, enabled, job.schedule, now),
    updatedAt: now,
    ...(cause ? { cause } : {}),
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
  // Changed by someone else: its runs are that caller's from now on. The owner's own change keeps who made it, unless
  // they gave it new words of their own (then what runs is theirs).
  const changedBy = recordedCauseInScope();
  const ownWords = !changedBy && (patch.prompt !== undefined || patch.description !== undefined || patch.template !== undefined);
  const { cause: _kept, ...uncaused } = updated;
  void _kept;
  const caused: AutomationJob = changedBy ? { ...uncaused, cause: changedBy } : ownWords ? uncaused : updated;

  const committed = await context.commitJob(job, caused, options);
  context.scheduleJob(committed);
  context.syncJobToRuntime(committed, 'automation.update');
  context.emitJobUpdated(committed, changedJobFields(job, committed));
  return committed;
}
