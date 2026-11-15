#!/usr/bin/env bun
/** `bun run build:binary`: the engine toolchain's one workspace launcher, running the build for this product. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkspaceToolchain, WorkspaceToolchainInterrupted } from '@goodvibes-jev/engine/toolchain';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.exitCode = await runWorkspaceToolchain(root, 'build', process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof WorkspaceToolchainInterrupted ? error.exitCode : 1;
}
