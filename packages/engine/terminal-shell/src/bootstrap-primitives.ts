import type { SessionEvent } from '@goodvibes-jev/engine/sdk/events';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import {
  createFeatureFlagManager,
  deriveFeatureStates,
  bindFeatureSettingsBridge,
} from '../../sdk/src/platform/runtime/feature-flags/index.js';
import {
  RuntimeEventBus,
  configureRuntimeEventBusDefaults,
  runtimeEventBusOptionsFrom,
} from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { createRuntimeStore, createDomainDispatch, type DomainDispatch } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import type { OrchestratorUserInputOptions } from '@goodvibes-jev/engine/sdk/platform/core';
import type { Notifier } from '@goodvibes-jev/engine/sdk/platform/integrations';
import { companionMessageToOrchestratorInputOptions } from './companion-input.js';
export function createTerminalFeatureFlags(config: ConfigManager) {
  const flags = createFeatureFlagManager();
  flags.loadFromConfig({ flags: deriveFeatureStates(config) });
  bindFeatureSettingsBridge(config, flags);
  return flags;
}
export function createTerminalEventState(config: Pick<ConfigManager, 'get'>) {
  configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) => config.get(key)));
  const runtimeBus = new RuntimeEventBus();
  const store = createRuntimeStore();
  return { runtimeBus, store, domainDispatch: createDomainDispatch(store) };
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
): () => void {
  return bus.on<Extract<SessionEvent, { type: 'COMPANION_MESSAGE_RECEIVED' }>>('COMPANION_MESSAGE_RECEIVED', ({ payload }) => {
    narrate?.(payload);
    if (handler.value) handler.value(payload.body, companionMessageToOrchestratorInputOptions(payload));
    else {
      conversation.addUserMessage(payload.body);
      render();
    }
  });
}
export function seedTerminalSession(dispatch: Pick<DomainDispatch, 'syncSessionState'>, sessionId: string, projectRoot: string): void {
  dispatch.syncSessionState(
    {
      id: sessionId,
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
export function syncTerminalNotifierQueues(
  notifier: Pick<Notifier, 'getQueueStatus'>,
  dispatch: Pick<DomainDispatch, 'syncIntegration'>,
  attach: () => () => void,
): () => void {
  const queues = notifier.getQueueStatus();
  if (!queues.length) return () => {};
  const unsubscribe = attach();
  for (const queue of queues) {
    dispatch.syncIntegration(
      {
        id: queue.channel,
        displayName: queue.channel[0]!.toUpperCase() + queue.channel.slice(1),
        category: 'communication',
        status: queue.metrics.deadLettered > 0 ? 'degraded' : 'healthy',
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
  return unsubscribe;
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
