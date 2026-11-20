/**
 * Runtime permissions simulation pipeline.
 *
 * `PermissionSimulator` wraps two `LayeredPolicyEvaluator` instances,
 * the *actual* (authoritative) evaluator and a *simulated* (candidate)
 * evaluator, and runs both in parallel for every call to `evaluate()`.
 *
 * Divergence tracking:
 *   - Counts by tool class, command prefix, and simulation mode.
 *   - Configurable divergence threshold for enforcement gate.
 *   - `getDivergenceReport()` returns aggregated stats.
 *
 * Simulation modes:
 *   - `simulation-only`   , Actual decision enforced; divergence recorded for
 *                            reports without warning emission.
 *   - `warn-on-divergence`, Actual decision enforced; divergence emits a warning.
 *   - `enforce`           , Simulated decision becomes authoritative; blocked if
 *                           divergence gate fails (rate > threshold).
 *
 * Capability gate: `permissions-simulation` (permissions.simulation) must be on to use this module.
 */

import { GoodVibesError } from '@goodvibes/engine/errors';
import type {
  CommandClassification,
  DivergenceRecord,
  DivergenceReport,
  DivergenceStats,
  DivergenceType,
  PermissionDecision,
  PermissionSimulatorConfig,
  PermissionsConfig,
  PolicyRule,
  SimulationMode,
  SimulationResult,
} from './types.js';

import { LayeredPolicyEvaluator } from './evaluator.js';

// ── Private helpers ────────────────────────────────────────────────────────────

/** Extracts the first meaningful token from the first string argument. */
function extractCommandPrefix(
  args: Record<string, unknown>,
): string | undefined {
  for (const key of ['command', 'path', 'url']) {
    const val = args[key]!;
    if (typeof val === 'string' && val.length > 0) {
      return val.split(/[\s/]+/)[0];
    }
  }
  return undefined;
}

/** Determines the divergence type between two decisions. */
function classifyDivergence(
  actual: PermissionDecision,
  simulated: PermissionDecision,
): DivergenceType {
  if (actual.allowed && !simulated.allowed) return 'allow-vs-deny';
  if (!actual.allowed && simulated.allowed) return 'deny-vs-allow';
  return 'reason-mismatch';
}

type DivergenceCounts = Record<DivergenceType, number>;

const emptyCounts = (): DivergenceCounts => ({ 'allow-vs-deny': 0, 'deny-vs-allow': 0, 'reason-mismatch': 0 });

function countDivergence(bucket: Record<string, DivergenceCounts>, key: string, type: DivergenceType): void {
  const counts = bucket[key] ?? (bucket[key] = emptyCounts());
  counts[type] += 1;
}

/** Builds a bucket's stats from its divergence counts and evaluation total. */
function statsFromCounts(counts: DivergenceCounts | undefined, totalEvaluations: number): DivergenceStats {
  const byType = counts ?? emptyCounts();
  const total = byType['allow-vs-deny'] + byType['deny-vs-allow'] + byType['reason-mismatch'];
  return {
    total,
    byType: { ...byType },
    divergenceRate: totalEvaluations > 0 ? total / totalEvaluations : 0,
    totalEvaluations,
  };
}

// ── PermissionSimulator ────────────────────────────────────────────────────────

/**
 * PermissionSimulator, Dual-evaluator simulation pipeline for runtime permissions.
 *
 * Runs two `LayeredPolicyEvaluator` instances (actual + simulated) in parallel
 * and tracks divergence between their decisions.
 *
 * Usage:
 * ```ts
 * const simulator = createPermissionSimulator(
 *   { mode: 'default', rules: currentRules },
 *   { mode: 'default', rules: candidateRules },
 *   'warn-on-divergence',
 * );
 * const result = simulator.evaluate('write', { path: '/tmp/out.txt' }, 'write');
 * if (result.diverged) {
 *   console.warn('divergence:', result.divergenceType);
 * }
 * ```
 */
export class PermissionSimulator {
  private readonly actual: LayeredPolicyEvaluator;
  private readonly simulated: LayeredPolicyEvaluator;
  private readonly simulationMode: SimulationMode;
  private readonly maxDivergenceRecords: number;
  private readonly divergenceThreshold: number;
  private readonly onWarning: ((record: DivergenceRecord) => void) | undefined;
  private readonly policySources: { readonly projectRoot: string | undefined; readonly rules: readonly PolicyRule[] };

  /** All recorded divergences, capped at `maxDivergenceRecords`. */
  private records: DivergenceRecord[] = [];

  /** Per-tool-class evaluation counts (diverged + non-diverged). */
  private evalsByClass: Partial<Record<CommandClassification, number>> = {};

  /** Per-command-prefix evaluation counts. */
  private evalsByPrefix: Record<string, number> = {};

  /** Per-mode evaluation counts. */
  private evalsByMode: Partial<Record<SimulationMode, number>> = {};

  /** Total evaluations across all calls. */
  private totalEvals = 0;

  /**
   * Divergence counts per bucket. Counted as each divergence happens, never recomputed from `records`,
   * which drops its oldest entries at the cap: the rate the enforcement gate and the promotion gate
   * read must not shrink because older divergences aged out of the list.
   */
  private divergenceTally = {
    overall: emptyCounts(),
    byClass: {} as Record<string, DivergenceCounts>,
    byPrefix: {} as Record<string, DivergenceCounts>,
    byMode: {} as Record<string, DivergenceCounts>,
  };

  private static readonly DEFAULT_MAX_RECORDS = 500;
  private static readonly DEFAULT_THRESHOLD = 0.05;

  constructor(
    actualConfig: PermissionsConfig,
    simulatedConfig: PermissionsConfig,
    simulationMode: SimulationMode,
    config: PermissionSimulatorConfig = {},
  ) {
    this.policySources = {
      projectRoot: simulatedConfig.projectRoot ?? actualConfig.projectRoot,
      rules: [...(actualConfig.rules ?? []), ...(simulatedConfig.rules ?? [])],
    };
    this.actual = new LayeredPolicyEvaluator(actualConfig);
    this.simulated = new LayeredPolicyEvaluator(simulatedConfig);
    this.simulationMode = simulationMode;
    this.maxDivergenceRecords =
      config.maxDivergenceRecords ?? PermissionSimulator.DEFAULT_MAX_RECORDS;
    this.divergenceThreshold =
      config.divergenceThreshold ?? PermissionSimulator.DEFAULT_THRESHOLD;
    this.onWarning = config.onWarning;
  }

  /**
   * evaluate, Runs both evaluators and returns a `SimulationResult`.
   *
   * In `enforce` mode the call will throw `SimulationEnforcementError` if
   * the divergence rate exceeds the configured threshold.
   *
   * @param toolName, The tool name being evaluated.
   * @param args    , The arguments passed to the tool.
   * @param classification, What the call does, from the gate's Jev reading.
   */
  /** @deprecated Synchronous compatibility only; use evaluateAsync. */
  evaluate(
    toolName: string,
    args: Record<string, unknown>,
    classification: CommandClassification,
  ): SimulationResult {
    // Enforcement gate, checked before evaluation in enforce mode
    if (this.simulationMode === 'enforce') {
      this.assertDivergenceGate();
    }

    const actualDecision = this.actual.evaluate(toolName, args, classification);
    const simulatedDecision = this.simulated.evaluate(toolName, args, classification);

    return this.finishEvaluation(toolName, args, classification, actualDecision, simulatedDecision);
  }

  async evaluateAsync(toolName: string, args: Record<string, unknown>, classification: CommandClassification): Promise<SimulationResult> {
    if (this.simulationMode === 'enforce') this.assertDivergenceGate();
    const actualDecision = await this.actual.evaluateAsync(toolName, args, classification);
    const simulatedDecision = await this.simulated.evaluateAsync(toolName, args, classification);
    return this.finishEvaluation(toolName, args, classification, actualDecision, simulatedDecision);
  }

  private finishEvaluation(toolName: string, args: Record<string, unknown>, classification: CommandClassification,
    actualDecision: PermissionDecision, simulatedDecision: PermissionDecision): SimulationResult {
    const diverged =
      actualDecision.allowed !== simulatedDecision.allowed ||
      actualDecision.reason !== simulatedDecision.reason ||
      actualDecision.sourceLayer !== simulatedDecision.sourceLayer;

    const commandPrefix = extractCommandPrefix(args);
    const toolClass = actualDecision.classification ?? classification;

    // ── Bookkeeping ────────────────────────────────────────────────────
    this.totalEvals += 1;
    this.evalsByClass[toolClass] = (this.evalsByClass[toolClass] ?? 0) + 1;
    this.evalsByMode[this.simulationMode] =
      (this.evalsByMode[this.simulationMode] ?? 0) + 1;
    if (commandPrefix !== undefined) {
      this.evalsByPrefix[commandPrefix] =
        (this.evalsByPrefix[commandPrefix] ?? 0) + 1;
    }

    // Determine the authoritative decision based on mode
    const authoritativeDecision =
      this.simulationMode === 'enforce' ? simulatedDecision : actualDecision;

    if (!diverged) {
      return { actualDecision, simulatedDecision, authoritativeDecision, diverged: false };
    }

    const divergenceType = classifyDivergence(actualDecision, simulatedDecision);

    // ── Record divergence ──────────────────────────────────────────────
    const record: DivergenceRecord = {
      timestamp: Date.now(),
      toolName,
      toolClass,
      commandPrefix,
      mode: this.simulationMode,
      divergenceType,
      actualReason: actualDecision.reason,
      simulatedReason: simulatedDecision.reason,
    };

    this.divergenceTally.overall[divergenceType] += 1;
    countDivergence(this.divergenceTally.byClass, toolClass, divergenceType);
    if (commandPrefix !== undefined) countDivergence(this.divergenceTally.byPrefix, commandPrefix, divergenceType);
    countDivergence(this.divergenceTally.byMode, this.simulationMode, divergenceType);

    if (this.records.length >= this.maxDivergenceRecords) {
      this.records.shift();
    }
    this.records.push(record);

    // ── Warn on divergence ─────────────────────────────────────────────
    if (this.simulationMode === 'warn-on-divergence') {
      if (this.onWarning) {
        this.onWarning(record);
      } else {
        process.stderr.write(
          `[permissions-simulation] warn-on-divergence: tool=${toolName} type=${divergenceType} actual=${actualDecision.reason} simulated=${simulatedDecision.reason}\n`,
        );
      }
    }

    return { actualDecision, simulatedDecision, authoritativeDecision, diverged: true, divergenceType };
  }

  /**
   * getDivergenceReport, Returns aggregated divergence statistics.
   *
   * Queryable by tool class and command prefix. Includes overall summary,
   * per-class, per-prefix, and per-mode breakdowns.
   */
  getDivergenceReport(): DivergenceReport {
    const tally = this.divergenceTally;
    const byToolClass: Partial<Record<CommandClassification, DivergenceStats>> = {};
    const byCommandPrefix: Record<string, DivergenceStats> = {};
    const byMode: Partial<Record<SimulationMode, DivergenceStats>> = {};

    for (const [cls, count] of Object.entries(this.evalsByClass)) {
      byToolClass[cls as CommandClassification] = statsFromCounts(tally.byClass[cls], count as number);
    }
    for (const [prefix, count] of Object.entries(this.evalsByPrefix)) {
      byCommandPrefix[prefix] = statsFromCounts(tally.byPrefix[prefix], count as number);
    }
    for (const [mode, count] of Object.entries(this.evalsByMode)) {
      byMode[mode as SimulationMode] = statsFromCounts(tally.byMode[mode], count as number);
    }
    const accumulatedOverall = statsFromCounts(tally.overall, this.totalEvals);

    return {
      overall: accumulatedOverall,
      byToolClass,
      byCommandPrefix,
      byMode,
      records: [...this.records],
    };
  }

  /**
   * getPolicySources, The project root and the rules of both policy sets, so a caller can build
   * evidence that exercises what the rules are about.
   */
  getPolicySources(): { readonly projectRoot: string | undefined; readonly rules: readonly PolicyRule[] } {
    return this.policySources;
  }

  /**
   * getActualEvaluator, Exposes the actual evaluator for direct inspection.
   */
  getActualEvaluator(): LayeredPolicyEvaluator {
    return this.actual;
  }

  /**
   * getSimulatedEvaluator, Exposes the simulated evaluator for direct inspection.
   */
  getSimulatedEvaluator(): LayeredPolicyEvaluator {
    return this.simulated;
  }

  /**
   * getSimulationMode, Returns the active simulation mode.
   */
  getSimulationMode(): SimulationMode {
    return this.simulationMode;
  }

  /**
   * isDivergenceGatePassing, Returns whether the divergence rate is within
   * the configured threshold. Always `true` in non-enforce modes.
   */
  isDivergenceGatePassing(): boolean {
    if (this.totalEvals === 0) return true;
    const report = this.getDivergenceReport();
    return report.overall.divergenceRate <= this.divergenceThreshold;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * assertDivergenceGate, Throws if divergence rate exceeds threshold.
   *
   * Only called in `enforce` mode prior to evaluation.
   */
  private assertDivergenceGate(): void {
    if (!this.isDivergenceGatePassing()) {
      const report = this.getDivergenceReport();
      throw new SimulationEnforcementError(
        `Simulation enforcement blocked: divergence rate ${
          (report.overall.divergenceRate * 100).toFixed(2)
        }% exceeds threshold ${
          (this.divergenceThreshold * 100).toFixed(2)
        }%`,
        report.overall.divergenceRate,
        this.divergenceThreshold,
      );
    }
  }
}

// ── SimulationEnforcementError ────────────────────────────────────────────────

/**
 * Thrown when `enforce` mode is active and the divergence gate fails.
 */
export class SimulationEnforcementError extends GoodVibesError {
  declare readonly code: 'SIMULATION_ENFORCEMENT_BLOCKED';
  /** Current divergence rate (0–1). */
  readonly divergenceRate: number;
  /** Configured divergence threshold (0–1). */
  readonly threshold: number;

  constructor(message: string, divergenceRate: number, threshold: number) {
    super(message, { code: 'SIMULATION_ENFORCEMENT_BLOCKED', category: 'permission', source: 'runtime', recoverable: false });
    this.name = 'SimulationEnforcementError';
    this.divergenceRate = divergenceRate;
    this.threshold = threshold;
  }
}
