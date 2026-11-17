/**
 * Evaluation Harness, barrel export.
 *
 * Provides the eval runner, scorecard scorer, the task-suite adapter that
 * evaluates the product on real work, and baseline persistence utilities.
 *
 * @example
 * ```ts
 * import { EvalRunner, createHeadlessRunExecutor, loadBaseline, runTaskSuite, taskSuiteAsEvalSuite } from './eval/index.js';
 *
 * const startedAt = Date.now();
 * const tasks = await runTaskSuite('eval/tasks', { executor: createHeadlessRunExecutor() });
 * const fresh = taskSuiteAsEvalSuite('eval/tasks', tasks, startedAt);
 * const gate = new EvalRunner().evaluateGate(fresh, await loadBaseline('.goodvibes/eval/baseline.json'));
 * if (!gate.passed) process.exit(1);
 * ```
 */

export type {
  EvalScenario,
  EvalRawResult,
  EvalResult,
  EvalSuiteResult,
  EvalScorecard,
  EvalBaseline,
  EvalGateResult,
  EvalDimension,
  EvalJudgmentAccuracy,
  DimensionScore,
  RegressionEntry,
  FloorFailureEntry,
  UnbaselinedScenario,
  BaselineSuiteSummary,
} from './types.js';

export { EvalRunner } from './runner.js';
export type { EvalRunnerOptions } from './runner.js';

export { scoreScenario, formatScorecard, judgmentQualityScore, DIMENSION_FLOOR } from './scorecard.js';

export {
  captureBaseline,
  serialiseBaseline,
  deserialiseBaseline,
  writeBaseline,
  loadBaseline,
  formatBaselineComparison,
} from './baseline.js';

export { formatSuiteResult, formatGateResult } from './format.js';

export {
  runTaskSuite,
  discoverTasks,
  loadTaskDefinition,
  defaultShellVerifier,
  formatTaskSuiteResult,
  taskSuiteAsEvalSuite,
} from './task-suite.js';
export type {
  TaskDefinition,
  DiscoveredTask,
  TaskExecutionContext,
  TaskSessionOutcome,
  TaskSessionExecutor,
  TaskVerifyContext,
  TaskVerifyResult,
  TaskVerifier,
  TaskResult,
  TaskSuiteResult,
  RunTaskSuiteOptions,
} from './task-suite.js';
export { createHeadlessRunExecutor, type HeadlessRunExecutorOptions } from './headless-executor.js';
