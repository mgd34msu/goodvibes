import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { CommandContext } from '../command-registry.ts';
import type { ConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
import { CONFIG_SCHEMA, CONFIG_KEYS } from '@goodvibes-jev/engine/platform/platform/config';
import { requireShellPaths } from './runtime-services.ts';

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
  ].join('\n');
}

export function buildSetupTransferBundle(ctx: CommandContext, snapshot: SetupReviewSnapshot): SetupTransferBundle {
  const shellPaths = requireShellPaths(ctx);
  const config: Record<string, unknown> = {};
  for (const entry of CONFIG_SCHEMA) {
    // The stored setting, never an owner-profile value: an exported profile value
    // would become an explicit setting on import and stop following the profile.
    let value: unknown;
    try { value = structuredClone(ctx.platform.configManager.getStored(entry.key as ConfigKey)); }
    catch { continue; } // a key with no place in this build's settings tree does not travel
    // Only settings that differ from the default travel: an exported default would
    // become an explicit override on import and keep an old default pinned.
    if (JSON.stringify(value) === JSON.stringify(entry.default)) continue;
    config[entry.key] = value;
  }
  const servicesPath = shellPaths.resolveProjectPath('tui', 'services.json');
  const pluginsPath = shellPaths.resolveProjectPath('tui', 'ecosystem', 'plugins.json');
  const skillsPath = shellPaths.resolveProjectPath('tui', 'ecosystem', 'skills.json');
  const services = existsSync(servicesPath)
    ? JSON.parse(readFileSync(servicesPath, 'utf-8')) as Record<string, unknown>
    : undefined;
  const plugins = existsSync(pluginsPath)
    ? JSON.parse(readFileSync(pluginsPath, 'utf-8')) as Record<string, unknown>
    : undefined;
  const skills = existsSync(skillsPath)
    ? JSON.parse(readFileSync(skillsPath, 'utf-8')) as Record<string, unknown>
    : undefined;

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
  };
}

export function createSetupLink(surface: string, target?: string): string {
  const encodedTarget = target ? `?target=${encodeURIComponent(target)}` : '';
  return `goodvibes://open/${encodeURIComponent(surface)}${encodedTarget}`;
}

export function parseSetupLink(value: string): { surface: string; target?: string } | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'goodvibes:') return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (parsed.hostname !== 'open' || segments.length !== 1) return null;
    return {
      surface: decodeURIComponent(segments[0]!),
      target: parsed.searchParams.get('target') ?? undefined,
    };
  } catch {
    return null;
  }
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
  return { ok: true, bundle: bundle as unknown as SetupTransferBundle, changes, ignoredKeys };
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
