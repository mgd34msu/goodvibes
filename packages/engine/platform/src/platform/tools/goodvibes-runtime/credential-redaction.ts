/**
 * credential-redaction.ts, what the goodvibes runtime tools may show of a
 * config value.
 *
 * A value is redacted when its KEY holds a credential or the VALUE itself is
 * credential material:
 *   - A schema key holds a credential when the declared list names it
 *     (config/secret-bearing-config-keys.ts). Every schema key the list does
 *     not name was read through `config.credential-key` at commit time, and
 *     the pre-commit credential-scope check refuses one that reads as a
 *     credential undeclared, so for a schema key the list already carries the
 *     reading. Any other key (a path inside a status object) is read now
 *     through `holdsCredential`, the same battery.
 *   - Declared structured reference arrays are shown only after their exact
 *     parser detaches them; malformed arrays are masked as a whole.
 *   - A string value under a key that is not a credential is read by Jev
 *     (`engine.tools.credential-value`) and shown only on a no that acts. Not
 *     read: an empty value, a `goodvibes://` reference (it names a stored
 *     secret rather than holding one), and any value the schema already
 *     fixes: the default, one of the setting's `enumValues`, or a value of a
 *     boolean or number setting (fixed text in config/schema*.ts, the same on
 *     every install).
 * A reading that is unsure, late or unavailable redacts that one row with
 * `source: 'reading-unavailable'`; the listing still completes.
 */
import { createHash } from 'node:crypto';
import { snapshotJudgmentInput, captureOwnedJson } from '../../gate/judgment-input.js';
import { CONFIG_SCHEMA, isValidConfigKey, type ConfigSetting } from '../../config/schema.js';
import { configKeyDescription, holdsCredential } from '../../config/credential-key-reading.js';
import { isSecretBearingConfigKey } from '../../config/secret-bearing-config-keys.js';
import { isStructuredCredentialReferenceConfigKey, captureStructuredCredentialReferenceConfigValue } from '../../config/structured-credential-config.js';
import { credentialValue, credentialValueState } from '../batteries/credential-value.js';
import { judge } from '../../runtime/judge.js';
import { redactSensitiveData } from '../../utils/redaction.js';

const KEY_SITE = 'tools.goodvibes-runtime.credential-key';
const VALUE_SITE = 'tools.goodvibes-runtime.credential-value';

const SECRET_REFERENCE_SCHEME = 'goodvibes://';

/** Whether a config key holds credential material. */
export async function isCredentialConfigKey(key: string): Promise<boolean> {
  if (isValidConfigKey(key)) return isSecretBearingConfigKey(key);
  return holdsCredential(key, configKeyDescription(key), KEY_SITE);
}

type ValueReading = 'shown' | 'redacted' | 'reading-unavailable';

/**
 * Whether a stored value is shown as it is: only a no that acts clears it.
 * Settled answers are kept for the process, keyed by the key and a hash of
 * the value, so a full config dump asks once per distinct value and no raw
 * value is held as a cache key.
 */
async function readValue(key: string, value: string): Promise<ValueReading> {
  let state: ReturnType<typeof credentialValueState>;
  // A value the input check refuses to send is credential material by that check.
  try { state = credentialValueState(key, configKeyDescription(key), value); } catch { return 'redacted'; }
  const { value: reading } = await judge<typeof credentialValue.items, ValueReading>({
    site: VALUE_SITE,
    battery: credentialValue,
    state,
    cache: { key: `${key}\u0000${createHash('sha256').update(value).digest('hex')}`, scope: 'process' },
    settle: ({ credential_material: reading }) => reading.outcome !== 'act' || reading.verdict === 'uncertain'
      ? undefined : reading.verdict === 'no' ? 'shown' : 'redacted',
    // With decision models off the local credential patterns decide; otherwise an answer that did not come is not a no.
    fallback: (why) => why === 'off' ? (redactSensitiveData(value) === value ? 'shown' : 'redacted') : why === 'unsure' ? 'redacted' : 'reading-unavailable',
    describe: (reading) => reading,
  });
  return reading;
}

function redacted(value: unknown, source?: 'reading-unavailable'): Record<string, unknown> {
  if (value === null || value === undefined || value === '') return { redacted: true, configured: false };
  return {
    redacted: true,
    configured: true,
    source: source ?? (typeof value === 'string' && value.startsWith(SECRET_REFERENCE_SCHEME) ? 'goodvibes-secret-ref' : 'credential-like-value'),
  };
}

let settingsByKey: ReadonlyMap<string, ConfigSetting> | undefined;
function schemaSetting(key: string): ConfigSetting | undefined {
  settingsByKey ??= new Map(CONFIG_SCHEMA.map((setting) => [setting.key, setting]));
  return settingsByKey.get(key);
}

/** A value the schema itself fixes (its default, one of its enum values, or a non-text setting) is not credential material. */
function fixedBySchema(key: string, value: string, schemaDefault: unknown): boolean {
  if (schemaDefault !== undefined && value === schemaDefault) return true;
  const setting = schemaSetting(key);
  if (setting === undefined) return false;
  return value === setting.default || setting.enumValues?.includes(value) === true || setting.type === 'boolean' || setting.type === 'number';
}

/**
 * The value as the tools may show it.
 *
 * @param key - The dotted config key the value is stored under.
 * @param value - The stored value.
 * @param schemaDefault - The key's default when the caller holds a schema the static one does not; a value equal to it is not read.
 */
export async function redactConfigValue(key: string, value: unknown, schemaDefault?: unknown): Promise<unknown> {
  if (isStructuredCredentialReferenceConfigKey(key)) {
    try { return captureStructuredCredentialReferenceConfigValue(key, value); }
    catch { return redacted(value); }
  }
  // Known private material is masked locally before asking even about its key.
  // Detach objects before an awaited reading can yield to their owner.
  try { value = snapshotJudgmentInput(value); snapshotJudgmentInput(key); }
  catch { return redacted(value); }
  if (await isCredentialConfigKey(key)) return redacted(value);
  if (value && typeof value === 'object') return redactObjectByPath(key, value);
  if (typeof value !== 'string' || value.trim() === '' || value.trim().startsWith(SECRET_REFERENCE_SCHEME)) return value;
  if (fixedBySchema(key, value, schemaDefault)) return value;
  const reading = await readValue(key, value);
  return reading === 'shown' ? value : redacted(value, reading === 'reading-unavailable' ? 'reading-unavailable' : undefined);
}

/** Every leaf of a nested object, each redacted under its dotted path below `prefix`. */
export async function redactObjectByPath(prefix: string, value: unknown): Promise<unknown> {
  if (isStructuredCredentialReferenceConfigKey(prefix)) return redactConfigValue(prefix, value);
  if (!value || typeof value !== 'object') return value;
  try { value = captureOwnedJson(value); } catch { return redacted(value); }
  // Each element is redacted as a value of its own path, so a string entry gets the same key and reading checks as any value.
  if (Array.isArray(value)) return Promise.all(value.map((entry, index) => redactConfigValue(`${prefix}.${index}`, entry)));
  const entries = await Promise.all(
    Object.entries(value as Record<string, unknown>).map(async ([key, entry]) => [key, await redactConfigValue(`${prefix}.${key}`, entry)] as const),
  );
  return Object.fromEntries(entries);
}
