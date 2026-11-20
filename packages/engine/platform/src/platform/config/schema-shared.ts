import { isAcceptableReasoningEffortSetting } from './reasoning-effort-setting.js';
import type { ConfigKey } from './schema-types.js';
import type { ConfigValue } from './schema-types-values.js';

/**
 * One settings row: its key is a ConfigKey (a leaf of GoodVibesConfig), so a
 * row for a key that does not exist is a compile error. A row states no
 * default: the domain's defaults object is the one owner of every default,
 * and `defineSettingsDomain` (schema-types.ts) reads each row's default from
 * it by the row's key, so the row, `/settings`, the web UI's settings data,
 * the docs and the loaded value cannot disagree.
 */
export type ConfigSettingDefinition = { [K in ConfigKey]: ConfigSettingFields & { key: K; default?: never } }[ConfigKey];
/** The default a row gets, read from its domain's defaults object. */
export type ConfigSettingDefault<K extends ConfigKey> = ConfigValue<K>;

/** What a settings row says besides its key and default. */
export interface ConfigSettingFields {
  type: 'boolean' | 'number' | 'string' | 'enum';
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
  /**
   * What a port number addresses. `'listen-port'` is a port this machine binds,
   * which belongs to the machine and never replicates to cluster peers;
   * `'remote-port'` is another server's port (a mail server), which travels
   * with the host it pairs with. Set by `port()` and `remotePort()`.
   */
  role?: 'listen-port' | 'remote-port' | undefined;
}

/**
 * What the program knows about a config key without asking anyone: who owns
 * it, whether a repository's project file may set it, whether its value is a
 * credential or card material, and whether a change to it loosens security.
 * `configKeyFacts(key)` (config-key-facts.ts) answers it from declarations;
 * every consumer reads these fields instead of keeping its own key list or
 * asking a model about a key's name or value.
 */
export interface ConfigKeyFacts {
  /** The runtime that owns, and therefore writes, the key (config-ownership.ts). */
  readonly owner: 'daemon' | 'client' | 'user';
  /** False when a project settings file, which is repository content, may not set the key at all. */
  readonly projectSettable: boolean;
  /** The value is credential material: a settings file holds only a `goodvibes://secrets/…` reference to it. */
  readonly secret: boolean;
  /** The value is payment card material: it is kept only in the daemon's card store, never in a settings file. */
  readonly cardMaterial: boolean;
  /** The key has a row in the config schema. A key without one is unknown to the program. */
  readonly inSchema: boolean;
  /**
   * Present on a key a change can loosen security through: true when going
   * from `prev` to `next` does. Where the direction cannot be told from the
   * values (a host, a policy source), any change counts as loosening.
   */
  readonly loosens?: (prev: unknown, next: unknown) => boolean;
  /** What a loosening change does, as a verb phrase ("turn the sandbox off") a refusal or an owner question can use. */
  readonly loosening?: string;
}

/**
 * Returns validate + validationHint for `provider.reasoningEffort`.
 *
 * Not an enum: which reasoning levels exist is per model, and the former
 * four-value list rejected `none`, `minimal`, `xhigh` and `max`. The stored
 * preference remains valid when a serving model temporarily offers fewer levels;
 * the model's request adapter resolves the effective level separately.
 */
export function reasoningEffortSetting(): Pick<ConfigSettingFields, 'validate' | 'validationHint'> {
  return {
    validate: isAcceptableReasoningEffortSetting,
    validationHint: 'a known reasoning effort level, run /effort for the current model choices',
  };
}

/** Returns validate + validationHint for an integer in [min, max]. */
export function intRange(
  min: number,
  max: number,
): Pick<ConfigSettingFields, 'validate' | 'validationHint'> {
  return {
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max,
    validationHint: `integer in [${min}, ${max}]`,
  };
}

/** Returns validate + validationHint for a float in [min, max]. */
export function numRange(
  min: number,
  max: number,
): Pick<ConfigSettingFields, 'validate' | 'validationHint'> {
  return {
    validate: (v) => typeof v === 'number' && v >= min && v <= max,
    validationHint: `number in [${min}, ${max}]`,
  };
}

/** An optional owner-configured work limit; zero disables it. */
export function optionalWorkLimit(): Pick<ConfigSettingFields, 'validate' | 'validationHint'> {
  return {
    validate: (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    validationHint: 'non-negative safe integer; 0 means unlimited',
  };
}

const PORT_VALIDATION_HINT = 'integer port in [1, 65535]';
const isPortNumber = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535;

/** A TCP port this machine listens on (integer in [1, 65535]); never replicated to cluster peers. */
export function port(): Pick<ConfigSettingFields, 'validate' | 'validationHint' | 'role'> {
  return { validate: isPortNumber, validationHint: PORT_VALIDATION_HINT, role: 'listen-port' };
}

/** A TCP port of a remote server this machine connects to (integer in [1, 65535]). */
export function remotePort(): Pick<ConfigSettingFields, 'validate' | 'validationHint' | 'role'> {
  return { validate: isPortNumber, validationHint: PORT_VALIDATION_HINT, role: 'remote-port' };
}
