import { retainCliConfig } from './cli-config-owner.js';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { ConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { decisionOrClassic, isClassicOperation, withDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import { captureOwnedJson } from '@goodvibes-jev/engine/platform/platform/gate';
import { createShellPathService, type ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
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
export interface SupportBundleRuntime {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly configManager: Parameters<typeof retainCliConfig>[0];
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
    readonly applySetting: (runtime: Runtime, key: ConfigKey, value: unknown) => void;
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
      const workingDirectory = runtime.workingDirectory,
        homeDirectory = runtime.homeDirectory;
      const signal = options.signal,
        callerCurrent = options.assertCurrent;
      const sourceCurrent = () => {
        signal?.throwIfAborted();
        if (
          options.signal !== signal ||
          options.assertCurrent !== callerCurrent ||
          runtime.configManager !== configManager ||
          runtime.workingDirectory !== workingDirectory ||
          runtime.homeDirectory !== homeDirectory
        )
          throw new Error('Support bundle input changed before export.');
        try {
          retainedConfig.assertCurrent();
        } catch {
          throw new Error('Support bundle input changed before export.');
        }
      };
      const assertCurrent = () => {
        sourceCurrent();
        const result: unknown = callerCurrent?.();
        if (result !== undefined) {
          drainOwned(result);
          throw new Error('Support bundle ownership must be synchronous.');
        }
        sourceCurrent();
      };
      assertCurrent();
      return await bindings.withServices(
        runtime,
        async (services) => {
          assertCurrent();
          const owner = await decisionOrClassic(() => Promise.resolve(captureJudgmentPort(policy.site, { ...options, assertCurrent })),
            () => undefined, () => { assertCurrent(); return true; });
          const current = () => { assertCurrent(); if (!isClassicOperation()) owner?.assertCurrent(); assertCurrent(); };
          current();
          const providers = await providerReadiness(services);
          current();
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
          redactedConfig.assertCurrent();
          current();
          mkdirSync(dirname(targetPath), { recursive: true });
          redactedConfig.assertCurrent();
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
      const path = rest.find((token) => token !== '--yes');
      if (!path) return { output: `Usage: ${policy.commandBase(runtime)} import <path> [--yes]`, exitCode: 2 };
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
      const pending: { key: ConfigKey; value: unknown }[] = [];
      const failed: { key: string; message: string }[] = [];
      let skippedRedacted = 0;
      for (const setting of bindings.schema) {
        const value = getNestedValue(config, setting.key);
        if (value === undefined) continue;
        if (containsRedactedValue(value)) {
          skippedRedacted++;
          continue;
        }
        // Check every value before changing any, so a bad key cannot leave a half-imported configuration.
        try {
          runtime.configManager.validateDynamic(setting.key, value);
          pending.push({ key: setting.key, value });
        } catch (error) {
          failed.push({ key: setting.key, message: summarizeError(error) });
        }
      }
      const redactedNote = skippedRedacted ? ` ${skippedRedacted} redacted value${skippedRedacted === 1 ? '' : 's'} skipped.` : '';
      if (failed.length > 0) {
        return {
          output: [
            `Bundle not imported: ${failed.length} value${failed.length === 1 ? '' : 's'} cannot be applied. Nothing was changed.`,
            ...failed.map((entry) => `  ${entry.key}: ${entry.message}`),
          ].join('\n'),
          exitCode: 1,
        };
      }
      const count = pending.length;
      if (!apply) {
        return {
          output: [
            `Refusing to import ${count} config value${count === 1 ? '' : 's'} without --yes. Nothing was changed.${redactedNote}`,
            ...pending.map((entry) => `  would set ${entry.key}`),
            `Usage: ${policy.commandBase(runtime)} import <path> --yes`,
          ].join('\n'),
          exitCode: 2,
        };
      }
      const applied: string[] = [];
      try {
        for (const entry of pending) {
          bindings.applySetting(runtime, entry.key, entry.value);
          applied.push(entry.key);
        }
      } catch (error) {
        return {
          output: [
            `Bundle import stopped after ${applied.length} of ${count} value${count === 1 ? '' : 's'}: ${summarizeError(error)}`,
            ...applied.map((key) => `  applied ${key}`),
          ].join('\n'),
          exitCode: 1,
        };
      }
      return {
        output: `Bundle imported: ${count} config value${count === 1 ? '' : 's'} applied.${redactedNote}`,
        exitCode: 0,
      };
    }
    return { output: `Usage: ${policy.commandBase(runtime)} export [path]|inspect <path>|import <path> [--yes]`, exitCode: 2 };
  }
  return handleBundleCommand;
}
