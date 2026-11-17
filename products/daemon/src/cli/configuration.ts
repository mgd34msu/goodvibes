import { createOriginalDarwinDaemonDataWriter } from '../config/native-installation.js';
import { admitInstalledClientDataWriter } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import { COMPILED_VERSION } from '../version.js';
const installedDataWriter = process.platform === 'darwin' ? undefined : admitInstalledClientDataWriter({ moduleUrl: import.meta.url, execPath: process.execPath, compiledVersion: COMPILED_VERSION, platform: process.platform });
/** One home/tier resolution shared by command and explicit serving entrypoints. */
import { copyFileSync, constants as fsConstants, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConfigManager, daemonConfigPathForHome, resolveGoodVibesHomeOwnership } from '@goodvibes-jev/engine/platform/platform/config';
import { readDaemonSetting } from '@goodvibes-jev/engine/platform/platform/workspace/daemon-home';
import { GOODVIBES_DAEMON_SETTINGS_ROOT, GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import type { DaemonCliFlags } from './types.js';

export function resolveDaemonCliOwnership(
  flags: Pick<DaemonCliFlags, 'daemonHome' | 'workingDir'>,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
) {
  // Resolve flags without mutating the parent environment or process cwd.
  const homes = resolveGoodVibesHomeOwnership({
    ...env,
    ...(env.GOODVIBES_HOME?.trim() ? { GOODVIBES_HOME: resolve(cwd, env.GOODVIBES_HOME.trim()) } : {}),
    ...(flags.daemonHome !== undefined ? { GOODVIBES_DAEMON_HOME: resolve(cwd, flags.daemonHome) }
      : env.GOODVIBES_DAEMON_HOME?.trim() ? { GOODVIBES_DAEMON_HOME: resolve(cwd, env.GOODVIBES_DAEMON_HOME.trim()) } : {}),
  });
  // Working dir: flag > env > the daemon's saved setting (a working-directory
  // change saved through POST /config, applied at this start) > cwd.
  const workingDirectoryOverride = flags.workingDir !== undefined ? '--working-dir'
    : env.GOODVIBES_WORKING_DIR !== undefined ? 'GOODVIBES_WORKING_DIR' : undefined;
  const workingDirectory = resolve(cwd, flags.workingDir ?? env.GOODVIBES_WORKING_DIR
    ?? readDaemonSetting(homes.daemonHomeDirectory, 'runtime.workingDir') ?? cwd);
  return { ...homes, workingDirectory, workingDirectoryOverride };
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
 */
function seedDaemonSettings(baseDirectory: string): void {
  const own = join(baseDirectory, '.goodvibes', GOODVIBES_DAEMON_SETTINGS_ROOT, 'settings.json');
  const previous = join(baseDirectory, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT, 'settings.json');
  try {
    if (existsSync(own) || !existsSync(previous)) return;
    mkdirSync(dirname(own), { recursive: true, mode: 0o700 });
    copyFileSync(previous, own, fsConstants.COPYFILE_EXCL);
  } catch {
    // Another start copied it first, or the directory is not writable: the
    // daemon starts from its defaults for client-scoped settings, as a new install does.
  }
}
