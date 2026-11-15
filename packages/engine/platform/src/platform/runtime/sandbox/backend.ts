import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type {
  SandboxBackendAvailability,
  SandboxBackendProbe,
  SandboxLaunchPlan,
  SandboxProfile,
} from './types.js';
import { getSandboxConfigSnapshot, type ConfigManagerLike } from './manager.js';

export function probeSandboxBackends(
  manager: ConfigManagerLike,
): SandboxBackendProbe {
  const config = getSandboxConfigSnapshot(manager);
  const backends: readonly SandboxBackendAvailability[] = [
    Object.freeze({
      id: 'local',
      available: true,
      detail: 'host-local process isolation is available when explicitly selected',
    }),
  ];
  return Object.freeze({
    requestedBackend: config.vmBackend,
    resolvedBackend: 'local',
    backends,
    warnings: [],
  });
}

function buildCommandSummary(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ').trim();
}

export function buildSandboxLaunchPlan(
  profile: SandboxProfile,
  label: string,
  workspaceRoot: string,
): SandboxLaunchPlan {
  const args = ['-lc', `echo "goodvibes sandbox ${profile.id}: ${label}"`];
  return Object.freeze({
    backend: 'local',
    command: process.env.SHELL || 'bash',
    args,
    workspaceRoot: resolve(workspaceRoot),
    summary: buildCommandSummary(process.env.SHELL || 'bash', args),
  });
}

export interface SandboxCommandPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly summary: string;
}

export function resolveSandboxCommandPlan(
  command: string,
  args: readonly string[],
): SandboxCommandPlan {
  return Object.freeze({
    command,
    args,
    summary: buildCommandSummary(command, args),
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
    const child = spawn(command, [...args], {
      cwd: options.cwd ?? launchPlan.workspaceRoot,
      env: { ...baseEnv, ...options.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // A timed-out command is killed and reported with no exit status, as the synchronous form did.
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
