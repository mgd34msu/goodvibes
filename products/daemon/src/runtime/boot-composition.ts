/** Explicit production boot operations. The executable opts in separately. */
import type { ServiceRegistry } from '@goodvibes-jev/engine/platform/platform/config';
import { Notifier } from '@goodvibes-jev/engine/platform/platform/integrations';
import { controlPlaneStorePath, registerNotificationDeadLetterGatewayMethods } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { synchronizeConfiguredServices } from '@goodvibes-jev/engine/platform/platform/runtime/bootstrap';
import { NOTIFICATIONS_METADATA_ONLY_KEY, readNotificationsMetadataOnly } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { describeFatalFailure } from '@goodvibes-jev/engine/platform/platform/daemon/fatal-boot-report';
import { checkDaemonGoogleAtBoot } from '@goodvibes-jev/engine/platform/platform/google';
import { nodeGoogleFilePort } from '@goodvibes-jev/engine/platform/platform/google/node';
import type { DaemonBootOperations } from './boot-tasks.js';
import { createDaemonPluginLoaderDeps } from './plugin-composition.js';
import type { RuntimeServices } from './runtime-services-types.js';


/**
 * platform factories use fail-fast joins. Keep every admitted credential/inspection
 * read owned after a sibling rejects, without mutating the shared registry.
 * The borrowed view delegates to the real methods and persisted configuration.
 */
async function withServiceReadDrain<T>(source: ServiceRegistry, action: (registry: ServiceRegistry) => Promise<T>): Promise<T> {
  const pending = new Set<Promise<void>>();
  const track = <R>(read: () => Promise<R>): Promise<R> => {
    const result = Promise.resolve().then(read);
    const settled = result.then(() => {}, () => {});
    pending.add(settled);
    void settled.then(() => { pending.delete(settled); });
    return result;
  };
  const methods = new Map<PropertyKey, { original: object; bound: (...args: unknown[]) => unknown }>();
  const registry: ServiceRegistry = new Proxy(source, {
    get(target, key): unknown {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      const known = methods.get(key);
      if (known?.original === value) return known.bound;
      // Registry methods retain their real receiver and private source owner.
      // inspect itself drains its credential siblings; the boot adapter owns
      // the returned operation without replacing its internal method bindings.
      const bound = (...args: unknown[]) => key === 'resolveSecret' || key === 'inspect'
        ? track(() => Reflect.apply(value, target, args) as Promise<unknown>)
        : Reflect.apply(value, target, args);
      methods.set(key, { original: value, bound });
      return bound;
    },
  });
  try { return await action(registry); }
  finally { while (pending.size > 0) await Promise.all([...pending]); }
}

/** Pass through RuntimeServicesOptions.createBootOperations; start after server init. */
export function createDaemonBootOperations(runtime: RuntimeServices): DaemonBootOperations {
  const notificationRows = new Set<string>();
  const metadataOnly = (): boolean => readNotificationsMetadataOnly(
    () => runtime.configManager.get(NOTIFICATIONS_METADATA_ONLY_KEY as never),
  );
  // The Slack/Discord notifier exists from the notifier step on; the webhook one always.
  let chatNotifier: Notifier | undefined;
  const deadLetterPath = (file: string): string => controlPlaneStorePath(runtime.shellPaths, runtime.surfaceRoot, file);
  const keepDeadLetters = (notifier: { persistDeadLetters(path: string): void }, file: string): void => {
    try { notifier.persistDeadLetters(deadLetterPath(file)); }
    catch (error) {
      logger.warn('Failed notifications will not survive a restart: their file could not be opened', {
        file, error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  // Owned by the configured-services step: aborted when the boot scope closes.
  const serviceChecks = new AbortController();
  // A workstream's start and ask come from its own record, so one started
  // before a restart is still announced with its real duration.
  const runtimeNotifications = {
    lookupContract: (contractId: string) => {
      const contract = runtime.contractRunner.get(contractId);
      return contract ? { startedAt: contract.createdAt, name: contract.ask } : undefined;
    },
  };
  return {
    startProviderWatch: () => runtime.providerRegistry.startWatching(runtime.runtimeBus),
    stopProviderWatch: () => runtime.providerRegistry.closeWatching(),
    createWebhooks() {
      // Boot uses the same graph owner as memory-pressure delivery, even with no URLs.
      // Acquire before configuration/attachment so failures still retire it.
      let stopRow: (() => void) | undefined;
      return {
        attach() {
          keepDeadLetters(runtime.webhookNotifier, 'notification-dead-letters-webhooks.json');
          registerNotificationDeadLetterGatewayMethods(runtime.gatewayMethods,
            () => chatNotifier ? [runtime.webhookNotifier, chatNotifier] : [runtime.webhookNotifier]);
          const urls = runtime.configManager.getCategory('notifications').webhookUrls;
          const syncRow = (): void => {
            const failed = runtime.webhookNotifier.listDeadLetters();
            const last = failed.at(-1);
            runtime.runtimeDispatch.syncIntegration({
              id: 'webhooks', displayName: 'Webhooks', category: 'communication',
              status: failed.length > 0 ? 'degraded' : 'healthy', enabled: true, successCount: 0, errorCount: failed.length,
              ...(last ? { lastErrorAt: last.deadAt, lastError: last.finalError } : {}),
              meta: { urlCount: runtime.webhookNotifier.getUrls().length, deadLetters: failed.length },
            }, 'boot.webhooks');
          };
          if (urls.length > 0) {
            runtime.webhookNotifier.setUrls(urls);
            notificationRows.add('webhooks');
            syncRow();
          }
          // URLs added later (/notify add) fail into the same list; the row follows it.
          stopRow = runtime.webhookNotifier.onDeadLetter(() => { notificationRows.add('webhooks'); syncRow(); });
          runtime.webhookNotifier.attachToRuntimeBus(runtime.runtimeBus, runtimeNotifications);
        },
        close: () => { stopRow?.(); return runtime.webhookNotifier.close(); },
      };
    },
    async createNotifier() {
      const notifier = await withServiceReadDrain(runtime.serviceRegistry, (registry) =>
        Notifier.fromConfig(registry, { featureFlags: runtime.featureFlags, metadataOnly, configManager: runtime.configManager, secretsManager: runtime.secretsManager }));
      const unsubscribers: (() => void)[] = [];
      let shown = new Set<string>();
      let attached = false;
      // One row per channel, rebuilt when the channels or their gaps change
      // (a webhook URL or default channel saved later) and when a notification
      // fails: a gap row says what to add, a queue row follows deliveries.
      const syncRows = (): void => {
        const queues = notifier.getQueueStatus();
        const gaps = notifier.channelGaps();
        const now = new Set<string>([...gaps.map((gap) => gap.channel), ...queues.map((queue) => queue.channel)]);
        for (const gone of shown) {
          if (now.has(gone)) continue;
          notificationRows.delete(gone);
          runtime.runtimeDispatch.syncIntegration({
            id: gone, displayName: gone[0]!.toUpperCase() + gone.slice(1),
            category: 'communication', status: 'unconfigured', enabled: false, successCount: 0, errorCount: 0, meta: {},
          }, 'boot.notifier');
        }
        shown = now;
        // A bot token alone connects chat, not notifications: the row says what to add.
        for (const gap of gaps) {
          notificationRows.add(gap.channel);
          runtime.runtimeDispatch.syncIntegration({
            id: gap.channel, displayName: gap.channel[0]!.toUpperCase() + gap.channel.slice(1),
            category: 'communication', status: 'degraded', enabled: true, successCount: 0, errorCount: 0,
            lastError: `${gap.reason}. ${gap.next}.`,
            meta: { notifications: 'no-target', next: gap.next },
          }, 'boot.notifier');
        }
        for (const queue of queues) {
          notificationRows.add(queue.channel);
          runtime.runtimeDispatch.syncIntegration({
            id: queue.channel, displayName: queue.channel[0]!.toUpperCase() + queue.channel.slice(1),
            category: 'communication', status: queue.metrics.deadLettered > 0 ? 'degraded' : 'healthy',
            enabled: true, successCount: queue.metrics.delivered, errorCount: queue.metrics.deadLettered,
            ...(queue.dlqEntries[0]?.deadAt ? { lastErrorAt: queue.dlqEntries[0].deadAt } : {}),
            ...(queue.dlqEntries[0]?.finalError ? { lastError: queue.dlqEntries[0].finalError } : {}),
            meta: { attempts: queue.metrics.totalAttempts, retrying: queue.metrics.retrying,
              deadLetters: queue.metrics.deadLettered, dlqSize: queue.metrics.dlqSize, sloEnforced: queue.sloEnforced },
          }, 'boot.notifier');
        }
        // Announcing runtime events only while a channel exists keeps a
        // channel-less notifier off every agent and workstream event.
        if (notifier.channels.length > 0 && !attached) {
          notifier.attachToRuntimeBus(runtime.runtimeBus, runtimeNotifications);
          attached = true;
        } else if (notifier.channels.length === 0 && attached) {
          notifier.detach();
          attached = false;
        }
      };
      return {
        attach() {
          chatNotifier = notifier;
          keepDeadLetters(notifier, 'notification-dead-letters-chat.json');
          syncRows();
          unsubscribers.push(notifier.onChannelsChanged(syncRows), notifier.onDeadLetter(syncRows));
        },
        close: () => { for (const unsubscribe of unsubscribers.splice(0)) unsubscribe(); return notifier.close(); },
      };
    },
    // Ends the background Google check when the daemon stops before Google answers.
    stopServiceChecks: () => { serviceChecks.abort(); },
    synchronizeServices: () => {
      // The Google grant is checked once, in the background, so a revoked one
      // is announced at start (a degraded row with the reason and the step)
      // instead of by the first call that fails; boot does not wait on Google.
      const { signal } = serviceChecks;
      void checkDaemonGoogleAtBoot({
        configManager: runtime.configManager,
        secretsManager: runtime.secretsManager,
        homeDirectory: runtime.homeDirectory,
        files: nodeGoogleFilePort,
        signal,
      }).then((check) => {
        // Stopped mid-check: the runtime it would report to is being disposed.
        if (signal.aborted) return;
        if (!check.usable && !check.needsReauthorization) return;
        if (check.needsReauthorization) logger.warn('The Google account needs to be connected again', { detail: check.detail });
        runtime.runtimeDispatch.syncIntegration({
          id: 'google', displayName: 'Google', category: 'communication',
          status: check.usable ? 'healthy' : 'degraded', enabled: true, successCount: 0, errorCount: check.usable ? 0 : 1,
          ...(check.usable ? {} : { lastErrorAt: Date.now(), lastError: `${check.detail} Connect the Google account again (the Agent's /google connect, or the web UI's Google setup).` }),
          meta: { needsReauthorization: check.needsReauthorization, scopes: [...check.scopes] },
        }, 'boot.google');
      }, () => undefined);
      return withServiceReadDrain(runtime.serviceRegistry, (registry) =>
        synchronizeConfiguredServices((record, source) => {
        // A webhook-only configured Slack/Discord service has no primary token.
        // Preserve the real notification owner's health and queue facts while
        // adding service inspection facts, rather than relabeling it unconfigured.
        const notification = notificationRows.has(record.id)
          ? runtime.runtimeStore.getState().integrations.integrations.get(record.id) : undefined;
        runtime.runtimeDispatch.syncIntegration(notification
          ? { ...record, ...notification, meta: { ...record.meta, ...notification.meta } }
          : record, source);
        }, registry));
    },
    initializePlugins: () => runtime.pluginManager.init(createDaemonPluginLoaderDeps(runtime)),
    closePlugins: () => runtime.pluginManager.close(),
    // The reason is the cause chain with credentials masked (the same line a
    // failed start prints), so a degraded daemon's log says why, not only where.
    reportFailure(step, error) {
      const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
      logger.warn('Daemon boot step failed', {
        step, name: error instanceof Error ? error.name : typeof error,
        ...(code === undefined ? {} : { code }),
        reason: describeFatalFailure(error),
      });
    },
  };
}
