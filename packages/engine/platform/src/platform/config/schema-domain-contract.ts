/**
 * Contract runner configuration.
 *
 * The `contract.*` settings replace the retired review loop's settings; the
 * settings migration in migrations.ts moves an existing file's values across
 * once. The runner reads them through platform/contract/config.ts, whose
 * CONTRACT_CONFIG_DEFAULTS holds the same defaults as below.
 *
 * A domain of its own rather than a block inside schema-domain-core.ts,
 * because that file is at its size ceiling.
 *
 * `gates` is an array, so, like conversationGate.gatedSurfaces, it is not a
 * scalar ConfigKey and is read through getCategory('contract').
 */
import { type ConfigSettingDefinition, intRange, numRange } from './schema-shared.js';
import type { ContractSettings } from './schema-types-contract.js';

export const contractConfigDefaults: { contract: ContractSettings } = {
  contract: {
    autoCommit: true,
    commitScope: 'scoped',
    // Gates are project-specific commands and run only when the owner enables them.
    gates: [
      { name: 'typecheck', command: 'npx tsc --noEmit', enabled: false },
      { name: 'lint', command: 'npx eslint . --max-warnings 0', enabled: false },
      { name: 'build', command: 'npm run build', enabled: false },
    ],
    acceptanceStakes: 'high',
    midRunChecks: true,
    evidenceNudgeLimit: 0,
    stallLimit: 3,
    maxNudgesPerUnit: 0,
    maxFixRounds: 3,
    planRepairLimit: 3,
    maxUnits: 0,
    judgmentCallBudget: 400,
    defaultAttempts: 1,
    maxActiveContracts: 6,
    maxParallelUnits: 64,
    isolation: 'auto',
    transportRetryLimit: 3,
    nudgeTtlMs: 300_000,
  },
};

/**
 * The keys that moved from the retired review loop's settings (autoCommit, commitScope, maxFixRounds,
 * transportRetryLimit) keep the old validators, so no value migrated from an existing file is refused on its next
 * load. Keys removed since (a step's silence limit, the gate command limit, the transport retry delay) are read past
 * silently and left in the file (SETTINGS_KEPT_FOR_ROLLBACK in config/settings-carry-forward.ts).
 */
export const contractConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'contract.autoCommit',
    label: "Commit a finished contract's work",
    type: 'boolean',
    description: 'Commit the deliverable when a contract passes: worktree mode merges the contract branch, shared mode commits the paths the contract touched',
  },
  {
    key: 'contract.commitScope',
    label: 'What a finished contract commits',
    type: 'enum',
    description: 'What a passing contract commits: off (never commit; the work is left as uncommitted changes), scoped (only the contract\'s own changes, default), all (the whole working tree in shared mode)',
    enumValues: ['off', 'scoped', 'all'],
  },
  {
    key: 'contract.acceptanceStakes',
    label: "How strict a contract's checks are",
    type: 'enum',
    description: 'How strong a reading must be before a criterion counts as met: high (default) or critical (the strictest declared pass band)',
    enumValues: ['high', 'critical'],
  },
  {
    key: 'contract.midRunChecks',
    label: 'Check work after every turn that changes files',
    type: 'boolean',
    description: 'Check a unit\'s work at the end of each turn that changed files, not only when the unit agent tries to finish',
  },
  {
    key: 'contract.evidenceNudgeLimit',
    label: 'Unconvincing checks before you are asked (0 for no limit)',
    type: 'number',
    description: 'Consecutive checks where the work does not show a criterion is met before the owner is asked to confirm; 0 disables this limit',
    ...intRange(0, Number.MAX_SAFE_INTEGER),
  },
  {
    key: 'contract.stallLimit',
    label: 'Checks without progress before work counts as stalled (0 for no limit)',
    type: 'number',
    description: 'Consecutive checks without progress that mark a unit as stalled and hand it to correction; 0 disables this limit',
    ...intRange(0, Number.MAX_SAFE_INTEGER),
  },
  {
    key: 'contract.maxNudgesPerUnit',
    label: 'Most corrections per unit (0 for no limit)',
    type: 'number',
    description: 'The most corrections one unit receives before it is treated as stalled; 0 disables this limit',
    ...intRange(0, Number.MAX_SAFE_INTEGER),
  },
  {
    key: 'contract.maxFixRounds',
    label: 'Most fix rounds before you decide (0 for no limit)',
    type: 'number',
    description: 'Planned-fix rounds plus fresh agents for one unit, group or deliverable before the owner decides; 0 disables this limit',
    ...intRange(0, Number.MAX_SAFE_INTEGER),
  },
  {
    key: 'contract.planRepairLimit',
    label: 'Most plan repairs before you decide (0 for no limit)',
    type: 'number',
    description: 'Times the planner is asked to repair a plan that fails its checks before the owner decides; 0 disables this limit (planning then stops only when the same problem comes back)',
    ...intRange(0, Number.MAX_SAFE_INTEGER),
  },
  {
    key: 'contract.maxUnits',
    label: 'Most units in a plan (0 for no limit)',
    type: 'number',
    description: 'The most units one contract plan may hold; 0 disables this limit',
    ...intRange(0, Number.MAX_SAFE_INTEGER),
  },
  {
    key: 'contract.judgmentCallBudget',
    label: 'Decision-model calls per contract',
    type: 'number',
    description: 'Decision-model calls one contract may spend on its checks, plans and corrections; once spent, the next correction goes to the owner with what was spent and what is still unmet instead of another fix round. 0 disables this budget',
    ...intRange(0, Number.MAX_SAFE_INTEGER),
  },
  {
    key: 'contract.defaultAttempts',
    label: 'Attempts per unit',
    type: 'number',
    description: 'Independent attempts per unit when the request does not ask for several; above 1, the best passing attempt is selected',
    ...intRange(1, 5),
  },
  {
    key: 'contract.maxActiveContracts',
    label: 'Contracts that run at once',
    type: 'number',
    description: 'Contracts that may run at once; further contracts wait in a queue',
    ...intRange(1, 64),
  },
  {
    key: 'contract.maxParallelUnits',
    label: 'Units that run at once',
    type: 'number',
    description: 'Units of one group that may run at once in worktree mode (shared mode always runs one)',
    ...intRange(1, 256),
  },
  {
    key: 'contract.isolation',
    label: 'Where contract work runs',
    type: 'enum',
    description: 'Where contract work runs: auto (a git worktree when the project is a git repository with a commit, otherwise the shared tree), worktree, or shared',
    enumValues: ['auto', 'worktree', 'shared'],
  },
  {
    key: 'contract.transportRetryLimit',
    label: 'Retries after a connection error',
    type: 'number',
    description: 'How many times a workstream phase agent that failed on a connection error is started again at once before its item fails. 0 disables it. A step of a piece of work is never started again by this: a failed step ends failed, and whether it runs again is decided by your permission mode.',
    ...numRange(0, 5),
  },
  {
    key: 'contract.nudgeTtlMs',
    label: 'Drop an unread correction after (ms)',
    type: 'number',
    description: 'How long in ms a correction sent to a running unit agent waits to be read before it expires',
    ...intRange(1000, 3_600_000),
  },
];
