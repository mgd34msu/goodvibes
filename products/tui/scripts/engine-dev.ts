#!/usr/bin/env bun
/** Forward to the engine tool in this actual monorepo. An explicit
 * GOODVIBES_WORKSPACE_PATH names a repository root, never an import subpath. */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_ROOT = process.env.GOODVIBES_WORKSPACE_PATH
  ? resolve(process.env.GOODVIBES_WORKSPACE_PATH) : resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ENGINE_ROOT = resolve(WORKSPACE_ROOT, 'packages/engine');
const TOOL = resolve(ENGINE_ROOT, 'scripts/engine-dev.ts');

if (!existsSync(ENGINE_ROOT)) {
  console.error(`engine-dev: local engine checkout not found at ${ENGINE_ROOT} (set GOODVIBES_WORKSPACE_PATH to override)`);
  process.exit(1);
}
if (!existsSync(TOOL)) {
  console.error(`engine-dev: local engine checkout at ${ENGINE_ROOT} has no scripts/engine-dev.ts (is it up to date?)`);
  process.exit(1);
}

const result = Bun.spawnSync(['bun', TOOL, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: ['inherit', 'inherit', 'inherit'],
});
process.exit(result.exitCode ?? 1);
