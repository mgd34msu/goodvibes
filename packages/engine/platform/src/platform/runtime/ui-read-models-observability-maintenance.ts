import type { RuntimeServices } from './services.js';
import type { UiReadModel } from './ui-read-models-base.js';
import { createStoreBackedReadModel } from './ui-read-model-helpers.js';
import type {
  ContinuitySnapshot as IntegrationContinuitySnapshot,
  SettingsSnapshot as IntegrationSettingsSnapshot,
  WorktreeSnapshot as IntegrationWorktreeSnapshot,
} from './integration/helpers.js';
import type { SessionReturnContextSummary } from './session-return-context.js';
import type { ManagedWorktreeMeta } from './worktree/registry.js';

export interface UiSettingsSnapshot {
  readonly available: boolean;
  readonly conflictCount: number;
  readonly recentFailureCount: number;
  readonly managedLockCount: number;
  readonly hasStagedManagedBundle: boolean;
}

export interface UiContinuitySnapshot {
  readonly sessionId: string;
  readonly status: string;
  readonly recoveryState: string;
  readonly lastSessionPointer: string | null;
  readonly recoveryFilePresent: boolean;
  readonly recoveryFile: Record<string, unknown> | null;
  readonly returnContext?: SessionReturnContextSummary | undefined;
}

export interface UiWorktreeSnapshot {
  readonly summary: {
    readonly total: number;
    readonly active: number;
    readonly paused: number;
  };
  readonly records: readonly ManagedWorktreeMeta[];
}

export interface UiMaintenanceObservabilityReadModels {
  readonly settings: UiReadModel<UiSettingsSnapshot>;
  readonly continuity: UiReadModel<UiContinuitySnapshot>;
  readonly worktrees: UiReadModel<UiWorktreeSnapshot>;
}

export function createMaintenanceObservabilityReadModels(runtimeServices: RuntimeServices): UiMaintenanceObservabilityReadModels {
  return {
    settings: {
      // The conflicts, failures and locks come from the config manager's files; nothing announces a change.
      pollOnly: true,
      getSnapshot() {
        const snapshot = runtimeServices.integrationHelpers.getSettingsSnapshot() as IntegrationSettingsSnapshot;
        return {
          available: snapshot.available,
          conflictCount: snapshot.available ? snapshot.conflicts.length : 0,
          recentFailureCount: snapshot.available ? snapshot.recentFailures.length : 0,
          managedLockCount: snapshot.available ? snapshot.managedLockCount : 0,
          hasStagedManagedBundle: snapshot.available ? Boolean(snapshot.stagedManagedBundle) : false,
        };
      },
      subscribe() {
        return () => {};
      },
    },
    // Session id and status follow the runtime store; the recovery file and last-session pointer are read
    // from disk, so they show on the next store change or the next read.
    continuity: createStoreBackedReadModel(runtimeServices, () => {
      const snapshot = runtimeServices.integrationHelpers.getContinuitySnapshot() as IntegrationContinuitySnapshot;
      return snapshot;
    }),
    worktrees: {
      // The records are read from the persisted worktree metadata on disk; nothing announces a change.
      pollOnly: true,
      getSnapshot() {
        const snapshot = runtimeServices.integrationHelpers.getWorktreeSnapshot() as IntegrationWorktreeSnapshot;
        return {
          summary: snapshot.summary,
          records: snapshot.records,
        };
      },
      subscribe() {
        return () => {};
      },
    },
  };
}
