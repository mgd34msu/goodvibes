import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { buildBwrapArgv, hostSandboxAvailability, runResolverConfigPath } from '../../tools/exec/sandbox.js';
import type {
  SandboxBackendProbe,
  SandboxLaunchPlan,
  SandboxProfile,
} from './types.js';

/**
 * The boundary a sandbox session can use on this host: bubblewrap when the
 * exec sandbox's host probe passed (the same one value the exec tool acts on),
 * otherwise host processes with no boundary.
 */
export function probeSandboxBackends(): SandboxBackendProbe {
  const availability = hostSandboxAvailability();
  return Object.freeze({
    resolvedBackend: availability.available ? 'bubblewrap' : 'host',
    backends: [
      Object.freeze({ id: 'bubblewrap' as const, available: availability.available, detail: availability.reason }),
      Object.freeze({ id: 'host' as const, available: true, detail: 'runs the process directly on the host, with no boundary' }),
    ],
    warnings: availability.available ? [] : [`processes cannot be contained on this host: ${availability.reason}`],
  });
}

/**
 * The launch plan for a session of this profile. Nothing is spawned here; each
 * process the session runs is wrapped with {@link sandboxCommandWrapper}.
 */
export function buildSandboxLaunchPlan(
  profile: SandboxProfile,
  workspaceRoot: string,
  writableExtras: readonly string[] = [],
): SandboxLaunchPlan {
  const root = resolve(workspaceRoot);
  const availability = hostSandboxAvailability();
  if (!availability.available || !availability.bwrapPath) {
    return Object.freeze({
      backend: 'host',
      workspaceRoot: root,
      writableExtras: [],
      network: 'enabled',
      summary: `host process in ${root}, no boundary (${availability.reason})`,
    });
  }
  const extras = writableExtras.filter((path) => isAbsolute(path));
  return Object.freeze({
    backend: 'bubblewrap',
    bwrapPath: availability.bwrapPath,
    workspaceRoot: root,
    writableExtras: extras,
    network: profile.network,
    summary: `bubblewrap: workspace ${root} writable${extras.length > 0 ? ` (and ${extras.join(', ')})` : ''}, system read-only, $HOME and /tmp private, `
      + (profile.network === 'enabled' ? 'host network shared' : 'network off'),
  });
}

/** Paths the boundary already binds read-only from the host. */
const SYSTEM_ROOTS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'];

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** `.../prefix/bin/tool` → `.../prefix`, so the tool's own libraries come with it. */
function installRoot(executable: string, home: string): string {
  const dir = dirname(executable);
  const root = basename(dir) === 'bin' ? dirname(dir) : dir;
  // Never re-expose the whole home directory the boundary hides.
  return within(home, root) ? dir : root;
}

/**
 * The host paths a program needs to start inside the boundary that the
 * boundary does not already provide: the install root of the executable (and
 * of its link target), and every absolute path argument (a script or a data
 * directory). Bound read-only. A program on the system paths needs none.
 *
 * A path argument inside the home directory the boundary hides is never bound:
 * an argument such as ~/.ssh/id_rsa would otherwise expose its directory to a
 * boundary that promises $HOME private. Such a path is seen only when it lies
 * in the workspace or in sandbox.workspaceWritable, which the boundary binds
 * itself.
 */
export function programReadOnlyPaths(command: string, args: readonly string[], workspaceRoot: string, home: string = homedir()): string[] {
  const paths = new Set<string>();
  const add = (path: string): void => {
    if (path === '/' || within(home, path)) return;
    if (SYSTEM_ROOTS.some((root) => within(path, root)) || within(path, workspaceRoot)) return;
    paths.add(path);
  };
  let resolvedHome: string | undefined;
  const realHome = (): string => {
    if (resolvedHome === undefined) {
      try { resolvedHome = realpathSync(home); } catch { resolvedHome = home; }
    }
    return resolvedHome;
  };
  const executable = isAbsolute(command) ? command : Bun.which(command);
  if (executable) {
    add(installRoot(executable, home));
    try { add(installRoot(realpathSync(executable), home)); } catch { /* a dangling link starts nothing; the spawn reports it */ }
  }
  for (const arg of args) {
    if (!isAbsolute(arg) || within(resolve(arg), home) || !existsSync(arg)) continue;
    try {
      // A link outside home that leads into it would bind its target.
      const target = realpathSync(arg);
      if ((within(target, home) || within(target, realHome())) && !within(target, workspaceRoot)) continue;
      add(statSync(arg).isDirectory() ? arg : dirname(arg));
    } catch { /* unreadable: the program reports it */ }
  }
  return [...paths];
}

/**
 * The argv to start `command` through so it runs inside the plan's boundary,
 * or an empty list for a host plan. `cwd` is resolved against the workspace.
 */
export function sandboxCommandWrapper(
  plan: SandboxLaunchPlan,
  command: string,
  args: readonly string[],
  cwd?: string | undefined,
): readonly string[] {
  if (plan.backend !== 'bubblewrap' || !plan.bwrapPath) return [];
  const home = homedir();
  const resolverConfigPath = plan.network === 'enabled' ? runResolverConfigPath() : undefined;
  return buildBwrapArgv({
    bwrapPath: plan.bwrapPath,
    workspaceDir: plan.workspaceRoot,
    cwd: cwd ? resolve(plan.workspaceRoot, cwd) : plan.workspaceRoot,
    writableExtras: plan.writableExtras,
    networkEnabled: plan.network === 'enabled',
    maskHomeDir: home,
    readOnlyExtras: programReadOnlyPaths(command, args, plan.workspaceRoot, home),
    ...(resolverConfigPath ? { resolverConfigPath } : {}),
  });
}

export interface SandboxCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function executeSandboxCommand(
  launchPlan: SandboxLaunchPlan,
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly inheritHostEnv?: boolean | undefined;
    readonly timeoutMs?: number | undefined;
    readonly input?: string | undefined;
  } = {},
): Promise<SandboxCommandResult> {
  const baseEnv = options.inheritHostEnv === false ? {} : process.env;
  const wrapper = sandboxCommandWrapper(launchPlan, command, args, options.cwd);
  const [program, ...programArgs] = wrapper.length > 0 ? [...wrapper, command, ...args] : [command, ...args];
  // Asynchronous so a slow command does not freeze the caller's event loop (the terminal UI).
  return new Promise((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (status: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(Object.freeze({ status, stdout, stderr }));
    };
    const child = spawn(program!, programArgs, {
      // Inside a boundary the working directory is set by the wrapper (--chdir).
      cwd: wrapper.length > 0 ? launchPlan.workspaceRoot : options.cwd ?? launchPlan.workspaceRoot,
      env: { ...baseEnv, ...options.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // A timed-out command is killed and reported with no exit status.
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(null); }, options.timeoutMs ?? 5000);
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.stdin.on('error', () => { /* the command exited before reading its input */ });
    child.on('error', (error) => { stderr = stderr || error.message; finish(null); });
    child.on('close', (code) => finish(code));
    child.stdin.end(options.input);
  });
}
