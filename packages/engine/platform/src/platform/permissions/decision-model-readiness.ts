/** Whether the gate has a decision model to hand `jev-decides` calls to, read from settings and from whether it answers. */

import type { ConfigManager } from '../config/manager.js';
import type { ConfigKey } from '../config/schema.js';
import { decisionModelReady, effectivePermissionMode, normalizePermissionMode, type GatePresetName } from '../gate/presets.js';
import { DECISION_MODEL_SET_KEYS, decisionModelSettings, type DecisionModelSettings } from '../config/decision-model-set.js';
import { requestedDecisionEndpoint, requestedDecisionModel } from '../config/decision-model-request.js';
import { captureJudgmentFallbackSettings } from '../config/judgment-fallback-settings.js';
import { gateDecisionsCalibrated, type DecisionTarget } from '../gate/calibration.js';
import { decisionModelFailure } from '../runtime/decision-policy.js';

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
  /**
   * Take a set model as answering even while its failure episode lasts. Only
   * for comparing modes across one decision: a failure or a recovery flips the
   * mode in force for the next call, never for a call already being decided.
   */
  readonly assumeAnswering?: boolean | undefined;
}

/** Why the gate has no decision model to hand `jev-decides` calls to; undefined when it has one. */
export type DecisionModelUnreadyReason =
  | { readonly kind: 'selected' }
  | { readonly kind: 'not-set' }
  | { readonly kind: 'uncalibrated' }
  | { readonly kind: 'failing'; readonly model: string; readonly what: string; readonly since: number };

function readinessReason(
  configManager: Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'isExplicitlySet'>>,
  options: DecisionModelReadinessOptions,
): DecisionModelUnreadyReason | undefined {
  const env = options.env ?? process.env;
  const settings = decisionModelSettings(key => configManager.get(key));
  if (!decisionModelReady(settings, env)) return settings.policy === 'No Decision Model' ? { kind: 'selected' } : { kind: 'not-set' };
  // A set model counts as working only while it answers: from its first
  // failure until it answers again (runtime/decision-policy.ts, one memory read).
  const failure = options.assumeAnswering === true ? undefined : decisionModelFailure();
  if (failure !== undefined) return { kind: 'failing', model: failure.model, what: failure.what, since: failure.since };
  // The owner's own choice of mode, saved or chosen for the session, stands on
  // a working model; the shipped default hands decisions to Jev only once they
  // were measured on everything that can answer them.
  if (options.chosen === true || configManager.isExplicitlySet?.('permissions.mode') !== false) return undefined;
  return gateDecisionsCalibrated(decisionTargets(settings, env)) ? undefined : { kind: 'uncalibrated' };
}

/**
 * Whether the gate has a decision model to hand `jev-decides` calls to. The
 * gate and every report of the mode in force (the mode-change event, status,
 * `/permissions`, the web UI) read this one answer, so they never disagree.
 */
export function permissionDecisionModelReady(
  configManager: Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'isExplicitlySet'>>,
  options: DecisionModelReadinessOptions = {},
): boolean {
  return readinessReason(configManager, options) === undefined;
}

/** The mode in force for a saved or chosen mode, and why it differs from that mode when it does. */
export interface PermissionModeInForce {
  /** The mode saved in settings, or chosen for the session. */
  readonly chosen: GatePresetName;
  /** The mode the gate decides calls by. */
  readonly mode: GatePresetName;
  /** One sentence saying why `mode` is not `chosen`; absent when they are the same. */
  readonly reason?: string;
}

/**
 * The mode in force for `chosen` (the saved `permissions.mode` when absent),
 * read the way the gate reads it, with the reason it differs. Costs a few
 * settings reads and one memory read; no request.
 */
export function describePermissionModeInForce(
  configManager: Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'isExplicitlySet'>>,
  input: { readonly chosen?: unknown; readonly explicitlyChosen?: boolean | undefined; readonly env?: Readonly<Record<string, string | undefined>> | undefined } = {},
): PermissionModeInForce {
  const fromSettings = input.chosen === undefined;
  const autoApprove = fromSettings && configManager.get('behavior.autoApprove' as ConfigKey) === true;
  const chosen = normalizePermissionMode(fromSettings ? configManager.get('permissions.mode' as ConfigKey) : input.chosen);
  if (autoApprove && chosen !== 'yolo') {
    return { chosen, mode: 'yolo', reason: 'the saved setting behavior.autoApprove is on, which selects yolo; choosing a mode in /settings clears it' };
  }
  const why = chosen === 'jev-decides'
    ? readinessReason(configManager, { ...(input.explicitlyChosen === true ? { chosen: true } : {}), ...(input.env ? { env: input.env } : {}) })
    : undefined;
  const mode = effectivePermissionMode(chosen, false, why === undefined);
  if (why === undefined || mode === chosen) return { chosen, mode };
  const reason = why.kind === 'selected'
    ? 'judgment.policy is No Decision Model, so Jev cannot decide and every call it would decide asks you'
    : why.kind === 'not-set'
      ? 'no decision model is set (judgment.model, judgment.endpoint or TYPESAFE_API_KEY), so every call Jev would decide asks you'
      : why.kind === 'uncalibrated'
        ? 'jev-decides is only the shipped default here and the gate\'s decisions were not measured on this decision model; choose jev-decides yourself (/settings permissions.mode) to use it'
        : `the decision model ${why.model} is not answering (${why.what}, since ${new Date(why.since).toISOString()}); calls Jev would decide ask you until it answers again`;
  return { chosen, mode, reason };
}
