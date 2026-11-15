/**
 * `bun run build:binary` / `smoke:binary`: the engine toolchain's one workspace
 * launcher, run under this product's build-preparation lock so a version
 * writer never changes the sources a running build reads.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isWorkspaceToolchainCommand,
  runWorkspaceToolchain as runToolchain,
  WorkspaceToolchainInterrupted,
  type WorkspaceToolchainCommand,
} from '@goodvibes-jev/engine/toolchain';
import { withBuildPreparationLock } from './build-preparation-lock.ts';

/** The daemon is this product's only build artifact; the shared daemon-only selectors would skip it. The bin checks every other argument. */
export function validateToolchainArguments(command: WorkspaceToolchainCommand, args: readonly string[]): void {
  if (command === 'build' && (args.includes('--daemon-only') || args.some(arg => arg.startsWith('daemon-') || arg.startsWith('--target=daemon-')))) {
    throw new Error('The daemon is the sole build artifact; use --target <platform-arch>, without --daemon-only or daemon-* selectors.');
  }
}

export async function runWorkspaceToolchain(productRoot: string, command: string, args: readonly string[]): Promise<number> {
  // Refuse a wrong command or argument before taking the lock.
  if (!isWorkspaceToolchainCommand(command)) throw new Error('Usage: run-toolchain.ts build|smoke [arguments]');
  validateToolchainArguments(command, args);
  return withBuildPreparationLock(productRoot, () => runToolchain(productRoot, command, args));
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    process.exitCode = await runWorkspaceToolchain(root, process.argv[2] ?? '', process.argv.slice(3));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof WorkspaceToolchainInterrupted ? error.exitCode : 1;
  }
}
