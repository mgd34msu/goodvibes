import { syncTerminalNotifierQueues } from '@goodvibes-jev/engine/terminal-shell/bootstrap-primitives';
import type { ConfigManager, SecretsManager } from '@goodvibes-jev/engine/platform/platform/config';
import { Notifier, type RuntimeNotificationOptions } from '@goodvibes-jev/engine/platform/platform/integrations';
import { readNotificationsMetadataOnly } from '@goodvibes-jev/engine/platform/platform/runtime/notification-privacy';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import type { createDomainDispatch } from '@goodvibes-jev/engine/platform/platform/runtime/state';

type DomainDispatch = ReturnType<typeof createDomainDispatch>;

/**
 * Reflect the notifier's outbound delivery queues into the integrations domain
 * (so the UI shows per-channel health) and attach the notifier to the runtime
 * bus. The platform's dispatcher owns the events and their wording, the same
 * one the daemon and the Agent attach; `options` names a workstream from its
 * own record, so one started before this app attached is still announced.
 */
export function syncNotifierQueueIntegrations(
  notifier: Notifier,
  runtimeBus: RuntimeEventBus,
  domainDispatch: DomainDispatch,
  options: RuntimeNotificationOptions = {},
): () => void {
  return syncTerminalNotifierQueues(notifier, domainDispatch, () => {
    notifier.attachToRuntimeBus(runtimeBus, options);
    return () => notifier.detach();
  });
}

/**
 * The Slack and Discord notifier, built from the configured services. Its
 * agent and workstream notices name the task unless
 * behavior.notificationsMetadataOnly is on; the setting is read at send time,
 * so a change applies without a restart.
 */
export function createRuntimeNotifier(
  serviceRegistry: Parameters<typeof Notifier.fromConfig>[0],
  configGet: (key: string) => unknown,
  configManager?: Pick<ConfigManager, 'get'>,
  secretsManager?: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
): Promise<Notifier> {
  return Notifier.fromConfig(serviceRegistry, {
    metadataOnly: () => readNotificationsMetadataOnly(configGet),
    // Supplies the stored bot tokens and the integrations.delivery.* settings.
    configManager: configManager ?? null,
    secretsManager: secretsManager ?? null,
  });
}
