/** `bun run build` / `smoke`: the engine toolchain's one workspace launcher, run for this product. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkspaceToolchain, WorkspaceToolchainInterrupted } from '@goodvibes/engine/toolchain';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.exitCode = await runWorkspaceToolchain(root, process.argv[2] ?? '', process.argv.slice(3));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof WorkspaceToolchainInterrupted ? error.exitCode : 1;
}
