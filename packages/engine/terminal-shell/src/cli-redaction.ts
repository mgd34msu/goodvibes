/**
 * cli-redaction.ts, masking credential-bearing values out of anything a
 * front-end writes to a file a person might hand to someone else (a support
 * bundle, a diagnostic dump, a config snapshot).
 *
 * Filing a credential in the right store buys nothing if the diagnostic dump
 * then prints it. Which config paths hold credentials:
 *
 *  - a key of the platform's config schema is answered by the platform's own
 *    declaration (SECRET_BEARING_CONFIG_PATHS), and so is every list element
 *    or leaf under one whose value passes that setting's own validator: the
 *    schema then says what each part is, so no reading is needed. A value the
 *    validator refuses holds something the schema did not declare, and its
 *    parts are read like any undeclared path;
 *  - any other path (a provider's key, an env map under an MCP server, a
 *    header map, payment card fields) is read by Jev with the
 *    `config.credential-key` reading, from the path and never the value, once
 *    per path with list indices folded together, and its value is kept in the
 *    clear only on a confident no.
 *
 * The tree is captured once. Classification and masking work on that detached
 * copy, so nothing between the capture and the result needs re-checking; the
 * result's `assertCurrent` is the one source check, for the caller to run
 * immediately before it publishes.
 */
import {
  CONFIG_SCHEMA,
  captureStructuredCredentialReferenceConfigValue,
  isStructuredCredentialReferenceConfigKey,
  isDeclaredSecretBearingConfigKey,
  readCredentialKey,
} from '@goodvibes-jev/engine/platform/platform/config';
import { mapLimit } from '@goodvibes-jev/judgment';
import type { JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { decisionOrClassic } from '@goodvibes-jev/engine/platform/platform/runtime/decision-policy';
import { captureOwnedJson, retainStrictJudgmentJson } from '@goodvibes-jev/engine/platform/platform/gate';
import { redactSensitiveDataAsync, redactStructuredDataAsync } from '@goodvibes-jev/engine/platform/platform/utils';
import { supportBundleFields } from './support-bundle-fields.js';

export const REDACTED_VALUE = '<redacted>';

/** The decision site the config path reading is logged under. */
export const CONFIG_PATH_CREDENTIAL_SITE = 'terminal-shell.redaction.config-path';

/** How many path readings run at once. */
const PATH_READING_CONCURRENCY = 8;

const SCHEMA_KEYS: ReadonlySet<string> = new Set(CONFIG_SCHEMA.map((setting) => setting.key));
const SCHEMA_VALIDATORS: ReadonlyMap<string, (value: unknown) => boolean> = new Map(
  CONFIG_SCHEMA.flatMap((setting) => (setting.validate ? [[setting.key, setting.validate] as const] : [])),
);

/** Whether a setting's value has the shape its schema declares, so the declaration covers every part of it. */
function holdsDeclaredShape(key: string, value: unknown): boolean {
  const validate = SCHEMA_VALIDATORS.get(key);
  if (!validate) return false;
  try { return validate(value); } catch { return false; }
}

/**
 * The schema key whose declaration answers for a path: the key itself, or the
 * setting it sits under when that setting's value has its declared shape
 * (`shaped`, filled while walking the tree). Undefined means the path is read.
 */
function declaredSetting(path: string, shaped: ReadonlySet<string> = new Set()): string | undefined {
  if (SCHEMA_KEYS.has(path)) return path;
  for (let end = path.lastIndexOf('.'); end > 0; end = path.lastIndexOf('.', end - 1)) {
    const prefix = path.slice(0, end);
    if (SCHEMA_KEYS.has(prefix)) return shaped.has(prefix) ? prefix : undefined;
  }
  return undefined;
}

/** The path a reading is asked about: list indices fold together, so one reading covers every element of a list. */
function readingPath(path: string): string {
  return path.split('.').filter((segment) => !/^\d+$/.test(segment)).join('.');
}

/** Unknown config paths keep values private unless a reading confidently excludes credentials. */
export async function isSensitiveConfigPath(path: string, options: JudgmentReadingOptions = {}): Promise<boolean> {
  if (isStructuredCredentialReferenceConfigKey(path)) return true;
  const setting = declaredSetting(path);
  if (setting !== undefined) return isDeclaredSecretBearingConfigKey(setting);
  return decisionOrClassic(async () => {
    const reading = await readCredentialKey({ key: readingPath(path), description: '' }, CONFIG_PATH_CREDENTIAL_SITE, options);
    return !(reading.verdict === 'no' && reading.outcome === 'act');
  }, () => true);
}

function captureConfig(config: unknown, options: JudgmentReadingOptions) {
  // Raw values stay local. This structural capture does not authorize transmission.
  const retained = retainStrictJudgmentJson(config);
  const callerCurrent = options.assertCurrent;
  const assertCurrent = (): void => {
    options.signal?.throwIfAborted();
    retained.assertCurrent();
    callerCurrent?.();
  };
  return { snapshot: retained.snapshot, assertCurrent };
}

// Redaction rule for sensitive config paths:
// - Non-string values: redact if truthy (i.e. non-null, non-undefined, non-zero, non-false).
//   Rationale: zero and false are never meaningful secrets; null/undefined mean absent.
// - String values: redact non-empty strings that are not goodvibes:// secret refs.
//   Rationale: empty string means unset; secret refs are safe placeholders, not raw values.
function holdsValue(value: unknown): boolean {
  if (typeof value !== 'string') return value !== null && value !== undefined && Boolean(value);
  if (value.trim().length === 0) return false;
  return !value.startsWith('goodvibes://secrets/');
}

function structuredReferenceValue(path: string, value: unknown): boolean {
  try { captureStructuredCredentialReferenceConfigValue(path, value); return true; }
  catch { return false; }
}

/** Every path in the tree whose value would be masked if the path is sensitive, with that value; `shaped` collects the settings whose value has its declared shape. */
function valuePaths(value: unknown, path: string, out: Map<string, unknown>, shaped: Set<string>): void {
  if (SCHEMA_KEYS.has(path) && value !== null && typeof value === 'object' && holdsDeclaredShape(path, value)) shaped.add(path);
  if (isStructuredCredentialReferenceConfigKey(path)) {
    if (!structuredReferenceValue(path, value)) out.set(path, value);
    return;
  }
  // Namespace objects are structural paths, not credentials containing every
  // public setting below them. Declared object-valued settings still own their
  // complete value; unknown containers have every descendant leaf screened.
  const container = value !== null && typeof value === 'object';
  if (path && holdsValue(value) && (!container || SCHEMA_KEYS.has(path))) out.set(path, value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => valuePaths(item, `${path}.${index}`, out, shaped));
  } else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) valuePaths(nested, path ? `${path}.${key}` : key, out, shaped);
  }
}

/** The sensitive paths of a config tree: declared paths by lookup, each distinct undeclared path read once. */
async function sensitivePaths(candidates: ReadonlyMap<string, unknown>, shaped: ReadonlySet<string>, options: JudgmentReadingOptions): Promise<ReadonlySet<string>> {
  const paths = [...candidates.keys()];
  const verdicts = new Map<string, boolean>();
  const unread = new Set<string>();
  for (const path of paths) {
    if (isStructuredCredentialReferenceConfigKey(path)) continue;
    const setting = declaredSetting(path, shaped);
    if (setting === undefined) unread.add(readingPath(path));
  }
  // Readings are not effects; only the abort signal reaches them. The source check belongs to the publisher.
  const readingOptions: JudgmentReadingOptions = options.signal ? { signal: options.signal } : {};
  const keys = [...unread];
  const read = await mapLimit(keys, PATH_READING_CONCURRENCY, (key) => isSensitiveConfigPath(key, readingOptions));
  keys.forEach((key, index) => verdicts.set(key, read[index] === true));
  return new Set(paths.filter((path) => {
    if (isStructuredCredentialReferenceConfigKey(path)) return true;
    const setting = declaredSetting(path, shaped);
    return setting !== undefined ? isDeclaredSecretBearingConfigKey(setting) : verdicts.get(readingPath(path)) === true;
  }));
}

function redactUnknown(value: unknown, path: string, sensitive: ReadonlySet<string>, redactedPaths: string[]): unknown {
  if (sensitive.has(path)) {
    redactedPaths.push(path);
    return REDACTED_VALUE;
  }
  if (isStructuredCredentialReferenceConfigKey(path)) return captureStructuredCredentialReferenceConfigValue(path, value);
  if (Array.isArray(value)) {
    return value.map((item, index) => redactUnknown(item, `${path}.${index}`, sensitive, redactedPaths));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      Object.defineProperty(result, key, { value: redactUnknown(nested, path ? `${path}.${key}` : key, sensitive, redactedPaths), enumerable: true });
    }
    return result;
  }
  return value;
}

export function isRedactedValue(value: unknown): boolean {
  return value === REDACTED_VALUE || value === '[REDACTED]' || value === '[REDACTED_PROFILE]' || value === '[REDACTED_TEXT]';
}

export interface RedactedConfigResult {
  readonly value: unknown;
  readonly redactedPaths: readonly string[];
  readonly assertCurrent: () => void;
}

export interface PreparedConfigRedaction extends RedactedConfigResult {
  /** Local masking inputs; never publish these values. */
  readonly sensitiveValues: readonly string[];
}

function sensitiveValues(candidates: ReadonlyMap<string, unknown>, sensitive: ReadonlySet<string>): readonly string[] {
  // A sensitive container's strings are all masked with it; collect them too.
  const values: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  for (const [path, value] of candidates) if (sensitive.has(path) && !isStructuredCredentialReferenceConfigKey(path)) collect(value);
  return [...new Set(values.filter((value) => holdsValue(value)))].sort((left, right) => right.length - left.length);
}

/** Classify one retained config once for its masked output and local secret sweeps. */
export async function prepareConfigRedaction(config: unknown, options: JudgmentReadingOptions = {}): Promise<PreparedConfigRedaction> {
  const source = captureConfig(config, options);
  const candidates = new Map<string, unknown>();
  const shaped = new Set<string>();
  valuePaths(source.snapshot, '', candidates, shaped);
  const sensitive = await sensitivePaths(candidates, shaped, options);
  const redactedPaths: string[] = [];
  const value = redactUnknown(source.snapshot, '', sensitive, redactedPaths);
  return { value, redactedPaths, sensitiveValues: sensitiveValues(candidates, sensitive), assertCurrent: source.assertCurrent };
}

export async function redactConfig(config: unknown, options: JudgmentReadingOptions = {}): Promise<RedactedConfigResult> {
  const prepared = await prepareConfigRedaction(config, options);
  return { value: prepared.value, redactedPaths: prepared.redactedPaths, assertCurrent: prepared.assertCurrent };
}

export function redactText(input: string, options: JudgmentReadingOptions = {}): Promise<string> {
  return redactSensitiveDataAsync(input, options);
}

export async function collectSensitiveConfigValues(config: unknown, options: JudgmentReadingOptions = {}): Promise<readonly string[]> {
  return (await prepareConfigRedaction(config, options)).sensitiveValues;
}

export async function redactSerializedSecrets(serialized: string, secretValues: readonly string[], options: JudgmentReadingOptions = {}): Promise<string> {
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); }
  catch { return redactSensitiveDataAsync(serialized, { ...options, secretValues }); }
  // Mask the parsed values and keys, never JSON punctuation. A protected value
  // such as "[]" or "{}" can also be native JSON syntax; rewriting serialized
  // bytes first can destroy the envelope and collapse all diagnostics to text.
  // This parse belongs solely to this export. Keep a native immutable snapshot
  // while the caller's owner continues to fence configuration and publication.
  const protectedValue = await redactStructuredDataAsync(captureOwnedJson(parsed), {
    ...options, secretValues, declaredFields: supportBundleFields(),
  });
  const result = JSON.stringify(protectedValue, null, 2);
  if (result === undefined) throw new Error('Redacted bundle is not JSON.');
  return result;
}
