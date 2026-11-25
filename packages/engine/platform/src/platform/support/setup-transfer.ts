/**
 * setup-transfer.ts, a program's setup as files for someone else: the support
 * folder (the setup review, the platform facts, the services and hooks files,
 * the remote runners) and the transfer file that carries the setup to another
 * computer. Written, read and brought in by the daemon (capabilities/builtin/
 * system-bundles.ts, `startup.*`); moved here from the terminal app's
 * local-setup-review.ts and local-setup-transfer.ts. A literal credential never
 * leaves: a setting that holds one stays behind, a file entry that holds one is
 * masked, and a secret-store reference travels as it is.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ConfigManager } from '../config/manager.js';
import type { ConfigKey } from '../config/schema-types.js';
import { CONFIG_KEYS, CONFIG_SCHEMA } from '../config/schema.js';
import { configKeyFacts, isProtectedConfigValue } from '../config/config-key-facts.js';
import { isSecretReferenceValue } from '../config/secret-bearing-config-keys.js';
import { redactDiagnosticValue } from '../utils/redaction.js';
import { securityRelevantSetting } from './support-bundle.js';

/** What a masked literal credential reads as in an exported file. */
export const MASKED_VALUE = '[REDACTED]';

/**
 * A copy of `value` with every literal credential replaced by {@link MASKED_VALUE},
 * decided leaf by leaf by the shared redaction rule (field name and value
 * class). A `goodvibes://secrets/...` reference is not a credential and travels
 * as it is. `masked` collects the path of every value that was masked.
 */
export function maskLiteralSecrets(value: unknown, masked: string[], path = '', key = 'value'): unknown {
  if (typeof value === 'string') {
    if (value.length === 0 || isSecretReferenceValue(value)) return value;
    const shown = (redactDiagnosticValue({ [key]: value }) as Record<string, unknown>)[key];
    if (shown === value) return value;
    masked.push(path || key);
    return MASKED_VALUE;
  }
  if (Array.isArray(value)) return value.map((entry, index) => maskLiteralSecrets(entry, masked, `${path}[${index}]`, key));
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value)) {
      copy[childKey] = maskLiteralSecrets(child, masked, path ? `${path}.${childKey}` : childKey, childKey);
    }
    return copy;
  }
  return value;
}

/** True when an exported part holds a value masked at export, so importing it would write the mask. */
function holdsMaskedValue(value: unknown): boolean {
  if (typeof value === 'string') return value === MASKED_VALUE;
  if (Array.isArray(value)) return value.some(holdsMaskedValue);
  if (value !== null && typeof value === 'object') return Object.values(value).some(holdsMaskedValue);
  return false;
}

/** One setup check: `warn` and `fail` are issues; `pass` and `info` (an optional feature not in use) are not. */
export interface SetupCheck {
  readonly severity: 'pass' | 'info' | 'warn' | 'fail';
  readonly area: string;
  readonly message: string;
}

/**
 * A program's setup as the daemon reads it: the models it can reach, the services and sign-ins, the skills, plugins,
 * tool servers and hooks of the project, the daemon's remote runners and the sandbox, with every check. A review a
 * terminal program wrote at 3.5.0 named its session (`sessionId`); the daemon's names the program (`program`).
 */
export interface SetupReview {
  readonly program?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly providerCount: number;
  readonly serviceCount: number;
  readonly oauthProviderCount: number;
  readonly builtinSubscriptionProviderCount: number;
  readonly activeSubscriptionCount: number;
  readonly pendingSubscriptionCount: number;
  readonly serviceIssues: readonly string[];
  readonly skillCount: number;
  readonly pluginCount: number;
  readonly quarantinedPluginCount: number;
  readonly pluginDirectories: readonly string[];
  readonly managedHookCount: number;
  readonly managedHookChainCount: number;
  readonly mcpServerCount: number;
  readonly quarantinedMcpCount: number;
  readonly elevatedMcpCount: number;
  readonly remoteRunnerCount: number;
  readonly remoteRunnersUnreadable?: string | undefined;
  readonly remoteRunners: readonly unknown[];
  readonly sandboxMcpIsolation: string;
  readonly sandboxSecureModeReady: boolean;
  readonly checks: readonly SetupCheck[];
  readonly issues: readonly SetupCheck[];
  readonly services: readonly string[];
}

export function isSetupIssue(check: SetupCheck): boolean {
  return check.severity === 'warn' || check.severity === 'fail';
}

// ---------------------------------------------------------------------------
// The transfer file
// ---------------------------------------------------------------------------

export interface SetupTransferBundle {
  readonly schemaVersion: 'v1';
  readonly exportedAt: number;
  readonly startupReview: SetupReview;
  readonly config: Record<string, unknown>;
  readonly services?: Record<string, unknown> | undefined;
  readonly ecosystem?: {
    readonly plugins?: Record<string, unknown> | undefined;
    readonly skills?: Record<string, unknown> | undefined;
  } | undefined;
  /** Where a literal credential was left out (a setting) or masked (a file entry) at export. */
  readonly redacted?: readonly string[] | undefined;
}

/** The files a transfer reads and replaces, for one program and project. */
export interface SetupTransferFiles {
  /** `~/.goodvibes/<program>/services.json`. */
  readonly services: string;
  /** `<project>/.goodvibes/<program>/ecosystem/plugins.json`. */
  readonly plugins: string;
  /** `<project>/.goodvibes/<program>/ecosystem/skills.json`. */
  readonly skills: string;
}

const countOf = (part: unknown): number => {
  const entries = part && typeof part === 'object' ? (part as { entries?: unknown }).entries : undefined;
  return Array.isArray(entries) ? entries.length : 0;
};

export function inspectSetupTransferBundle(bundle: SetupTransferBundle): string {
  const review = bundle.startupReview;
  return [
    'Setup Transfer Review',
    `  schemaVersion: ${bundle.schemaVersion}`,
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    review.sessionId ? `  session: ${review.sessionId}` : `  reviewed by: the daemon, for ${review.program === 'agent' ? 'the Agent' : 'the terminal app'}`,
    `  services: ${review.serviceCount}`,
    `  plugins: ${review.pluginCount}`,
    `  skills: ${review.skillCount}`,
    `  remote runners: ${review.remoteRunnerCount}`,
    `  config keys: ${Object.keys(bundle.config ?? {}).length}`,
    `  curated plugins: ${countOf(bundle.ecosystem?.plugins)}`,
    `  curated skills: ${countOf(bundle.ecosystem?.skills)}`,
    `  credentials left out or masked: ${bundle.redacted?.length ?? 0}${bundle.redacted && bundle.redacted.length > 0 ? ` (${bundle.redacted.slice(0, 8).join(', ')}${bundle.redacted.length > 8 ? ', ...' : ''})` : ''}`,
  ].join('\n');
}

/**
 * The setup to carry to another machine: non-default settings, the service
 * registry and the curated catalogs. A literal credential never leaves: a
 * setting that holds one is left out and a file entry that holds one is
 * masked; references to the secret store travel, so the other machine
 * resolves them from its own store.
 */
export function buildSetupTransferBundle(config: Pick<ConfigManager, 'get'>, files: SetupTransferFiles, review: SetupReview): SetupTransferBundle {
  const settings: Record<string, unknown> = {};
  const redacted: string[] = [];
  for (const entry of CONFIG_SCHEMA) {
    // The stored setting, never an owner-profile value: an exported profile value
    // would become an explicit setting on import and stop following the profile.
    let value: unknown;
    try { value = structuredClone(config.get(entry.key as ConfigKey)); }
    catch { continue; } // a key with no place in this build's settings tree does not travel
    // Only settings that differ from the default travel: an exported default would
    // become an explicit override on import and keep an old default pinned.
    if (JSON.stringify(value) === JSON.stringify(entry.default)) continue;
    // A setting that holds a literal credential stays behind whole: a masked value would be written on import.
    const protectedLiteral = isProtectedConfigValue(entry.key) && typeof value === 'string' && value.length > 0 && !isSecretReferenceValue(value);
    const masked: string[] = [];
    if (!protectedLiteral) maskLiteralSecrets(value, masked, entry.key, entry.key);
    if (protectedLiteral || masked.length > 0) {
      redacted.push(entry.key);
      continue;
    }
    settings[entry.key] = value;
  }
  const readPart = (path: string): Record<string, unknown> | undefined => (existsSync(path)
    ? maskLiteralSecrets(JSON.parse(readFileSync(path, 'utf-8')), redacted, path.slice(path.lastIndexOf('/') + 1)) as Record<string, unknown>
    : undefined);
  return {
    schemaVersion: 'v1',
    exportedAt: Date.now(),
    startupReview: review,
    config: settings,
    services: readPart(files.services),
    ecosystem: { plugins: readPart(files.plugins), skills: readPart(files.skills) },
    ...(redacted.length > 0 ? { redacted } : {}),
  };
}

export function writeSetupTransferBundle(targetPath: string, bundle: SetupTransferBundle): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
}

export interface SetupTransferChange {
  readonly key: ConfigKey;
  readonly previous: unknown;
  readonly next: unknown;
}

export type SetupTransferPlan =
  | {
      readonly ok: true;
      readonly bundle: SetupTransferBundle;
      /** Settings whose value in the bundle differs from the live one, and which bringing it in applies. */
      readonly changes: readonly SetupTransferChange[];
      /**
       * Security settings that differ, left as they are unless security settings are brought in too: the ones a
       * support bundle's load holds back (support-bundle.ts `securityRelevantSetting`: a change that loosens a
       * protection by the key's own facts, or one to where data and secrets are kept and what starts).
       */
      readonly heldBack: readonly SetupTransferChange[];
      /** Keys in the bundle this build does not know; they are not applied. */
      readonly ignoredKeys: readonly string[];
      /** Parts that hold values masked at export; the local file is kept. */
      readonly skippedParts: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check a parsed bundle completely before anything is written: the schema
 * version, the shape of every part, and every setting value against the config
 * schema. A bundle that fails any check changes nothing. Security settings are
 * held back unless `includeSecurity` asks for them too.
 */
export function planSetupTransferImport(config: Pick<ConfigManager, 'get' | 'validateDynamic'>, bundle: unknown, includeSecurity = false): SetupTransferPlan {
  if (!isPlainObject(bundle)) return { ok: false, reason: 'not a setup transfer bundle (expected a JSON object).' };
  if (bundle.schemaVersion !== 'v1') {
    return { ok: false, reason: `unsupported schemaVersion ${JSON.stringify(bundle.schemaVersion)}; this build reads "v1". Save it again from a matching release.` };
  }
  if (!isPlainObject(bundle.config)) return { ok: false, reason: 'the bundle has no "config" object.' };
  if (bundle.services !== undefined && !isPlainObject(bundle.services)) return { ok: false, reason: '"services" must be an object.' };
  if (bundle.ecosystem !== undefined) {
    if (!isPlainObject(bundle.ecosystem)) return { ok: false, reason: '"ecosystem" must be an object.' };
    for (const part of ['plugins', 'skills'] as const) {
      if (bundle.ecosystem[part] !== undefined && !isPlainObject(bundle.ecosystem[part])) return { ok: false, reason: `"ecosystem.${part}" must be an object.` };
    }
  }
  const changes: SetupTransferChange[] = [];
  const heldBack: SetupTransferChange[] = [];
  const ignoredKeys: string[] = [];
  const invalid: string[] = [];
  for (const [rawKey, next] of Object.entries(bundle.config)) {
    if (!CONFIG_KEYS.has(rawKey as ConfigKey)) { ignoredKeys.push(rawKey); continue; }
    const key = rawKey as ConfigKey;
    try {
      config.validateDynamic(key, next);
    } catch (error) {
      invalid.push(`${key} (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const previous = config.get(key);
    if (JSON.stringify(previous) === JSON.stringify(next)) continue;
    const change = { key, previous: structuredClone(previous), next: structuredClone(next) };
    (securityRelevantSetting(key, previous, next) && !includeSecurity ? heldBack : changes).push(change);
  }
  if (invalid.length > 0) return { ok: false, reason: `these settings are invalid, so nothing was imported: ${invalid.join('; ')}` };
  const typed = bundle as unknown as SetupTransferBundle;
  const skippedParts: string[] = [];
  const parts: Record<string, unknown> = { services: typed.services, 'ecosystem.plugins': typed.ecosystem?.plugins, 'ecosystem.skills': typed.ecosystem?.skills };
  const kept: Record<string, unknown> = {};
  for (const [name, part] of Object.entries(parts)) {
    if (part === undefined) continue;
    if (holdsMaskedValue(part)) skippedParts.push(name);
    else kept[name] = part;
  }
  const importable: SetupTransferBundle = {
    ...typed,
    services: kept['services'] as Record<string, unknown> | undefined,
    ecosystem: { plugins: kept['ecosystem.plugins'] as Record<string, unknown> | undefined, skills: kept['ecosystem.skills'] as Record<string, unknown> | undefined },
  };
  return { ok: true, bundle: importable, changes, heldBack, ignoredKeys, skippedParts };
}

/** The security settings a transfer holds back, each with its present and incoming value; a credential is never printed. */
export function describeHeldBackSettings(heldBack: readonly { readonly key: string; readonly previous: unknown; readonly next: unknown }[]): string[] {
  return heldBack.map((change) => {
    const loosening = configKeyFacts(change.key).loosens?.(change.previous, change.next) ? '  (loosens a protection)' : '';
    return `  ${change.key}: ${shownValue(change.key, change.previous)} now, ${shownValue(change.key, change.next)} in the file${loosening}`;
  });
}

/** The files an import replaces whole, with what goes into each. */
export function setupTransferWrites(bundle: SetupTransferBundle, files: SetupTransferFiles): readonly { readonly name: string; readonly path: string; readonly body: unknown }[] {
  return [
    ...(bundle.services ? [{ name: 'services.json', path: files.services, body: bundle.services }] : []),
    ...(bundle.ecosystem?.plugins ? [{ name: 'ecosystem/plugins.json', path: files.plugins, body: bundle.ecosystem.plugins }] : []),
    ...(bundle.ecosystem?.skills ? [{ name: 'ecosystem/skills.json', path: files.skills, body: bundle.ecosystem.skills }] : []),
  ];
}

/** A setting value as a change list shows it: a credential is never printed. */
function shownValue(key: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return '(unset)';
  if (isProtectedConfigValue(key) && !isSecretReferenceValue(value)) return '(a credential)';
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** True for a change to a key that can loosen security or holds a credential or card material. */
export function isSecurityBearingChange(change: { readonly key: string }): boolean {
  const facts = configKeyFacts(change.key);
  return facts.loosens !== undefined || facts.secret || facts.cardMaterial;
}

/**
 * The lines for the settings a transfer changes: every change to a key that can
 * loosen security or holds a credential with its old and new value, the rest by
 * name.
 */
export function describeSetupTransferChanges(changes: readonly { readonly key: string; readonly previous: unknown; readonly next: unknown }[]): string[] {
  const security = changes.filter(isSecurityBearingChange);
  const others = changes.filter((change) => !security.includes(change));
  return [
    `Settings that change: ${changes.length}.`,
    ...security.map((change) => {
      const loosening = configKeyFacts(change.key).loosens?.(change.previous, change.next) ? '  (loosens a protection)' : '';
      return `  ${change.key}: ${shownValue(change.key, change.previous)} -> ${shownValue(change.key, change.next)}${loosening}`;
    }),
    ...(others.length > 0 ? [`  ${security.length > 0 ? 'also: ' : ''}${others.slice(0, 12).map((change) => change.key).join(', ')}${others.length > 12 ? `, and ${others.length - 12} more` : ''}`] : []),
  ];
}

// ---------------------------------------------------------------------------
// The support folder
// ---------------------------------------------------------------------------

/** What a support folder holds besides the review: the platform facts, the files copied in (masked), the runners. */
export interface SupportFolderParts {
  readonly review: SetupReview;
  readonly platformReview: Record<string, unknown>;
  /** Files copied in, each masked: `[source path, name in the folder]`. */
  readonly copies: readonly (readonly [string, string])[];
  readonly remoteSummary: Record<string, unknown>;
}

/** The name of the file whose presence says a folder holds a support bundle. */
export const SUPPORT_FOLDER_MARK = 'startup-review.json';

/**
 * Write a support folder: the setup review, the platform review (install,
 * storage key names, sandbox), the services file and the hooks file (masked by
 * the shared redaction rule), and the remote runners' summary. Returns how many
 * values were masked.
 */
export function writeSupportFolder(targetDir: string, parts: SupportFolderParts): { readonly masked: number } {
  mkdirSync(targetDir, { recursive: true });
  const masked: string[] = [];
  writeFileSync(join(targetDir, SUPPORT_FOLDER_MARK), JSON.stringify(maskLiteralSecrets(parts.review, masked), null, 2) + '\n', 'utf-8');
  writeFileSync(join(targetDir, 'platform-review.json'), JSON.stringify(maskLiteralSecrets(parts.platformReview, masked, 'platform-review.json'), null, 2) + '\n', 'utf-8');
  for (const [source, name] of parts.copies) {
    if (!existsSync(source)) continue;
    const text = readFileSync(source, 'utf-8');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = { unreadable: `${name} is not valid JSON; its text is not included.` }; }
    writeFileSync(join(targetDir, name), JSON.stringify(maskLiteralSecrets(parsed, masked, name), null, 2) + '\n', 'utf-8');
  }
  writeFileSync(join(targetDir, 'remote-summary.json'), JSON.stringify(maskLiteralSecrets(parts.remoteSummary, masked, 'remote-summary.json'), null, 2) + '\n', 'utf-8');
  return { masked: masked.length };
}

const textList = (value: unknown): readonly string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

/**
 * Read back a support folder: the files it holds and, from platform-review.json,
 * the install, secure-storage, integration-helper, sandbox and link facts (key
 * names only, as written). Throws when the folder holds no platform review.
 */
export function inspectSupportFolder(targetDir: string): string {
  const reviewPath = join(targetDir, 'platform-review.json');
  if (!existsSync(reviewPath)) throw new Error(`${targetDir} holds no support bundle (no platform-review.json)`);
  const review = asRecord(JSON.parse(readFileSync(reviewPath, 'utf-8')) as unknown);
  const install = asRecord(review['install']);
  const storage = asRecord(review['storage']);
  const helpers = review['integrationHelpers'];
  const sandbox = asRecord(review['sandbox']);
  const links = review['deepLinks'];
  const indent = (text: unknown): string[] => (typeof text === 'string' && text.trim() ? text.trimEnd().split('\n').map((line) => `    ${line}`) : ['    (not recorded)']);
  const storedKeys = textList(storage['storedKeys']);
  const overridden = textList(storage['overriddenByEnv']);
  let files: string[] = [];
  try { files = readdirSync(targetDir).filter((name) => name.endsWith('.json')).sort(); } catch { files = ['platform-review.json']; }
  return [
    `Support Bundle Review: ${targetDir}`,
    `  files: ${files.join(', ')}`,
    `  install: app ${String(install['appVersion'] ?? 'unknown')}, working directory ${String(install['workingDirectory'] ?? 'unknown')}, ${String(install['profileCount'] ?? 0)} profile(s)`,
    `  secure storage: ${storedKeys.length} stored key(s)${overridden.length > 0 ? `, ${overridden.length} overridden by the environment` : ''}`,
    ...storedKeys.map((key) => `    ${key}${overridden.includes(key) ? ' (environment override)' : ''}`),
    typeof helpers === 'string'
      ? `  integration helpers: ${helpers}`
      : `  integration helpers: ${textList(asRecord(helpers)['apiFamilies']).length} API family(ies), ${textList(asRecord(helpers)['routes']).length} route(s)`,
    '  sandbox review:',
    ...indent(sandbox['review']),
    '  sandbox recommendation:',
    ...indent(sandbox['recommendation']),
    typeof links === 'string' ? `  links to views: ${links}` : `  deep links: ${textList(links).length}`,
  ].join('\n');
}
