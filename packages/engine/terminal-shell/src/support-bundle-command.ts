import { retainCliConfig } from './cli-config-owner.js';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import type { ConfigKey, ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { isDaemonOwnedConfigKey, isSecretBearingConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { decisionOrClassic, isClassicOperation, withDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime/decision-policy';
import { captureOwnedJson } from '@goodvibes-jev/engine/platform/platform/gate/judgment-input';
import { createShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell-paths';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { listProviderRuntimeSnapshots, type ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import type { CliCommandOutput } from './cli-types.js';
import { REDACTED_VALUE, prepareConfigRedaction, redactSerializedSecrets } from './cli-redaction.js';
import {
  formatJsonOrText,
  readJsonFile,
  getNestedValue,
  containsRedactedValue,
  inspectBundle as inspect,
} from './support-bundle-inspection.js';
/**
 * Settings that decide what runs without asking, what the machine exposes to
 * the network, how it starts, and where its data and secrets live. An import
 * leaves them as they are unless asked for by name.
 */
export function securityRelevantSetting(key: string): boolean {
  return /^(permissions|sandbox|service|storage|policy|network|mcp)\./.test(key)
    || key === 'behavior.autoApprove' || key === 'judgment.policy'
    || /^(controlPlane|httpListener|web)\.(host|hostMode|trustProxy|trustCloudflare)$/.test(key)
    || /^fetch\.(allowLocalhost|trustedHosts|blockedHosts)$/.test(key)
    || key.startsWith('daemon.connectedHost.') || key === 'integrations.routeBinding'
    || /(Path|Dir)$/.test(key);
}

/** A value as one short line; credential settings show only whether they are set. */
function showSettingValue(key: string, value: unknown): string {
  if (value === undefined) return '(unset)';
  if (isSecretBearingConfigKey(key)) return value === '' || value === null ? '(empty)' : '<set>';
  const text = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

export interface SupportBundleRuntime {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly configManager: Parameters<typeof retainCliConfig>[0] & Pick<ConfigManager, 'get' | 'validateDynamic' | 'setMany'>;
  readonly cli: {
    readonly commandArgs: readonly string[];
    readonly binary: string;
    readonly flags: {
      readonly outputFormat?: string | undefined;
      readonly yes?: boolean | undefined;
    };
  };
}
/** Version `export` writes and `import` accepts. */
const BUNDLE_VERSION = 2;
type ProviderSnapshot = Awaited<ReturnType<typeof listProviderRuntimeSnapshots>>[number];
export function createSupportBundleCommand<
  Runtime extends SupportBundleRuntime,
  Services,
  Service extends {
    readonly issues: readonly unknown[];
  },
>(
  bindings: {
    readonly schema: readonly {
      readonly key: ConfigKey;
    }[];
    readonly createSecrets: (runtime: Runtime) => {
      inspect(): Promise<unknown>;
    };
    readonly withServices: <Output>(
      runtime: Runtime,
      body: (services: Services) => Promise<Output>,
      options: {
        readonly catalog: {
          readonly contextWindowEnrichment: 'none';
        };
      },
    ) => Promise<Output>;
    readonly providerRegistry: (services: Services) => ProviderRegistry;
    readonly classifyProvider: (
      snapshot: ProviderSnapshot,
      options: {
        readonly site: string;
      },
    ) => Promise<unknown>;
    readonly servicePosture: (
      runtime: Runtime,
      options: JudgmentReadingOptions & {
        readonly logTailBytes: number;
      },
    ) => Promise<Service>;
    readonly authPosture: (runtime: Runtime) => unknown;
    readonly packageVersion: () => string;
    readonly onboardingMarkerPath: (paths: ShellPathService, scope: 'user' | 'project') => string;
    /**
     * The routed write for a daemon-owned setting: the daemon applies it when
     * one answers, its settings file is written for it to read at start when
     * none is running, and an unreachable configured host refuses.
     */
    readonly routeDaemonSetting: (runtime: Runtime, key: ConfigKey, value: unknown) => Promise<unknown>;
  },
  policy: {
    readonly site: string;
    readonly providerSite: string;
    readonly packageName: string;
    readonly bundleType: string;
    readonly title: string;
    readonly commandBase: (runtime: Runtime) => string;
    readonly defaultFilename: string;
    readonly detachConfig: boolean;
    readonly time: (timestamp: number) => string;
    readonly invalidJsonSeparator: string;
    readonly exportLabel: string;
    readonly issuesKey: string;
  },
) {
  async function providerReadiness(services: Services) {
    const snapshots = await listProviderRuntimeSnapshots(bindings.providerRegistry(services), { modelFamilyEnrichment: 'none' });
    return Promise.all(
      snapshots.map(async (snapshot) => ({
        provider: snapshot.providerId,
        active: snapshot.active,
        configured: snapshot.runtime.auth?.configured ?? true,
        configuredVia: snapshot.runtime.auth?.mode ?? 'unknown',
        models: snapshot.modelCount,
        setup: await bindings.classifyProvider(snapshot, { site: policy.providerSite }),
      })),
    );
  }
  async function handleBundleCommand(runtime: Runtime, options: JudgmentReadingOptions = {}): Promise<CliCommandOutput> {
    return withDecisionModelPolicy(() => runtime.configManager.get('judgment.policy'), () => handleOwnedBundleCommand(runtime, options));
  }

  async function handleOwnedBundleCommand(runtime: Runtime, options: JudgmentReadingOptions): Promise<CliCommandOutput> {
    const [sub = 'inspect', ...rest] = runtime.cli.commandArgs;
    const shellPaths = createShellPathService({
      workingDirectory: runtime.workingDirectory,
      homeDirectory: runtime.homeDirectory,
    });
    if (sub === 'inspect') {
      const path = rest[0];
      if (!path) return { output: `Usage: ${policy.commandBase(runtime)} inspect <path>`, exitCode: 2 };
      const sourcePath = shellPaths.resolveWorkspacePath(path);
      const parsed = readJsonFile(sourcePath);
      if (!parsed.ok) return { output: `Invalid bundle JSON${policy.invalidJsonSeparator}${parsed.error}`, exitCode: 1 };
      const summary = inspect(sourcePath, parsed.value, bindings.schema);
      return {
        output: formatJsonOrText(
          runtime,
          summary,
          [
            policy.title,
            `  type: ${summary.type}`,
            `  version: ${summary.version}`,
            `  path: ${summary.path}`,
            `  capturedAt: ${summary.capturedAt === null ? 'n/a' : policy.time(summary.capturedAt)}`,
            `  configKeys: ${summary.configKeys}`,
            `  redactedConfigKeys: ${summary.redactedConfigPaths.length}`,
            `  diagnostics: ${summary.hasDiagnostics ? 'present' : 'missing'}`,
          ].join('\n'),
        ),
        exitCode: 0,
      };
    }
    if (sub === 'export') {
      const outputPath = rest[0] ?? policy.defaultFilename;
      const secrets = bindings.createSecrets(runtime);
      const configManager = runtime.configManager;
      const retainedConfig = retainCliConfig(configManager);
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
      return await bindings.withServices(
        runtime,
        async (services) => {
          const owner = await decisionOrClassic(() => Promise.resolve(captureJudgmentPort(policy.site, { ...options, assertCurrent })),
            () => undefined, () => true);
          const current = () => { assertCurrent(); if (!isClassicOperation()) owner?.assertCurrent(); };
          const providers = await providerReadiness(services);
          const reading = { ...options, signal: owner?.signal ?? options.signal, assertCurrent: current };
          const redactedConfig = await prepareConfigRedaction(rawConfig, reading);
          const service = await bindings.servicePosture(runtime, { ...reading, logTailBytes: 8192 });
          const bundle = {
            ...(isClassicOperation() ? { operationProvenance: 'classic', semanticAssessment: 'not-evaluated' } : {}),
            version: BUNDLE_VERSION,
            type: policy.bundleType,
            capturedAt: Date.now(),
            package: {
              name: policy.packageName,
              version: bindings.packageVersion(),
            },
            roots: {
              workingDirectory: runtime.workingDirectory,
              homeDirectory: runtime.homeDirectory,
            },
            config: redactedConfig.value,
            redaction: {
              sentinel: REDACTED_VALUE,
              redactedConfigPaths: redactedConfig.redactedPaths,
            },
            diagnostics: {
              service,
              auth: bindings.authPosture(runtime),
              providers,
            },
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
          return {
            output: formatJsonOrText(
              runtime,
              {
                path: targetPath,
                redactedConfigPaths: redactedConfig.redactedPaths,
                [policy.issuesKey]: service.issues,
              },
              `${policy.exportLabel}: ${targetPath}\n  redactedConfigKeys: ${redactedConfig.redactedPaths.length}\n  ${policy.issuesKey}: ${service.issues.length}`,
            ),
            exitCode: 0,
          };
        },
        { catalog: { contextWindowEnrichment: 'none' } },
      );
    }
    if (sub === 'import') {
      const apply = runtime.cli.flags.yes === true || rest.includes('--yes');
      const includeSecurity = rest.includes('--include-security');
      const path = rest.find((token) => token !== '--yes' && token !== '--include-security');
      if (!path) return { output: `Usage: ${policy.commandBase(runtime)} import <path> [--include-security] [--yes]`, exitCode: 2 };
      const sourcePath = shellPaths.resolveWorkspacePath(path);
      const parsed = readJsonFile(sourcePath);
      if (!parsed.ok) return { output: `Invalid bundle JSON${policy.invalidJsonSeparator}${parsed.error}`, exitCode: 1 };
      const bundleType = parsed.value['type'];
      if (bundleType !== policy.bundleType) {
        return {
          output: `${sourcePath} is a "${String(bundleType ?? 'unknown')}" bundle; this command imports "${policy.bundleType}" bundles. Nothing was changed.`,
          exitCode: 1,
        };
      }
      if (parsed.value['version'] !== BUNDLE_VERSION) {
        return {
          output: `${sourcePath} is bundle version ${String(parsed.value['version'] ?? 'unknown')}; this command imports version ${BUNDLE_VERSION}. Nothing was changed.`,
          exitCode: 1,
        };
      }
      const config = parsed.value['config'];
      if (!config || typeof config !== 'object') return { output: 'Bundle has no config object to import.', exitCode: 1 };
      // Only values that differ from the current settings are imported. Settings
      // that decide what runs unasked, what the machine exposes and where data
      // lives are held back unless --include-security asks for them.
      const current = retainCliConfig(runtime.configManager).raw;
      const pending: { key: ConfigKey; value: unknown; from: unknown }[] = [];
      const heldBack: { key: ConfigKey; value: unknown; from: unknown }[] = [];
      let skippedRedacted = 0;
      let unchanged = 0;
      for (const setting of bindings.schema) {
        const value = getNestedValue(config, setting.key);
        if (value === undefined) continue;
        if (containsRedactedValue(value)) {
          skippedRedacted++;
          continue;
        }
        const from = getNestedValue(current, setting.key);
        if (JSON.stringify(from) === JSON.stringify(value)) { unchanged++; continue; }
        (securityRelevantSetting(setting.key) && !includeSecurity ? heldBack : pending).push({ key: setting.key, value, from });
      }
      const redactedNote = [
        skippedRedacted ? ` ${skippedRedacted} redacted value${skippedRedacted === 1 ? '' : 's'} skipped.` : '',
        unchanged ? ` ${unchanged} value${unchanged === 1 ? '' : 's'} already match.` : '',
        heldBack.length ? ` ${heldBack.length} security setting${heldBack.length === 1 ? '' : 's'} held back (add --include-security to import ${heldBack.length === 1 ? 'it' : 'them'}).` : '',
      ].join('');
      const describe = (entry: { key: ConfigKey; value: unknown; from: unknown }) =>
        `  ${entry.key}: ${showSettingValue(entry.key, entry.from)} -> ${showSettingValue(entry.key, entry.value)}`;
      const count = pending.length;
      if (count === 0) {
        return {
          output: [`Nothing to import: no value in the bundle differs from the current settings, apart from what was held back.${redactedNote}`,
            ...(heldBack.length ? ['Held back (security):', ...heldBack.map(describe)] : [])].join('\n'),
          exitCode: 0,
        };
      }
      if (!apply) {
        // The preview names every value the import would refuse, so one --yes run can succeed.
        const failed: { key: string; message: string }[] = [];
        for (const entry of pending) {
          try {
            runtime.configManager.validateDynamic(entry.key, entry.value);
          } catch (error) {
            failed.push({ key: entry.key, message: summarizeError(error) });
          }
        }
        if (failed.length > 0) {
          return {
            output: [
              `Bundle not imported: ${failed.length} value${failed.length === 1 ? '' : 's'} cannot be applied. Nothing was changed.`,
              ...failed.map((entry) => `  ${entry.key}: ${entry.message}`),
            ].join('\n'),
            exitCode: 1,
          };
        }
        const security = pending.filter((entry) => securityRelevantSetting(entry.key));
        const ordinary = pending.filter((entry) => !securityRelevantSetting(entry.key));
        return {
          output: [
            `Refusing to import ${count} changed config value${count === 1 ? '' : 's'} without --yes. Nothing was changed.${redactedNote}`,
            ...(security.length ? ['Security settings (current -> new):', ...security.map(describe)] : []),
            ...(ordinary.length ? ['Other settings (current -> new):', ...ordinary.map(describe)] : []),
            ...(heldBack.length ? ['Held back (security; add --include-security):', ...heldBack.map(describe)] : []),
            `Usage: ${policy.commandBase(runtime)} import <path>${includeSecurity ? ' --include-security' : ''} --yes`,
          ].join('\n'),
          exitCode: 2,
        };
      }
      // A daemon-owned setting has one writer, the daemon: it goes through the
      // routed write. Every value is checked before anything is written.
      const daemonOwned = pending.filter((entry) => isDaemonOwnedConfigKey(entry.key));
      const local = pending.filter((entry) => !isDaemonOwnedConfigKey(entry.key));
      for (const entry of daemonOwned) {
        try { runtime.configManager.validateDynamic(entry.key, entry.value); } catch (error) {
          return { output: `Bundle not imported: ${entry.key}: ${summarizeError(error)}. Nothing was changed.`, exitCode: 1 };
        }
      }
      // One update for this surface's settings: every value is admitted before
      // anything is written, so a bad value leaves the configuration as it was.
      const result = local.length > 0
        ? runtime.configManager.setMany(local.map(({ key, value }) => ({ key, value })), { kind: 'owner', surface: `${policy.commandBase(runtime)} import` })
        : { ok: true as const, saved: [] as readonly ConfigKey[] };
      if (!result.ok) {
        return {
          output: [
            `Bundle not imported: ${result.refusal.reason} State: ${result.refusal.state}.`,
            ...result.refusal.next.map((step) => `  ${step}`),
            ...result.saved.map((key) => `  saved ${key}`),
          ].join('\n'),
          exitCode: 1,
        };
      }
      const refused: string[] = [];
      for (const entry of daemonOwned) {
        try { await bindings.routeDaemonSetting(runtime, entry.key, entry.value); } catch (error) {
          refused.push(`  ${entry.key}: ${summarizeError(error)}`);
        }
      }
      if (refused.length > 0) {
        return {
          output: [`Bundle partly imported: ${count - refused.length} of ${count} config values applied; these daemon settings were not:`, ...refused].join('\n'),
          exitCode: 1,
        };
      }
      return {
        output: `Bundle imported: ${count} config value${count === 1 ? '' : 's'} applied${daemonOwned.length > 0 ? ` (${daemonOwned.length} by the daemon)` : ''}.${redactedNote}`,
        exitCode: 0,
      };
    }
    return { output: `Usage: ${policy.commandBase(runtime)} export [path]|inspect <path>|import <path> [--include-security] [--yes]`, exitCode: 2 };
  }
  return handleBundleCommand;
}
