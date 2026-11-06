import {
  Orchestrator,
  type OrchestratorOptions,
  type OrchestratorCoreServices,
  type OrchestratorUserInputOptions,
} from '@goodvibes-jev/engine/sdk/platform/core';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
/** Mutable UI callbacks remain owned by each shell instance. */
export function createTerminalOrchestrator(
  options: Omit<OrchestratorOptions, 'getViewportHeight' | 'scrollToEnd' | 'requestRender'>,
  requestRender: () => void,
) {
  const orchestratorRefs = {
    getViewportHeight: (): number => 20,
    scrollToEnd: (_height: number): void => {},
    requestRender: (): void => requestRender(),
  };
  const orchestrator = new Orchestrator({
    ...options,
    getViewportHeight: () => orchestratorRefs.getViewportHeight(),
    scrollToEnd: (height) => orchestratorRefs.scrollToEnd(height),
    requestRender: () => orchestratorRefs.requestRender(),
  });
  return { orchestrator, orchestratorRefs };
}
export function terminalCompanionInputHandler(
  orchestrator: Pick<Orchestrator, 'handleUserInput'>,
  onError: (error: unknown) => void,
  beforeInput?: (() => void) | undefined,
) {
  return (text: string, options?: OrchestratorUserInputOptions): void => {
    beforeInput?.();
    void orchestrator.handleUserInput(text, undefined, options).catch(onError);
  };
}
/** Common mechanical services only; memory and code-injection authority is supplied separately. */
export function projectOrchestratorCoreServices(input: {
  readonly configManager: ConfigManager;
  readonly providerRegistry: ProviderRegistry;
  readonly services: Pick<
    OrchestratorCoreServices,
    'planManager' | 'adaptivePlanner' | 'sessionMemoryStore' | 'sessionLineageTracker' | 'idempotencyStore'
  >;
}) {
  const { configManager, providerRegistry, services } = input;
  return {
    configManager,
    providerRegistry,
    planManager: services.planManager,
    adaptivePlanner: services.adaptivePlanner,
    sessionMemoryStore: services.sessionMemoryStore,
    sessionLineageTracker: services.sessionLineageTracker,
    idempotencyStore: services.idempotencyStore,
  };
}
