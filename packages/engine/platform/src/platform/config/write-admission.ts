/**
 * What a settings write must satisfy beyond the per-key `validate`, so a write
 * and the next load agree on what a valid value is.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { ConfigSetting } from './schema.js';
import { readDotPath } from './shared-config-tier.js';
import { resolveEffectiveSystemRamMb, validateMemoryPolicy, type MemoryPolicyValues } from '../runtime/memory/memory-governor.js';
import { ConfigError } from '../types/errors.js';
import { coerceSchemaValue } from './manager-bootstrap.js';
import { configKeyFacts, isProjectRestrictedKey } from './config-key-facts.js';
import { isSecretReferenceValue } from './secret-bearing-config-keys.js';
import { restrictProjectLayer } from './project-layer-restrictions.js';
import { writeRawDotPath } from './settings-io.js';

/** The reason `value` is the wrong type for `schema`, or null. Enums are checked by the caller. */
export function schemaTypeRefusal(schema: Pick<ConfigSetting, 'type'>, value: unknown): string | null {
  switch (schema.type) {
    case 'boolean': return typeof value === 'boolean' ? null : 'expects true or false';
    case 'number': return typeof value === 'number' && Number.isFinite(value) ? null : 'expects a finite number';
    case 'string': return typeof value === 'string' ? null : 'expects text';
    case 'object': return value !== null && typeof value === 'object' ? null : 'expects a list or object';
    default: return null;
  }
}

/**
 * Leaves a product writes under a category the platform owns, with no schema row
 * and no default (the settings surface or a feature module owns the editor).
 * A write to any other absent leaf under an existing category is a misspelt key
 * and is refused instead of being saved where nothing reads it. A key the
 * writing manager registers as a host setting is admitted by its own
 * descriptor; a key belongs here only while some manager that does not
 * register it (the daemon's, for instance) may still write it.
 */
const PRODUCT_OWNED_LEAVES: ReadonlySet<string> = new Set([
  'behavior.budgetAlertUsd', 'behavior.notifyAfterSeconds', 'behavior.notifyOnAgentFailure',
  'behavior.notifyOnApprovalPending', 'behavior.notifyOnBudgetBreach', 'behavior.notifyOnChainFailure',
  'behavior.notifyOnlyWhenUnfocused', 'behavior.terminalBell', 'behavior.terminalNotifyAgentBlocked',
  'behavior.terminalNotifyApprovalWait', 'behavior.terminalNotifyTurnEnd', 'behavior.notificationsMetadataOnly',
  'tools.hostedResearchScreening', 'memory.projection.dir', 'storage.codeIndexEnabled',
  'permissions.execEnvScrubAllowlist',
  'payments.shippingAddress', 'payments.billingAddress',
]);

/** Tool and record-keyed maps whose leaf names are chosen by the user or by a registered tool. */
const OPEN_KEY_PREFIXES: readonly string[] = ['permissions.tools.', 'pricing.modelPrices.', 'payments.shippingAddress.', 'payments.billingAddress.'];

/**
 * The reason a write to a key with no schema row is refused, or null. `config`
 * is the live config: a key already present there (a default with no editor
 * row) is accepted, and so are the product-owned leaves above; any other leaf
 * under a section that exists is refused.
 */
export function nonSchemaKeyRefusal(key: string, _value: unknown, config?: unknown): string | null {
  if (config === undefined || PRODUCT_OWNED_LEAVES.has(key)) return null;
  if (OPEN_KEY_PREFIXES.some(prefix => key.startsWith(prefix))) return null;
  if (readDotPath(config, key).present) return null;
  return 'no such setting; check the spelling against the settings list';
}

/**
 * Why `value` may not be written at `key` because of what the key holds, or
 * null: card material is never a setting, and a credential key holds only a
 * `goodvibes://secrets/` reference, never the credential. One owner of the rule
 * for every writer (`set`, `setDynamic`, `setMany`, prepared imports). The
 * reason never quotes the value. Cost: one facts lookup.
 */
export function credentialValueRefusal(key: string, value: unknown): { readonly code: 'CONFIG_CARD_MATERIAL' | 'CONFIG_SECRET_LITERAL'; readonly reason: string; readonly next: string } | null {
  const facts = configKeyFacts(key);
  if (facts.cardMaterial) {
    return { code: 'CONFIG_CARD_MATERIAL', reason: `${key} is card material, which is kept only in the daemon's card store, never in a settings file.`,
      next: 'Enter the card with /payments card in a terminal app, or under Payments in the web UI.' };
  }
  if (facts.secret && typeof value === 'string' && value.trim() !== '' && !isSecretReferenceValue(value)) {
    return { code: 'CONFIG_SECRET_LITERAL', reason: `${key} holds a credential, and a settings file keeps only a reference to it.`,
      next: `Save the credential with /secrets set <KEY> <value> (or the credentials route), then set ${key} to goodvibes://secrets/goodvibes/<KEY>.` };
  }
  return null;
}

/** The memory settings as they would be with `value` written at `key`. */
function projectedMemoryPolicy(key: string, value: number, config: unknown): MemoryPolicyValues {
  const read = (path: string, fallback: number): number => {
    if (path === key) return value;
    const found = readDotPath(config, path).value;
    return typeof found === 'number' ? found : fallback;
  };
  return {
    budgetMb: read('memory.budgetMb', 0),
    elevatedPct: read('memory.tier.elevatedPct', Number.NaN),
    highPct: read('memory.tier.highPct', Number.NaN),
    criticalPct: read('memory.tier.criticalPct', Number.NaN),
    hardLimitPct: read('memory.hardLimitPct', 90),
  };
}

/**
 * The tiers must stay ordered: elevated < high < critical <= 100. The rule is
 * the memory governor's own (`validateMemoryPolicy`), so a write is refused
 * with the same sentence the governor would give.
 */
export function memoryTierOrderRefusal(key: string, value: unknown, config: unknown): string | null {
  if (!key.startsWith('memory.tier.') || typeof value !== 'number') return null;
  const problem = validateMemoryPolicy(projectedMemoryPolicy(key, value, config), resolveEffectiveSystemRamMb());
  return problem?.group === 'tiers' ? `would break the memory settings: ${problem.message}` : null;
}

/**
 * The hard limit (a percent of the kill ceiling) must sit above the critical
 * tier (a percent of the budget); the governor's own rule decides it, so the
 * write that would break it is refused with the numbers. `ceilingMb` is
 * injectable so the check is deterministic.
 */
export function memoryBudgetRefusal(
  key: string, value: unknown, config: unknown, ceilingMb: number = resolveEffectiveSystemRamMb(),
): string | null {
  if (key !== 'memory.budgetMb' && key !== 'memory.hardLimitPct' && key !== 'memory.tier.criticalPct') return null;
  if (typeof value !== 'number') return null;
  const problem = validateMemoryPolicy(projectedMemoryPolicy(key, value, config), ceilingMb);
  return problem?.group === 'hard-limit' ? `would break the memory settings: ${problem.message}` : null;
}

/** What {@link admitSettingValue} checks a value against beyond its schema row. */
export interface SettingAdmissionContext {
  /** The live config the value would join; the rules across settings read it with the value in place. */
  readonly config?: unknown;
  /** The project settings file that outranks the file being written, when there is one. */
  readonly projectConfigPath?: string | null | undefined;
}

export type SettingAdmission =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

function frozenCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    for (const child of Object.values(node)) freeze(child);
    Object.freeze(node);
  };
  freeze(copy);
  return copy;
}

/**
 * The one admission of a settings value, for every way a setting is written:
 * coercion (money, permission mode), a JSON round trip, the schema's own
 * validator, enum and type, the rules across settings (memory tiers and
 * budget) against `context.config` with the value in place, and the
 * stricter-project-value hold. Returns the normalized value or why it is
 * refused. The reason never quotes the value.
 */
export function admitSettingValue(
  key: string,
  schema: Pick<ConfigSetting, 'type' | 'enumValues' | 'validate' | 'validationHint' | 'unit'> | undefined,
  value: unknown,
  context: SettingAdmissionContext = {},
): SettingAdmission {
  let next: unknown;
  try {
    const encoded = JSON.stringify(coerceSchemaValue(key, schema, value));
    if (encoded === undefined) return { ok: false, reason: 'needs a value' };
    next = JSON.parse(encoded);
  } catch (error) {
    return { ok: false, reason: error instanceof ConfigError ? error.message : 'not a value a settings file can hold' };
  }
  const credential = credentialValueRefusal(key, next);
  if (credential) return { ok: false, reason: `${credential.reason} ${credential.next}` };
  if (schema?.validate && !schema.validate(frozenCopy(next))) return { ok: false, reason: schema.validationHint ?? 'rejected by its schema' };
  if (schema?.type === 'enum') {
    if (!schema.enumValues?.includes(next as string)) return { ok: false, reason: `allowed: ${schema.enumValues?.join(', ') ?? 'none'}` };
  } else if (schema) {
    const typeRefusal = schemaTypeRefusal(schema, next);
    if (typeRefusal) return { ok: false, reason: typeRefusal };
  }
  if (context.config !== undefined || !schema) {
    const across = schema
      ? memoryTierOrderRefusal(key, next, context.config) ?? memoryBudgetRefusal(key, next, context.config)
      : nonSchemaKeyRefusal(key, next, context.config);
    if (across) return { ok: false, reason: across };
  }
  if (context.config !== undefined && context.projectConfigPath) {
    const held = stricterProjectValueRefusal(key, next, context.config, context.projectConfigPath);
    if (held) return { ok: false, reason: held };
  }
  return { ok: true, value: next };
}

/**
 * A project file may only tighten a restricted key, and its stricter value
 * outranks the global file at every load. Writing a different global value
 * would show as live now and be undone at the next start, so it is refused.
 */
export function stricterProjectValueRefusal(key: string, value: unknown, config: unknown, projectConfigPath: string): string | null {
  if (!isProjectRestrictedKey(key) || !existsSync(projectConfigPath)) return null;
  let projectValue: { present: boolean; value: unknown };
  try { projectValue = readDotPath(JSON.parse(readFileSync(projectConfigPath, 'utf-8')), key); }
  catch { return null; }
  if (!projectValue.present || JSON.stringify(projectValue.value) === JSON.stringify(value)) return null;
  const baseline = structuredClone(config) as Record<string, unknown>;
  writeRawDotPath(baseline, key, structuredClone(value));
  const layer: Record<string, unknown> = {};
  writeRawDotPath(layer, key, structuredClone(projectValue.value));
  if (restrictProjectLayer(layer, baseline, projectConfigPath).notices.length > 0) return null;
  return `held at ${JSON.stringify(projectValue.value)} by the project settings file ${projectConfigPath}, which may only make it stricter `
    + 'and would override the new value at the next start; remove the key from that file (or reset it) first, then set it again';
}
