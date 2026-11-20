/**
 * bootstrap-notifier.ts, the Slack and Discord notifier the agent attaches to
 * its runtime bus. Extracted from bootstrap-core so the privacy wiring has a
 * test of its own.
 */
import type { ConfigManager, SecretsManager } from '@goodvibes/engine/platform/platform/config';
import { Notifier } from '@goodvibes/engine/platform/platform/integrations';
import { readNotificationsMetadataOnly } from '@goodvibes/engine/platform/platform/runtime/notification-privacy';

/**
 * The Slack and Discord notifier, built from the configured services. Its
 * runtime-bus notices use the public legacy-envelope adapter. The current platform
 * permits captured event details only when the live setting is literal false;
 * absent, malformed, or revoked preferences keep subsequent deliveries
 * metadata-only. The platform owns admission and delivery-time privacy checks.
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
