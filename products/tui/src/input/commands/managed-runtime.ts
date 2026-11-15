import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { profileDataToConfigSnapshot } from '@goodvibes-jev/engine/platform/platform/profiles';
import { CONFIG_SCHEMA, type ConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
import { getProviderIdFromModel } from '@goodvibes-jev/engine/platform/platform/providers';
import { CONFIG_KEYS } from '@goodvibes-jev/engine/platform/platform/config';
import type { ManagedSettingsBundle } from '@/runtime/index.ts';
import {
  applyStagedManagedBundle,
  clearManagedSettingLock,
  formatStagedManagedBundleReview,
  getSettingsControlPlaneSnapshot,
  inspectManagedSettingsBundle,
  recordSettingsSyncEvent,
  recordSettingsSyncFailure,
  rollbackManagedApply,
  setManagedSettingLock,
  stageManagedSettingsBundle,
} from '@/runtime/index.ts';
import { requireProfileManager, requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

/** The stored settings, never an owner-profile value: a rollback must not pin a profile value as a setting. */
function buildConfigSnapshot(
  manager: { getStored: (key: ConfigKey) => unknown },
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const entry of CONFIG_SCHEMA) {
    try {
      snapshot[entry.key] = structuredClone(manager.getStored(entry.key));
    } catch {
      // A key with no place in this build's settings tree is not part of the snapshot.
    }
  }
  return snapshot;
}

/** The session's model fields mirror three config keys; refresh them after any change to the config. */
function syncRuntimeMirror(ctx: CommandContext): void {
  const config = ctx.platform.configManager;
  ctx.session.runtime.model = String(config.get('provider.model'));
  ctx.session.runtime.provider = getProviderIdFromModel(config.get('provider.model'));
  ctx.session.runtime.reasoningEffort = config.get('provider.reasoningEffort') as string;
}

function splitKeyArguments(values: readonly string[]): { requestedKeys: ConfigKey[]; invalidKeys: string[]; yes: boolean } {
  const yes = values.includes('--yes');
  const keys = values.filter((value) => value !== '--yes');
  return {
    requestedKeys: keys.filter((value): value is ConfigKey => CONFIG_KEYS.has(value as ConfigKey)),
    invalidKeys: keys.filter((value) => !CONFIG_KEYS.has(value as ConfigKey)),
    yes,
  };
}

function readBundleFile(sourcePath: string): unknown {
  let text: string;
  try {
    text = readFileSync(sourcePath, 'utf-8');
  } catch (error) {
    throw new Error(`Cannot read ${sourcePath}: ${summarizeError(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${sourcePath} is not valid JSON, so it is not a managed settings bundle.`);
  }
}

const MANAGED_USAGE_ARGS = '[review|staged|rollback-history|export <profile> <path>|inspect <path>|stage <path>|apply <path> [key ...] [--yes]|apply-staged [key ...]|rollback <token>|lock <key> <source> <reason...>|unlock <key>]';
const MANAGED_USAGE = `Usage: /managed ${MANAGED_USAGE_ARGS}`;

export function registerManagedRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'managed',
    description: 'Export, inspect, and apply managed settings bundles',
    usage: MANAGED_USAGE_ARGS,
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const controlPlaneConfigDir = ctx.platform.configManager.getControlPlaneConfigDir();
      const sub = args[0] ?? 'review';
      const pm = requireProfileManager(ctx);
      if (sub === 'review') {
        const profiles = pm.list();
        const snapshot = getSettingsControlPlaneSnapshot(ctx.platform.configManager);
        ctx.print([
          'Managed Settings Review',
          `  saved profiles: ${profiles.length}`,
          `  live config keys: ${Object.keys(buildConfigSnapshot(ctx.platform.configManager)).length}`,
          `  staged bundle: ${snapshot.stagedManagedBundle ? snapshot.stagedManagedBundle.profileName : 'none'}`,
          `  active locks: ${snapshot.managedLockCount}`,
          `  rollback records: ${snapshot.rollbackHistory.length}`,
        ].join('\n'));
        return;
      }

      if (sub === 'staged') {
        ctx.print(formatStagedManagedBundleReview(ctx.platform.configManager));
        return;
      }

      if (sub === 'rollback-history') {
        const snapshot = getSettingsControlPlaneSnapshot(ctx.platform.configManager);
        ctx.print(snapshot.rollbackHistory.length > 0
          ? [
              'Managed Rollback History',
              ...snapshot.rollbackHistory.map((entry) => (
                `  ${entry.token}  ${entry.profileName}  restored=${entry.restoredKeys.length}  ${new Date(entry.appliedAt).toLocaleString()}`
              )),
            ].join('\n')
          : 'Managed Rollback History\n  No managed rollback records yet.');
        return;
      }

      if (sub === 'lock') {
        const key = args[1] as ConfigKey | undefined;
        const source = args[2];
        const reason = args.slice(3).join(' ').trim();
        if (!key || !source || !reason) {
          ctx.print('Usage: /managed lock <key> <source> <reason...>');
          return;
        }
        if (!CONFIG_KEYS.has(key)) {
          ctx.print(`Unknown config key: ${key}. No lock was recorded.`);
          return;
        }
        setManagedSettingLock(key, source, reason, controlPlaneConfigDir);
        ctx.print(`Managed lock recorded for ${key}.`);
        return;
      }

      if (sub === 'unlock') {
        const key = args[1] as ConfigKey | undefined;
        if (!key) {
          ctx.print('Usage: /managed unlock <key>');
          return;
        }
        if (!CONFIG_KEYS.has(key)) {
          ctx.print(`Unknown config key: ${key}.`);
          return;
        }
        ctx.print(clearManagedSettingLock(key, controlPlaneConfigDir) ? `Managed lock cleared for ${key}.` : `No managed lock found for ${key}.`);
        return;
      }

      if (sub === 'export') {
        const profileName = args[1];
        const pathArg = args[2];
        if (!profileName || !pathArg) {
          ctx.print('Usage: /managed export <profile> <path>');
          return;
        }
        const loaded = pm.load(profileName);
        const bundle: ManagedSettingsBundle = {
          version: 1,
          exportedAt: Date.now(),
          profileName,
          settings: profileDataToConfigSnapshot(loaded.data),
        };
        const targetPath = shellPaths.resolveWorkspacePath(pathArg);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
        recordSettingsSyncEvent({
          surface: 'managed',
          direction: 'export',
          path: targetPath,
          timestamp: Date.now(),
          detail: `${Object.keys(bundle.settings).length} settings exported from ${profileName}`,
        }, controlPlaneConfigDir);
        ctx.print(`Managed settings bundle exported to ${targetPath}`);
        return;
      }

      if (sub === 'apply-staged') {
        const { requestedKeys, invalidKeys } = splitKeyArguments(args.slice(1));
        if (invalidKeys.length > 0) {
          ctx.print(`Unknown config key(s): ${invalidKeys.join(', ')}`);
          return;
        }
        try {
          const result = await applyStagedManagedBundle(ctx.platform.configManager, requestedKeys);
          syncRuntimeMirror(ctx);
          ctx.print(`Staged managed settings applied (${result.appliedCount} changes, rollback ${result.rollbackToken}${result.remainingCount > 0 ? `, ${result.remainingCount} still staged` : ''}).`);
        } catch (error) {
          recordSettingsSyncFailure('managed', summarizeError(error), controlPlaneConfigDir);
          ctx.print(summarizeError(error));
        }
        return;
      }

      if (sub === 'rollback') {
        const token = args[1];
        if (!token) {
          ctx.print('Usage: /managed rollback <token>');
          return;
        }
        try {
          const restored = rollbackManagedApply(ctx.platform.configManager, token);
          syncRuntimeMirror(ctx);
          ctx.print(`Managed rollback ${token} restored ${restored} setting(s).`);
        } catch (error) {
          recordSettingsSyncFailure('managed', summarizeError(error), controlPlaneConfigDir);
          ctx.print(summarizeError(error));
        }
        return;
      }

      if (sub !== 'inspect' && sub !== 'stage' && sub !== 'apply') {
        recordSettingsSyncFailure('managed', `unsupported subcommand: ${sub}`, controlPlaneConfigDir);
        ctx.print(MANAGED_USAGE);
        return;
      }
      const pathArg = args[1];
      if (!pathArg) {
        ctx.print(`Usage: /managed ${sub} <path>`);
        return;
      }
      const sourcePath = shellPaths.resolveWorkspacePath(pathArg);
      const keyArguments = splitKeyArguments(args.slice(2));
      if (sub === 'apply' && keyArguments.invalidKeys.length > 0) {
        ctx.print(`Unknown config key(s): ${keyArguments.invalidKeys.join(', ')}`);
        return;
      }

      try {
        const bundle = readBundleFile(sourcePath) as ManagedSettingsBundle;

        if (sub === 'inspect') {
          ctx.print(await inspectManagedSettingsBundle(ctx.platform.configManager, bundle, sourcePath));
          return;
        }

        const stage = await stageManagedSettingsBundle(ctx.platform.configManager, bundle, sourcePath);
        const ignoredNote = stage.ignoredKeys && stage.ignoredKeys.length > 0
          ? `\nIgnored unknown keys (not staged): ${stage.ignoredKeys.join(', ')}`
          : '';
        if (sub === 'stage') {
          ctx.print(`Managed settings bundle staged from ${sourcePath} (${stage.changeCount} changes, risk=${stage.risk}).${ignoredNote}`);
          return;
        }

        // apply: a bundle that is not known to be low risk is staged for review instead of applied in one step.
        if (stage.risk !== 'low' && !keyArguments.yes) {
          ctx.print([
            `Managed settings bundle staged from ${sourcePath} (${stage.changeCount} changes, risk=${stage.risk}); nothing was applied.`,
            'Review it with /managed staged, then run /managed apply-staged, or re-run /managed apply <path> --yes.',
            ...(ignoredNote ? [ignoredNote.trimStart()] : []),
          ].join('\n'));
          return;
        }
        const result = await applyStagedManagedBundle(ctx.platform.configManager, keyArguments.requestedKeys);
        syncRuntimeMirror(ctx);
        ctx.print(`Managed settings bundle applied from ${sourcePath} (${result.appliedCount} changes, risk=${stage.risk}, rollback ${result.rollbackToken}${result.remainingCount > 0 ? `, ${result.remainingCount} still staged` : ''}).${ignoredNote}`);
      } catch (error) {
        recordSettingsSyncFailure('managed', summarizeError(error), controlPlaneConfigDir);
        ctx.print(`/managed ${sub} failed: ${summarizeError(error)}`);
      }
    },
  });
}
