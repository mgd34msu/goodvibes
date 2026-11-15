import type { ExternalOperationSource } from '../permissions/external-request.js';
import { bindAutomationAction } from './action-source.js';
import { randomUUID } from 'node:crypto';
import { SharedSessionBroker } from '../control-plane/index.js';
import type { SharedSessionRecord, SharedSessionSubmission } from '../control-plane/index.js';
import type { RouteBindingManager } from '../channels/index.js';
import type { AutomationJob } from './jobs.js';
import type { AutomationRouteBinding } from './routes.js';
import type { AutomationRun, AutomationRunContinuationMode } from './runs.js';
import type { AutomationSessionTarget } from './session-targets.js';
import type { AutomationRunTrigger } from './types.js';
import type { ConfigManager } from '../config/manager.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { readAutomationRunTransience } from './manager-runtime-delivery.js';
import {
  buildAutomationExecutionIntent,
  buildAutomationExecutionContext,
  canSettleStoredRun,
  jobEnablement,
} from './manager-runtime-helpers.js';
import { executeCheckinJob, type AutomationCheckinEvaluator } from './checkin-execution.js';
import { markWorkAuthorized } from '../agents/conversation-continuation.js';
import type { AutomationRunSettlement } from './manager-runtime-reconcile.js';

export interface AutomationManagerExecutionContext {
  /** Transfer a reserved startup slot to the now-visible run record. */
  readonly onRunRecorded?: () => void;
  readonly configManager: ConfigManager;
  readonly routeBindings: RouteBindingManager;
  readonly sessionBroker: SharedSessionBroker;
  readonly defaultSurfaceKind?: AutomationSessionTarget['surfaceKind'] | undefined;
  readonly defaultSurfaceId?: string | undefined;
  readonly spawnTask: (input: {
    readonly prompt: string;
    readonly modelId?: string | undefined;
    readonly modelProvider?: string | undefined;
    readonly fallbackModels?: readonly string[] | undefined;
    readonly routing?: AutomationRun['execution']['routing'] | undefined;
    readonly executionIntent?: AutomationRun['execution']['executionIntent'] | undefined;
    readonly template?: string | undefined;
    readonly reasoningEffort?: AutomationRun['execution']['reasoningEffort'] | undefined;
    readonly toolAllowlist?: readonly string[] | undefined;
    readonly context?: string | undefined;
  }) => string;
  readonly saveJobs: () => Promise<void>;
  readonly saveRuns: () => Promise<void>;
  readonly pruneRunHistory: (jobId?: string) => void;
  readonly activeRunCount: () => number;
  readonly maxConcurrentRuns: () => number;
  readonly syncExecutionRoute: (job: AutomationJob, run: AutomationRun) => Promise<void>;
  readonly syncRunToRuntime: (run: AutomationRun, source: string) => void;
  readonly syncJobToRuntime: (job: AutomationJob, source: string) => void;
  readonly emitRunStarted: (job: AutomationJob, run: AutomationRun) => void;
  readonly emitRunCompleted: (job: AutomationJob, run: AutomationRun, outcome: 'success' | 'partial' | 'failed' | 'cancelled') => void;
  readonly emitRunFailed: (job: AutomationJob, run: AutomationRun, error: string, retryable: boolean) => void;
  readonly maybeDeliverRun: (job: AutomationJob, run: AutomationRun) => void;
  /**
   * What a run that failed to START needs beyond its failed record: the failure
   * notice with the job's retry or cooldown policy, the auto-disable event, and
   * the cancellation of an agent that was spawned before the start failed.
   * Optional so a caller that only records runs need not wire them.
   */
  readonly followUpStartFailure?: ((job: AutomationJob, run: AutomationRun, retryable: boolean) => void) | undefined;
  readonly emitJobAutoDisabled?: ((job: AutomationJob, reason: string) => void) | undefined;
  readonly cancelTask?: ((agentId: string) => void) | undefined;
  readonly applyFailureToJob: (job: AutomationJob, timestamp: number, countRun?: boolean) => AutomationJob;
  /** Ends a running run the one way every run ends (see settleAutomationRun). */
  readonly settleRun: (run: AutomationRun, settlement: AutomationRunSettlement, source: string) => AutomationRun;
  readonly jobs: Map<string, AutomationJob>;
  readonly runs: Map<string, AutomationRun>;
  /**
   * Optional check-in evaluator. When a `kind: 'checkin'` job fires and this is
   * attached, executeAutomationJob delegates to it (see checkin-execution.ts)
   * instead of the generic agent-spawn path. Absent → a checkin job degrades to
   * an ordinary job (nothing to evaluate), never an error.
   */
  readonly checkinEvaluator?: AutomationCheckinEvaluator | undefined;
}

interface ResolvedAutomationExecution {
  readonly task: string;
  readonly continuationMode: AutomationRunContinuationMode;
  readonly session?: SharedSessionRecord | undefined;
  readonly route?: AutomationRouteBinding | undefined;
  readonly agentId?: string | undefined;
  /** The session input this run submitted; the spawned agent claims exactly it. */
  readonly inputId?: string | undefined;
  readonly target: AutomationSessionTarget;
  readonly executionIntent: AutomationRun['executionIntent'];
  readonly updatedJob?: AutomationJob | undefined;
}

/** The job was removed while one of its runs was starting. */
class AutomationJobRemovedError extends Error {
  constructor(jobId: string) { super(`Automation job ${jobId} was removed while its run was starting`); }
}

/**
 * Applies a run's start to the job as it is now, not to the copy read before
 * the start awaited anything: an edit that landed meanwhile is kept, and a
 * job removed meanwhile is not brought back (undefined is returned).
 */
function recordOnCurrentJob(
  context: AutomationManagerExecutionContext,
  jobId: string,
  change: (current: AutomationJob) => AutomationJob,
): AutomationJob | undefined {
  const current = context.jobs.get(jobId);
  if (!current) return undefined;
  const updated = change(current);
  context.jobs.set(jobId, updated);
  return updated;
}

function requireHostSurfaceKind(
  context: AutomationManagerExecutionContext,
  target: AutomationSessionTarget,
  job: AutomationJob,
): NonNullable<AutomationSessionTarget['surfaceKind']> {
  const surfaceKind = target.surfaceKind ?? context.defaultSurfaceKind;
  if (!surfaceKind) {
    throw new Error(
      `Automation target "${target.kind}" requires target.surfaceKind or an explicit AutomationManager defaultSurfaceKind (${job.id})`,
    );
  }
  return surfaceKind;
}

function resolveHostSurfaceId(
  context: AutomationManagerExecutionContext,
  surfaceKind: NonNullable<AutomationSessionTarget['surfaceKind']>,
): string {
  return context.defaultSurfaceId ?? `surface:${surfaceKind}`;
}

export async function executeAutomationJob(
  context: AutomationManagerExecutionContext,
  job: AutomationJob,
  trigger: AutomationRunTrigger,
  dueRun: boolean,
  attempt = 1,
  operation?: ExternalOperationSource,
): Promise<AutomationRun> {
  const assertSource = () => {
    if (job.execution.requiresSourceOwner && !operation) throw new Error('Automation original source owner is unavailable');
    operation?.assertCurrent(); operation?.signal?.throwIfAborted();
    if (operation && context.jobs.get(job.id)?.mutationRevision !== job.mutationRevision) throw new Error('Source-owned automation job changed or was removed');
  };
  assertSource();
  if (job.kind === 'checkin' && context.checkinEvaluator) {
    return await executeCheckinJob(context, context.checkinEvaluator, job, trigger, dueRun, attempt);
  }
  const now = Date.now();
  const prompt = job.execution.prompt ?? job.description ?? job.name;
  // A target that cannot be resolved (missing session or route, no surface
  // kind) is a failed start like any other: the run is recorded against the
  // unresolved target and goes through the failure handling below.
  let resolveFailure: { readonly error: unknown } | undefined;
  let resolved: ResolvedAutomationExecution;
  try {
    resolved = await resolveAutomationExecution(context, job, prompt, trigger);
  } catch (error) {
    resolveFailure = { error };
    resolved = {
      task: prompt,
      continuationMode: 'spawn',
      target: job.execution.target,
      executionIntent: buildAutomationExecutionIntent(job.execution.target.kind, 'spawn'),
    };
  }
  assertSource();
  const effectiveJob = resolved.updatedJob ?? job;
  const run: AutomationRun = {
    id: `autorun-${job.id}-${now}-${randomUUID().slice(0, 6)}`,
    labels: trigger === 'manual' ? ['manual'] : ['scheduled'],
    createdAt: now,
    updatedAt: now,
    createdBy: 'automation-manager',
    updatedBy: 'automation-manager',
    jobId: job.id,
    status: 'running',
    triggeredBy: {
      ...effectiveJob.source,
      lastSeenAt: now,
      updatedAt: now,
    },
    target: resolved.target,
    execution: {
      ...effectiveJob.execution,
      prompt,
    },
    scheduleKind: effectiveJob.schedule.kind,
    queuedAt: now,
    startedAt: now,
    endedAt: undefined,
    durationMs: undefined,
    forceRun: trigger === 'manual',
    dueRun,
    attempt,
    sessionId: resolved.session?.id,
    routeId: resolved.route?.id,
    route: resolved.route,
    continuationMode: resolved.continuationMode,
    executionIntent: resolved.executionIntent,
    deliveryIds: [],
    deliveryAttempts: undefined,
    modelId: effectiveJob.execution.modelId,
    providerId: effectiveJob.execution.modelProvider,
    result: undefined,
    error: undefined,
    cancelledReason: undefined,
    agentId: resolved.agentId,
  };

  // What starting a run writes on its job: the run counters, and the session
  // a pinned target was given on its first run.
  const startOnJob = (current: AutomationJob): AutomationJob => ({
    ...current,
    ...(resolved.updatedJob ? { execution: { ...current.execution, target: resolved.updatedJob.execution.target } } : {}),
    lastRunAt: now,
    lastRunId: run.id,
    runCount: current.runCount + 1,
    updatedAt: now,
  });

  // Set once the agent exists, so a later failure can cancel and record it.
  let spawnedAgentId: string | undefined;
  try {
    if (resolveFailure) throw resolveFailure.error;
    if (resolved.continuationMode === 'continued-live') {
      const runningRun: AutomationRun = {
        ...run,
        agentId: resolved.agentId,
      };
      const updatedJob = recordOnCurrentJob(context, job.id, startOnJob);
      if (!updatedJob) throw new AutomationJobRemovedError(job.id);
      context.runs.set(runningRun.id, runningRun);
      context.onRunRecorded?.();
      await context.syncExecutionRoute(updatedJob, runningRun);
      context.pruneRunHistory(updatedJob.id);
      await Promise.all([context.saveJobs(), context.saveRuns()]);
      context.syncRunToRuntime(runningRun, 'automation.execute');
      context.syncJobToRuntime(updatedJob, 'automation.execute');
      context.emitRunStarted(updatedJob, runningRun);
      return runningRun;
    }

    const executionContext = buildAutomationExecutionContext(effectiveJob.execution, resolved.session?.id);
    assertSource();
    const agentId = context.spawnTask(bindAutomationAction({
      prompt: resolved.task,
      modelId: effectiveJob.execution.modelId,
      modelProvider: effectiveJob.execution.modelProvider,
      fallbackModels: effectiveJob.execution.fallbackModels,
      routing: effectiveJob.execution.routing,
      executionIntent: effectiveJob.execution.executionIntent,
      template: effectiveJob.execution.template,
      reasoningEffort: effectiveJob.execution.reasoningEffort,
      toolAllowlist: effectiveJob.execution.toolAllowlist,
      ...(executionContext ? { context: executionContext } : {}),
    }, operation));
    spawnedAgentId = agentId;
    const runningRun: AutomationRun = {
      ...run,
      agentId,
    };
    if (resolved.session?.id && resolved.continuationMode !== 'background') {
      await context.sessionBroker.bindAgent(resolved.session.id, agentId, resolved.inputId);
    }
    const updatedJob = recordOnCurrentJob(context, job.id, startOnJob);
    if (!updatedJob) throw new AutomationJobRemovedError(job.id);
    context.runs.set(runningRun.id, runningRun);
    context.onRunRecorded?.();
    await context.syncExecutionRoute(updatedJob, runningRun);
    context.pruneRunHistory(updatedJob.id);
    await Promise.all([context.saveJobs(), context.saveRuns()]);
    context.syncRunToRuntime(runningRun, 'automation.execute');
    context.syncJobToRuntime(updatedJob, 'automation.execute');
    context.emitRunStarted(updatedJob, runningRun);
    return runningRun;
  } catch (error) {
    const message = summarizeError(error);
    const stored = context.runs.get(run.id);
    if (!canSettleStoredRun(stored, 'failed')) {
      // Cancelled (or otherwise settled) while the start was in flight: the
      // recorded outcome stands; the start failure is still the caller's error.
      logger.warn('AutomationManager: start failed after the run was already settled; keeping its recorded status', {
        jobId: job.id, runId: run.id, status: stored?.status, error: message,
      });
      throw error;
    }
    if (spawnedAgentId !== undefined) {
      // The agent started but the run could not be recorded as running: stop it
      // so it does not keep working untracked, and keep its id on the record.
      try { context.cancelTask?.(spawnedAgentId); }
      catch (cancelError) {
        logger.warn('AutomationManager: could not cancel the agent of a run that failed to record', { jobId: job.id, runId: run.id, agentId: spawnedAgentId, error: summarizeError(cancelError) });
      }
    }
    if (resolved.session?.id && resolved.inputId && resolved.continuationMode === 'shared-session') {
      // The job's prompt was queued in the session for this run's agent. No
      // agent will answer it now, so it is marked failed instead of waiting
      // there; a retry queues its own.
      try { await context.sessionBroker.failInput(resolved.session.id, resolved.inputId, message); }
      catch (inputError) {
        logger.warn('AutomationManager: the session input of a failed start could not be marked failed', { jobId: job.id, runId: run.id, inputId: resolved.inputId, error: summarizeError(inputError) });
      }
    }
    if (error instanceof AutomationJobRemovedError || !context.jobs.has(job.id)) {
      // Nothing is left to count the run against or retry: it is recorded as
      // cancelled, the way a running run of a removed job is.
      const cancelledRun: AutomationRun = {
        ...run,
        status: 'cancelled',
        endedAt: now,
        durationMs: 0,
        cancelledReason: 'job-removed',
        ...(spawnedAgentId !== undefined ? { agentId: spawnedAgentId } : {}),
      };
      context.runs.set(cancelledRun.id, cancelledRun);
      context.onRunRecorded?.();
      context.syncRunToRuntime(cancelledRun, 'automation.execute');
      try { await context.saveRuns(); }
      catch (persistError) {
        logger.warn('AutomationManager: the run of a removed job could not be saved', { jobId: job.id, runId: run.id, error: summarizeError(persistError) });
      }
      throw error;
    }
    const failedRun: AutomationRun = {
      ...run,
      status: 'failed',
      endedAt: now,
      durationMs: 0,
      error: message,
      ...(spawnedAgentId !== undefined ? { agentId: spawnedAgentId } : {}),
    };
    context.runs.set(failedRun.id, failedRun);
    context.onRunRecorded?.();
    const updatedJob = recordOnCurrentJob(context, job.id, current => context.applyFailureToJob(current, now))!;
    try {
      await context.syncExecutionRoute(updatedJob, failedRun);
      if (failedRun.sessionId && failedRun.continuationMode !== 'continued-live') {
        await context.sessionBroker.appendSystemMessage(failedRun.sessionId, `Automation failed: ${message}`, {
          automationJobId: updatedJob.id,
          automationRunId: failedRun.id,
          status: 'failed',
        });
      }
      context.pruneRunHistory(updatedJob.id);
      await Promise.all([context.saveJobs(), context.saveRuns()]);
    } catch (persistError) {
      // The in-memory record stands; the start failure below is still reported.
      logger.warn('AutomationManager: a failed start could not be fully recorded', { jobId: job.id, runId: run.id, error: summarizeError(persistError) });
    }
    context.syncRunToRuntime(failedRun, 'automation.execute');
    context.syncJobToRuntime(updatedJob, 'automation.execute');
    const transience = await readAutomationRunTransience({ error }, 'automation.run.start', { jobId: updatedJob.id, runId: failedRun.id });
    const retryable = transience?.failureClass === 'retryable';
    context.emitRunFailed(updatedJob, failedRun, message, retryable);
    if (!updatedJob.enabled && effectiveJob.enabled) {
      context.emitJobAutoDisabled?.(updatedJob, updatedJob.pausedReason ?? 'failure-threshold-reached');
    }
    context.followUpStartFailure?.(updatedJob, failedRun, retryable);
    throw error;
  }
}

export async function resolveAutomationExecution(
  context: AutomationManagerExecutionContext,
  job: AutomationJob,
  prompt: string,
  trigger: AutomationRunTrigger,
): Promise<ResolvedAutomationExecution> {
  const target = job.execution.target;
  await context.routeBindings.start();
  await context.sessionBroker.start();

  if (target.kind === 'isolated') {
    return {
      task: prompt,
      continuationMode: 'spawn',
      route: resolveRouteForTarget(context, target, job),
      target,
      executionIntent: buildAutomationExecutionIntent(target.kind, 'spawn'),
    };
  }

  if (target.kind === 'background') {
    return {
      task: prompt,
      continuationMode: 'background',
      route: resolveRouteForTarget(context, target, job),
      target,
      executionIntent: buildAutomationExecutionIntent(target.kind, 'background'),
    };
  }

  if (target.kind === 'main') {
    const surfaceKind = requireHostSurfaceKind(context, target, job);
    const preferredSession = target.sessionId
      ? context.sessionBroker.getSession(target.sessionId)
      : await context.sessionBroker.findPreferredSession({
          surfaceKind,
        });
    if (!preferredSession && !target.createIfMissing) {
      throw new Error(`No active shared session found for main target (${job.id})`);
    }
    const fallbackSessionId = target.sessionId ?? target.pinnedSessionId ?? 'main';
    const session = preferredSession ?? await context.sessionBroker.ensureSession({
      sessionId: fallbackSessionId,
      title: 'Main automation session',
      metadata: {
        source: 'automation',
        jobId: job.id,
        targetKind: 'main',
      },
      participant: {
        surfaceKind,
        surfaceId: resolveHostSurfaceId(context, surfaceKind),
        userId: 'automation',
        displayName: `Automation: ${job.name}`,
        lastSeenAt: Date.now(),
      },
    });
    return await resolveSharedSessionExecution(context, job, prompt, trigger, {
      sessionId: session.id,
      target: {
        ...target,
        sessionId: session.id,
      },
    });
  }

  if (target.kind === 'route') {
    const routeId = target.routeId ?? job.delivery.replyToRouteId;
    if (!routeId) {
      throw new Error(`Automation route target requires a route binding (${job.id})`);
    }
    const route = context.routeBindings.getBinding(routeId);
    if (!route) {
      throw new Error(`Automation route target not found: ${routeId}`);
    }
    return await resolveSharedSessionExecution(context, job, prompt, trigger, {
      routeId: route.id,
      target: {
        ...target,
        routeId: route.id,
      },
    });
  }

  if (target.kind === 'session') {
    if (!target.sessionId) {
      throw new Error(`Automation session target requires sessionId (${job.id})`);
    }
    const existingSession = context.sessionBroker.getSession(target.sessionId);
    if (!existingSession && !target.createIfMissing) {
      throw new Error(`Automation session target not found: ${target.sessionId}`);
    }
    const session = await context.sessionBroker.ensureSession({
      sessionId: target.sessionId,
      title: `${job.name} automation session`,
      metadata: {
        source: 'automation',
        jobId: job.id,
      },
      participant: {
        surfaceKind: 'service',
        surfaceId: 'surface:automation',
        userId: 'automation',
        displayName: `Automation: ${job.name}`,
        lastSeenAt: Date.now(),
      },
    });
    return await resolveSharedSessionExecution(context, job, prompt, trigger, {
      sessionId: session.id,
      target: {
        ...target,
        sessionId: session.id,
      },
    });
  }

  if (target.kind === 'pinned') {
    const pinnedSessionId = target.pinnedSessionId ?? `auto-pin-${job.id}`;
    const session = await context.sessionBroker.ensureSession({
      sessionId: pinnedSessionId,
      title: `${job.name} automation session`,
      metadata: {
        source: 'automation',
        jobId: job.id,
        targetKind: 'pinned',
      },
      participant: {
        surfaceKind: 'service',
        surfaceId: 'surface:automation',
        userId: 'automation',
        displayName: `Automation: ${job.name}`,
        lastSeenAt: Date.now(),
      },
    });
    const updatedTarget: AutomationSessionTarget = {
      ...target,
      pinnedSessionId,
      sessionId: session.id,
    };
    return await resolveSharedSessionExecution(context, job, prompt, trigger, {
      sessionId: session.id,
      target: updatedTarget,
      updatedJob: target.pinnedSessionId === pinnedSessionId
        ? undefined
        : {
            ...job,
            updatedAt: Date.now(),
            execution: {
              ...job.execution,
              target: updatedTarget,
            },
          },
    });
  }

  if (target.kind === 'current') {
    const surfaceKind = requireHostSurfaceKind(context, target, job);
    const preferredSession = target.sessionId
      ? context.sessionBroker.getSession(target.sessionId)
      : await context.sessionBroker.findPreferredSession({
          surfaceKind,
        });
    if (!preferredSession && !target.createIfMissing) {
      throw new Error(`No active shared session found for current target (${job.id})`);
    }
    const session = preferredSession ?? await context.sessionBroker.ensureSession({
      title: `${job.name} automation session`,
      metadata: {
        source: 'automation',
        jobId: job.id,
        targetKind: 'current',
      },
      participant: {
        surfaceKind,
        surfaceId: resolveHostSurfaceId(context, surfaceKind),
        userId: 'automation',
        displayName: `Automation: ${job.name}`,
        lastSeenAt: Date.now(),
      },
    });
    return await resolveSharedSessionExecution(context, job, prompt, trigger, {
      sessionId: session.id,
      target: {
        ...target,
        sessionId: session.id,
      },
    });
  }

  return {
    task: prompt,
    continuationMode: 'spawn',
    route: resolveRouteForTarget(context, target, job),
    target,
    executionIntent: buildAutomationExecutionIntent(target.kind, 'spawn'),
  };
}

export async function resolveSharedSessionExecution(
  context: AutomationManagerExecutionContext,
  job: AutomationJob,
  prompt: string,
  trigger: AutomationRunTrigger,
  input: {
    readonly sessionId?: string | undefined;
    readonly routeId?: string | undefined;
    readonly target: AutomationSessionTarget;
    readonly updatedJob?: AutomationJob | undefined;
  },
): Promise<ResolvedAutomationExecution> {
  const route = input.routeId
    ? context.routeBindings.getBinding(input.routeId)
    : resolveRouteForTarget(context, input.target, job);
  if (route?.id && input.target.preserveThread && (input.target.threadId || input.target.channelId)) {
    await context.routeBindings.patchBinding(route.id, {
      ...(input.target.threadId ? { threadId: input.target.threadId } : {}),
      ...(input.target.channelId ? { channelId: input.target.channelId } : {}),
    });
  }
  if (job.execution.requiresSourceOwner) {
    if (!input.sessionId) throw new Error('Source-owned automation needs its pinned session');
    const session = context.sessionBroker.getSession(input.sessionId);
    if (!session) throw new Error('Source-owned automation session is unavailable');
    // Generated task prose must never become an authorized queued conversation input.
    return { task: prompt, session, route, target: input.target, continuationMode: 'spawn',
      executionIntent: buildAutomationExecutionIntent(input.target.kind, 'spawn'),
      ...(input.updatedJob ? { updatedJob: input.updatedJob } : {}) };
  }
  const submission = await context.sessionBroker.submitMessage({
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(route?.id ? { routeId: route.id } : {}),
    surfaceKind: 'service',
    surfaceId: 'surface:automation',
    externalId: `automation:${job.id}`,
    userId: 'automation',
    displayName: `Automation: ${job.name}`,
    title: job.name,
    body: prompt,
    // A schedule, trigger, or on-exit chain was authorized when it was
    // CREATED and must not be re-asked at execution time. The marker is what
    // tells the shared-session continuation runner that this input is
    // confirmed work rather than a message to answer, see
    // agents/conversation-continuation.ts.
    metadata: markWorkAuthorized({
      automationJobId: job.id,
      trigger,
      targetKind: input.target.kind,
    }),
  });
  return toResolvedExecution(job, input.target, submission, input.updatedJob);
}

export function toResolvedExecution(
  job: AutomationJob,
  target: AutomationSessionTarget,
  submission: SharedSessionSubmission,
  updatedJob?: AutomationJob,
): ResolvedAutomationExecution {
  const resolvedTarget: AutomationSessionTarget = {
    ...target,
    sessionId: submission.session.id,
    ...(submission.routeBinding?.id ? { routeId: submission.routeBinding.id } : {}),
  };
  return {
    task: submission.task ?? (job.execution.prompt ?? job.description ?? job.name),
    continuationMode: submission.mode === 'continued-live' ? 'continued-live' : 'shared-session',
    session: submission.session,
    route: submission.routeBinding,
    agentId: submission.activeAgentId,
    inputId: submission.input.id,
    target: resolvedTarget,
    executionIntent: buildAutomationExecutionIntent(
      target.kind,
      submission.mode === 'continued-live' ? 'continued-live' : 'shared-session',
    ),
    updatedJob,
  };
}

export function resolveRouteForTarget(
  context: AutomationManagerExecutionContext,
  target: AutomationSessionTarget,
  job: AutomationJob,
): AutomationRouteBinding | undefined {
  const routeId = target.routeId ?? job.delivery.replyToRouteId;
  if (!routeId) return undefined;
  return context.routeBindings.getBinding(routeId);
}

export async function syncExecutionRoute(
  context: AutomationManagerExecutionContext,
  job: AutomationJob,
  run: AutomationRun,
): Promise<void> {
  if (!run.routeId) return;
  await context.routeBindings.patchBinding(run.routeId, {
    ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
    jobId: job.id,
    runId: run.id,
    ...(run.target.threadId ? { threadId: run.target.threadId } : {}),
    ...(run.target.channelId ? { channelId: run.target.channelId } : {}),
  });
}

export function applyFailureToJob(job: AutomationJob, timestamp: number, countRun = true): AutomationJob {
  const nextFailureCount = job.failureCount + 1;
  const shouldPause = Boolean(job.failure.disableAfterFailures)
    && nextFailureCount >= job.failure.maxConsecutiveFailures;
  return {
    ...job,
    lastRunAt: timestamp,
    runCount: countRun ? job.runCount + 1 : job.runCount,
    failureCount: nextFailureCount,
    ...(shouldPause ? jobEnablement(false) : {}),
    pausedReason: shouldPause ? 'failure-threshold-reached' : job.pausedReason,
    updatedAt: timestamp,
  };
}
