/**
 * daemon-program.ts, the one place every program finds the daemon program on this machine and starts it.
 *
 * Finding it: the terminal app's service and status commands, the start-up of both terminal programs, `do` and
 * `find` in all three programs and the Agent's repair all ask {@link findDaemonProgram}, so they agree on whether the
 * daemon is here and which file it is. In order: `GOODVIBES_DAEMON_COMMAND`; this process itself when it is the
 * daemon; the packaged copies under a product's own folder (`dist/`, `vendor/`, `bin/`); the programs beside this
 * one (the installers put the three programs in one directory); `PATH`.
 *
 * Starting it: {@link startDaemonProgram} runs `<program> serve` detached in the login home (where a service would run
 * it), so it outlives the command that started it, its output appended to `started-daemon.log` in the daemon's home.
 * Nothing is asked: a program never fails for want of a running local daemon when the daemon program is here.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, closeSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { resolveGoodVibesDaemonHome, resolveGoodVibesHome } from '../../config/goodvibes-home.js';

/** The daemon program, as a command and the words before its own arguments (a script run by its runtime). */
export interface DaemonProgram {
  readonly command: string;
  readonly args: readonly string[];
  /** Where it was found. */
  readonly source: 'env' | 'self' | 'package' | 'sibling' | 'path';
}

export interface FindDaemonProgramOptions {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly argv?: readonly string[] | undefined;
  readonly execPath?: string | undefined;
  /** A product's own package folders, whose `dist/`, `vendor/` and `bin/` may hold the daemon program. */
  readonly packageRoots?: readonly string[] | undefined;
  /** This process is the daemon program (its own `do` and `find`): it is the answer. */
  readonly self?: boolean | undefined;
}

/** The release file name of the daemon program for this platform. */
export function daemonProgramArtifactName(platform: string = process.platform, arch: string = process.arch): string {
  if (platform === 'linux' && arch === 'x64') return 'goodvibes-daemon-linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'goodvibes-daemon-linux-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'goodvibes-daemon-macos-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'goodvibes-daemon-macos-arm64';
  if (platform === 'win32') return 'goodvibes-daemon-windows.exe';
  return 'goodvibes-daemon';
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function firstExecutable(paths: readonly string[]): string | null {
  for (const path of paths) if (executable(path)) return path;
  return null;
}

/** The daemon programs that may sit beside a program at `path`. */
function besides(path: string): string[] {
  if (!path.trim() || !isAbsolute(path)) return [];
  const dir = dirname(path);
  const name = basename(path);
  const candidates = [join(dir, 'goodvibes-daemon'), join(dir, daemonProgramArtifactName())];
  if (name.startsWith('goodvibes-') && !name.startsWith('goodvibes-daemon-')) candidates.push(join(dir, name.replace(/^goodvibes-/, 'goodvibes-daemon-')));
  return [...new Set(candidates)];
}

/** A packaged `bin/goodvibes-daemon` wrapper's own release file, when the package carries one. */
function packagedFileOfWrapper(path: string): string {
  let real = path;
  try { real = realpathSync(path); } catch { /* the path as given */ }
  if (basename(real) !== 'goodvibes-daemon' || basename(dirname(real)) !== 'bin') return path;
  const root = dirname(dirname(real));
  return firstExecutable([join(root, 'vendor', daemonProgramArtifactName()), join(root, 'dist', daemonProgramArtifactName()), join(root, 'dist', 'goodvibes-daemon')]) ?? path;
}

function onPath(command: string, pathValue: string | undefined, env: NodeJS.ProcessEnv): string | null {
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const entry of (pathValue ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(entry, `${command}${extension}`);
      if (executable(candidate)) return candidate;
    }
  }
  return null;
}

/** Whether this process is the daemon program, and how it was started (a release file, or a script run by its runtime). */
function thisProcess(execPath: string, argv: readonly string[]): DaemonProgram {
  const script = argv[1] ?? '';
  return /\.(?:[cm]?[jt]s)$/.test(script) && isAbsolute(script)
    ? { command: execPath, args: [script], source: 'self' }
    : { command: execPath, args: [], source: 'self' };
}

/** The daemon program on this machine, or null when it is not here. */
export function findDaemonProgram(options: FindDaemonProgramOptions = {}): DaemonProgram | null {
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const argv = options.argv ?? process.argv;
  const override = env.GOODVIBES_DAEMON_COMMAND?.trim();
  if (override) return { command: override, args: [], source: 'env' };
  if (options.self === true || basename(execPath) === 'goodvibes-daemon' || basename(execPath) === daemonProgramArtifactName()) return thisProcess(execPath, argv);
  for (const root of options.packageRoots ?? []) {
    const packaged = firstExecutable([
      join(root, 'dist', daemonProgramArtifactName()), join(root, 'dist', 'goodvibes-daemon'),
      join(root, 'vendor', daemonProgramArtifactName()), join(root, 'bin', 'goodvibes-daemon'),
    ]);
    if (packaged) return { command: packaged, args: [], source: 'package' };
  }
  const sibling = firstExecutable([...besides(execPath), ...besides(argv[1] ?? '')]);
  if (sibling) return { command: packagedFileOfWrapper(sibling), args: [], source: 'sibling' };
  const found = onPath('goodvibes-daemon', env.PATH, env);
  if (found) return { command: packagedFileOfWrapper(found), args: [], source: 'path' };
  return null;
}

/** What starting the daemon program did. */
export type DaemonProgramStart =
  | { readonly ok: true; readonly pid: number; readonly logPath: string; readonly exited: () => number | null }
  | { readonly ok: false; readonly error: string };

/**
 * Start `<program> serve` detached in the login home, its output appended to `started-daemon.log` in the daemon's
 * home. The started daemon belongs to nobody here: it keeps running after this process ends. `exited` says the exit
 * code once it has ended (it lost a race for the port, or failed to start), null while it runs.
 */
export function startDaemonProgram(program: DaemonProgram, env: NodeJS.ProcessEnv = process.env): DaemonProgramStart {
  const daemonHome = resolveGoodVibesDaemonHome(resolveGoodVibesHome(env), env);
  const logPath = join(daemonHome, 'started-daemon.log');
  let log: number | undefined;
  try {
    mkdirSync(daemonHome, { recursive: true });
    log = openSync(logPath, 'a');
    let code: number | null = null;
    let failed: string | undefined;
    // GOODVIBES_WORKING_DIR is a program's own folder: the daemon has no working folder and refuses to start with it.
    const daemonEnv: NodeJS.ProcessEnv = { ...env };
    delete daemonEnv.GOODVIBES_WORKING_DIR;
    const child = spawn(program.command, [...program.args, 'serve'], {
      cwd: env.HOME?.trim() || homedir(),
      env: daemonEnv,
      detached: true,
      shell: false,
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    child.on('error', (error) => { failed = error.message; });
    child.on('exit', (exitCode, signal) => { code = exitCode ?? (signal ? 128 : 1); });
    child.unref();
    if (child.pid === undefined) return { ok: false, error: `${program.command} could not be started${failed ? ` (${failed})` : ''}` };
    return { ok: true, pid: child.pid, logPath, exited: () => code };
  } catch (error) {
    return { ok: false, error: `${program.command} could not be started (${error instanceof Error ? error.message : String(error)})` };
  } finally {
    // The child holds its own copy of the log file.
    if (log !== undefined) try { closeSync(log); } catch { /* already closed */ }
  }
}
