import { createOriginalDarwinDaemonDataWriter } from '../config/native-installation.js';
import { admitInstalledClientDataWriter } from '@goodvibes/engine/platform/platform/runtime/self-update';
import { COMPILED_VERSION } from '../version.js';
const installedDataWriter = process.platform === 'darwin' ? undefined : admitInstalledClientDataWriter({ moduleUrl: import.meta.url, execPath: process.execPath, compiledVersion: COMPILED_VERSION, platform: process.platform });
/** One home/tier resolution shared by command and explicit serving entrypoints. */
import { copyFileSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigManager, daemonConfigPathForHome, resolveGoodVibesHomeOwnership } from '@goodvibes/engine/platform/platform/config';
import { GOODVIBES_DAEMON_SETTINGS_ROOT, GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import { mirrorManagedLocksForRelease } from '@goodvibes/engine/platform/platform/runtime/settings';
import type { DaemonCliFlags } from './types.js';
import { daemonHomeEnvironment } from './daemon-home-environment.js';

export function resolveDaemonCliOwnership(
  flags: Pick<DaemonCliFlags, 'daemonHome' | 'workingDir'>,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
) {
  // A working folder named for the daemon is refused, with the one sentence, before anything is read or made.
  if (flags.workingDir !== undefined || env.GOODVIBES_WORKING_DIR !== undefined) throw new Error(DAEMON_HAS_NO_WORKING_FOLDER);
  // Resolve flags without mutating the parent environment or process cwd.
  const homes = resolveGoodVibesHomeOwnership(daemonHomeEnvironment(flags, env, cwd));
  // The folder the daemon was started in (or a folder a 3.5.0 daemon saved) means nothing: the daemon serves every
  // project at once and makes a project's files, code index, checkpoints and identity only for a project a call or a
  // turn names. Its own working folder is a folder of its own in its home, which no project is and nobody works in;
  // its records are in its home too (daemon-records.ts), carried from the folders a 3.5.0 daemon used.
  const workingDirectory = daemonOwnFolder(homes.daemonHomeDirectory);
  return { ...homes, workingDirectory };
}

/** What the daemon says when started with `--working-dir` (`-C`, `--cd`) or GOODVIBES_WORKING_DIR. */
export const DAEMON_HAS_NO_WORKING_FOLDER = 'The daemon no longer has a working folder, so --working-dir (-C, --cd) and GOODVIBES_WORKING_DIR are refused: each program and each schedule names its own project; start goodvibes-daemon without them.';

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
  // Every managed lock that holds is also kept where a released 3.5.0 reads locks, so a rollback weakens nothing
  // (a lock an administrator put in a folder of this version by hand is copied there at this start).
  if (options.readOnly !== true) mirrorManagedLocksForRelease(config);
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
