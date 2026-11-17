/** Whether the gate has a decision model to hand `jev-decides` calls to, read from settings. */

import type { ConfigManager } from '../config/manager.js';
import type { ConfigKey } from '../config/schema.js';
import { decisionModelReady } from '../gate/presets.js';
import { DECISION_MODEL_SET_KEYS, decisionModelSettings } from '../config/decision-model-set.js';
import { gateDecisionsCalibrated } from '../gate/calibration.js';

/** The settings whose change can turn the decision model the gate relies on ready or not ready. */
export const DECISION_MODEL_READINESS_KEYS = DECISION_MODEL_SET_KEYS satisfies readonly ConfigKey[];

/**
 * Whether the gate has a decision model to hand `jev-decides` calls to. The
 * gate and every report of the mode in force (the mode-change event) read this
 * one answer, so they never disagree.
 */
export function permissionDecisionModelReady(
  configManager: Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'isExplicitlySet'>>,
): boolean {
  const model = configManager.get('judgment.model');
  if (!decisionModelReady(decisionModelSettings(key => configManager.get(key)))) return false;
  // The owner's own choice of mode stands on a working model; the shipped
  // default hands decisions to Jev only once they were measured on it.
  return configManager.isExplicitlySet?.('permissions.mode') !== false || gateDecisionsCalibrated(String(model ?? ''));
}
