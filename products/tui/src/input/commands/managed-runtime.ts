import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { profileDataToConfigSnapshot } from '@goodvibes-jev/engine/platform/platform/profiles';
import { CONFIG_SCHEMA } from '@goodvibes-jev/engine/platform/platform/config/schema';
import type { ConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
import { CONFIG_KEYS } from '@goodvibes-jev/engine/platform/platform/config/schema';
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
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { describeSetupTransferChanges, isSecurityBearingChange } from './local-setup-transfer.ts';

/** The stored settings, never an owner-profile value: a rollback must not pin a profile value as a setting. */
function buildConfigSnapshot(
  manager: { get: (key: ConfigKey) => unknown },
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const entry of CONFIG_SCHEMA) {
    try {
      snapshot[entry.key] = structuredClone(manager.get(entry.key));
    } catch {
      // A key with no place in this build's settings tree is not part of the snapshot.
    }
  }
  return snapshot;
}

function splitKeyArguments(values: readonly string[]): { requestedKeys: ConfigKey[]; invalidKeys: string[] } {
  // `--yes` answers the registry's question in advance; it never selects a key.
  const keys = values.filter((value) => value !== '--yes');
  return {
    requestedKeys: keys.filter((value): value is ConfigKey => CONFIG_KEYS.has(value as ConfigKey)),
    invalidKeys: keys.filter((value) => !CONFIG_KEYS.has(value as ConfigKey)),
  };
}

type PlannedChange = { readonly key: string; readonly previous: unknown; readonly next: unknown };

/** `apply-staged [--stage <id>] [key ...]`: the stage id the person reviewed, and the rest. */
function splitStageArgument(args: readonly string[]): { readonly stageId?: string | undefined; readonly rest: readonly string[] } {
  const at = args.indexOf('--stage');
  if (at < 0) return { rest: args };
  return { stageId: args[at + 1], rest: [...args.slice(0, at), ...args.slice(at + 2)] };
}

/**
 * The setting changes an `apply <path>` or `apply-staged` line would make, read
 * from the bundle file or the staged record with no model and no write; undefined
 * for any other line or one the handler will refuse.
 */
function plannedManagedChanges(args: readonly string[], ctx: CommandContext): (readonly PlannedChange[] & { readonly stageId?: string }) | undefined {
  const config = ctx.platform.configManager;
  if (args[0] === 'apply' && args[1]) {
    const { requestedKeys, invalidKeys } = splitKeyArguments(args.slice(2));
    if (invalidKeys.length > 0) return undefined;
    let bundle: ManagedSettingsBundle;
    try {
      bundle = readBundleFile(requireShellPaths(ctx).resolveWorkspacePath(args[1])) as ManagedSettingsBundle;
    } catch {
      return undefined;
    }
    if (!bundle || typeof bundle !== 'object' || !bundle.settings || typeof bundle.settings !== 'object') return undefined;
    return Object.entries(bundle.settings)
      .filter(([key]) => CONFIG_KEYS.has(key as ConfigKey) && (requestedKeys.length === 0 || requestedKeys.includes(key as ConfigKey)))
      .map(([key, next]) => ({ key, previous: config.get(key as ConfigKey), next }))
      .filter((change) => JSON.stringify(change.previous) !== JSON.stringify(change.next));
  }
  if (args[0] === 'apply-staged') {
    const { stageId, rest } = splitStageArgument(args.slice(1));
    const { requestedKeys, invalidKeys } = splitKeyArguments(rest);
    const staged = getSettingsControlPlaneSnapshot(config).stagedManagedBundle;
    if (invalidKeys.length > 0 || !staged || (stageId !== undefined && staged.id !== stageId)) return undefined;
    // The stage shown is the one applied: its id goes to the handler as what was reviewed.
    return Object.assign(staged.changes
      .filter((change) => change.changed && (requestedKeys.length === 0 || requestedKeys.includes(change.key)))
      .map((change) => ({ key: change.key, previous: change.previousValue, next: change.nextValue })), { stageId: staged.id });
  }
  return undefined;
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

const MANAGED_USAGE_ARGS = '[review|staged|rollback-history|export <profile> <path>|inspect <path>|stage <path>|apply <path> [key ...]|apply-staged [--stage <id>] [key ...]|rollback <token>|lock <key> <source> <reason...>|unlock <key>]';
const MANAGED_USAGE = `Usage: /managed ${MANAGED_USAGE_ARGS}`;

export function registerManagedRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'managed',
    // A lock reason is free text, kept as typed.
    rawRest: (args) => ((args[0] ?? '').toLowerCase() === 'lock' ? 3 : undefined),
    description: 'Export, inspect, and apply managed settings bundles',
    usage: MANAGED_USAGE_ARGS,
    confirm(args, ctx) {
      if (args[0] === 'unlock' && args[1]) {
        return { title: `Unlock managed setting ${args[1]}?`, detail: `The managed lock on ${args[1]} is cleared, so it can be changed here again. A lock set by your organisation is a security setting; /managed lock sets it again.`, confirmLabel: 'Unlock' };
      }
      // Applying a bundle asks once only when it changes a key that can loosen security or holds a credential.
      const changes = plannedManagedChanges(args, ctx);
      if (!changes || !changes.some(isSecurityBearingChange)) return undefined;
      return {
        title: 'Apply managed settings that change security?',
        detail: [...describeSetupTransferChanges(changes), 'Each applied key is locked as managed; /managed rollback <token> puts the previous values back.'].join('\n'),
        confirmLabel: 'Apply',
        ...(changes.stageId !== undefined ? { reviewed: changes.stageId } : {}),
      };
    },
    async handler(args, ctx, reviewed?: unknown) {
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
        const { stageId, rest } = splitStageArgument(args.slice(1));
        const { requestedKeys, invalidKeys } = splitKeyArguments(rest);
        if (invalidKeys.length > 0) {
          ctx.print(`Unknown config key(s): ${invalidKeys.join(', ')}`);
          return;
        }
        if (args.includes('--stage') && !stageId) {
          ctx.print('Usage: /managed apply-staged [--stage <id>] [key ...] (the id is on the stage line of /managed staged)');
          return;
        }
        try {
          // The stage the confirmation showed, else the one named with --stage: another stage put there since is refused.
          const reviewedStageId = typeof reviewed === 'string' ? reviewed : stageId;
          const result = await applyStagedManagedBundle(ctx.platform.configManager, requestedKeys, reviewedStageId);
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
          ctx.print(`Managed rollback ${token} restored ${restored} setting(s).`);
        } catch (error) {
          recordSettingsSyncFailure('managed', summarizeError(error), controlPlaneConfigDir);
          ctx.print(summarizeError(error));
        }
        return;
      }

      // A mistyped subcommand is a usage error, not a failed sync: nothing is recorded.
      if (sub !== 'inspect' && sub !== 'stage' && sub !== 'apply') {
        ctx.print(`Unknown subcommand "${sub}".\n${MANAGED_USAGE}`);
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

        // Exactly the stage this line made: another process's stage written in between is refused, not applied.
        const result = await applyStagedManagedBundle(ctx.platform.configManager, keyArguments.requestedKeys, stage.id);
        ctx.print(`Managed settings bundle applied from ${sourcePath} (${result.appliedCount} changes, risk=${stage.risk}, rollback ${result.rollbackToken}${result.remainingCount > 0 ? `, ${result.remainingCount} still staged` : ''}).${ignoredNote}`);
      } catch (error) {
        recordSettingsSyncFailure('managed', summarizeError(error), controlPlaneConfigDir);
        ctx.print(`/managed ${sub} failed: ${summarizeError(error)}`);
      }
    },
  });
}
