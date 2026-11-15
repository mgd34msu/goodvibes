/**
 * Health Error Propagation, HealthStoreWiring
 *
 * Wires together the RuntimeHealthAggregator, CascadeEngine, and RuntimeEventBus
 * to form a complete error-propagation pipeline. When a domain health status
 * changes, the wiring evaluates cascade rules and applies their effects.
 *
 * Lifecycle:
 * 1. Call `start()` to subscribe to aggregator health changes.
 * 2. Call `evaluateDomain()` to push a domain health update and trigger cascades.
 * 3. Call `stop()` to unsubscribe and release all listeners.
 *
 * @module health/wiring
 */

import type { EvaluateResult, HealthDomain, HealthStatus } from './types.js';
import type { RuntimeHealthAggregator } from './aggregator.js';
import type { CascadeEngine } from './cascade-engine.js';
import type { RuntimeEventBus } from '../events/index.js';
import { handleCascadeEffect } from './effect-handlers.js';
import { logger } from '../../utils/logger.js';

/**
 * Wires the health aggregator, cascade engine, and event bus together.
 *
 * Orchestrates the full error-propagation pipeline:
 * domain health change → cascade evaluation → effect application → event emission.
 */
/** The reasons the cascade effect handlers write on a target domain. */
const CASCADE_REASON_PREFIXES = [
  'In-flight cancellation requested',
  'Marked ',
  'Tool deregistration requested',
  'Dispatch blocked (scope',
  'New operations blocked',
] as const;

export class HealthStoreWiring {
  private unsubscribe: (() => void) | null = null;

  /**
   * @param aggregator - Tracks per-domain health; source of health change events.
   * @param cascadeEngine - Evaluates declarative cascade rules against domain health.
   * @param eventBus - Receives CASCADE_APPLIED and synthetic domain events.
   */
  constructor(
    private readonly aggregator: RuntimeHealthAggregator,
    private readonly cascadeEngine: CascadeEngine,
    private readonly eventBus: RuntimeEventBus,
  ) {}

  /**
   * Start listening to aggregator health changes.
   *
   * When any domain health changes (detected via aggregator subscribers),
   * the cascade engine is not automatically re-evaluated for subscriber-driven
   * changes, callers should use `evaluateDomain()` for explicit cascade evaluation.
   *
   * Calling `start()` on an already-started wiring replaces the existing
   * subscription without leaking the previous one.
   */
  start(): void {
    // Release any existing subscription before re-subscribing
    this.unsubscribe?.();
    // Subscribe to aggregator for observability (e.g. external monitoring).
    // The primary cascade pipeline is driven by evaluateDomain() calls.
    this.unsubscribe = this.aggregator.subscribe((health) => {
      // Log health state transitions for observability.
      // The primary cascade pipeline is driven by evaluateDomain() calls;
      // this subscription provides a secondary audit trail for monitoring.
      const failed = health.failedDomains;
      const degraded = health.degradedDomains;
      if (failed.length > 0 || degraded.length > 0) {
        logger.info('Runtime health changed', {
          overall: health.overall,
          failedDomains: failed,
          degradedDomains: degraded,
        });
      }
    });
  }

  /**
   * Stop listening to aggregator health changes and release all resources.
   *
   * Safe to call multiple times, subsequent calls are no-ops.
   */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Update a domain's health status and evaluate cascade rules.
   *
   * Pipeline:
   * 1. Update the domain health in the aggregator.
   * 2. Evaluate cascade rules for the new domain + status.
   * 3. Apply all actionable cascade effects via effect handlers.
   *    Pending-recovery effects are NOT applied, they await recovery exhaustion.
   *    Each evaluation that leaves a rule pending counts as one recovery
   *    attempt, so a domain that keeps failing reaches exhaustion and its
   *    cascade is applied instead of waiting forever.
   *
   * @param domain - The domain whose health has changed.
   * @param status - The new health status for the domain.
   * @param sourceContext - Optional context identifying the triggering entity
   *   (e.g. `{ pluginId: 'my-plugin' }`). Propagated into CascadeResult.
   * @returns the cascades applied and those still pending recovery.
   */
  evaluateDomain(
    domain: HealthDomain,
    status: HealthStatus,
    sourceContext?: Record<string, string>,
  ): EvaluateResult {
    // 1. Update domain health in the aggregator
    this.aggregator.updateDomainHealth(domain, status);

    // A source that recovered lifts the dispatch blocks its failure placed on other domains.
    if (status === 'healthy') this.releaseBlockedTargets(domain);

    // 2. Evaluate cascade rules for this domain transition
    const evaluation = this.cascadeEngine.evaluate(domain, status, sourceContext);
    const { cascades, pendingRecovery } = evaluation;

    // 3. Apply each actionable cascade effect
    for (const cascade of cascades) {
      handleCascadeEffect(cascade.effect, cascade, {
        aggregator: this.aggregator,
        eventBus: this.eventBus,
      });
    }
    if (pendingRecovery.length > 0) this.aggregator.recordRecoveryAttempt(domain);
    return evaluation;
  }

  /**
   * Return a target domain to healthy when the effect a recovered source
   * placed on it (a dispatch block, a cancellation or deregistration request,
   * children marked failed) was its only reason to be unhealthy and no other
   * source still holds it. A domain that is unhealthy for its own reasons is
   * left alone: only the reasons the effect handlers write are recognised.
   */
  private releaseBlockedTargets(source: HealthDomain): void {
    for (const rule of this.cascadeEngine.getRulesForDomain(source, 'failed')) {
      if (rule.target === 'ALL') continue;
      const target = this.aggregator.getDomainHealth(rule.target);
      if (target.status === 'healthy' || target.status === 'unknown') continue;
      // Another effect may have overwritten the reason since this rule's own
      // effect ran, so any reason an effect handler writes counts, not only this rule's.
      const reason = target.failureReason ?? '';
      const placedByEffect = CASCADE_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix));
      if (!placedByEffect) continue;
      if (this.cascadeEngine.getActiveRulesTargeting(rule.target).length > 0) continue;
      this.aggregator.updateDomainHealth(rule.target, 'healthy', { degradedCapabilities: [] });
    }
  }
}
