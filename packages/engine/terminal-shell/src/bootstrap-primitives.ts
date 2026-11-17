import type { SessionEvent } from '@goodvibes-jev/engine/platform/events';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { createFeatureFlagManager } from '@goodvibes-jev/engine/platform/platform/runtime/feature-flags/manager';
import { deriveFeatureStates, bindFeatureSettingsBridge } from '@goodvibes-jev/engine/platform/platform/runtime/feature-flags/feature-settings';
import {
  RuntimeEventBus,
  configureRuntimeEventBusDefaults,
  runtimeEventBusOptionsFrom,
} from '@goodvibes-jev/engine/platform/platform/runtime/state';
import { createRuntimeStore, createDomainDispatch } from '@goodvibes-jev/engine/platform/platform/runtime/store';
import type { DomainDispatch } from '@goodvibes-jev/engine/platform/platform/runtime/state';
import { attachSessionRecoveryState } from '@goodvibes-jev/engine/platform/platform/runtime/emitters';
import type { OrchestratorUserInputOptions } from '@goodvibes-jev/engine/platform/platform/core';
import type { Notifier } from '@goodvibes-jev/engine/platform/platform/integrations';
import { companionMessageToOrchestratorInputOptions } from './companion-input.js';
const featureFlagBridgeTeardowns = new WeakMap<object, () => void>();
export function createTerminalFeatureFlags(config: ConfigManager) {
  const flags = createFeatureFlagManager();
  flags.loadFromConfig({ flags: deriveFeatureStates(config) });
  featureFlagBridgeTeardowns.set(flags, bindFeatureSettingsBridge(config, flags));
  return flags;
}
/** Detach the config subscription `createTerminalFeatureFlags` attached, so a disposed runtime is not kept alive by the config manager. */
export function disposeTerminalFeatureFlags(flags: object): void {
  const teardown = featureFlagBridgeTeardowns.get(flags);
  if (teardown === undefined) return;
  featureFlagBridgeTeardowns.delete(flags);
  teardown();
}
export function createTerminalEventState(config: Pick<ConfigManager, 'get'>) {
  configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) => config.get(key)));
  const runtimeBus = new RuntimeEventBus();
  const store = createRuntimeStore();
  const domainDispatch = createDomainDispatch(store);
  // The session recovery state the store shows is derived from the session
  // events (loading, repairing, ready, recovery failed); it lives as long as the bus.
  attachSessionRecoveryState(runtimeBus, domainDispatch);
  return { runtimeBus, store, domainDispatch };
}
export async function initializeTerminalMemory(
  store: { init(): Promise<unknown>; save(): Promise<unknown>; close(): unknown },
  unsubs: Array<() => void | Promise<void>>,
): Promise<void> {
  await store.init();
  unsubs.push(async () => {
    try {
      await store.save();
    } finally {
      store.close();
    }
  });
}
export function attachTerminalCompanionInput(
  bus: Pick<RuntimeEventBus, 'on'>,
  handler: { value: ((text: string, options?: OrchestratorUserInputOptions) => void) | null },
  conversation: { addUserMessage(text: string): unknown },
  render: () => void,
  narrate?: (payload: Extract<SessionEvent, { type: 'COMPANION_MESSAGE_RECEIVED' }>) => void,
  options: {
    /** The session this terminal is running. When given, a message addressed to any other session is ignored. */
    readonly activeSessionId?: (() => string | undefined) | undefined;
    /** Told when a message arrives before the orchestrator is ready and so is recorded but not answered. */
    readonly notice?: ((text: string) => void) | undefined;
  } = {},
): () => void {
  return bus.on<Extract<SessionEvent, { type: 'COMPANION_MESSAGE_RECEIVED' }>>('COMPANION_MESSAGE_RECEIVED', ({ payload }) => {
    const active = options.activeSessionId?.();
    if (active !== undefined && payload.sessionId !== active) return;
    narrate?.(payload);
    if (handler.value) handler.value(payload.body, companionMessageToOrchestratorInputOptions(payload));
    else {
      conversation.addUserMessage(payload.body);
      options.notice?.('A companion message arrived before the assistant was ready. It is shown in the conversation but no turn was started; send it again to get an answer.');
      render();
    }
  });
}
export function seedTerminalSession(dispatch: Pick<DomainDispatch, 'syncSessionState'>, sessionId: string, projectRoot: string): void {
  dispatch.syncSessionState(
    {
      id: sessionId,
      conversationSessionId: sessionId,
      projectRoot,
      status: 'active',
      startedAt: Date.now(),
      recoveryState: 'ready',
      isResumed: false,
      wasRepaired: false,
      lineageId: sessionId,
      lineage: [{ sessionId, createdAt: Date.now() }],
    },
    'bootstrap.session',
  );
}
/**
 * Attach the Slack and Discord notifier to the runtime bus and mirror its
 * delivery queues into the integrations domain. The notifier is attached even
 * with no channel yet: it resolves its channels at send time, so a token saved
 * during the session delivers the next notification. The rows are written now
 * and again whenever the notifier's channels change or a notification fails. A
 * chat service connected with a bot token but no notification target gets a
 * degraded row that names what to add, as the daemon shows it.
 */
export function syncTerminalNotifierQueues(
  notifier: Pick<Notifier, 'getQueueStatus' | 'onChannelsChanged' | 'channelGaps' | 'onDeadLetter'>,
  dispatch: Pick<DomainDispatch, 'syncIntegration'>,
  attach: () => () => void,
): () => void {
  const unsubscribe = attach();
  let shown = new Set<string>();
  const syncRows = (): void => {
    const queues = notifier.getQueueStatus();
    const gaps = notifier.channelGaps();
    const now = new Set([...queues.map((queue) => queue.channel), ...gaps.map((gap) => gap.channel)]);
    for (const gone of shown) {
      if (now.has(gone)) continue;
      dispatch.syncIntegration(
        { id: gone, displayName: gone[0]!.toUpperCase() + gone.slice(1), category: 'communication', status: 'unconfigured', enabled: false, successCount: 0, errorCount: 0, meta: {} },
        'bootstrap.notifier',
      );
    }
    shown = now;
    for (const gap of gaps) {
      dispatch.syncIntegration(
        {
          id: gap.channel, displayName: gap.channel[0]!.toUpperCase() + gap.channel.slice(1),
          category: 'communication', status: 'degraded', enabled: true, successCount: 0, errorCount: 0,
          lastError: `${gap.reason}. ${gap.next}.`,
          meta: { notifications: 'no-target', next: gap.next },
        },
        'bootstrap.notifier',
      );
    }
    for (const queue of queues) {
      dispatch.syncIntegration(
        {
          id: queue.channel,
          displayName: queue.channel[0]!.toUpperCase() + queue.channel.slice(1),
          category: 'communication',
          status: queue.metrics.deadLettered > 0 ? 'degraded' : queue.metrics.delivered > 0 ? 'healthy' : 'configured',
          enabled: true,
          successCount: queue.metrics.delivered,
          errorCount: queue.metrics.deadLettered,
          ...(queue.dlqEntries[0]?.deadAt ? { lastErrorAt: queue.dlqEntries[0].deadAt } : {}),
          ...(queue.dlqEntries[0]?.finalError ? { lastError: queue.dlqEntries[0].finalError } : {}),
          meta: {
            attempts: queue.metrics.totalAttempts,
            retrying: queue.metrics.retrying,
            deadLetters: queue.metrics.deadLettered,
            dlqSize: queue.metrics.dlqSize,
            sloEnforced: queue.sloEnforced,
          },
        },
        'bootstrap.notifier',
      );
    }
  };
  syncRows();
  const stopRows = notifier.onChannelsChanged(syncRows);
  const stopFailures = notifier.onDeadLetter(syncRows);
  return () => { stopRows(); stopFailures(); unsubscribe(); };
}

export function initialTerminalRuntimeFields(
  config: Pick<ConfigManager, 'get'>,
  providerFromModel: (model: unknown) => string,
  loadSystemPrompt: () => string,
) {
  return {
    model: config.get('provider.model') as string,
    provider: providerFromModel(config.get('provider.model')),
    debugMode: false,
    systemPrompt: loadSystemPrompt(),
    reasoningEffort: (config.get('provider.reasoningEffort') as string | undefined) ?? '',
  };
}
