import {
  Orchestrator,
  type OrchestratorOptions,
  type OrchestratorCoreServices,
  type OrchestratorUserInputOptions,
} from '@goodvibes/engine/platform/platform/core';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { OwnerInputAnswered } from './companion-input.js';
import type { ProviderRegistry } from '@goodvibes/engine/platform/platform/providers';
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
  return (text: string, options?: OrchestratorUserInputOptions, answered?: OwnerInputAnswered): void => {
    beforeInput?.();
    // A turn that ran is answered from its own turn events; one that failed to start is answered here.
    void orchestrator.handleUserInput(text, undefined, options).catch((error: unknown) => {
      answered?.({ answer: `This message could not be answered: ${error instanceof Error ? error.message : String(error)}`, status: 'failed' });
      onError(error);
    });
  };
}
/** Common mechanical services only; memory and code-injection authority is supplied separately. */
export function projectOrchestratorCoreServices(input: {
  readonly configManager: ConfigManager;
  readonly providerRegistry: ProviderRegistry;
  readonly services: Pick<
    OrchestratorCoreServices,
    'planManager' | 'sessionMemoryStore' | 'sessionLineageTracker' | 'idempotencyStore' | 'sessionOrchestration'
  >;
}): {
  configManager: ConfigManager;
  providerRegistry: ProviderRegistry;
  planManager: OrchestratorCoreServices['planManager'];
  sessionMemoryStore: OrchestratorCoreServices['sessionMemoryStore'];
  sessionLineageTracker: OrchestratorCoreServices['sessionLineageTracker'];
  idempotencyStore: OrchestratorCoreServices['idempotencyStore'];
  sessionOrchestration: OrchestratorCoreServices['sessionOrchestration'];
} {
  const { configManager, providerRegistry, services } = input;
  return {
    configManager,
    providerRegistry,
    planManager: services.planManager,
    sessionMemoryStore: services.sessionMemoryStore,
    sessionLineageTracker: services.sessionLineageTracker,
    idempotencyStore: services.idempotencyStore,
    // Tasks another session handed to this one are said at the start of each turn until accepted.
    sessionOrchestration: services.sessionOrchestration,
  };
}
