import { isAcceptableReasoningEffortSetting } from './reasoning-effort-setting.js';
/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

export interface ConfigSettingDefinition {
  key: string;
  type: 'boolean' | 'number' | 'string' | 'enum';
  default: unknown;
  description: string;
  /** Retained for saved-config compatibility, excluded from current settings controls. */
  deprecated?: boolean;
  enumValues?: string[] | undefined;
  validate?: ((value: unknown) => boolean) | undefined;
  /**
   * Optional hint appended to the validation-failure message when `validate`
   * returns false. Use to tell callers the accepted range or format,
   * e.g. `'finite number in [0.25, 4.0]'`.
   */
  validationHint?: string | undefined;
  /**
   * What kind of quantity the number is, when knowing that changes how a value
   * is read or shown.
   *
   * `'money'` marks a key holding an amount of `payments.currency`, written the
   * way a person says it. It exists so a surface (a settings screen, a set
   * command, a formatter) can ask the SCHEMA what a key holds instead of
   * pattern-matching the key's NAME, the old keys were detected by a suffix on
   * the name, which is exactly what tied every consumer to a naming scheme and
   * broke them all when the names changed.
   */
  unit?: 'money' | undefined;
}

/**
 * Returns validate + validationHint for `provider.reasoningEffort`.
 *
 * Not an enum: which reasoning levels exist is per model, and the former
 * four-value list rejected `none`, `minimal`, `xhigh` and `max`. The stored
 * preference remains valid when a serving model temporarily offers fewer levels;
 * the model's request adapter resolves the effective level separately.
 */
export function reasoningEffortSetting(): Pick<ConfigSettingDefinition, 'validate' | 'validationHint'> {
  return {
    validate: isAcceptableReasoningEffortSetting,
    validationHint: 'a known reasoning effort level, run /effort for the current model choices',
  };
}

/** Returns validate + validationHint for an integer in [min, max]. */
export function intRange(
  min: number,
  max: number,
): Pick<ConfigSettingDefinition, 'validate' | 'validationHint'> {
  return {
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max,
    validationHint: `integer in [${min}, ${max}]`,
  };
}

/** Returns validate + validationHint for a float in [min, max]. */
export function numRange(
  min: number,
  max: number,
): Pick<ConfigSettingDefinition, 'validate' | 'validationHint'> {
  return {
    validate: (v) => typeof v === 'number' && v >= min && v <= max,
    validationHint: `number in [${min}, ${max}]`,
  };
}

/** An optional owner-configured work limit; zero disables it. */
export function optionalWorkLimit(): Pick<ConfigSettingDefinition, 'validate' | 'validationHint'> {
  return {
    validate: (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    validationHint: 'non-negative safe integer; 0 means unlimited',
  };
}

/** Returns validate + validationHint for a TCP port (integer in [1, 65535]). */
/**
 * The hint every port setting carries.
 *
 * Exported because it is the only structural mark a port has: cluster config
 * replication reads it to refuse to replicate ANY port, and a shared constant
 * is what keeps that refusal true when a new port setting is added.
 */
export const PORT_VALIDATION_HINT = 'integer port in [1, 65535]';

export function port(): Pick<ConfigSettingDefinition, 'validate' | 'validationHint'> {
  return {
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535,
    validationHint: PORT_VALIDATION_HINT,
  };
}
