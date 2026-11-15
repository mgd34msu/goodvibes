/**
 * What a settings write must satisfy beyond the per-key `validate`, so a write
 * and the next load agree on what a valid value is.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { ConfigSetting } from './schema.js';
import { readDotPath } from './shared-config-tier.js';
import { resolveEffectiveSystemRamMb } from '../runtime/memory/memory-governor.js';
import { ConfigError } from '../types/errors.js';
import { coerceSchemaValue } from './manager-bootstrap.js';
import { isProjectRestrictedKey } from './config-key-facts.js';
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
 * and is refused instead of being saved where nothing reads it.
 */
const PRODUCT_OWNED_LEAVES: ReadonlySet<string> = new Set([
  'behavior.budgetAlertUsd', 'behavior.notifyAfterSeconds', 'behavior.notifyOnAgentFailure',
  'behavior.notifyOnApprovalPending', 'behavior.notifyOnBudgetBreach', 'behavior.notifyOnChainFailure',
  'behavior.notifyOnlyWhenUnfocused', 'behavior.terminalBell', 'behavior.terminalNotifyAgentBlocked',
  'behavior.terminalNotifyApprovalWait', 'behavior.terminalNotifyTurnEnd', 'behavior.notificationsMetadataOnly',
  'tools.hostedResearchScreening', 'memory.projection.dir', 'memory.showProvenance', 'storage.codeIndexEnabled',
  'permissions.execEnvScrubAllowlist',
  'payments.cardNumber', 'payments.cardExpiry', 'payments.cardCvv', 'payments.cardholderName',
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
 * The tiers must stay ordered: elevated < high < critical <= 100. The memory
 * governor refuses to start otherwise, so a write that would invert them is
 * refused here with the other two values named.
 */
export function memoryTierOrderRefusal(key: string, value: unknown, config: unknown): string | null {
  if (!key.startsWith('memory.tier.') || typeof value !== 'number') return null;
  const read = (name: string): number => {
    const path = `memory.tier.${name}`;
    if (path === key) return value;
    const found = readDotPath(config, path).value;
    return typeof found === 'number' ? found : Number.NaN;
  };
  const elevated = read('elevatedPct');
  const high = read('highPct');
  const critical = read('criticalPct');
  if (elevated > 0 && elevated < high && high < critical && critical <= 100) return null;
  return `would leave elevatedPct (${elevated}), highPct (${high}) and criticalPct (${critical}) out of order; each must be above the one before and at most 100, so change the other tier first`;
}

/**
 * The governor refuses to start when its hard limit (a percent of the kill
 * ceiling) sits at or below the critical tier (a percent of the budget). A
 * budget close to the machine's memory, or a hard limit pulled low, reaches
 * that state, so the write that would cause it is refused with the numbers.
 * `ceilingMb` is injectable so the check is deterministic.
 */
export function memoryBudgetRefusal(
  key: string, value: unknown, config: unknown, ceilingMb: number = resolveEffectiveSystemRamMb(),
): string | null {
  if (key !== 'memory.budgetMb' && key !== 'memory.hardLimitPct' && key !== 'memory.tier.criticalPct') return null;
  if (typeof value !== 'number') return null;
  const read = (name: string, fallback: number): number => {
    const found = readDotPath(config, name).value;
    return typeof found === 'number' ? found : fallback;
  };
  const pick = (name: string, fallback: number): number => (name === key ? value : read(name, fallback));
  const budgetMb = pick('memory.budgetMb', 0);
  if (!(budgetMb > 0)) return null; // auto budget is capped well under the ceiling
  const criticalMb = budgetMb * (pick('memory.tier.criticalPct', 95) / 100);
  const hardLimitPct = pick('memory.hardLimitPct', 90);
  const hardLimitMb = ceilingMb * (hardLimitPct / 100);
  if (hardLimitMb > criticalMb) return null;
  return `would put the critical tier (${Math.round(criticalMb)}MB) at or above the hard limit (${Math.round(hardLimitMb)}MB = ${hardLimitPct}% of the ${Math.round(ceilingMb)}MB this machine can use), and the memory governor refuses to start that way; lower memory.budgetMb or memory.tier.criticalPct, or raise memory.hardLimitPct`;
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
