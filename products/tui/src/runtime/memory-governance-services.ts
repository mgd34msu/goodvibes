// ---------------------------------------------------------------------------
// memory-governance-services.ts, the tail step that constructs and starts the
// platform's MemoryGovernor for the terminal app.
//
// The CacheRegistry, PauseController and the admission-gate holder are built
// EARLY in services.ts (so the scheduler gates and the knowledge background
// jobs can consult the pause controller before the governor exists); this
// helper hands them to the platform's createMemoryGovernance and starts it.
//
// What the governor does here, and what it does not:
//   - it refuses expensive work at the critical tier (`admitExpensiveWork`)
//     and pauses the deferrable background jobs under pressure;
//   - it registers no cache to trim: nothing this process could register
//     reclaims resident memory (the knowledge job-run history is capped on
//     every write and lives in SQLite; the session broker's trim only retires
//     abandoned inputs), so trimming would delete history and free nothing;
//   - it never exits the process. The daemon has a service manager to restart
//     it; an interactive terminal has a person in front of it, so a tripwire
//     snapshots the stores, reports the pressure and keeps running.
// ---------------------------------------------------------------------------

import {
  createMemoryGovernance,
  type CacheRegistry,
  type PauseController,
  type MemoryGovernor,
} from '@goodvibes-jev/engine/platform/platform/runtime/memory';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import type { RuntimeEventBus } from '@/runtime/index.ts';

export interface MemoryGovernanceServicesDeps {
  readonly configManager: ConfigManager;
  readonly runtimeBus: RuntimeEventBus;
  /** Built early in services.ts so scheduler gates can consult it before the governor. */
  readonly cacheRegistry: CacheRegistry;
  readonly pauseController: PauseController;
  /** The deferrable background jobs the governor pauses under pressure. */
  readonly jobIds: readonly string[];
  /** Where the tripwire receipt is written, so the pressure can be read after the fact. */
  readonly receiptPath: string;
  /**
   * Not trimmed: the knowledge job-run history is already capped on write and
   * trimming it frees no resident memory. Accepted until the caller stops passing it.
   */
  readonly knowledgeStores?: unknown;
  /** Not trimmed: the broker's trim only retires abandoned inputs and frees nothing. */
  readonly sessionBroker?: unknown;
  /** Store snapshots taken when the tripwire fires, so a leak that ends in a kill loses nothing. */
  readonly onTripwireShutdown?: (() => Promise<void> | void) | undefined;
}

export interface MemoryGovernanceServices {
  readonly memoryGovernor: MemoryGovernor;
}

/**
 * Construct + start the MemoryGovernor, reading the memory.* config domain.
 * The governor starts by default; it is a safety feature.
 */
export function wireMemoryGovernance(deps: MemoryGovernanceServicesDeps): MemoryGovernanceServices {
  const { configManager } = deps;
  const { memoryGovernor } = createMemoryGovernance({
    config: {
      budgetMb: configManager.get('memory.budgetMb'),
      elevatedPct: configManager.get('memory.tier.elevatedPct'),
      highPct: configManager.get('memory.tier.highPct'),
      criticalPct: configManager.get('memory.tier.criticalPct'),
      tripwireRateMbPerSec: configManager.get('memory.tripwire.rateMbPerSec'),
      tripwireSustainSec: configManager.get('memory.tripwire.sustainSec'),
      hardLimitPct: configManager.get('memory.hardLimitPct'),
    },
    runtimeBus: deps.runtimeBus,
    cacheRegistry: deps.cacheRegistry,
    pauseController: deps.pauseController,
    caches: [],
    jobIds: deps.jobIds,
    receiptPath: deps.receiptPath,
    onTripwireShutdown: deps.onTripwireShutdown,
    deps: {
      exit: (receipt) => {
        logger.warn('[memory] the terminal app keeps running past a memory tripwire; save your work and restart it when convenient', {
          trigger: receipt.trigger,
          rssMb: receipt.rssMb,
          budgetMb: receipt.budgetMb,
          receiptPath: deps.receiptPath,
        });
      },
    },
  });
  return { memoryGovernor };
}
