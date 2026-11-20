import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  applySettingsSyncBundle,
  exportSettingsSyncBundle,
  formatResolvedSettingReview,
  resolveSettingsSyncConflict,
  formatSettingsControlPlaneReview,
  getSettingsControlPlaneSnapshot,
  inspectSettingsSyncBundle,
  recordSettingsSyncEvent,
  recordSettingsSyncFailure,
  type SettingsSyncBundle,
} from '@/runtime/index.ts';
import { type ConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
import { CONFIG_KEYS } from '@goodvibes-jev/engine/platform/platform/config/schema';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { defineCommand, defineList, type ListRow } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { doAction, listInput, readAction, textInput } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { requireShellPaths } from '@goodvibes-jev/engine/terminal-shell/command-service-access';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { describeSetupTransferChanges, isSecurityBearingChange } from './local-setup-transfer.ts';

/** Read a settings sync bundle, refusing in words (never a stack) a file that is unreadable, not JSON, or not shaped like a bundle. */
function readSettingsSyncBundle(sourcePath: string): SettingsSyncBundle {
  let text: string;
  try {
    text = readFileSync(sourcePath, 'utf-8');
  } catch (error) {
    throw new Error(`Cannot read ${sourcePath}: ${summarizeError(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${sourcePath} is not valid JSON, so it is not a settings sync bundle.`);
  }
  const bundle = parsed as Partial<Record<keyof SettingsSyncBundle, unknown>> | null;
  const settings = bundle?.settings;
  if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle)
    || typeof settings !== 'object' || settings === null || Array.isArray(settings)
    || typeof bundle.exportedAt !== 'number' || !Number.isFinite(bundle.exportedAt) || Number.isNaN(new Date(bundle.exportedAt).getTime())) {
    throw new Error(`${sourcePath} is not a settings sync bundle: expected a JSON object with a numeric exportedAt and a settings object. Nothing was applied.`);
  }
  return parsed as SettingsSyncBundle;
}

const TERMINAL_ONLY = 'Synced settings are kept on this machine.';

const CONFLICTS = defineList<CommandContext>({
  name: 'settings-sync.conflicts',
  async read(ctx) {
    return getSettingsControlPlaneSnapshot(ctx.platform.configManager).conflicts.map((conflict): ListRow => ({ value: conflict.key, label: conflict.key, detail: `from ${conflict.source}` }));
  },
  operator: { terminalOnly: TERMINAL_ONLY },
});
const BUNDLE = textInput({ id: 'path', label: 'Bundle file', help: 'A settings sync bundle (JSON)', why: 'a file path in this project', kind: 'path', typed: { position: 1 } });

export function registerSettingsSyncRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'settings-sync',
    title: 'Settings sync',
    summary: 'Carry your settings to another machine as a file, and settle values that disagree',
    group: 'Settings',
    report: 'review',
    firstScreenRows: ['review', 'export', 'pull', 'conflicts', 'resolve', { label: 'Look closer', actions: ['inspect', 'show', 'failures', 'open'] }],
    actions: [
      readAction<CommandContext>({
        id: 'review', label: 'See where your settings come from', word: 'review',
        sentence: 'Shows which layers your settings come from, sync state, conflicts, locks and recent failures.',
        async run(_values, ctx) { return formatSettingsControlPlaneReview(ctx.platform.configManager).join('\n'); },
      }),
      doAction<CommandContext>({
        id: 'open', label: 'Open the settings sync screen', word: 'open', touches: 'reads',
        sentence: 'Opens the full-screen view of synced settings and conflicts.', operator: { terminalOnly: 'It is a terminal screen.' },
        async run(_values, ctx) {
          if (!ctx.openModal) throw commandRefusal('This surface has no settings sync screen.', '/settings-sync review shows the same.');
          ctx.openModal('settings-sync-modal');
        },
      }),
      readAction<CommandContext>({
        id: 'show', label: 'See where one setting\'s value comes from', word: 'show',
        inputs: [textInput({ id: 'key', label: 'Setting', help: 'A setting key, as /settings shows it', why: 'a setting key from /settings', typed: { position: 1 } })],
        sentence: 'Shows {key}\'s value in each layer and which one wins.', example: { key: 'provider.model' },
        async run(values, ctx) {
          if (!CONFIG_KEYS.has(values.key as ConfigKey)) throw commandRefusal(`Unknown setting key: ${values.key}.`);
          return formatResolvedSettingReview(ctx.platform.configManager, values.key as ConfigKey);
        },
      }),
      readAction<CommandContext>({
        id: 'conflicts', label: 'See settings that disagree', word: 'conflicts',
        sentence: 'Shows the settings whose synced value differs from this machine\'s.',
        async run(_values, ctx) {
          const snapshot = getSettingsControlPlaneSnapshot(ctx.platform.configManager);
          return snapshot.conflicts.length > 0
            ? ['Settings Sync Conflicts', ...snapshot.conflicts.map((conflict) => `  ${conflict.key}  source=${conflict.source}  path=${conflict.path}`)].join('\n')
            : 'Settings Sync Conflicts\n  No settings conflicts recorded.';
        },
      }),
      {
        id: 'resolve', label: 'Settle a setting that disagrees', word: 'resolve',
        inputs: [
          listInput({ id: 'key', label: 'Setting', help: 'Settings that disagree', list: CONFLICTS }),
          { id: 'keep', label: 'Keep', help: 'Which value wins', kind: 'choice', choices: [{ value: 'local', label: 'This machine\'s value' }, { value: 'synced', label: 'The synced value' }], required: true, typed: { position: 2 } },
        ],
        sentence: '{key} keeps the {keep} value until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { terminalOnly: TERMINAL_ONLY }, example: { key: 'provider.model', keep: 'local' },
        async run(values, ctx) {
          if (!resolveSettingsSyncConflict(ctx.platform.configManager, values.key as ConfigKey, values.keep as 'local' | 'synced')) {
            throw commandRefusal(`No synced conflict found for ${values.key}.`, '/settings-sync conflicts lists the conflicts that are open');
          }
          return `${values.key} keeps the ${values.keep === 'local' ? 'local' : 'synced'} value.`;
        },
      },
      readAction<CommandContext>({
        id: 'failures', label: 'See recent sync failures', word: 'failures',
        sentence: 'Shows the sync and managed-setting attempts that failed recently and why.',
        async run(_values, ctx) {
          const snapshot = getSettingsControlPlaneSnapshot(ctx.platform.configManager);
          return snapshot.recentFailures.length > 0
            ? ['Settings Sync Failures', ...snapshot.recentFailures.map((failure) => `  ${failure.surface}  ${failure.message}`)].join('\n')
            : 'Settings Sync Failures\n  No recent sync or managed-setting failures recorded.';
        },
      }),
      doAction<CommandContext>({
        id: 'export', label: 'Save your settings to a sync bundle', word: 'export', inputs: [{ ...BUNDLE, help: 'Where to write the bundle' }],
        sentence: 'Your settings are written to {path} as a bundle another machine can pull.',
        operator: { terminalOnly: TERMINAL_ONLY }, example: { path: 'settings-sync.json' },
        async run(values, ctx) {
          const targetPath = requireShellPaths(ctx).resolveWorkspacePath(values.path!);
          const bundle = exportSettingsSyncBundle(ctx.platform.configManager);
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
          recordSettingsSyncEvent({ surface: 'settings-sync', direction: 'export', path: targetPath, timestamp: Date.now(), detail: `${Object.keys(bundle.settings).length} settings exported` }, ctx.platform.configManager.getControlPlaneConfigDir());
          return `Saved the settings sync bundle to ${targetPath}`;
        },
      }),
      readAction<CommandContext>({
        id: 'inspect', label: 'Look inside a sync bundle', word: 'inspect', inputs: [BUNDLE],
        sentence: 'Shows what {path} holds; nothing is changed.', example: { path: 'settings-sync.json' },
        async run(values, ctx) {
          try {
            return inspectSettingsSyncBundle(readSettingsSyncBundle(requireShellPaths(ctx).resolveWorkspacePath(values.path!)));
          } catch (error) {
            recordSettingsSyncFailure('settings-sync', summarizeError(error), ctx.platform.configManager.getControlPlaneConfigDir());
            throw commandRefusal(`Cannot inspect ${values.path}: ${summarizeError(error)}`);
          }
        },
      }),
      {
        id: 'pull', label: 'Take the settings from a sync bundle', word: 'pull', inputs: [BUNDLE],
        sentence: 'The settings in {path} replace yours until you change them, except keys a managed lock owns; changes that touch security are shown and asked about first.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { terminalOnly: TERMINAL_ONLY }, example: { path: 'settings-sync.json' },
        async run(values, ctx) {
          const sourcePath = requireShellPaths(ctx).resolveWorkspacePath(values.path!);
          const config = ctx.platform.configManager;
          try {
            // One read: the changes shown are the changes applied.
            const bundle = readSettingsSyncBundle(sourcePath);
            const changes = Object.entries(bundle.settings)
              .filter(([key]) => CONFIG_KEYS.has(key as ConfigKey))
              .map(([key, next]) => ({ key, previous: config.get(key as ConfigKey), next }))
              .filter((change) => JSON.stringify(change.previous) !== JSON.stringify(change.next));
            if (changes.some(isSecurityBearingChange)) {
              const body = [...describeSetupTransferChanges(changes), 'A key a managed lock owns is skipped; /managed history lists what changed.'].join('\n');
              if (!ctx.confirm) throw commandRefusal(`These synced settings change security, so they are pulled only where you can be asked:\n${body}`);
              if (!(await ctx.confirm({ title: 'Pull synced settings that change security?', body, confirmLabel: 'Pull', cancelLabel: 'Back', tone: 'danger' }))) throw commandRefusal('Not pulled: nothing was changed.');
            }
            const result = applySettingsSyncBundle(config, bundle, sourcePath);
            return `Pulled the settings sync bundle from ${sourcePath} (${result.appliedCount} applied, ${result.conflictCount} conflicts${result.skippedLockedKeys ? `, ${result.skippedLockedKeys.length} skipped because managed locks own them: ${result.skippedLockedKeys.join(', ')}` : ''}).`;
          } catch (error) {
            recordSettingsSyncFailure('settings-sync', summarizeError(error), config.getControlPlaneConfigDir());
            throw commandRefusal(`Not pulled: ${summarizeError(error)}`, '/settings-sync inspect <file> shows what the bundle holds');
          }
        },
      },
    ],
  }));
}
