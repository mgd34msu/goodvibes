/**
 * bootstrap-core-helpers.ts, the pure parts of the interactive bootstrap.
 *
 * Split out of bootstrap-core.ts, which had reached the 800-line cap
 * check-architecture.ts enforces. At the cap the next change to that file is
 * blocked regardless of what it is, so the seam is drawn here: nothing below
 * touches BootstrapCoreState or the composition order, and each function is
 * callable on its own.
 *
 * bootstrap-core.ts re-exports all four names, so every existing importer is
 * unaffected.
 */
import { WebhookNotifier, type RuntimeNotificationOptions } from '@goodvibes/engine/platform/platform/integrations';

import { RuntimeEventBus } from '@/runtime/index.ts';




/**
 * Registers the webhook notifier for the runtime session.
 *
 * Configures the provided WebhookNotifier with the given URL list, attaches it
 * to the runtime bus so it receives SESSION_NOTIFICATION events, and pushes a
 * detach() cleanup into runtimeUnsubs for shutdown. The attach happens even
 * with no URL configured: a URL added mid-session is read by the same shared
 * instance, and a notifier with no URLs sends nothing, so skipping the attach
 * would leave failure notifications dead until restart. `options` names a
 * workstream from its own record (see RuntimeNotificationOptions).
 */
export function registerWebhookNotifier(
  webhookNotifier: WebhookNotifier,
  webhookUrls: string[],
  runtimeBus: RuntimeEventBus,
  runtimeUnsubs: Array<() => void>,
  options: RuntimeNotificationOptions = {},
): void {
  if (webhookUrls.length > 0) webhookNotifier.setUrls(webhookUrls);
  webhookNotifier.attachToRuntimeBus(runtimeBus, options);
  runtimeUnsubs.push(() => webhookNotifier.detach());
}
