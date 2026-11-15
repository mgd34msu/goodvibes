import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { CommandContext } from '../command-registry.ts';
import type { ConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
import { CONFIG_SCHEMA, CONFIG_KEYS, configKeyFacts, isProtectedConfigValue, isSecretReferenceValue } from '@goodvibes-jev/engine/platform/platform/config';
import { redactDiagnosticValue } from '@goodvibes-jev/engine/platform/platform/utils';
import { requireShellPaths } from './runtime-services.ts';

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

export interface SetupReviewSnapshot {
  readonly sessionId: string;
  readonly providerCount: number;
  readonly serviceCount: number;
  readonly oauthProviderCount: number;
  readonly builtinSubscriptionProviderCount: number;
  readonly activeSubscriptionCount: number;
  readonly pendingSubscriptionCount: number;
  readonly serviceIssues: string[];
  readonly skillCount: number;
  readonly pluginCount: number;
  readonly quarantinedPluginCount: number;
  readonly pluginDirectories: string[];
  readonly managedHookCount: number;
  readonly managedHookChainCount: number;
  readonly mcpServerCount: number;
  readonly quarantinedMcpCount: number;
  readonly elevatedMcpCount: number;
  readonly remoteRunnerCount: number;
  readonly sandboxReplIsolation: string;
  readonly sandboxMcpIsolation: string;
  readonly sandboxSecureModeReady: boolean;
  readonly issues: Array<{ severity: 'pass' | 'warn' | 'fail'; area: string; message: string }>;
  readonly services: string[];
}

export interface SetupTransferBundle {
  readonly schemaVersion: 'v1';
  readonly exportedAt: number;
  readonly startupReview: SetupReviewSnapshot;
  readonly config: Record<string, unknown>;
  readonly services?: Record<string, unknown>;
  readonly ecosystem?: {
    readonly plugins?: Record<string, unknown>;
    readonly skills?: Record<string, unknown>;
  };
  /** Where a literal credential was left out (a setting) or masked (a file entry) at export. */
  readonly redacted?: readonly string[];
}

export function inspectSetupTransferBundle(bundle: SetupTransferBundle): string {
  const ecosystemPluginCount = bundle.ecosystem?.plugins && Array.isArray((bundle.ecosystem.plugins as { entries?: unknown[] }).entries)
    ? ((bundle.ecosystem.plugins as { entries: unknown[] }).entries.length)
    : 0;
  const ecosystemSkillCount = bundle.ecosystem?.skills && Array.isArray((bundle.ecosystem.skills as { entries?: unknown[] }).entries)
    ? ((bundle.ecosystem.skills as { entries: unknown[] }).entries.length)
    : 0;
  return [
    'Setup Transfer Review',
    `  schemaVersion: ${bundle.schemaVersion}`,
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  session: ${bundle.startupReview.sessionId}`,
    `  services: ${bundle.startupReview.serviceCount}`,
    `  plugins: ${bundle.startupReview.pluginCount}`,
    `  skills: ${bundle.startupReview.skillCount}`,
    `  remote runners: ${bundle.startupReview.remoteRunnerCount}`,
    `  config keys: ${Object.keys(bundle.config ?? {}).length}`,
    `  curated plugins: ${ecosystemPluginCount}`,
    `  curated skills: ${ecosystemSkillCount}`,
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
export function buildSetupTransferBundle(ctx: CommandContext, snapshot: SetupReviewSnapshot): SetupTransferBundle {
  const shellPaths = requireShellPaths(ctx);
  const config: Record<string, unknown> = {};
  const redacted: string[] = [];
  for (const entry of CONFIG_SCHEMA) {
    // The stored setting, never an owner-profile value: an exported profile value
    // would become an explicit setting on import and stop following the profile.
    let value: unknown;
    try { value = structuredClone(ctx.platform.configManager.getStored(entry.key as ConfigKey)); }
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
    config[entry.key] = value;
  }
  const readPart = (path: string): Record<string, unknown> | undefined => (existsSync(path)
    ? maskLiteralSecrets(JSON.parse(readFileSync(path, 'utf-8')), redacted, path.slice(path.lastIndexOf('/') + 1)) as Record<string, unknown>
    : undefined);
  const services = readPart(shellPaths.resolveProjectPath('tui', 'services.json'));
  const plugins = readPart(shellPaths.resolveProjectPath('tui', 'ecosystem', 'plugins.json'));
  const skills = readPart(shellPaths.resolveProjectPath('tui', 'ecosystem', 'skills.json'));

  return {
    schemaVersion: 'v1',
    exportedAt: Date.now(),
    startupReview: snapshot,
    config,
    services,
    ecosystem: {
      plugins,
      skills,
    },
    ...(redacted.length > 0 ? { redacted } : {}),
  };
}

export function exportSetupTransferBundle(
  ctx: CommandContext,
  pathArg: string,
  bundle: SetupTransferBundle,
): string {
  const shellPaths = requireShellPaths(ctx);
  const targetPath = shellPaths.resolveWorkspacePath(pathArg);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
  return targetPath;
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
      /** Settings whose value in the bundle differs from the live one. */
      readonly changes: readonly SetupTransferChange[];
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
 * schema. A bundle that fails any check changes nothing.
 */
export function planSetupTransferImport(configManager: CommandContext['platform']['configManager'], bundle: unknown): SetupTransferPlan {
  if (!isPlainObject(bundle)) return { ok: false, reason: 'not a setup transfer bundle (expected a JSON object).' };
  if (bundle.schemaVersion !== 'v1') {
    return { ok: false, reason: `unsupported schemaVersion ${JSON.stringify(bundle.schemaVersion)}; this build reads "v1". Re-export the bundle from a matching release.` };
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
  const ignoredKeys: string[] = [];
  const invalid: string[] = [];
  for (const [rawKey, next] of Object.entries(bundle.config)) {
    if (!CONFIG_KEYS.has(rawKey as ConfigKey)) { ignoredKeys.push(rawKey); continue; }
    const key = rawKey as ConfigKey;
    try {
      configManager.validateDynamic(key, next);
    } catch (error) {
      invalid.push(`${key} (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const previous = configManager.get(key);
    if (JSON.stringify(previous) !== JSON.stringify(next)) changes.push({ key, previous: structuredClone(previous), next: structuredClone(next) });
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
  return { ok: true, bundle: importable, changes, ignoredKeys, skippedParts };
}

/** A setting value as the import question shows it: a credential is never printed. */
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
 * The import question's lines for the settings: every change to a key that can
 * loosen security or holds a credential with its old and new value, the rest by
 * name.
 */
export function describeSetupTransferChanges(changes: readonly { readonly key: string; readonly previous: unknown; readonly next: unknown }[]): string[] {
  const security = changes.filter(isSecurityBearingChange);
  const others = changes.filter((change) => !security.includes(change));
  return [
    `Settings that change: ${changes.length}.`,
    ...security.map((change) => {
      const loosening = configKeyFacts(change.key).loosens?.(change.previous, change.next) ? '  (loosens security)' : '';
      return `  ${change.key}: ${shownValue(change.key, change.previous)} -> ${shownValue(change.key, change.next)}${loosening}`;
    }),
    ...(others.length > 0 ? [`  also: ${others.slice(0, 12).map((change) => change.key).join(', ')}${others.length > 12 ? `, and ${others.length - 12} more` : ''}`] : []),
  ];
}

/** Write every change, or put the already-written ones back and rethrow, so a failure leaves no half-imported config. */
export function applySetupTransferChanges(
  configManager: CommandContext['platform']['configManager'],
  changes: readonly SetupTransferChange[],
): void {
  const written: SetupTransferChange[] = [];
  try {
    for (const change of changes) {
      configManager.setDynamic(change.key, change.next);
      written.push(change);
    }
  } catch (error) {
    revertSetupTransferChanges(configManager, written);
    throw error;
  }
}

/** Put the previous value back for every given change, newest first. Best effort: a failed restore never hides the original error. */
export function revertSetupTransferChanges(
  configManager: CommandContext['platform']['configManager'],
  changes: readonly SetupTransferChange[],
): void {
  for (const change of [...changes].reverse()) {
    try {
      configManager.setDynamic(change.key, change.previous);
    } catch {
      // Best effort.
    }
  }
}
