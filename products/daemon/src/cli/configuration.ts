import { createOriginalDarwinDaemonDataWriter } from '../config/native-installation.js';
import { admitInstalledClientDataWriter } from '@goodvibes/engine/platform/platform/runtime/self-update';
import { COMPILED_VERSION } from '../version.js';
const installedDataWriter = process.platform === 'darwin' ? undefined : admitInstalledClientDataWriter({ moduleUrl: import.meta.url, execPath: process.execPath, compiledVersion: COMPILED_VERSION, platform: process.platform });
/** One home/tier resolution shared by command and explicit serving entrypoints. */
import { copyFileSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConfigManager, daemonConfigPathForHome, resolveGoodVibesHomeOwnership } from '@goodvibes/engine/platform/platform/config';
import { readDaemonSetting } from '@goodvibes/engine/platform/platform/workspace/daemon-home';
import { GOODVIBES_DAEMON_SETTINGS_ROOT, GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import type { DaemonCliFlags } from './types.js';
import { daemonHomeEnvironment } from './daemon-home-environment.js';

export function resolveDaemonCliOwnership(
  flags: Pick<DaemonCliFlags, 'daemonHome' | 'workingDir'>,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
) {
  // Resolve flags without mutating the parent environment or process cwd.
  const homes = resolveGoodVibesHomeOwnership(daemonHomeEnvironment(flags, env, cwd));
  // The folder the daemon was started in (flag > env > a folder a 3.5.0 daemon saved > cwd) means nothing: the daemon
  // serves every project at once and makes a project's files, code index, checkpoints and identity only for a project a
  // call or a turn names. Its own working folder is a folder of its own in its home, which no project is and nobody
  // works in; its records are in its home too (daemon-records.ts), carried from the folders a 3.5.0 daemon used.
  const startFolder = resolve(cwd, flags.workingDir ?? env.GOODVIBES_WORKING_DIR
    ?? readDaemonSetting(homes.daemonHomeDirectory, 'runtime.workingDir') ?? cwd);
  const workingDirectory = daemonOwnFolder(homes.daemonHomeDirectory);
  return { ...homes, workingDirectory, startFolder };
}

/** The daemon's own working folder, in its home: nothing a project does lands here, and it is never a project. */
export function daemonOwnFolder(daemonHomeDirectory: string): string {
  const folder = join(daemonHomeDirectory, 'own-folder');
  try { mkdirSync(folder, { recursive: true, mode: 0o700 }); } catch { /* the start reports an unwritable home itself */ }
  return folder;
}

export function createDaemonCliConfiguration(
  flags: Pick<DaemonCliFlags, 'daemonHome' | 'workingDir'>,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  options: {
    readonly diagnosticMode?: 'default' | 'structural' | undefined;
    readonly readOnly?: boolean;
  } = {},
) {
  const nativeDataWriter = process.platform === 'darwin' ? createOriginalDarwinDaemonDataWriter() : installedDataWriter;
  const homes = resolveDaemonCliOwnership(flags, env, cwd);
  const { workingDirectory } = homes;
  if (options.readOnly !== true) {
    seedDaemonSettings(homes.homeDirectory);
    seedDaemonSettings(workingDirectory);
  }
  const config = new ConfigManager({
    nativeDataWriter,
    workingDir: workingDirectory, homeDir: homes.homeDirectory,
    surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
    // Client-scoped settings in the daemon's own file, not the terminal app's.
    settingsSurfaceRoot: GOODVIBES_DAEMON_SETTINGS_ROOT,
    daemonTierPath: daemonConfigPathForHome(homes.daemonHomeDirectory),
    // The daemon's own command line writes the daemon's settings file
    // (`goodvibes-daemon config set controlPlane.port 4321`); a running daemon
    // picks the change up from the file.
    ownsDaemonTier: options.readOnly !== true,
    diagnosticMode: options.diagnosticMode,
    readOnly: options.readOnly,
  });
  return { ...homes, workingDirectory, config };
}
export type DaemonCliConfiguration = ReturnType<typeof createDaemonCliConfiguration>;

/**
 * The daemon read its client-scoped settings from the terminal app's file
 * before it had its own. The first start with its own file begins from a copy
 * of that one, so nothing the daemon was configured with changes underfoot;
 * from then on the two are separate. One existence check per start.
 *
 * The copy leaves out `daemon.connectedHost.*`: those say which daemon the
 * terminal app dials, and in the daemon's file they would aim every flag-less
 * daemon command (status, cluster, mcp) at that other daemon. A file that is
 * not a JSON object is copied as it is; the daemon's settings reader reports it.
 */
function seedDaemonSettings(baseDirectory: string): void {
  const own = join(baseDirectory, '.goodvibes', GOODVIBES_DAEMON_SETTINGS_ROOT, 'settings.json');
  const previous = join(baseDirectory, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT, 'settings.json');
  try {
    if (existsSync(own) || !existsSync(previous)) return;
    mkdirSync(dirname(own), { recursive: true, mode: 0o700 });
    const text = readFileSync(previous, 'utf-8');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      copyFileSync(previous, own, fsConstants.COPYFILE_EXCL);
      return;
    }
    writeFileSync(own, `${JSON.stringify(withoutConnectedHost(parsed as Record<string, unknown>), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    // Another start copied it first, or the directory is not writable: the
    // daemon starts from its defaults for client-scoped settings, as a new install does.
  }
}

/** The settings without `daemon.connectedHost`, written nested or as dotted keys. */
function withoutConnectedHost(settings: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'daemon.connectedHost' || key.startsWith('daemon.connectedHost.')) continue;
    if (key === 'daemon' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const daemon = Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([inner]) => inner !== 'connectedHost' && !inner.startsWith('connectedHost.')));
      if (Object.keys(daemon).length > 0) copy[key] = daemon;
      continue;
    }
    copy[key] = value;
  }
  return copy;
}
