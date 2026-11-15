import { randomUUID } from 'node:crypto';
import type { ArtifactReference, ArtifactStore } from '../artifacts/index.js';
import { ChannelDeliveryRouter, RouteBindingManager } from '../channels/index.js';
import { ServiceRegistry } from '../config/service-registry.js';
import { createDomainDispatch } from '../runtime/store/index.js';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { RouteSurfaceKind } from '../../events/routes.js';
import type { DeliveryKind } from '../../events/deliveries.js';
import {
  emitDeliveryDeadLettered,
  emitDeliveryFailed,
  emitDeliveryQueued,
  emitDeliveryStarted,
  emitDeliverySucceeded,
} from '../runtime/emitters/index.js';
import type { AutomationDeliveryAttempt, AutomationDeliveryTarget } from './delivery.js';
import { calculateRetryDelay } from './failures.js';
import type { AutomationJob } from './jobs.js';
import type { AutomationRouteBinding } from './routes.js';
import type { AutomationRun } from './runs.js';
import { readFailureTransience } from '../integrations/delivery.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import type { FeatureFlagReader } from '../runtime/feature-flags/index.js';
import { isFeatureGateEnabled, isSurfaceFeatureGateEnabled } from '../runtime/feature-flags/index.js';
import { sleep } from '../utils/concurrency.js';

function buildDeliveryMessage(job: AutomationJob, run: AutomationRun): string {
  const lines = [
    `Automation: ${job.name}`,
    `Run: ${run.id}`,
    `Status: ${run.status}`,
  ];
  if (run.error) lines.push(`Error: ${run.error}`);
  if (job.delivery.includeSummary) {
    const content = typeof run.result === 'string'
      ? run.result
      : run.result !== undefined
        ? JSON.stringify(run.result, null, 2)
        : '';
    if (content) {
      lines.push('');
      lines.push(content.length > 3500 ? `${content.slice(0, 3500)}...` : content);
    }
  }
  return lines.join('\n');
}

function toDeliveryKind(surfaceKind: RouteSurfaceKind, reply: boolean): DeliveryKind {
  if (reply) return 'reply';
  return surfaceKind === 'webhook' ? 'callback' : 'notification';
}

/**
 * The surface a delivery goes to, from the target the manager holds: its own
 * surface kind (a route target gets its binding's), else what its delivery
 * mode is. A webhook target is a webhook; an integration or link target
 * without a surface is a service endpoint, never a webhook.
 */
function toDeliverySurfaceKind(target: AutomationDeliveryTarget): RouteSurfaceKind {
  if (target.surfaceKind) return target.surfaceKind;
  return target.kind === 'webhook' ? 'webhook' : 'service';
}

/**
 * The identifier an event names a target by: its route id, then its label,
 * then the host of a URL address, then its delivery mode. The address itself
 * is never used: a Slack or Discord incoming-webhook URL is a secret.
 */
function toDeliveryTargetId(target: AutomationDeliveryTarget): string {
  if (target.routeId) return target.routeId;
  if (target.label) return target.label;
  if (target.address) {
    try {
      const host = new URL(target.address).host;
      if (host) return host;
    } catch {
      // Not a URL (a phone number, an e-mail address): fall through to the mode.
    }
  }
  return target.kind;
}

function extractArtifactReferences(result: unknown): ArtifactReference[] {
  if (!result || typeof result !== 'object') return [];
  const record = result as Record<string, unknown>;
  const rawItems = [
    ...(Array.isArray(record.artifacts) ? record.artifacts : []),
    ...(Array.isArray(record.attachments) ? record.attachments : []),
    ...(Array.isArray(record.artifactIds) ? record.artifactIds.map((artifactId) => ({ artifactId })) : []),
  ];
  const references: ArtifactReference[] = [];
  for (const entry of rawItems) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      references.push({ artifactId: entry.trim() });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    const artifactId = typeof candidate.artifactId === 'string'
      ? candidate.artifactId
      : typeof candidate.id === 'string'
        ? candidate.id
        : '';
    if (!artifactId) continue;
    references.push({
      artifactId,
      ...(typeof candidate.label === 'string' ? { label: candidate.label } : {}),
      ...(typeof candidate.metadata === 'object' && candidate.metadata !== null
        ? { metadata: candidate.metadata as Record<string, unknown> }
        : {}),
    });
  }
  return references.filter((entry, index, values) => values.findIndex((candidate) => candidate.artifactId === entry.artifactId) === index);
}

interface ResolvedDeliveryTarget {
  readonly target: AutomationDeliveryTarget;
  readonly binding?: AutomationRouteBinding | undefined;
}

export class AutomationDeliveryManager {
  private readonly routeBindings: RouteBindingManager;
  private readonly deliveryRouter: ChannelDeliveryRouter;
  private readonly featureFlags: FeatureFlagReader;
  private readonly artifactStore: Pick<ArtifactStore, 'get'> | undefined;
  private runtimeDispatch: DomainDispatch | null = null;
  private runtimeBus: RuntimeEventBus | null = null;

  constructor(config: {
    readonly serviceRegistry?: ServiceRegistry | undefined;
    readonly secretsManager?: Pick<import('../config/secrets.js').SecretsManager, 'get' | 'getGlobalHome'> | undefined;
    readonly configManager?: import('../config/manager.js').ConfigManager | undefined;
    readonly routeBindings: RouteBindingManager;
    readonly deliveryRouter?: ChannelDeliveryRouter | undefined;
    readonly artifactStore?: ArtifactStore | undefined;
    readonly runtimeStore?: RuntimeStore | undefined;
    readonly runtimeBus?: RuntimeEventBus | undefined;
    readonly featureFlags?: FeatureFlagReader | undefined;
  }) {
    this.routeBindings = config.routeBindings;
    this.artifactStore = config.artifactStore;
    this.featureFlags = config.featureFlags ?? null;
    if (config.deliveryRouter) {
      this.deliveryRouter = config.deliveryRouter;
    } else {
      if (!config.serviceRegistry || !config.configManager || !config.artifactStore || !config.secretsManager) {
        throw new Error(
          'AutomationDeliveryManager requires serviceRegistry, configManager, artifactStore, and secretsManager '
          + 'when no deliveryRouter is provided. Without secretsManager the router it builds cannot resolve '
          + 'goodvibes://secrets/... credentials, so those surfaces accept replies and never send them.',
        );
      }
      this.deliveryRouter = new ChannelDeliveryRouter({
        configManager: config.configManager,
        secretsManager: config.secretsManager,
        serviceRegistry: config.serviceRegistry,
        artifactStore: config.artifactStore,
      });
    }
    if (config.runtimeStore) this.runtimeDispatch = createDomainDispatch(config.runtimeStore);
    this.runtimeBus = config.runtimeBus ?? null;
  }

  attachRuntime(config: {
    readonly runtimeStore?: RuntimeStore | null | undefined;
    readonly runtimeBus?: RuntimeEventBus | null | undefined;
  }): void {
    if (config.runtimeStore) {
      this.runtimeDispatch = createDomainDispatch(config.runtimeStore);
    }
    if (config.runtimeBus) {
      this.runtimeBus = config.runtimeBus;
    }
  }

  getDeliveryRouter(): ChannelDeliveryRouter {
    return this.deliveryRouter;
  }

  private isEnabled(): boolean {
    return isFeatureGateEnabled(this.featureFlags, 'delivery-engine');
  }

  private isTargetEnabled(target: AutomationDeliveryTarget): boolean {
    return isSurfaceFeatureGateEnabled(this.featureFlags, target.surfaceKind ?? 'webhook');
  }

  setControlPlaneGateway(gateway: import('../control-plane/gateway.js').ControlPlaneGateway | null): void {
    this.deliveryRouter.setControlPlaneGateway(gateway);
  }

  async deliverJobRun(job: AutomationJob, run: AutomationRun): Promise<readonly AutomationDeliveryAttempt[]> {
    if (!this.isEnabled()) return [];
    if (job.delivery.mode === 'none') return [];

    await this.routeBindings.start();
    const body = buildDeliveryMessage(job, run);
    const reply = job.delivery.targets.length === 0 && Boolean(job.delivery.replyToRouteId);
    const primaryTargets = this.resolveTargets(job.delivery.targets.length > 0
      ? [...job.delivery.targets]
      : job.delivery.replyToRouteId
        ? [{ kind: 'surface', routeId: job.delivery.replyToRouteId } satisfies AutomationDeliveryTarget]
        : []);
    const attempts = await this.deliverText(job, run, body, primaryTargets.map((entry) => entry.target), { reply });
    const needsFallback = attempts.length === 0 || attempts.every((attempt) => attempt.status === 'failed' || attempt.status === 'dead_lettered');
    if (!needsFallback || job.delivery.fallbackTargets.length === 0) {
      return attempts;
    }
    const fallbackAttempts = await this.deliverText(job, run, body, job.delivery.fallbackTargets);
    return [...attempts, ...fallbackAttempts];
  }

  async deliverText(
    job: AutomationJob,
    run: AutomationRun,
    body: string,
    targets: readonly AutomationDeliveryTarget[],
    options: { readonly reply?: boolean } = {},
  ): Promise<readonly AutomationDeliveryAttempt[]> {
    const reply = options.reply === true;
    if (!this.isEnabled()) return [];
    await this.routeBindings.start();
    const resolvedTargets = this.resolveTargets(targets).filter((entry) => this.isTargetEnabled(entry.target));
    if (resolvedTargets.length === 0) return [];

    const attempts: AutomationDeliveryAttempt[] = [];
    for (const resolved of resolvedTargets) {
      const target = resolved.target;
      const deliveryId = `delivery-${randomUUID().slice(0, 8)}`;
      const startedAt = Date.now();
      let attempt: AutomationDeliveryAttempt = {
        id: deliveryId,
        runId: run.id,
        jobId: job.id,
        target,
        status: 'pending',
      };
      attempts.push(attempt);
      this.syncAttempt(attempt, run, 'queued', reply);

      const retryPolicy = job.failure.retryPolicy;
      let attemptIndex = 0;
      let lastError = '';
      while (attemptIndex < Math.max(1, retryPolicy.maxAttempts)) {
        attemptIndex += 1;
        attempt = {
          ...attempt,
          status: 'sending',
          startedAt: Date.now(),
          error: undefined,
        };
        // The stored attempt carries what is really happening, so it is never
        // left `pending` while a send is in flight or after one settles.
        attempts[attempts.length - 1] = attempt;
        // Reporting the start is observability: if it throws the send still
        // goes ahead, and the sent/failed report that follows settles the state.
        try { this.syncAttempt(attempt, run, 'started', reply); }
        catch (error) { logger.warn('Delivery started but its start could not be reported', { deliveryId, error: summarizeError(error) }); }
        try {
          const responseId = await this.sendTarget(resolved, body, job, run);
          if (resolved.binding?.id && responseId) {
            try {
              await this.routeBindings.captureReplyTarget(resolved.binding.id, responseId, resolved.binding.threadId);
            } catch (error) {
              logger.warn('Delivery succeeded but reply routing could not be saved', { deliveryId, error: summarizeError(error) });
            }
          }
          attempt = {
            ...attempt,
            status: 'sent',
            endedAt: Date.now(),
            responseId: responseId ?? target.address ?? target.routeId ?? target.label ?? target.surfaceKind ?? 'delivered',
          };
          attempts[attempts.length - 1] = attempt;
          try { this.syncAttempt(attempt, run, 'succeeded', reply); }
          catch (error) { logger.warn('Delivery succeeded but its receipt could not be saved', { deliveryId, error: summarizeError(error) }); }
          lastError = '';
          break;
        } catch (error) {
          lastError = summarizeError(error);
          const transience = await readFailureTransience(error, 'automation.delivery.attempt');
          const retryable = transience.failureClass === 'retryable';
          logger.debug('AutomationDeliveryManager: delivery attempt failed', {
            jobId: job.id,
            runId: run.id,
            attempt: attemptIndex,
            failureClass: transience.failureClass,
            basis: transience.basis,
            reason: transience.detail,
          });
          const lastTry = attemptIndex >= Math.max(1, retryPolicy.maxAttempts);
          if (!retryable || lastTry) {
            attempt = {
              ...attempt,
              status: retryable ? 'dead_lettered' : 'failed',
              endedAt: Date.now(),
              error: lastError,
            };
            attempts[attempts.length - 1] = attempt;
            // Reporting is observability: a throwing report must not stop the
            // remaining targets from being tried.
            try { this.syncAttempt(attempt, run, 'failed', reply, lastError, retryable, attemptIndex); }
            catch (reportError) { logger.warn('Delivery failed and its failure could not be reported', { deliveryId, error: summarizeError(reportError) }); }
            break;
          }
          const delayMs = calculateRetryDelay(
            retryPolicy.delayMs,
            attemptIndex,
            retryPolicy.strategy,
            retryPolicy.maxDelayMs,
            retryPolicy.jitterMs,
          );
          await sleep(delayMs);
        }
      }
    }

    return attempts;
  }

  private resolveTargets(targets: readonly AutomationDeliveryTarget[]): ResolvedDeliveryTarget[] {
    return targets.map((target) => {
      if (!target.routeId) return target;
      const binding = this.routeBindings.getBinding(target.routeId);
      if (!binding) return { target };
      return {
        target: {
          ...target,
          surfaceKind: target.surfaceKind ?? binding.surfaceKind,
          address: target.address
            ?? (typeof binding.metadata.responseUrl === 'string' ? binding.metadata.responseUrl
              : typeof binding.metadata.callbackUrl === 'string' ? binding.metadata.callbackUrl
                : binding.channelId ?? binding.externalId),
          label: target.label ?? binding.title,
        },
        binding,
      };
    }).map((entry) => ('target' in entry ? entry : { target: entry }));
  }

  private async sendTarget(
    resolved: ResolvedDeliveryTarget,
    body: string,
    job: AutomationJob,
    run: AutomationRun,
  ): Promise<string | undefined> {
    return this.deliveryRouter.deliver({
      target: resolved.target,
      body,
      title: job.name,
      jobId: job.id,
      runId: run.id,
      status: run.status,
      includeLinks: job.delivery.includeLinks,
      ...(run.result !== undefined ? { attachments: this.attachableArtifacts(run) } : {}),
      ...(run.agentId ? { agentId: run.agentId } : {}),
      ...(resolved.binding ? { binding: resolved.binding } : {}),
    });
  }

  /**
   * The artifacts named in a run's result that this run could have produced.
   * The result is agent or remote-peer output, so an id in it proves nothing:
   * only an artifact that exists and was created after the run started is
   * attached, which keeps a result from pulling an unrelated stored artifact
   * out to the job's targets. Without a store to check against, nothing is
   * attached.
   */
  private attachableArtifacts(run: AutomationRun): ArtifactReference[] {
    const references = extractArtifactReferences(run.result);
    if (references.length === 0) return references;
    if (!this.artifactStore) {
      logger.warn('Delivery attachments skipped: no artifact store to confirm the run created them', { runId: run.id, count: references.length });
      return [];
    }
    const startedAt = run.startedAt ?? run.queuedAt;
    return references.filter((reference) => {
      const descriptor = this.artifactStore?.get(reference.artifactId);
      const owned = descriptor !== null && descriptor !== undefined && descriptor.createdAt >= startedAt;
      if (!owned) logger.warn('Delivery attachment skipped: the artifact was not created by this run', { runId: run.id, artifactId: reference.artifactId });
      return owned;
    });
  }

  private syncAttempt(
    attempt: AutomationDeliveryAttempt,
    run: AutomationRun,
    phase: 'queued' | 'started' | 'succeeded' | 'failed',
    reply: boolean,
    error?: string,
    retryable = false,
    attempts = 1,
  ): void {
    this.runtimeDispatch?.syncDeliveryAttempt(attempt, `deliveries.${phase}`);
    if (!this.runtimeBus) return;
    const surfaceKind = toDeliverySurfaceKind(attempt.target);
    const targetId = toDeliveryTargetId(attempt.target);
    const ctx = {
      sessionId: run.target.sessionId ?? 'automation',
      source: 'automation-delivery-manager',
      traceId: attempt.id,
    } as const;
    if (phase === 'queued') {
      emitDeliveryQueued(this.runtimeBus, ctx, {
        deliveryId: attempt.id,
        jobId: attempt.jobId,
        runId: attempt.runId,
        surfaceKind,
        targetId,
        deliveryKind: toDeliveryKind(surfaceKind, reply),
      });
      return;
    }
    if (phase === 'started') {
      emitDeliveryStarted(this.runtimeBus, ctx, {
        deliveryId: attempt.id,
        jobId: attempt.jobId,
        runId: attempt.runId,
        surfaceKind,
        targetId,
        startedAt: attempt.startedAt ?? Date.now(),
      });
      return;
    }
    if (phase === 'succeeded') {
      emitDeliverySucceeded(this.runtimeBus, ctx, {
        deliveryId: attempt.id,
        jobId: attempt.jobId,
        runId: attempt.runId,
        surfaceKind,
        targetId,
        completedAt: attempt.endedAt ?? Date.now(),
        durationMs: Math.max(0, (attempt.endedAt ?? Date.now()) - (attempt.startedAt ?? Date.now())),
      });
      return;
    }
    const failureText = error ?? attempt.error ?? 'delivery failed';
    // A dead-lettered attempt used every try it had: no further attempt is
    // coming, so the failure is final and the exhaustion is its own event.
    const exhausted = attempt.status === 'dead_lettered';
    emitDeliveryFailed(this.runtimeBus, ctx, {
      deliveryId: attempt.id,
      jobId: attempt.jobId,
      runId: attempt.runId,
      surfaceKind,
      targetId,
      failedAt: attempt.endedAt ?? Date.now(),
      error: failureText,
      retryable: exhausted ? false : retryable,
    });
    if (exhausted) {
      emitDeliveryDeadLettered(this.runtimeBus, ctx, {
        deliveryId: attempt.id,
        jobId: attempt.jobId,
        runId: attempt.runId,
        surfaceKind,
        targetId,
        reason: failureText,
        attempts,
      });
    }
  }
}
