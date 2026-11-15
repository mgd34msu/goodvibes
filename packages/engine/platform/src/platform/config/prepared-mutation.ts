/** Data-only substrate for ConfigManager's same-owner settings mutation. No grants. */
import { ConfigError } from '../types/errors.js';
import { defineLifecycle } from '../utils/lifecycle-machine.js';
import type { ConfigKey, ConfigSetting } from './schema.js';
import { admitSettingValue, type SettingAdmissionContext } from './write-admission.js';
import type { PreparedSettingsTarget } from './prepared-target.js';

declare const mutationBrand: unique symbol;
declare const transitionBrand: unique symbol;
export interface PreparedConfigMutation { readonly [mutationBrand]: true; }
export interface PreparedConfigMutationTransition { readonly [transitionBrand]: true; }
export type PreparedConfigMutationRequest =
  | { readonly operation: 'set'; readonly key: ConfigKey; readonly value: unknown }
  | { readonly operation: 'reset'; readonly key: ConfigKey; readonly value?: never };
export interface PreparedConfigMutationDestination {
  readonly path: string;
  readonly operation: 'set' | 'remove';
  readonly tier: 'global' | 'project' | 'daemon' | 'shared';
}
/** Values are private substrate data, not automatically safe journal/judgment evidence. */
export interface PreparedConfigMutationFacts {
  readonly operation: 'set' | 'reset';
  readonly key: ConfigKey;
  readonly value: unknown;
  /** Ordered possible setting-file effects; absent tier removals remain no-ops. */
  readonly destinations: readonly PreparedConfigMutationDestination[];
  readonly incarnation: number;
  /** Full ordered plan, present only for a same-owner compound mutation. */
  readonly effects?: readonly PreparedConfigMutationFacts[];
}
export interface PreparedConfigMutationTransitionFacts {
  readonly beforeIncarnation: number;
  readonly afterIncarnation: number;
}
export interface PreparedConfigMutationReceipt {
  readonly status: 'committed' | 'partial' | 'unknown';
  /** Setting files whose atomic replacement completed, in publication order. */
  readonly completedPaths: readonly string[];
  /** The failed publication, whose effect is not claimed to have rolled back. */
  readonly uncertainPath?: string;
}

/** Why an owner refused before any effect; the wire vocabulary of the settings precondition refusals. */
export type PreparedMutationRefusalReason = 'stale' | 'spent' | 'managed' | 'read-only' | 'owner-fault';
/** A refusal that changed nothing, tagged with a value-free reason a caller can act on. */
export class PreparedMutationRefusal extends ConfigError {
  constructor(readonly refusalReason: PreparedMutationRefusalReason, message: string) {
    super(message);
    this.name = 'PreparedMutationRefusal';
  }
}

export type PreparedMutationPhase = 'prepared' | 'beginning' | 'begun' | 'committing' | 'spent';
/**
 * One prepared settings change, from capture to its single use.
 * - `prepared -> beginning -> begun` is the owner's begin, which runs every re-entrant callback first.
 * - `begun -> committing -> spent` is the one finish. A re-entered finish finds `committing` and is refused.
 * - A step of a compound plan has no begin of its own: the plan's finish moves each step `prepared -> begun`
 *   directly, because the plan already ran its begin and no callback may run between steps.
 * - Any failure, and any refused re-entry, ends in `spent`; `spent` is final and is never reused.
 */
export const preparedMutationLifecycle = defineLifecycle<PreparedMutationPhase>('Prepared settings change', {
  prepared: ['beginning', 'begun', 'spent'],
  beginning: ['begun', 'spent'],
  begun: ['committing', 'spent'],
  committing: ['spent'],
  spent: [],
});

export interface PreparedMutationRecord {
  readonly facts: PreparedConfigMutationFacts;
  readonly schemaIdentity: object;
  readonly schemaSignature: string;
  readonly validator: ConfigSetting['validate'];
  readonly normalizedJson: string;
  readonly steps?: readonly PreparedConfigMutation[];
  phase: PreparedMutationPhase;
  transition?: PreparedConfigMutationTransition;
  targets?: readonly PreparedSettingsTarget[];
  completion?: {
    readonly receipt: PreparedConfigMutationReceipt;
    readonly incarnation: number;
    readonly runtimeJson: string;
    readonly stores: readonly { readonly path: string; readonly stamp: string }[];
  };
}

/** Only JSON-shaped detached values reach the callback-free publication tail. */
export function freezePreparedData<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezePreparedData(child);
    Object.freeze(value);
  }
  return value;
}

export function preparedSchemaSignature(schema: Omit<ConfigSetting, 'key'>): string {
  return JSON.stringify({ type: schema.type, default: schema.default, description: schema.description,
    enumValues: schema.enumValues, validationHint: schema.validationHint, unit: schema.unit });
}

/**
 * Admit a prepared value through the one settings admission (write-admission.ts),
 * without ever giving a callback our stored value. With `context.config` the
 * rules across settings and the stricter-project-value hold apply too, so a
 * prepared change is refused for exactly what a direct set is refused for.
 */
export function normalizePreparedValue(key: ConfigKey, schema: Omit<ConfigSetting, 'key'>, value: unknown, context: SettingAdmissionContext = {}): unknown {
  let admission: ReturnType<typeof admitSettingValue>;
  try { admission = admitSettingValue(key, schema, value, context); }
  catch { admission = { ok: false, reason: 'rejected by its schema' }; }
  // Never include the proposed value or a borrowed validator error in a refusal.
  if (!admission.ok) throw new ConfigError(`Invalid prepared value for setting ${key}.`);
  return freezePreparedData(admission.value);
}
