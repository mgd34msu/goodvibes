/** Whether the gate has a decision model to hand `jev-decides` calls to, read from settings. */

import type { ConfigManager } from '../config/manager.js';
import type { ConfigKey } from '../config/schema.js';
import { decisionModelReady } from '../gate/presets.js';
import { DECISION_MODEL_SET_KEYS, decisionModelSettings, type DecisionModelSettings } from '../config/decision-model-set.js';
import { requestedDecisionEndpoint, requestedDecisionModel } from '../config/decision-model-request.js';
import { captureJudgmentFallbackSettings } from '../config/judgment-fallback-settings.js';
import { gateDecisionsCalibrated, type DecisionTarget } from '../gate/calibration.js';

/** The settings whose change can turn the decision model the gate relies on ready or not ready. */
export const DECISION_MODEL_READINESS_KEYS = DECISION_MODEL_SET_KEYS satisfies readonly ConfigKey[];

/**
 * Every place a gate decision can be answered: the endpoint and model a
 * request goes to (the one resolver requests use, config/decision-model-request.ts),
 * then each fallback target in order. Settings the request path would refuse
 * are none: nothing measured them.
 */
function decisionTargets(settings: DecisionModelSettings, env: Readonly<Record<string, string | undefined>>): readonly DecisionTarget[] {
  const primary: DecisionTarget = { endpoint: requestedDecisionEndpoint(settings.endpoint, env), model: requestedDecisionModel(settings.model, env) };
  try {
    return [primary, ...captureJudgmentFallbackSettings(settings.fallbacks).map((target) => ({ endpoint: target.endpoint, model: target.model }))];
  } catch {
    return [];
  }
}

export interface DecisionModelReadinessOptions {
  /**
   * The mode in force was chosen by the owner for this session (Shift+Tab, a
   * hosted session's mode, a channel profile) rather than read from settings.
   * Such a choice counts as his, the same as one saved in settings.
   */
  readonly chosen?: boolean | undefined;
  /** The environment requests read TYPESAFE_* from; the process environment when absent, as the gate's own readiness reads it. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/**
 * Whether the gate has a decision model to hand `jev-decides` calls to. The
 * gate and every report of the mode in force (the mode-change event) read this
 * one answer, so they never disagree.
 */
export function permissionDecisionModelReady(
  configManager: Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'isExplicitlySet'>>,
  options: DecisionModelReadinessOptions = {},
): boolean {
  const env = options.env ?? process.env;
  const settings = decisionModelSettings(key => configManager.get(key));
  if (!decisionModelReady(settings, env)) return false;
  // The owner's own choice of mode, saved or chosen for the session, stands on
  // a working model; the shipped default hands decisions to Jev only once they
  // were measured on everything that can answer them.
  if (options.chosen === true || configManager.isExplicitlySet?.('permissions.mode') !== false) return true;
  return gateDecisionsCalibrated(decisionTargets(settings, env));
}
