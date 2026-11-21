/**
 * schema-domain-memory.ts, MemoryGovernor config (`memory.*`).
 *
 * Owner-confirmed defaults (2026-07-14). `memory.budgetMb` uses 0 as an "auto"
 * sentinel: the governor resolves it to min(25% of system RAM, 4096 MB) at
 * runtime, kept a sentinel here so the browser-safe config schema never calls
 * node:os. The tier percentages and tripwire values are literal defaults.
 */
import { type ConfigSettingDefinition, intRange, numRange } from './schema-shared.js';

/** MemoryGovernor policy (`memory.*`). */
export interface MemoryConfig {
  /** Budget in MB. 0 = auto: min(25% of system RAM, 4096). */
  budgetMb: number;
  tier: {
    /** Trim caches to floor + gc at/above this % of budget. */
    elevatedPct: number;
    /** Flush caches + pause deferrable jobs at/above this % of budget. */
    highPct: number;
    /** Refuse new expensive work + emit ops event at/above this % of budget. */
    criticalPct: number;
  };
  tripwire: {
    /** Post-flush RSS growth rate (MB/s) that, if sustained, indicates a leak. */
    rateMbPerSec: number;
    /** How long (s) the growth must be sustained after a flush before exiting. */
    sustainSec: number;
  };
  /**
   * Absolute-RSS backstop as a percent of the EFFECTIVE KILL CEILING, the
   * own-cgroup memory limit where one applies, else physical RAM. Default 90.
   * Anchored to the ceiling (not the budget) so a large-but-stable working set
   * above the deliberately-small budget never exits a healthy daemon; the
   * critical tier handles that by refusing new expensive work and staying
   * alive. This only fires when the kernel/cgroup OOM killer is genuinely
   * imminent and the leak was too slow for the rate tripwire to see.
   */
  hardLimitPct: number;
  projection: {
    /** Folder `/memory sync-files` writes memory records to as files, relative to the project. */
    dir: string;
  };
}

export const memoryConfigDefaults: { memory: MemoryConfig } = {
  memory: {
    budgetMb: 0,
    tier: {
      elevatedPct: 60,
      highPct: 80,
      criticalPct: 95,
    },
    tripwire: {
      rateMbPerSec: 25,
      sustainSec: 60,
    },
    hardLimitPct: 90,
    projection: {
      dir: '.goodvibes/memory/projection',
    },
  },
};

export const memoryConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'memory.budgetMb',
    label: 'Memory GoodVibes aims to stay under (MB, 0 for automatic)',
    type: 'number',
    description:
      'How much memory the daemon plans to use, in MB. The governor sheds caches and pauses background jobs as RSS approaches this budget. 0 means auto: min(25% of system RAM, 4096 MB), resolved at daemon start. Applies after the daemon restarts.',
    ...intRange(0, 1_048_576),
  },
  {
    key: 'memory.tier.elevatedPct',
    label: 'Trim caches at this share of the memory budget (%)',
    type: 'number',
    description:
      'At this share of the memory budget, the daemon trims what it keeps in memory. Applies after the daemon restarts.',
    ...intRange(1, 100),
  },
  {
    key: 'memory.tier.highPct',
    label: 'Pause background work at this share of the memory budget (%)',
    type: 'number',
    description:
      'At this share of the memory budget, the daemon empties what it keeps in memory and pauses background work that can wait. Applies after the daemon restarts.',
    ...intRange(1, 100),
  },
  {
    key: 'memory.tier.criticalPct',
    label: 'Refuse new heavy work at this share of the memory budget (%)',
    type: 'number',
    description:
      'At this share of the memory budget, the daemon refuses new heavy work and says why. Applies after the daemon restarts.',
    ...intRange(1, 100),
  },
  {
    key: 'memory.tripwire.rateMbPerSec',
    label: 'Memory growth that suggests a leak (MB per second)',
    type: 'number',
    description:
      'If memory use keeps growing faster than this, in MB per second, after the daemon has emptied what it keeps, it suspects a leak. Applies after the daemon restarts.',
    ...numRange(1, 100_000),
  },
  {
    key: 'memory.tripwire.sustainSec',
    label: 'How long growth must last to count as a leak (seconds)',
    type: 'number',
    description:
      'How long, in seconds, that growth must last before the daemon records why and restarts itself cleanly. Applies after the daemon restarts.',
    ...intRange(1, 86_400),
  },
  {
    key: 'memory.hardLimitPct',
    label: 'Restart before memory reaches this share of the limit (%)',
    type: 'number',
    description:
      'The daemon restarts before its memory reaches this share of the most it may use: its own memory limit where it has one, else the computer\'s memory. If RSS holds at/above this percent of that ceiling for memory.tripwire.sustainSec, the governor writes a hard-limit receipt and exits so a supervisor restarts clean, catching a leak too slow for memory.tripwire.rateMbPerSec just before the kernel/cgroup OOM killer would strike. Default 90: fire at 90% of the real kill line, leaving a safety margin for the exit itself. Deliberately anchored to the kill ceiling and NOT to memory.budgetMb: the budget caps small by design (25% of RAM, max 4096 MB), and a large-but-stable working set above the budget on a big-RAM host is handled by the critical tier (refuse new expensive work, stay alive), anchoring the exit to the budget would put such a healthy daemon in a permanent restart loop. Applies after the daemon restarts.',
    ...intRange(1, 100),
  },
  {
    key: 'memory.projection.dir',
    label: 'Folder memories are written to as files',
    type: 'string',
    description:
      '/memory sync-files writes one markdown file per standing (project/team-scope) memory record here, and commits the folder when it sits inside a git repository. A relative path resolves against the project working directory. /memory review-files reads your edits back from this folder as proposals; editing or deleting a file never changes the memory store directly.',
    validate: (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0,
    validationHint: 'a folder path, relative to the project or absolute',
  },
];
