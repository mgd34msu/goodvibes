#!/usr/bin/env bun
/**
 * Post-build smoke test for the GoodVibes Agent binary.
 *
 * Verifies that the compiled Agent executable launches and prints exactly its
 * version banner; any other output (a module or addon load failure shows up
 * there) fails the smoke. It never starts or owns a daemon.
 *
 * The boot/version policy lives in the shared
 * @goodvibes/engine/toolchain `post-build-smoke` (one implementation across
 * tui/agent). This file is a thin adapter: it resolves the binary (from
 * --binary or the configured default) and delegates to the toolchain, sourcing
 * the version banner contract from toolchain.config.json.
 */
import { existsSync } from 'node:fs';
import { runPostBuildSmoke, loadToolchainConfig } from '@goodvibes/engine/toolchain';

const root = process.cwd();
const smoke = loadToolchainConfig(root).smoke;
if (!smoke) {
  console.error('[agent-smoke] FAIL: toolchain.config.json is missing a `smoke` section');
  process.exit(1);
}

const args = process.argv.slice(2);
const named = args.length === 2 && args[0] === '--binary' && !!args[1] && !args[1].startsWith('-');
if (args.length !== 0 && !named) {
  console.error('[agent-smoke] Usage: post-build-smoke.ts [--binary <path>]');
  process.exit(2);
}
const binary = named ? (args[1] as string) : smoke.binaryDefault;

if (!existsSync(binary)) {
  console.error(`[agent-smoke] FAIL: Binary not found: ${binary}`);
  process.exit(1);
}

const result = await runPostBuildSmoke({ binary, config: smoke });
process.exit(result.ok ? 0 : 1);
