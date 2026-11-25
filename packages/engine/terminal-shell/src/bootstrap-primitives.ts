import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { createFeatureFlagManager } from '@goodvibes/engine/platform/platform/runtime/feature-flags/manager';
import { deriveFeatureStates, bindFeatureSettingsBridge } from '@goodvibes/engine/platform/platform/runtime/feature-flags/feature-settings';
import {
  RuntimeEventBus,
  configureRuntimeEventBusDefaults,
  runtimeEventBusOptionsFrom,
} from '@goodvibes/engine/platform/platform/runtime/state';
import { createRuntimeStore, createDomainDispatch } from '@goodvibes/engine/platform/platform/runtime/store';
import type { DomainDispatch } from '@goodvibes/engine/platform/platform/runtime/state';
import { attachSessionRecoveryState } from '@goodvibes/engine/platform/platform/runtime/emitters';
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

export function initialTerminalRuntimeFields(
  config: Pick<ConfigManager, 'get'>,
  providerFromModel: (model: unknown) => string,
  loadSystemPrompt: () => string,
) {
  return {
    model: config.get('provider.model') as string,
    provider: providerFromModel(config.get('provider.model')),
    systemPrompt: loadSystemPrompt(),
    reasoningEffort: (config.get('provider.reasoningEffort') as string | undefined) ?? '',
  };
}
