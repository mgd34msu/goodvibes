import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
import { defineCommand, defineList, type ListRow } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { doAction, listInput, readAction, textInput } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
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

function splitKeyArguments(keys: readonly string[]): { requestedKeys: ConfigKey[]; invalidKeys: string[] } {
  return {
    requestedKeys: keys.filter((value): value is ConfigKey => CONFIG_KEYS.has(value as ConfigKey)),
    invalidKeys: keys.filter((value) => !CONFIG_KEYS.has(value as ConfigKey)),
  };
}

type PlannedChange = { readonly key: string; readonly previous: unknown; readonly next: unknown };

/** The setting changes `bundle` makes (only `requestedKeys` when any are named); undefined when it is not a bundle. */
function bundleChanges(bundle: ManagedSettingsBundle, requestedKeys: readonly ConfigKey[], config: CommandContext['platform']['configManager']): PlannedChange[] | undefined {
  if (!bundle || typeof bundle !== 'object' || !bundle.settings || typeof bundle.settings !== 'object') return undefined;
  return Object.entries(bundle.settings)
    .filter(([key]) => CONFIG_KEYS.has(key as ConfigKey) && (requestedKeys.length === 0 || requestedKeys.includes(key as ConfigKey)))
    .map(([key, next]) => ({ key, previous: config.get(key as ConfigKey), next }))
    .filter((change) => JSON.stringify(change.previous) !== JSON.stringify(change.next));
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

/**
 * Applying changes that can loosen security or hold a credential shows them
 * and asks first; what is applied is exactly what was shown (this one read of
 * the bundle, or the stage id shown). Anything else applies at once.
 */
async function askBeforeSecurityChanges(ctx: CommandContext, changes: readonly PlannedChange[]): Promise<void> {
  if (!changes.some(isSecurityBearingChange)) return;
  const body = [...describeSetupTransferChanges(changes), 'Each applied key is locked as managed; /managed rollback <token> puts the previous values back.'].join('\n');
  if (!ctx.confirm) throw commandRefusal(`These managed settings change security, so they are applied only where you can be asked:\n${body}`);
  if (!(await ctx.confirm({ title: 'Apply managed settings that change security?', body, confirmLabel: 'Apply', cancelLabel: 'Back', tone: 'danger' }))) {
    throw commandRefusal('Not applied: nothing was changed.');
  }
}

function keysOf(text: string | undefined): ConfigKey[] {
  const { requestedKeys, invalidKeys } = splitKeyArguments((text ?? '').split('\n').map((key) => key.trim()).filter(Boolean));
  if (invalidKeys.length > 0) throw commandRefusal(`Unknown setting key(s): ${invalidKeys.join(', ')}. Nothing was applied.`);
  return requestedKeys;
}

const TERMINAL_ONLY = 'Managed settings are kept on this machine.';

const PROFILES = defineList<CommandContext>({
  name: 'managed.profiles',
  async read(ctx) { return requireProfileManager(ctx).list().map((profile): ListRow => ({ value: profile.name, label: profile.name })); },
  operator: { terminalOnly: TERMINAL_ONLY },
});
const ROLLBACKS = defineList<CommandContext>({
  name: 'managed.rollbacks',
  async read(ctx) {
    return getSettingsControlPlaneSnapshot(ctx.platform.configManager).rollbackHistory.map((entry): ListRow => ({
      value: entry.token, label: `${entry.profileName}, ${new Date(entry.appliedAt).toLocaleString()}`, state: `${entry.restoredKeys.length} setting(s)`,
    }));
  },
  operator: { terminalOnly: TERMINAL_ONLY },
});

const BUNDLE = textInput({ id: 'path', label: 'Bundle file', help: 'A managed settings bundle (JSON)', why: 'a file path in this project', kind: 'path', typed: { position: 1 } });
const ONLY_KEYS = textInput({ id: 'keys', label: 'Only these settings', help: 'Setting keys, separated by commas', why: 'setting keys from /settings', typed: { flag: '--key', repeats: true }, optional: { default: '', means: 'every setting in it' } });
const KEY = textInput({ id: 'key', label: 'Setting', help: 'A setting key, as /settings shows it', why: 'a setting key from /settings', typed: { position: 1 } });

export function registerManagedRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'managed',
    // --yes confirms only right after the action word: the same word in the text is text.
    leadingFlagsOnly: true,
    title: 'Managed settings',
    summary: 'Apply settings bundles your organisation manages, lock settings, and roll an apply back',
    group: 'Settings',
    report: 'review',
    firstScreenRows: [
      'review', 'apply', 'staged', 'apply-staged',
      { label: 'Look at and stage bundles', actions: ['inspect', 'stage', 'export'] },
      { label: 'Roll back an apply', actions: ['history', 'rollback'] },
      { label: 'Lock or unlock a setting', actions: ['lock', 'unlock'] },
    ],
    actions: [
      readAction<CommandContext>({
        id: 'review', label: 'See managed settings at a glance', word: 'review',
        sentence: 'Shows saved profiles, the staged bundle, active locks and rollback records.',
        async run(_values, ctx) {
          const snapshot = getSettingsControlPlaneSnapshot(ctx.platform.configManager);
          return [
            'Managed Settings Review',
            `  saved profiles: ${requireProfileManager(ctx).list().length}`,
            `  live config keys: ${Object.keys(buildConfigSnapshot(ctx.platform.configManager)).length}`,
            `  staged bundle: ${snapshot.stagedManagedBundle ? snapshot.stagedManagedBundle.profileName : 'none'}`,
            `  active locks: ${snapshot.managedLockCount}`,
            `  rollback records: ${snapshot.rollbackHistory.length}`,
          ].join('\n');
        },
      }),
      readAction<CommandContext>({
        id: 'staged', label: 'See the staged bundle', word: 'staged',
        sentence: 'Shows the bundle staged to apply, its stage id and each change it makes.',
        async run(_values, ctx) { return formatStagedManagedBundleReview(ctx.platform.configManager); },
      }),
      readAction<CommandContext>({
        id: 'history', label: 'See applies you can roll back', word: 'history',
        sentence: 'Shows each managed apply with its rollback token and how many settings it changed.',
        async run(_values, ctx) {
          const snapshot = getSettingsControlPlaneSnapshot(ctx.platform.configManager);
          return snapshot.rollbackHistory.length > 0
            ? ['Managed Rollback History', ...snapshot.rollbackHistory.map((entry) => `  ${entry.token}  ${entry.profileName}  restored=${entry.restoredKeys.length}  ${new Date(entry.appliedAt).toLocaleString()}`)].join('\n')
            : 'Managed Rollback History\n  No managed rollback records yet.';
        },
      }),
      readAction<CommandContext>({
        id: 'inspect', label: 'Look inside a managed bundle', word: 'inspect', inputs: [BUNDLE],
        sentence: 'Shows what {path} would change here and how risky it is; nothing is changed.', example: { path: 'managed/team.json' },
        async run(values, ctx) {
          const sourcePath = requireShellPaths(ctx).resolveWorkspacePath(values.path!);
          try {
            return await inspectManagedSettingsBundle(ctx.platform.configManager, readBundleFile(sourcePath) as ManagedSettingsBundle, sourcePath);
          } catch (error) {
            throw commandRefusal(`Cannot inspect ${values.path}: ${summarizeError(error)}`);
          }
        },
      }),
      doAction<CommandContext>({
        id: 'export', label: 'Save a profile as a managed bundle', word: 'export',
        inputs: [listInput({ id: 'profile', label: 'Profile', help: 'Your saved settings profiles', list: PROFILES }), { ...BUNDLE, help: 'Where to write the bundle', typed: { position: 2 } }],
        sentence: 'The settings of profile {profile} are written to {path} as a managed bundle.',
        operator: { terminalOnly: TERMINAL_ONLY }, example: { profile: 'team', path: 'managed/team.json' },
        async run(values, ctx) {
          const loaded = requireProfileManager(ctx).load(values.profile!);
          const bundle: ManagedSettingsBundle = { version: 1, exportedAt: Date.now(), profileName: values.profile!, settings: profileDataToConfigSnapshot(loaded.data) };
          const targetPath = requireShellPaths(ctx).resolveWorkspacePath(values.path!);
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
          recordSettingsSyncEvent({ surface: 'managed', direction: 'export', path: targetPath, timestamp: Date.now(), detail: `${Object.keys(bundle.settings).length} settings exported from ${values.profile}` }, ctx.platform.configManager.getControlPlaneConfigDir());
          return `Saved the managed settings bundle to ${targetPath}`;
        },
      }),
      {
        id: 'stage', label: 'Stage a managed bundle to apply later', word: 'stage', inputs: [BUNDLE],
        sentence: 'The changes in {path} are staged, ready to apply, until you change it; nothing is applied yet.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { terminalOnly: TERMINAL_ONLY }, example: { path: 'managed/team.json' },
        async run(values, ctx) {
          const sourcePath = requireShellPaths(ctx).resolveWorkspacePath(values.path!);
          try {
            const stage = await stageManagedSettingsBundle(ctx.platform.configManager, readBundleFile(sourcePath) as ManagedSettingsBundle, sourcePath);
            return `Staged the managed settings bundle from ${sourcePath} (${stage.changeCount} changes, risk=${stage.risk}, stage ${stage.id}).${stage.ignoredKeys && stage.ignoredKeys.length > 0 ? `\nIgnored unknown keys (not staged): ${stage.ignoredKeys.join(', ')}` : ''}`;
          } catch (error) {
            recordSettingsSyncFailure('managed', summarizeError(error), ctx.platform.configManager.getControlPlaneConfigDir());
            throw commandRefusal(`Not staged: ${summarizeError(error)}`);
          }
        },
      },
      {
        id: 'apply', label: 'Apply a managed bundle', word: 'apply', inputs: [BUNDLE, ONLY_KEYS],
        sentence: 'The settings in {path} are applied and locked as managed until you change it (or roll it back); changes that touch security are shown and asked about first.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'rollback',
        operator: { terminalOnly: TERMINAL_ONLY }, example: { path: 'managed/team.json' },
        async run(values, ctx) {
          const requestedKeys = keysOf(values.keys);
          const sourcePath = requireShellPaths(ctx).resolveWorkspacePath(values.path!);
          let bundle: ManagedSettingsBundle;
          try { bundle = readBundleFile(sourcePath) as ManagedSettingsBundle; } catch (error) { throw commandRefusal(`Not applied: ${summarizeError(error)}`); }
          // One read: the changes shown are the changes staged and applied below.
          await askBeforeSecurityChanges(ctx, bundleChanges(bundle, requestedKeys, ctx.platform.configManager) ?? []);
          try {
            const stage = await stageManagedSettingsBundle(ctx.platform.configManager, bundle, sourcePath);
            // Exactly the stage this action made: another process's stage written in between is refused, not applied.
            const result = await applyStagedManagedBundle(ctx.platform.configManager, requestedKeys, stage.id);
            return `Applied the managed settings bundle from ${sourcePath} (${result.appliedCount} changes, risk=${stage.risk}, rollback ${result.rollbackToken}${result.remainingCount > 0 ? `, ${result.remainingCount} still staged` : ''}).${stage.ignoredKeys && stage.ignoredKeys.length > 0 ? `\nIgnored unknown keys (not staged): ${stage.ignoredKeys.join(', ')}` : ''}`;
          } catch (error) {
            recordSettingsSyncFailure('managed', summarizeError(error), ctx.platform.configManager.getControlPlaneConfigDir());
            throw commandRefusal(`Not applied: ${summarizeError(error)}`);
          }
        },
      },
      {
        id: 'apply-staged', label: 'Apply the staged bundle', word: 'apply-staged', inputs: [ONLY_KEYS],
        sentence: 'The staged settings are applied and locked as managed until you change it (or roll it back); changes that touch security are shown and asked about first.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'rollback',
        operator: { terminalOnly: TERMINAL_ONLY }, example: {},
        async run(values, ctx) {
          const requestedKeys = keysOf(values.keys);
          const staged = getSettingsControlPlaneSnapshot(ctx.platform.configManager).stagedManagedBundle;
          if (!staged) throw commandRefusal('Nothing is staged.', 'Stage a bundle with /managed stage <file>.');
          await askBeforeSecurityChanges(ctx, staged.changes
            .filter((change) => change.changed && (requestedKeys.length === 0 || requestedKeys.includes(change.key as ConfigKey)))
            .map((change) => ({ key: change.key, previous: change.previousValue, next: change.nextValue })));
          try {
            // The stage shown is the one applied: another stage put there since is refused.
            const result = await applyStagedManagedBundle(ctx.platform.configManager, requestedKeys, staged.id);
            return `Applied the staged managed settings (${result.appliedCount} changes, rollback ${result.rollbackToken}${result.remainingCount > 0 ? `, ${result.remainingCount} still staged` : ''}).`;
          } catch (error) {
            recordSettingsSyncFailure('managed', summarizeError(error), ctx.platform.configManager.getControlPlaneConfigDir());
            throw commandRefusal(`Not applied: ${summarizeError(error)}`);
          }
        },
      },
      {
        id: 'rollback', label: 'Put back the values from before an apply', word: 'rollback',
        inputs: [listInput({ id: 'token', label: 'Apply', help: 'Past managed applies', list: ROLLBACKS })],
        sentence: 'The settings apply {token} changed get their earlier values back, until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { terminalOnly: TERMINAL_ONLY }, example: { token: 'rb-3f1c' },
        async run(values, ctx) {
          try {
            return `Rollback ${values.token} put back ${rollbackManagedApply(ctx.platform.configManager, values.token!)} setting(s).`;
          } catch (error) {
            recordSettingsSyncFailure('managed', summarizeError(error), ctx.platform.configManager.getControlPlaneConfigDir());
            throw commandRefusal(`Not rolled back: ${summarizeError(error)}`);
          }
        },
      },
      {
        id: 'lock', label: 'Lock a setting as managed', word: 'lock',
        inputs: [KEY, textInput({ id: 'source', label: 'Who manages it', help: 'Who set the lock (your team, an admin)', why: 'a name you choose', typed: { position: 2 } }), textInput({ id: 'reason', label: 'Why', help: 'The reason shown to whoever tries to change it', why: 'your own words', typed: { tail: true } })],
        sentence: '{key} is locked as managed by {source} ("{reason}"), so it cannot be changed here, until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'unlock',
        operator: { terminalOnly: TERMINAL_ONLY }, example: { key: 'permissions.mode', source: 'security-team', reason: 'set by policy' },
        async run(values, ctx) {
          if (!CONFIG_KEYS.has(values.key as ConfigKey)) throw commandRefusal(`Unknown setting key: ${values.key}. No lock was recorded.`);
          setManagedSettingLock(values.key as ConfigKey, values.source!, values.reason!, ctx.platform.configManager.getControlPlaneConfigDir());
          return `Locked ${values.key}.`;
        },
      },
      {
        id: 'unlock', label: 'Unlock a managed setting', word: 'unlock', inputs: [KEY],
        sentence: 'The managed lock on {key} is cleared, so it can be changed here again, until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'lock',
        ownerOnly: { reason: 'a lock set by your organisation is a security setting', instead: 'Ask the owner to unlock it with /managed unlock.' },
        operator: { terminalOnly: TERMINAL_ONLY }, example: { key: 'permissions.mode' },
        async run(values, ctx) {
          if (!CONFIG_KEYS.has(values.key as ConfigKey)) throw commandRefusal(`Unknown setting key: ${values.key}.`);
          if (!clearManagedSettingLock(values.key as ConfigKey, ctx.platform.configManager.getControlPlaneConfigDir())) throw commandRefusal(`${values.key} has no managed lock.`);
          return `Unlocked ${values.key}.`;
        },
      },
    ],
  }));
}
