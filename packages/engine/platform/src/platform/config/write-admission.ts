/**
 * What a settings write must satisfy beyond the per-key `validate`, so a write
 * and the next load agree on what a valid value is.
 */
import { isAbsolute } from 'node:path';
import type { ConfigSetting } from './schema.js';
import { readDotPath } from './shared-config-tier.js';
import { resolveEffectiveSystemRamMb } from '../runtime/memory/memory-governor.js';

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

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value as string[] : null;
}

/**
 * Keys that have a default but no schema row (the settings surface owns their
 * editor). They still get a content check here, because the sandbox executor
 * consumes them as raw lists.
 */
const NON_SCHEMA_VALUE_RULES: Readonly<Record<string, (value: unknown) => string | null>> = {
  'sandbox.egressAllowlist': (value) => {
    const list = stringList(value);
    if (!list) return 'expects a list of command names';
    return list.every((entry) => entry.trim().length > 0) ? null : 'entries must be non-empty command names';
  },
  'sandbox.workspaceWritable': (value) => {
    const list = stringList(value);
    if (!list) return 'expects a list of absolute paths';
    const relative = list.find((entry) => !isAbsolute(entry));
    return relative === undefined ? null : `"${relative}" is not an absolute path`;
  },
};

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
  'permissions.execEnvScrubAllowlist', 'worktree.setup.commands', 'worktree.setup.carryOverGlobs',
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
export function nonSchemaKeyRefusal(key: string, value: unknown, config?: unknown): string | null {
  const rule = NON_SCHEMA_VALUE_RULES[key]?.(value);
  if (rule) return rule;
  if (config === undefined || NON_SCHEMA_VALUE_RULES[key] || PRODUCT_OWNED_LEAVES.has(key)) return null;
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
