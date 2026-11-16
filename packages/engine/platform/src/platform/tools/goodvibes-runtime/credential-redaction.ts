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
 *   - A string value under a key that is not a credential is decided here, in
 *     code, and never leaves the process: it is shown only when the local
 *     credential patterns leave it alone AND its shape cannot be a secret (a
 *     number, date or time; a name such as a model id, host name or on/off
 *     word; a file path; a URL with no user, password, query or fragment),
 *     with no part that looks generated. Everything else is masked with
 *     `source: 'unrecognised-shape'`; the owner reads it in the config file
 *     or the settings screen. Not checked: an empty value, a `goodvibes://`
 *     reference (it names a stored secret rather than holding one), and any
 *     value the schema already fixes: the default, one of the setting's
 *     `enumValues`, or a value of a boolean or number setting (fixed text in
 *     config/schema*.ts, the same on every install).
 */
import { snapshotJudgmentInput, captureOwnedJson } from '../../gate/judgment-input.js';
import { CONFIG_SCHEMA, isValidConfigKey, type ConfigSetting } from '../../config/schema.js';
import { configKeyDescription, holdsCredential } from '../../config/credential-key-reading.js';
import { isSecretBearingConfigKey } from '../../config/secret-bearing-config-keys.js';
import { isStructuredCredentialReferenceConfigKey, captureStructuredCredentialReferenceConfigValue } from '../../config/structured-credential-config.js';
import { redactSensitiveData } from '../../utils/redaction.js';

const KEY_SITE = 'tools.goodvibes-runtime.credential-key';

const SECRET_REFERENCE_SCHEME = 'goodvibes://';

/** Whether a config key holds credential material. */
export async function isCredentialConfigKey(key: string): Promise<boolean> {
  if (isValidConfigKey(key)) return isSecretBearingConfigKey(key);
  return holdsCredential(key, configKeyDescription(key), KEY_SITE);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a word looks generated rather than named: a UUID, or a run of
 * twelve or more characters between separators that mixes letters with
 * digits, mixes cases heavily, or is 24 or more letters long.
 */
function looksGenerated(word: string): boolean {
  if (UUID.test(word)) return true;
  return word.split(/[._+~ ()-]/).some((part) => {
    if (part.length < 12) return false;
    const digits = part.replace(/[^0-9]/g, '').length;
    if (digits === part.length) return false;
    if (digits > 0) return true;
    const upper = part.replace(/[^A-Z]/g, '').length;
    return part.length >= 24 || (upper >= 4 && part.length - upper >= 4);
  });
}

const NUMBER_LIKE = /^[0-9][0-9\s:*/,.+%-]*[A-Za-z]{0,3}$/;
const NAME_PART = '[A-Za-z0-9][A-Za-z0-9._+-]*';
const NAME = new RegExp(`^${NAME_PART}(?:[/:]${NAME_PART}){0,7}$`);
const PATH = /^(?:~|\.{1,2}|[A-Za-z]:)?[/\\][A-Za-z0-9._+~ ()/\\-]*$/;
const URL_START = /^[a-z][a-z0-9+.-]*:\/\//i;
const MAX_SHOWN_LENGTH = 1024;

const namedParts = (text: string, separator: RegExp): boolean => text.split(separator).every((part) => !looksGenerated(part));

/**
 * Whether a stored value has a shape that cannot be a secret: a number, date,
 * time or interval; a name (a model id, host name with an optional port, or a
 * word such as on/off); a file path; or a URL with no user, password, query
 * or fragment. A value with a part that looks generated is none of these.
 * Decided from the text alone; nothing is sent anywhere.
 */
export function valueShapeCannotBeSecret(value: string): boolean {
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_SHOWN_LENGTH) return false;
  if (NUMBER_LIKE.test(text)) return true;
  if (NAME.test(text)) return namedParts(text, /[/:]/);
  if (PATH.test(text)) return namedParts(text, /[/\\]/);
  if (!URL_START.test(text) || /[\s?#@]/.test(text)) return false;
  let url: URL;
  try { url = new URL(text); } catch { return false; }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return false;
  const rest = text.slice(text.indexOf('://') + 3);
  return /^[A-Za-z0-9._+~:/[\]-]*$/.test(rest) && namedParts(rest, /[/:]/);
}

const MASKED_NEXT = 'Not shown here because it could be a secret. The owner can read it in the config file or the settings screen; a value that must stay private belongs in a credential setting.';

function redacted(value: unknown, source?: 'unrecognised-shape'): Record<string, unknown> {
  if (value === null || value === undefined || value === '') return { redacted: true, configured: false };
  return {
    redacted: true,
    configured: true,
    source: source ?? (typeof value === 'string' && value.startsWith(SECRET_REFERENCE_SCHEME) ? 'goodvibes-secret-ref' : 'credential-like-value'),
    ...(source === 'unrecognised-shape' ? { next: MASKED_NEXT } : {}),
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
  // Known private material is masked locally before the key is read.
  // Detach objects before an awaited reading can yield to their owner.
  try { value = snapshotJudgmentInput(value); snapshotJudgmentInput(key); }
  catch { return redacted(value); }
  if (await isCredentialConfigKey(key)) return redacted(value);
  if (value && typeof value === 'object') return redactObjectByPath(key, value);
  if (typeof value !== 'string' || value.trim() === '' || value.trim().startsWith(SECRET_REFERENCE_SCHEME)) return value;
  if (fixedBySchema(key, value, schemaDefault)) return value;
  if (redactSensitiveData(value) !== value) return redacted(value);
  return valueShapeCannotBeSecret(value) ? value : redacted(value, 'unrecognised-shape');
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
