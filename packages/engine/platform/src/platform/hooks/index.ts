export { TurnHookOwner, bindTurnHookDispatcher } from './turn-ownership.js';
export type { HookDispatchOptions, HookWorkAdmission, TurnHookDispatcher } from './turn-ownership.js';
export type { HookExecutionOptions } from './execution.js';
export { HookDispatcher, hookDefinitionProblem, hooksFileRefusal } from './dispatcher.js';
export type { HookRunnerDeps } from './dispatcher.js';
export { ChainEngine } from './chain-engine.js';
export { HookActivityTracker } from './activity.js';
export { HookWorkbench, HooksFileAwaitingTrustError, createHookWorkbench } from './workbench.js';
export type { HooksFileTrustGate } from './workbench.js';
export { createHookApi, createHookApiDispatcher } from './hook-api.js';
export type {
  CreateHookApiOptions,
  HookApi,
  HookApiDispatcher,
  HookApiWorkbenchRuntime,
  HookContractRecord,
  HookContractSource,
  HookWorkbenchApi,
} from './hook-api.js';
export type {
  HookPhase,
  HookCategory,
  HookEventPath,
  HookPattern,
  HookEvent,
  HookResult,
  HookType,
  HookDefinition,
  ChainStep,
  HookChain,
  HooksConfig,
} from './types.js';
export type { HookActivityRecord } from './activity.js';
export type { HookAuthoringAction, HookConfigInspection, HookSimulationResult, HooksFileDescription } from './workbench.js';
export type { HookExecutionMode, HookAuthority, HookPointContract } from './contracts.js';
export {
  listHookPointContracts,
  getHookPointContract,
  hookPatternProblem,
  parseHookPath,
} from './contracts.js';
export { matchesEventPath, matchesMatcher, patternsOverlap } from './matcher.js';
export { safeEvaluate } from './chain-engine.js';

import type { HookActivityTracker } from './activity.js';
import { HookDispatcher, type HookRunnerDeps } from './dispatcher.js';

/**
 * A dispatcher with the same runners the runtime builds: pass the agent
 * manager, tool LLM and project root to run `agent`, `prompt` and `ts` hooks.
 * A runner left out answers that it is not configured in this runtime.
 */
export function createHookDispatcher(config: HookRunnerDeps & {
  readonly activityTracker?: HookActivityTracker | undefined;
} = {}): HookDispatcher {
  const { activityTracker, ...runnerDeps } = config;
  return new HookDispatcher(runnerDeps, activityTracker);
}
