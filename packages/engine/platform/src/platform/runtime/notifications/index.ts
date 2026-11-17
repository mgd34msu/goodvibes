/**
 * Notification routing module, barrel export and factory.
 *
 * Every routed notification is kept in the notification history; the router
 * decides only how loudly each one is shown and which collapse group it joins.
 *
 * @example
 * ```ts
 * import { createNotificationRouter } from './notifications/index.js';
 *
 * const router = createNotificationRouter(configManager);
 * router.setDomainVerbosity('tools', 'minimal');
 * const decision = router.route(myNotification);
 * ```
 */

export type {
  NotificationLevel,
  NotificationPresence,
  DomainVerbosity,
  NotificationAction,
  Notification,
  RoutingDecision,
  RoutedNotification,
  DomainConfig,
  RoutingReasonCode,
  NotificationTag,
} from './types.js';

export { NotificationRouter, type NotificationRouterOptions } from './router.js';

export {
  applyDefaultPolicy,
  applyQuietTypingPolicy,
  BatchPolicy,
  type CollapsePlacement,
} from './policies/index.js';

import { NotificationRouter, type NotificationRouterOptions } from './router.js';
import type { ConfigManager } from '../../config/manager.js';

/**
 * Create a NotificationRouter. With a config source, whether repeats are held
 * in the history follows notifications.adaptiveSuppression and the number of a
 * collapse group's members shown per window comes from
 * notifications.burstThreshold (both read here, once); explicit options win. The collapse window follows the print
 * level, which sets it when the mode manager attaches the router.
 */
export function createNotificationRouter(
  configManager?: Pick<ConfigManager, 'get'>,
  options: NotificationRouterOptions = {},
): NotificationRouter {
  return new NotificationRouter({
    windowMs: options.windowMs,
    shownPerWindow: options.shownPerWindow ?? configManager?.get('notifications.burstThreshold'),
    adaptiveSuppression: options.adaptiveSuppression ?? configManager?.get('notifications.adaptiveSuppression'),
  });
}
