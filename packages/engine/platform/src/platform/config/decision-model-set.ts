/**
 * Whether the owner has set a decision model at all. One answer for the
 * decision policy (nothing set: every operation runs without a decision model, silently),
 * the gate (jev-decides behaves as ask-me) and every status that says whether
 * decision models are in use.
 */

/** The judgment settings that say whether a decision model is set. */
export interface DecisionModelSettings {
  readonly policy?: unknown;
  readonly endpoint?: unknown;
  readonly model?: unknown;
  readonly keySource?: unknown;
  readonly keyName?: unknown;
  readonly fallbacks?: unknown;
  /** `judgment.noDecisionModel`: no decision model chosen, which wins over every other setting and the environment. */
  readonly noDecisionModel?: unknown;
}

/** The settings keys whose change can set or unset a decision model. */
export const DECISION_MODEL_SET_KEYS = ['judgment.policy', 'judgment.endpoint', 'judgment.model', 'judgment.keySource', 'judgment.keyName', 'judgment.fallbacks', 'judgment.noDecisionModel'] as const;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

type StoredDecisionKeyProbe = (keyName: string) => boolean;
const storedKeyProbes: StoredDecisionKeyProbe[] = [];

/**
 * Registers a process-level check for whether a decision-model key exists in
 * the active runtime's secret store (used only when `decisionModelSet` is
 * called against `process.env` without an explicit `hasStoredKey` override).
 * Returns a disposer that removes this probe.
 */
export function registerStoredDecisionKeyProbe(probe: StoredDecisionKeyProbe): () => void {
  storedKeyProbes.push(probe);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const idx = storedKeyProbes.lastIndexOf(probe);
    if (idx >= 0) storedKeyProbes.splice(idx, 1);
  };
}

function hasRegisteredStoredKey(keyName: string): boolean {
  for (let i = storedKeyProbes.length - 1; i >= 0; i -= 1) {
    try { if (storedKeyProbes[i]!(keyName)) return true; } catch { /* ignore probe failure */ }
  }
  return false;
}

/**
 * Set when any of these is: an endpoint (setting or TYPESAFE_BASE_URL), a
 * fallback target, an explicit credential choice (a secret-store entry, or no
 * authentication), a key in the environment, or a model (setting or
 * TYPESAFE_DEFAULT_MODEL). With none there is nothing to ask. A set model that
 * then fails is reported, not treated as unset. The policy is not read here.
 * No decision model chosen (`judgment.noDecisionModel`) is not set, whatever
 * else the settings or the environment hold.
 */
export function decisionModelSet(
  settings: DecisionModelSettings,
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly hasStoredKey?: boolean | undefined } = {},
): boolean {
  if (settings.noDecisionModel === true) return false;
  if (text(settings.endpoint) || text(env['TYPESAFE_BASE_URL'])) return true;
  if (Array.isArray(settings.fallbacks) && settings.fallbacks.length > 0) return true;
  if (settings.keySource === 'secret' || settings.keySource === 'none') return true;
  const keyName = text(settings.keyName) || 'TYPESAFE_API_KEY';
  if (text(env[keyName])) return true;
  if (options.hasStoredKey === true) return true;
  if (options.hasStoredKey === undefined && env === process.env && hasRegisteredStoredKey(keyName)) return true;
  return Boolean(text(settings.model) || text(env['TYPESAFE_DEFAULT_MODEL']));
}

/** Reads the settings {@link decisionModelSet} needs from a settings reader. */
export function decisionModelSettings(get: (key: (typeof DECISION_MODEL_SET_KEYS)[number]) => unknown): DecisionModelSettings {
  return {
    policy: get('judgment.policy'), endpoint: get('judgment.endpoint'), model: get('judgment.model'),
    keySource: get('judgment.keySource'), keyName: get('judgment.keyName'), fallbacks: get('judgment.fallbacks'),
    noDecisionModel: get('judgment.noDecisionModel'),
  };
}
