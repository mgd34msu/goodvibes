export type { UiReadModel } from './ui-read-models-base.js';
export type { DoctorReport } from './ops/index.js';
export type {
  UiCoreReadModels,
  UiProvidersSnapshot,
  UiSessionSnapshot,
  UiAgentsSnapshot,
  UiTasksSnapshot,
} from './ui-read-models-core.js';
export type {
  UiOperationsReadModels,
  UiAutomationSnapshot,
  UiRoutesSnapshot,
  UiWatchersSnapshot,
  UiContractsSnapshot,
  UiCommunicationSnapshot,
  UiControlPlaneSnapshot,
} from './ui-read-models-operations.js';
export type {
  UiObservabilityReadModels,
  UiRemoteSnapshot,
  UiIntelligenceSnapshot,
  UiMarketplaceSnapshot,
  UiCockpitSnapshot,
  UiSecuritySnapshot,
  UiHealthSnapshot,
  UiMcpServerSnapshot,
  UiMcpSnapshot,
  UiLocalAuthSnapshot,
  UiSettingsSnapshot,
  UiContinuitySnapshot,
  UiWorktreeSnapshot,
} from './ui-read-models-observability.js';
export type { UiObservabilityReadModelOptions } from './ui-read-models-observability-options.js';

import type { RuntimeServices } from './services.js';
import { createOpsCheckContext, runDoctor, type DoctorReport } from './ops/index.js';
import { createSessionSurface } from './session-surface.js';
import { createCoreReadModels, type UiCoreReadModels } from './ui-read-models-core.js';
import {
  createOperationsReadModels,
  type UiOperationsReadModels,
  type UiOperationsReadModelOptions,
} from './ui-read-models-operations.js';
import {
  createObservabilityReadModels,
  type UiObservabilityReadModels,
  type UiObservabilityReadModelOptions,
} from './ui-read-models-observability.js';

export type UiReadModelOptions = UiOperationsReadModelOptions & UiObservabilityReadModelOptions;

/** `/doctor <symptom>`: a symptom's runbook, its checks run against this app's live state. */
export interface UiDoctorReadModel {
  diagnose(symptom: string): Promise<DoctorReport>;
}

export type UiReadModels = UiCoreReadModels & UiOperationsReadModels & UiObservabilityReadModels & { readonly doctor: UiDoctorReadModel };

/**
 * The check context is built once with the read models: its one bus observer
 * keeps the time of the last runtime event (one number per event); everything
 * else is read only when a diagnosis runs.
 */
function createDoctorReadModel(runtimeServices: RuntimeServices): UiDoctorReadModel {
  const surface = createSessionSurface({
    surfaceRoot: runtimeServices.surfaceRoot,
    workingDirectory: runtimeServices.shellPaths.workingDirectory,
    homeDirectory: runtimeServices.shellPaths.homeDirectory,
  });
  const context = createOpsCheckContext({
    store: runtimeServices.runtimeStore,
    runtimeBus: runtimeServices.runtimeBus,
    listApprovals: (limit) => runtimeServices.approvalBroker.listApprovals(limit),
    recoveryFilePath: () => {
      const sessionId = runtimeServices.runtimeStore.getState().session.id;
      return sessionId ? surface.recoveryFile(sessionId) : undefined;
    },
    lastSessionPointerPath: surface.lastSessionPointer,
    contextWindow: () => runtimeServices.providerRegistry.getCurrentModel().contextWindow,
    plugins: () => runtimeServices.pluginManager.list(),
  });
  return { diagnose: (symptom) => runDoctor(symptom, context) };
}

export function createUiReadModels(
  runtimeServices: RuntimeServices,
  options: UiReadModelOptions = {},
): UiReadModels {
  return {
    ...createCoreReadModels(runtimeServices),
    ...createOperationsReadModels(runtimeServices, options),
    ...createObservabilityReadModels(runtimeServices, options),
    doctor: createDoctorReadModel(runtimeServices),
  };
}
