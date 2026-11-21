/**
 * `/presets`, described once (command-actions/): saved sets of display,
 * model and behaviour settings. Pick one to load (or save the current
 * settings as one), and move them between machines as a file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { defineCommand } from '@goodvibes/engine/terminal-shell/command-actions';
import { choiceInput, doAction, readAction, textInput } from '@goodvibes/engine/terminal-shell/described-command-kit';
import type { ProfileBundleEntry, ProfileSyncBundle } from '@/runtime/index.ts';
import { recordSettingsSyncEvent, recordSettingsSyncFailure } from '@/runtime/index.ts';
import { requireProfileManager, requireShellPaths } from './runtime-services.ts';

function inspectProfileSyncBundle(bundle: ProfileSyncBundle): string {
  return [
    'Presets file',
    `  saved: ${new Date(bundle.exportedAt).toISOString()}`,
    `  presets: ${bundle.profiles.length}`,
    `  in use when saved: ${bundle.activeProfile ?? '(none)'}`,
  ].join('\n');
}

const FILE = textInput({ id: 'path', label: 'File', help: 'A presets file', why: 'a file on this machine', kind: 'path', typed: { position: 1 } });
const LOCAL_ONLY = { terminalOnly: 'Presets are files of this terminal app on this machine.' } as const;

/** Read a presets file, or a refusal that says why it cannot be used. */
function readBundle(targetPath: string): ProfileSyncBundle {
  try {
    return JSON.parse(readFileSync(targetPath, 'utf-8')) as ProfileSyncBundle;
  } catch (error) {
    throw commandRefusal(`${targetPath} cannot be read (${error instanceof Error ? error.message : String(error)}). Nothing was changed.`);
  }
}

export function registerProfileSyncRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'presets',
    title: 'Presets',
    summary: 'Saved sets of display, model and behaviour settings: load one, save yours as one, and move them between machines',
    group: 'Settings',
    report: 'list',
    actions: [
      doAction<CommandContext>({
        id: 'open', label: 'Pick a preset', word: 'open', touches: 'reads',
        sentence: 'Opens your presets: Enter loads one, Ctrl+S saves the current settings as one, Ctrl+D deletes one.', operator: LOCAL_ONLY,
        async run(_values, ctx) {
          if (!ctx.openProfilePicker) throw commandRefusal('The presets picker is not available here.', '/presets list shows them.');
          ctx.openProfilePicker();
        },
      }),
      readAction<CommandContext>({
        id: 'list', label: 'See your presets', word: 'list',
        sentence: 'Lists your saved presets and when each was saved.', operator: LOCAL_ONLY,
        async rowValue(ctx) { const count = requireProfileManager(ctx).list().length; return count === 0 ? 'none yet' : `${count} saved`; },
        async run(_values, ctx) {
          const profiles = requireProfileManager(ctx).list();
          return profiles.length > 0
            ? ['Presets', ...profiles.map((profile) => `  ${profile.name}  ${new Date(profile.timestamp).toISOString()}`)].join('\n')
            : 'No presets saved yet. Pick a preset (/presets open) and press Ctrl+S to save the current settings as one.';
        },
      }),
      {
        id: 'export', label: 'Save your presets to a file', word: 'export',
        inputs: [FILE, choiceInput({
          id: 'overwrite', label: 'If the file exists', help: 'Keep it, or write over it',
          choices: [{ value: 'no', label: 'Keep it and stop' }, { value: 'yes', label: 'Write over it', risk: 'cannot-be-undone' }],
          typed: { flag: '--overwrite', switchOn: 'yes' }, optional: { default: 'no', means: 'keep it and stop' },
        })],
        sentence: 'Every preset is written to {path}, to bring to another machine, until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', operator: LOCAL_ONLY, example: { path: 'presets.json' },
        async run(values, ctx) {
          const targetPath = requireShellPaths(ctx).resolveWorkspacePath(values.path!);
          if (existsSync(targetPath) && values.overwrite !== 'yes') throw commandRefusal(`${targetPath} already exists; nothing was written.`, `Write over it: /presets export ${values.path} --overwrite`);
          const pm = requireProfileManager(ctx);
          const profiles = pm.list().map((profile) => {
            const loaded = pm.load(profile.name);
            return { name: profile.name, timestamp: loaded.timestamp, data: loaded.data } satisfies ProfileBundleEntry;
          });
          const bundle: ProfileSyncBundle = { version: 1, exportedAt: Date.now(), profiles };
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
          recordSettingsSyncEvent({ surface: 'profiles', direction: 'export', path: targetPath, timestamp: Date.now(), detail: `${profiles.length} profiles exported` }, ctx.platform.configManager.getControlPlaneConfigDir());
          return `Saved ${profiles.length} preset${profiles.length === 1 ? '' : 's'} to ${targetPath}.`;
        },
      },
      readAction<CommandContext>({
        id: 'inspect', label: 'Check a presets file', word: 'inspect', inputs: [FILE],
        sentence: 'Shows what the presets file {path} holds, without adding anything.', example: { path: 'presets.json' }, operator: LOCAL_ONLY,
        async run(values, ctx) { return inspectProfileSyncBundle(readBundle(requireShellPaths(ctx).resolveWorkspacePath(values.path!))); },
      }),
      {
        id: 'import', label: 'Add presets from a file', word: 'import',
        inputs: [
          FILE,
          textInput({ id: 'prefix', label: 'Name prefix', help: 'A word put before each name, so none clash with yours', why: 'a word you choose', typed: { flag: '--prefix' }, optional: { default: '', means: 'their own names' } }),
          choiceInput({
            id: 'overwrite', label: 'If a name is taken', help: 'One of your presets may have the same name',
            choices: [{ value: 'no', label: 'Stop and say so' }, { value: 'yes', label: 'Replace yours', risk: 'cannot-be-undone' }],
            typed: { flag: '--overwrite', switchOn: 'yes' }, optional: { default: 'no', means: 'stop and say so' },
          }),
        ],
        sentence: 'The presets in {path} are added to yours, until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', operator: LOCAL_ONLY, example: { path: 'presets.json', prefix: 'laptop' },
        async run(values, ctx) {
          const controlPlaneConfigDir = ctx.platform.configManager.getControlPlaneConfigDir();
          const pm = requireProfileManager(ctx);
          const targetPath = requireShellPaths(ctx).resolveWorkspacePath(values.path!);
          const overwrite = values.overwrite === 'yes';
          const prefix = values.prefix?.trim() ?? '';
          const bundle = readBundle(targetPath);
          const entries: unknown = bundle?.profiles;
          const invalid = Array.isArray(entries)
            ? entries.findIndex((entry: unknown) => {
                const e = entry as { name?: unknown; data?: unknown } | null;
                return typeof e?.name !== 'string' || e.name.trim() === '' || typeof e.data !== 'object' || e.data === null;
              })
            : -2;
          if (invalid === -2) throw commandRefusal(`${targetPath} is not a presets file (no "profiles" list). Nothing was changed.`);
          if (invalid >= 0) throw commandRefusal(`Preset ${invalid + 1} in the file has no name or settings. Nothing was changed.`);
          const incoming = bundle.profiles.map((entry) => ({ name: prefix ? `${prefix}-${entry.name}` : entry.name, data: entry.data }));
          // Presets are stored under their sanitized name, so that is the name a clash is judged by;
          // the manager's own test decides which names keep nothing once stored.
          const unstorable = incoming.filter((entry) => pm.storedName(entry.name) === undefined).map((entry) => entry.name);
          if (unstorable.length > 0) throw commandRefusal(`${unstorable.length} preset name(s) keep no characters once stored (letters and digits of any script, "-" and "_" are kept): ${unstorable.map((name) => JSON.stringify(name)).join(', ')}. Nothing was changed.`);
          // Every name was proven storable above.
          const storedAs = (name: string): string => pm.storedName(name)!;
          const seen = new Map<string, string>();
          for (const entry of incoming) {
            const stored = storedAs(entry.name);
            const first = seen.get(stored);
            if (first !== undefined) throw commandRefusal(`"${first}" and "${entry.name}" are both stored as "${stored}". Nothing was changed.`);
            seen.set(stored, entry.name);
          }
          const existing = new Set(pm.list().map((profile) => profile.name));
          const clashes = incoming.filter((entry) => existing.has(storedAs(entry.name))).map((entry) => storedAs(entry.name));
          if (clashes.length > 0 && !overwrite) {
            throw commandRefusal(`${clashes.length} preset(s) already exist: ${clashes.join(', ')}. Nothing was changed.`, `Replace them: /presets import ${values.path} --overwrite, or give a prefix: --prefix <word>`);
          }
          const saved: string[] = [];
          try {
            for (const entry of incoming) {
              pm.save(entry.name, entry.data);
              saved.push(entry.name);
            }
          } catch (error) {
            recordSettingsSyncFailure('profiles', `import stopped after ${saved.length} of ${incoming.length}: ${error instanceof Error ? error.message : String(error)}`, controlPlaneConfigDir);
            throw commandRefusal(`Adding presets stopped: ${error instanceof Error ? error.message : String(error)}.\n  saved before it stopped (${saved.length} of ${incoming.length}): ${saved.join(', ') || '(none)'}`);
          }
          recordSettingsSyncEvent({
            surface: 'profiles', direction: 'import', path: targetPath, timestamp: Date.now(),
            detail: `${incoming.length} profiles imported${prefix ? ` with prefix ${prefix}` : ''}${clashes.length > 0 ? `, ${clashes.length} replaced` : ''}`,
          }, controlPlaneConfigDir);
          return `Added ${incoming.length} preset(s) from ${targetPath}${clashes.length > 0 ? `; replaced: ${clashes.join(', ')}` : ''}.`;
        },
      },
    ],
  }));
}
