/**
 * NotificationRouter, decides how loudly each notification is shown. Every
 * routed notification is kept in the notification history; the decision says
 * whether it also toasts now, and which collapse group it belongs to.
 *
 * Policy stack (applied in order):
 * 1. Default policy       , level + domain verbosity (set by the print level)
 *                           → toast or history
 * 2. Collapse policy      , one group per domain, level and title per window;
 *                           while notifications.adaptiveSuppression is on,
 *                           members past the number shown go to the history
 * 3. Quiet-typing policy  , holds non-critical toasts while the user types
 */

import type {
  DomainConfig,
  DomainVerbosity,
  Notification,
  RoutingDecision,
} from './types.js';
import { applyDefaultPolicy } from './policies/default-policy.js';
import { applyQuietTypingPolicy } from './policies/quiet-typing.js';
import { BatchPolicy } from './policies/batch-policy.js';

/** Default verbosity applied to domains with no explicit configuration. */
const DEFAULT_VERBOSITY: DomainVerbosity = 'normal';

export interface NotificationRouterOptions {
  /** Collapse window in ms (the print level sets it through setBatchWindowMs). */
  readonly windowMs?: number | undefined;
  /** Members of one collapse group shown on screen per window (notifications.burstThreshold). */
  readonly shownPerWindow?: number | undefined;
  /** notifications.adaptiveSuppression: whether collapsed repeats are held in the history. */
  readonly adaptiveSuppression?: boolean | undefined;
}

export class NotificationRouter {
  private readonly domains = new Map<string, DomainConfig>();
  private quietWhileTyping = false;
  private defaultDomainVerbosity: DomainVerbosity = DEFAULT_VERBOSITY;
  private readonly collapse: BatchPolicy;
  private adaptiveSuppression: boolean;

  constructor(options: NotificationRouterOptions = {}) {
    this.collapse = new BatchPolicy(options.windowMs, options.shownPerWindow);
    this.adaptiveSuppression = options.adaptiveSuppression ?? false;
  }

  /** Decide how loudly a notification is shown and which collapse group it joins. */
  route(notification: Notification): RoutingDecision {
    const verbosity = this.getDomainVerbosity(notification.domain);
    const presence = applyDefaultPolicy(notification.level, verbosity);
    // Critical, milestone and alert notifications never collapse: each one is its own entry.
    const placement = notification.level === 'critical' || notification.tag === 'milestone' || notification.tag === 'alert'
      ? undefined
      : this.collapse.evaluate(notification);
    const group = placement ? { batchKey: placement.batchKey } : {};

    if (placement?.collapsed && this.adaptiveSuppression) {
      return { presence: 'history', ...group, reasonCode: 'batch_window_collapsed' };
    }

    const quietReason = applyQuietTypingPolicy(notification.level, presence, this.quietWhileTyping);
    if (quietReason !== undefined) {
      return { presence: 'history', ...group, suppressed: quietReason, reasonCode: 'quiet_while_typing' };
    }

    // Held by the domain's verbosity: the same level would toast at the most verbose setting.
    const heldByVerbosity = presence === 'history' && applyDefaultPolicy(notification.level, 'verbose') === 'toast';
    return { presence, ...group, reasonCode: heldByVerbosity ? 'domain_verbosity_low' : 'allowed' };
  }

  setDomainVerbosity(domain: string, verbosity: DomainVerbosity): void {
    this.domains.set(domain, { verbosity });
  }

  /** While enabled, non-critical notifications that would toast are kept in the history only. */
  setQuietWhileTyping(enabled: boolean): void {
    this.quietWhileTyping = enabled;
  }

  /** Set the collapse window; the print level calls this. Groups already open keep their window. */
  setBatchWindowMs(ms: number): void {
    this.collapse.setWindowMs(ms);
  }

  /** The verbosity of domains with no override of their own. */
  setDefaultDomainVerbosity(verbosity: DomainVerbosity): void {
    this.defaultDomainVerbosity = verbosity;
  }

  /** notifications.adaptiveSuppression: whether collapsed repeats are held in the history. */
  setAdaptiveSuppression(enabled: boolean): void {
    this.adaptiveSuppression = enabled;
  }

  isAdaptiveSuppressionEnabled(): boolean {
    return this.adaptiveSuppression;
  }

  private getDomainVerbosity(domain: string): DomainVerbosity {
    return this.domains.get(domain)?.verbosity ?? this.defaultDomainVerbosity;
  }
}
