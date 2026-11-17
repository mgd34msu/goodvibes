import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CommandRegistry } from '../command-registry.ts';
import type { ProfileBundleEntry, ProfileSyncBundle } from '@/runtime/index.ts';
import { recordSettingsSyncEvent, recordSettingsSyncFailure } from '@/runtime/index.ts';
import { requireProfileManager, requireShellPaths } from './runtime-services.ts';

function inspectProfileSyncBundle(bundle: ProfileSyncBundle): string {
  return [
    'Profile Sync Bundle Review',
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  profiles: ${bundle.profiles.length}`,
    `  activeProfile: ${bundle.activeProfile ?? '(none)'}`,
  ].join('\n');
}

export function registerProfileSyncRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'profile-sync',
    aliases: ['profilesync'],
    description: 'Export, import, and inspect profile sync bundles',
    usage: '[list|export <path>|inspect <path>|import <path> [prefix] [--overwrite]]',
    handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const controlPlaneConfigDir = ctx.platform.configManager.getControlPlaneConfigDir();
      const sub = args[0] ?? 'list';
      const pm = requireProfileManager(ctx);
      if (sub === 'list') {
        const profiles = pm.list();
        ctx.print(
          profiles.length > 0
            ? ['Profile Sync', ...profiles.map((profile) => `  ${profile.name}  ${new Date(profile.timestamp).toISOString()}`)].join('\n')
            : 'Profile Sync\n  No profiles saved yet.',
        );
        return;
      }

      const pathArg = args[1];
      if (!pathArg) {
        ctx.print(`Usage: /profile-sync ${sub} <path>${sub === 'import' ? ' [prefix] [--overwrite]' : ''}`);
        return;
      }
      const targetPath = shellPaths.resolveWorkspacePath(pathArg);

      if (sub === 'export') {
        const profiles = pm.list().map((profile) => {
          const loaded = pm.load(profile.name);
          return {
            name: profile.name,
            timestamp: loaded.timestamp,
            data: loaded.data,
          } satisfies ProfileBundleEntry;
        });
        const bundle: ProfileSyncBundle = {
          version: 1,
          exportedAt: Date.now(),
          profiles,
        };
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
        recordSettingsSyncEvent({
          surface: 'profiles',
          direction: 'export',
          path: targetPath,
          timestamp: Date.now(),
          detail: `${profiles.length} profiles exported`,
        }, controlPlaneConfigDir);
        ctx.print(`Profile sync bundle exported to ${targetPath}`);
        return;
      }

      if (sub === 'inspect') {
        const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as ProfileSyncBundle;
        ctx.print(inspectProfileSyncBundle(bundle));
        return;
      }

      if (sub === 'import') {
        const importArgs = args.slice(2);
        const overwrite = importArgs.includes('--overwrite');
        const prefix = importArgs.find((a) => a !== '--overwrite')?.trim() ?? '';
        let bundle: ProfileSyncBundle;
        try {
          bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as ProfileSyncBundle;
        } catch (error) {
          ctx.print(`Profile sync import failed: cannot read ${targetPath} (${error instanceof Error ? error.message : String(error)}). Nothing was changed.`);
          return;
        }
        const entries: unknown = bundle?.profiles;
        const invalid = Array.isArray(entries)
          ? entries.findIndex((entry: unknown) => {
              const e = entry as { name?: unknown; data?: unknown } | null;
              return typeof e?.name !== 'string' || e.name.trim() === '' || typeof e.data !== 'object' || e.data === null;
            })
          : -2;
        if (invalid === -2) {
          ctx.print(`Profile sync import refused: ${targetPath} is not a profile sync bundle (no "profiles" list). Nothing was changed.`);
          return;
        }
        if (invalid >= 0) {
          ctx.print(`Profile sync import refused: profile entry ${invalid + 1} has no name or data. Nothing was changed.`);
          return;
        }
        const incoming = bundle.profiles.map((entry) => ({ name: prefix ? `${prefix}-${entry.name}` : entry.name, data: entry.data }));
        // Profiles are stored under their sanitized name, so that is the name a clash is judged by.
        const unstorable = incoming.filter((entry) => !/[a-z0-9]/i.test(entry.name)).map((entry) => entry.name);
        if (unstorable.length > 0) {
          ctx.print(`Profile sync import refused: ${unstorable.length} profile name(s) have no letters or digits: ${unstorable.map((name) => JSON.stringify(name)).join(', ')}. Nothing was changed.`);
          return;
        }
        const seen = new Map<string, string>();
        for (const entry of incoming) {
          const stored = pm.sanitizeName(entry.name);
          const first = seen.get(stored);
          if (first !== undefined) {
            ctx.print(`Profile sync import refused: "${first}" and "${entry.name}" are both stored as "${stored}". Nothing was changed.`);
            return;
          }
          seen.set(stored, entry.name);
        }
        const existing = new Set(pm.list().map((profile) => profile.name));
        const clashes = incoming.filter((entry) => existing.has(pm.sanitizeName(entry.name))).map((entry) => pm.sanitizeName(entry.name));
        if (clashes.length > 0 && !overwrite) {
          ctx.print(
            `Profile sync import refused: ${clashes.length} profile(s) already exist: ${clashes.join(', ')}. Nothing was changed.\n`
            + `Re-run with --overwrite to replace them, or give a prefix: /profile-sync import <path> <prefix>`,
          );
          return;
        }
        const saved: string[] = [];
        try {
          for (const entry of incoming) {
            pm.save(entry.name, entry.data);
            saved.push(entry.name);
          }
        } catch (error) {
          recordSettingsSyncFailure('profiles', `import stopped after ${saved.length} of ${incoming.length}: ${error instanceof Error ? error.message : String(error)}`, controlPlaneConfigDir);
          ctx.print(
            `Profile sync import stopped: ${error instanceof Error ? error.message : String(error)}.\n`
            + `  saved before the failure (${saved.length} of ${incoming.length}): ${saved.join(', ') || '(none)'}`,
          );
          return;
        }
        recordSettingsSyncEvent({
          surface: 'profiles',
          direction: 'import',
          path: targetPath,
          timestamp: Date.now(),
          detail: `${incoming.length} profiles imported${prefix ? ` with prefix ${prefix}` : ''}${clashes.length > 0 ? `, ${clashes.length} replaced` : ''}`,
        }, controlPlaneConfigDir);
        ctx.print(
          `Profile sync bundle imported from ${targetPath}: ${incoming.length} profile(s) saved`
          + (clashes.length > 0 ? `, replaced: ${clashes.join(', ')}` : '')
          + '.',
        );
        return;
      }

      // A mistyped subcommand is a usage error, not a failed sync: nothing is recorded.
      ctx.print(`Unknown subcommand "${sub}". Usage: /profile-sync [list|export <path>|inspect <path>|import <path> [prefix] [--overwrite]]`);
    },
  });
}
