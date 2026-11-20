/**
 * The one launcher a product's `build` and `smoke` scripts use to run the
 * toolchain CLI of the engine installed in its workspace.
 *
 * It resolves the bin the installed engine declares (so it works when install
 * scripts were disabled and no bin shim exists), runs it in the product root,
 * forwards an interrupt to the whole build, and waits for the build to end.
 * Arguments are checked by the bin itself; a product passes `validate` only for
 * a rule of its own.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import { dirname, resolve } from 'node:path';

export const WORKSPACE_TOOLCHAIN_COMMANDS = {
  build: 'goodvibes-build-binaries',
  smoke: 'goodvibes-post-build-smoke',
} as const;

export type WorkspaceToolchainCommand = keyof typeof WORKSPACE_TOOLCHAIN_COMMANDS;

const USAGE = 'Usage: run-toolchain.ts build|smoke [arguments]';

/** The build or smoke run was stopped by a signal; `exitCode` is the shell convention (128 + signal number). */
export class WorkspaceToolchainInterrupted extends Error {
  readonly exitCode: number;
  constructor(readonly signal: NodeJS.Signals) {
    super(`The toolchain run was stopped by ${signal} before it finished; its output is incomplete. Run the command again.`);
    this.name = 'WorkspaceToolchainInterrupted';
    this.exitCode = 128 + (constants.signals[signal] ?? 15);
  }
}

export function isWorkspaceToolchainCommand(command: string): command is WorkspaceToolchainCommand {
  return Object.hasOwn(WORKSPACE_TOOLCHAIN_COMMANDS, command);
}

/** Path of the CLI the product's installed engine declares for `command`. */
export function resolveWorkspaceToolchain(productRoot: string, command: string): string {
  if (!isWorkspaceToolchainCommand(command)) throw new Error(USAGE);
  const require = createRequire(resolve(productRoot, 'package.json'));
  const manifestPath = require.resolve('@goodvibes/engine/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: Record<string, unknown> };
  const name = WORKSPACE_TOOLCHAIN_COMMANDS[command];
  const entry = manifest.bin?.[name];
  if (typeof entry !== 'string') throw new Error(`The workspace engine does not declare ${name}.`);
  const path = resolve(dirname(manifestPath), entry);
  if (!existsSync(path)) throw new Error(`Build the workspace engine before running ${name}. Missing declared CLI: ${path}`);
  return path;
}

export interface WorkspaceToolchainOptions {
  /** A product's own argument rule, checked before anything starts. */
  readonly validate?: (command: WorkspaceToolchainCommand, args: readonly string[]) => void;
  /** Runtime that executes the CLI (default: the current one). */
  readonly execPath?: string;
}

const FORWARDED: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

/**
 * Run the declared CLI with `args` and resolve with its exit code. On POSIX the
 * build runs as its own process group: an interrupt is passed to the whole
 * group, and whatever the build leaves running when it exits is killed, so no
 * grandchild keeps writing build output after the command returned.
 */
export async function runWorkspaceToolchain(
  productRoot: string,
  command: string,
  args: readonly string[],
  options: WorkspaceToolchainOptions = {},
): Promise<number> {
  if (!isWorkspaceToolchainCommand(command)) throw new Error(USAGE);
  options.validate?.(command, args);
  const cli = resolveWorkspaceToolchain(productRoot, command);
  const group = process.platform !== 'win32';
  const child = spawn(options.execPath ?? process.execPath, [cli, ...args], {
    cwd: productRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: group,
  });
  const signalBuild = (signal: NodeJS.Signals): void => {
    try {
      if (group && child.pid !== undefined) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  let interruptedBy: NodeJS.Signals | undefined;
  const forward = (signal: NodeJS.Signals): void => { interruptedBy ??= signal; signalBuild(signal); };
  for (const signal of FORWARDED) process.on(signal, forward);
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('exit', (code, signal) => {
        // The leader is gone; end anything it left in its group right away,
        // before the group id can be reused.
        if (group) signalBuild('SIGKILL');
        resolveExit({ code, signal });
      });
    });
    const stoppedBy = interruptedBy ?? exit.signal;
    if (stoppedBy) throw new WorkspaceToolchainInterrupted(stoppedBy);
    return exit.code ?? 1;
  } finally {
    for (const signal of FORWARDED) process.off(signal, forward);
  }
}
