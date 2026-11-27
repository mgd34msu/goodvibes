/**
 * support-bundle.ts, a program's settings and setup in one redacted file: written,
 * read back, and loaded again, by the daemon's System capabilities (`bundle.*`,
 * capabilities/builtin/system-bundles.ts), which every door runs: the System
 * place, a model, an outside agent, `do`, and the programs' command-line forms
 * (`goodvibes support-bundle`, `goodvibes-agent bundle`, terminal-shell
 * support-bundle-cli.ts).
 * Nothing secret is written: the settings go through the one config redaction
 * (config-redaction.ts), the whole file through the serialized sweep, and the
 * secret store is described by its key names only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes/engine/errors';
import type { ConfigManager } from '../config/manager.js';
import type { ConfigKey } from '../config/schema-types.js';
import { configKeyFacts } from '../config/config-key-facts.js';
import { isDaemonOwnedConfigKey } from '../config/config-ownership.js';
import { isSecretBearingConfigKey } from '../config/secret-bearing-config-keys.js';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';
import { summarizeError } from '../utils/native-error-summary.js';
import { decisionOrClassic, isClassicOperation, withDecisionModelPolicy } from '../runtime/decision-policy.js';
import { captureOwnedJson } from '../gate/judgment-input.js';
import { createShellPathService, type ShellPathService } from '../runtime/shell-paths.js';
import { listProviderRuntimeSnapshots } from '../providers/runtime-snapshot.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { REDACTED_VALUE, isRedactedValue, prepareConfigRedaction, redactSerializedSecrets } from './config-redaction.js';
import { retainCliConfig } from './service-posture.js';

// ---------------------------------------------------------------------------
// Reading a bundle file
// ---------------------------------------------------------------------------

/** A partially redacted object cannot restore a configuration setting faithfully. */
export function containsRedactedValue(value: unknown): boolean {
  if (isRedactedValue(value)) return true;
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(containsRedactedValue);
}

export interface BundleInspectSummary {
  readonly type: string;
  readonly version: string;
  readonly path: string;
  readonly capturedAt: number | null;
  readonly configKeys: number;
  readonly redactedConfigPaths: readonly string[];
  readonly hasDiagnostics: boolean;
}

export function getNestedValue(source: unknown, key: string): unknown {
  let cursor = source;
  for (const part of key.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(cursor, part);
    if (!descriptor || !('value' in descriptor)) return undefined;
    cursor = descriptor.value;
  }
  return cursor;
}

export function readJsonFile(path: string): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: summarizeError(error) };
  }
}

export function inspectBundle(path: string, parsed: Record<string, unknown>, schema: readonly { readonly key: string }[]): BundleInspectSummary {
  const redaction = parsed['redaction'] as { redactedConfigPaths?: unknown } | undefined;
  return {
    type: String(parsed['type'] ?? 'unknown'),
    version: String(parsed['version'] ?? 'unknown'),
    path,
    capturedAt: typeof parsed['capturedAt'] === 'number' ? parsed['capturedAt'] : null,
    configKeys: parsed['config'] && typeof parsed['config'] === 'object'
      ? schema.filter((setting) => getNestedValue(parsed['config'], setting.key) !== undefined).length
      : 0,
    redactedConfigPaths: Array.isArray(redaction?.redactedConfigPaths) ? redaction.redactedConfigPaths as string[] : [],
    hasDiagnostics: Boolean(parsed['diagnostics'] && typeof parsed['diagnostics'] === 'object'),
  };
}

// ---------------------------------------------------------------------------
// Which settings an import holds back
// ---------------------------------------------------------------------------

/**
 * Where the program keeps its data and secrets, how it starts, and which host
 * and MCP servers it works with. Changing these loosens nothing, so the key
 * facts do not rate them, but they are not another person's to choose.
 */
const PLACEMENT_SETTING = /^(service|storage|mcp|daemon\.connectedHost)\.|(Path|Dir)$/;

/**
 * Keys under a placement family that are a protection with a direction of their own (config-key-facts.ts), not a
 * place: judged by that direction alone, so a move to the stricter value is not held back.
 */
const POLICY_NOT_PLACEMENT: ReadonlySet<string> = new Set(['storage.secretPolicy']);

/**
 * A change an import holds back unless security settings are asked for: one the
 * key's own facts say loosens security (config-key-facts.ts, the one owner of
 * that rule, read from the current and new value), or one to a placement
 * setting above.
 */
export function securityRelevantSetting(key: string, from: unknown, value: unknown): boolean {
  return configKeyFacts(key).loosens?.(from, value) === true || (PLACEMENT_SETTING.test(key) && !POLICY_NOT_PLACEMENT.has(key));
}

/** A value as one short line; credential settings show only whether they are set. */
export function showSettingValue(key: string, value: unknown): string {
  if (value === undefined) return '(unset)';
  if (isSecretBearingConfigKey(key)) return value === '' || value === null ? '(empty)' : '<set>';
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/** The settings, folders and caller a bundle is written for. */
export interface SupportBundleSource {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly configManager: Pick<ConfigManager, 'getRaw' | 'getConfigurationIncarnation' | 'get' | 'validateDynamic' | 'setMany'>;
}

type ProviderSnapshot = Awaited<ReturnType<typeof listProviderRuntimeSnapshots>>[number];

export interface SupportBundleBindings<Runtime extends SupportBundleSource, Services, Service extends { readonly issues: readonly unknown[] }> {
  readonly schema: readonly { readonly key: ConfigKey }[];
  readonly createSecrets: (runtime: Runtime) => { inspect(): Promise<unknown> };
  readonly withServices: <Output>(runtime: Runtime, body: (services: Services) => Promise<Output>, options: { readonly catalog: { readonly contextWindowEnrichment: 'none' } }) => Promise<Output>;
  readonly providerRegistry: (services: Services) => ProviderRegistry;
  readonly classifyProvider: (snapshot: ProviderSnapshot, options: { readonly site: string }) => Promise<unknown>;
  readonly servicePosture: (runtime: Runtime, options: JudgmentReadingOptions & { readonly logTailBytes: number }) => Promise<Service>;
  readonly authPosture: (runtime: Runtime) => unknown;
  readonly packageVersion: () => string;
  readonly onboardingMarkerPath: (paths: ShellPathService, scope: 'user' | 'project') => string;
  /**
   * The routed write for the daemon-owned settings, as one update the daemon
   * admits whole (config.setMany): `daemon` when one answered and took them,
   * `none` when no daemon is running (nothing written; the caller puts them in
   * the daemon's file in its own single update). An unreachable configured
   * host, or a refusal, throws and nothing was written.
   */
  readonly routeDaemonSettings: (runtime: Runtime, entries: readonly { readonly key: ConfigKey; readonly value: unknown }[]) => Promise<{ readonly appliedBy: 'daemon' | 'none' }>;
}

export interface SupportBundlePolicy<Runtime> {
  readonly site: string;
  readonly providerSite: string;
  readonly packageName: string;
  readonly bundleType: string;
  readonly title: string;
  readonly defaultFilename: string;
  readonly detachConfig: boolean;
  readonly time: (timestamp: number) => string;
  readonly invalidJsonSeparator: string;
  readonly issuesKey: string;
}

/** Version a bundle is written as and loaded from. */
export const SUPPORT_BUNDLE_VERSION = 2;

export interface SupportBundleWritten {
  readonly path: string;
  readonly redactedConfigPaths: readonly string[];
  readonly issues: readonly unknown[];
}

export interface SupportBundleChange { readonly key: ConfigKey; readonly value: unknown; readonly from: unknown }

/** What loading a bundle would change, or why it cannot be loaded. */
export type SupportBundleLoadPlan =
  | { readonly ok: false; readonly problem: string }
  | {
    readonly ok: true;
    /** Settings that would change. */
    readonly pending: readonly SupportBundleChange[];
    /** Security settings left as they are (asked for with `includeSecurity`). */
    readonly heldBack: readonly SupportBundleChange[];
    /** Values written as redacted: never loaded. */
    readonly skippedRedacted: number;
    /** Values that already match. */
    readonly unchanged: number;
    /** Values the settings would refuse, by key. */
    readonly invalid: readonly { readonly key: string; readonly message: string }[];
  };

export type SupportBundleLoaded =
  | { readonly ok: true; readonly applied: readonly SupportBundleChange[]; readonly daemonApplied: number; readonly plan: Extract<SupportBundleLoadPlan, { ok: true }> }
  | { readonly ok: false; readonly problem: string; readonly lines?: readonly string[] };

export function createSupportBundle<Runtime extends SupportBundleSource, Services, Service extends { readonly issues: readonly unknown[] }>(
  bindings: SupportBundleBindings<Runtime, Services, Service>,
  policy: SupportBundlePolicy<Runtime>,
) {
  async function providerReadiness(services: Services) {
    const snapshots = await listProviderRuntimeSnapshots(bindings.providerRegistry(services), { modelFamilyEnrichment: 'none' });
    return Promise.all(snapshots.map(async (snapshot) => ({
      provider: snapshot.providerId,
      active: snapshot.active,
      configured: snapshot.runtime.auth?.configured ?? true,
      configuredVia: snapshot.runtime.auth?.mode ?? 'unknown',
      models: snapshot.modelCount,
      setup: await bindings.classifyProvider(snapshot, { site: policy.providerSite }),
    })));
  }

  const pathsOf = (runtime: Runtime): ShellPathService => createShellPathService({ workingDirectory: runtime.workingDirectory, homeDirectory: runtime.homeDirectory });

  /** Write a bundle to `outputPath` (in the runtime's folder when not absolute). */
  async function write(runtime: Runtime, outputPath: string, options: JudgmentReadingOptions = {}): Promise<SupportBundleWritten> {
    return withDecisionModelPolicy(() => runtime.configManager.get('judgment.policy'), async () => {
      const shellPaths = pathsOf(runtime);
      const secrets = bindings.createSecrets(runtime);
      const retainedConfig = retainCliConfig(runtime.configManager);
      const rawConfig = policy.detachConfig ? captureOwnedJson(retainedConfig.raw) : retainedConfig.raw;
      // The settings are captured once above. The one check that they still match
      // runs immediately before the file is written, the step that publishes them.
      const assertCurrent = () => {
        options.signal?.throwIfAborted();
        try {
          retainedConfig.assertCurrent();
        } catch {
          throw new Error('Support bundle input changed before export.');
        }
        options.assertCurrent?.();
      };
      return await bindings.withServices(runtime, async (services) => {
        const owner = await decisionOrClassic(() => Promise.resolve(captureJudgmentPort(policy.site, { ...options, assertCurrent })), () => undefined, () => true);
        const current = () => { assertCurrent(); if (!isClassicOperation()) owner?.assertCurrent(); };
        const providers = await providerReadiness(services);
        const reading = { ...options, signal: owner?.signal ?? options.signal, assertCurrent: current };
        const redactedConfig = await prepareConfigRedaction(rawConfig, reading);
        const service = await bindings.servicePosture(runtime, { ...reading, logTailBytes: 8192 });
        const bundle = {
          ...(isClassicOperation() ? { operationProvenance: 'classic', semanticAssessment: 'not-evaluated' } : {}),
          version: SUPPORT_BUNDLE_VERSION,
          type: policy.bundleType,
          capturedAt: Date.now(),
          package: { name: policy.packageName, version: bindings.packageVersion() },
          roots: { workingDirectory: runtime.workingDirectory, homeDirectory: runtime.homeDirectory },
          config: redactedConfig.value,
          redaction: { sentinel: REDACTED_VALUE, redactedConfigPaths: redactedConfig.redactedPaths },
          diagnostics: { service, auth: bindings.authPosture(runtime), providers },
          secrets: await secrets.inspect(),
          onboarding: {
            userMarker: existsSync(bindings.onboardingMarkerPath(shellPaths, 'user')),
            projectMarker: existsSync(bindings.onboardingMarkerPath(shellPaths, 'project')),
          },
        };
        const targetPath = shellPaths.resolveWorkspacePath(outputPath);
        let serialized = await redactSerializedSecrets(JSON.stringify(bundle, null, 2), redactedConfig.sensitiveValues, reading);
        if (isClassicOperation()) {
          // The final redaction phase can be the one that exhausts the chain.
          // Stamp only fixed native metadata onto its already-redacted JSON.
          serialized = JSON.stringify({ ...JSON.parse(serialized) as Record<string, unknown>,
            // Public native envelope constants are not derived from config
            // or diagnostic values that the redactor has withheld.
            version: bundle.version, type: bundle.type,
            operationProvenance: 'classic', semanticAssessment: 'not-evaluated' }, null, 2);
        }
        mkdirSync(dirname(targetPath), { recursive: true });
        current();
        writeFileSync(targetPath, serialized + '\n', 'utf-8');
        return { path: targetPath, redactedConfigPaths: redactedConfig.redactedPaths, issues: service.issues };
      }, { catalog: { contextWindowEnrichment: 'none' } });
    });
  }

  /** What loading the bundle at `sourcePath` would change; nothing is written. */
  function plan(runtime: Runtime, sourcePath: string, includeSecurity: boolean): SupportBundleLoadPlan {
    const parsed = readJsonFile(sourcePath);
    if (!parsed.ok) return { ok: false, problem: `Invalid bundle JSON${policy.invalidJsonSeparator}${parsed.error}` };
    const bundleType = parsed.value['type'];
    if (bundleType !== policy.bundleType) {
      return { ok: false, problem: `${sourcePath} is a "${String(bundleType ?? 'unknown')}" bundle; this loads "${policy.bundleType}" bundles. Nothing was changed.` };
    }
    if (parsed.value['version'] !== SUPPORT_BUNDLE_VERSION) {
      return { ok: false, problem: `${sourcePath} is bundle version ${String(parsed.value['version'] ?? 'unknown')}; this loads version ${SUPPORT_BUNDLE_VERSION}. Nothing was changed.` };
    }
    const config = parsed.value['config'];
    if (!config || typeof config !== 'object') return { ok: false, problem: 'Bundle has no config object to import.' };
    // Only values that differ from the current settings are imported. Settings
    // that decide what runs unasked, what the machine exposes and where data
    // lives are held back unless security settings are asked for.
    const current = retainCliConfig(runtime.configManager).raw;
    const pending: SupportBundleChange[] = [];
    const heldBack: SupportBundleChange[] = [];
    let skippedRedacted = 0;
    let unchanged = 0;
    for (const setting of bindings.schema) {
      const value = getNestedValue(config, setting.key);
      if (value === undefined) continue;
      if (containsRedactedValue(value)) { skippedRedacted++; continue; }
      const from = getNestedValue(current, setting.key);
      if (JSON.stringify(from) === JSON.stringify(value)) { unchanged++; continue; }
      (securityRelevantSetting(setting.key, from, value) && !includeSecurity ? heldBack : pending).push({ key: setting.key, value, from });
    }
    const invalid: { key: string; message: string }[] = [];
    for (const entry of pending) {
      try { runtime.configManager.validateDynamic(entry.key, entry.value); } catch (error) { invalid.push({ key: entry.key, message: summarizeError(error) }); }
    }
    return { ok: true, pending, heldBack, skippedRedacted, unchanged, invalid };
  }

  /** Load every pending change of the plan: the daemon's settings first, as one update, then this program's. */
  async function load(runtime: Runtime, sourcePath: string, includeSecurity: boolean): Promise<SupportBundleLoaded> {
    const planned = plan(runtime, sourcePath, includeSecurity);
    if (!planned.ok) return planned;
    if (planned.invalid.length > 0) {
      return { ok: false, problem: `Bundle not imported: ${planned.invalid.length} value${planned.invalid.length === 1 ? '' : 's'} cannot be applied. Nothing was changed.`,
        lines: planned.invalid.map((entry) => `  ${entry.key}: ${entry.message}`) };
    }
    const pending = planned.pending;
    if (pending.length === 0) return { ok: true, applied: [], daemonApplied: 0, plan: planned };
    // A daemon-owned setting has one writer, the daemon. Its settings go
    // first, as one update it admits whole; this program's are written only
    // once it has taken them, so a refusal leaves everything as it was.
    const daemonOwned = pending.filter((entry) => isDaemonOwnedConfigKey(entry.key));
    const local = pending.filter((entry) => !isDaemonOwnedConfigKey(entry.key));
    let daemonApplied = false;
    if (daemonOwned.length > 0) {
      try {
        daemonApplied = (await bindings.routeDaemonSettings(runtime, daemonOwned.map(({ key, value }) => ({ key, value })))).appliedBy === 'daemon';
      } catch (error) {
        return { ok: false, problem: `Bundle not imported: the daemon did not take its ${daemonOwned.length} setting${daemonOwned.length === 1 ? '' : 's'} (${summarizeError(error)}). Nothing was changed.` };
      }
    }
    // With no daemon running, its settings go into its file in the same one
    // update as this program's: every value is admitted before anything is written.
    const writes = daemonApplied ? local : pending;
    const result = writes.length > 0
      ? runtime.configManager.setMany(writes.map(({ key, value }) => ({ key, value })), localOwnerActor(),
        !daemonApplied && daemonOwned.length > 0 ? { daemonNotRunning: true } : {})
      : { ok: true as const, saved: [] as readonly ConfigKey[] };
    if (!result.ok) {
      return {
        ok: false,
        problem: daemonApplied
          ? `Bundle partly imported: the daemon took its ${daemonOwned.length} setting${daemonOwned.length === 1 ? '' : 's'}; this program's were not saved: ${result.refusal.reason} State: ${result.refusal.state}.`
          : `Bundle not imported: ${result.refusal.reason} State: ${result.refusal.state}.`,
        lines: [...result.refusal.next.map((step) => `  ${step}`), ...result.saved.map((key) => `  saved ${key}`)],
      };
    }
    return { ok: true, applied: pending, daemonApplied: daemonApplied ? daemonOwned.length : 0, plan: planned };
  }

  /** The text of a plan: the settings it changes (security ones first), and what it holds back. */
  function describe(planned: Extract<SupportBundleLoadPlan, { ok: true }>): { readonly note: string; readonly security: string[]; readonly ordinary: string[]; readonly heldBack: string[] } {
    const line = (entry: SupportBundleChange) => `  ${entry.key}: ${showSettingValue(entry.key, entry.from)} -> ${showSettingValue(entry.key, entry.value)}`;
    const held = planned.heldBack.length;
    return {
      note: [
        planned.skippedRedacted ? ` ${planned.skippedRedacted} redacted value${planned.skippedRedacted === 1 ? '' : 's'} skipped.` : '',
        planned.unchanged ? ` ${planned.unchanged} value${planned.unchanged === 1 ? '' : 's'} already match.` : '',
        held ? ` ${held} security setting${held === 1 ? '' : 's'} held back.` : '',
      ].join(''),
      security: planned.pending.filter((entry) => securityRelevantSetting(entry.key, entry.from, entry.value)).map(line),
      ordinary: planned.pending.filter((entry) => !securityRelevantSetting(entry.key, entry.from, entry.value)).map(line),
      heldBack: planned.heldBack.map(line),
    };
  }

  function inspectFile(sourcePath: string): { readonly ok: true; readonly summary: BundleInspectSummary } | { readonly ok: false; readonly problem: string } {
    const parsed = readJsonFile(sourcePath);
    if (!parsed.ok) return { ok: false, problem: `Invalid bundle JSON${policy.invalidJsonSeparator}${parsed.error}` };
    return { ok: true, summary: inspect(sourcePath, parsed.value) };
  }

  function inspect(sourcePath: string, parsed: Record<string, unknown>): BundleInspectSummary {
    return inspectBundle(sourcePath, parsed, bindings.schema);
  }

  function summaryText(summary: BundleInspectSummary): string {
    return [
      policy.title,
      `  type: ${summary.type}`,
      `  version: ${summary.version}`,
      `  path: ${summary.path}`,
      `  capturedAt: ${summary.capturedAt === null ? 'n/a' : policy.time(summary.capturedAt)}`,
      `  configKeys: ${summary.configKeys}`,
      `  redactedConfigKeys: ${summary.redactedConfigPaths.length}`,
      `  diagnostics: ${summary.hasDiagnostics ? 'present' : 'missing'}`,
    ].join('\n');
  }

  return { write, plan, load, describe, inspectFile, summaryText, pathsOf };
}
