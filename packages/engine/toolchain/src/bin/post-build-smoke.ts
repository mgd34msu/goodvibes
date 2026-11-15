#!/usr/bin/env node
import { loadToolchainConfig } from '../lib/load-config.js';
import { consoleLogger } from '../lib/effects.js';
import { runPostBuildSmoke } from '../lib/post-build-smoke.js';
import { flagValue } from '../lib/cli-args.js';

const root = process.cwd();
const config = loadToolchainConfig(root);
if (!config.smoke) {
  consoleLogger.error('post-build-smoke: no `smoke` section in toolchain.config.json');
  process.exit(1);
}
let binary: string | undefined;
try {
  binary = flagValue(process.argv.slice(2), '--binary');
} catch (error) {
  consoleLogger.error(`post-build-smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
const result = await runPostBuildSmoke({ binary: binary ?? config.smoke.binaryDefault, config: config.smoke, logger: consoleLogger });
process.exit(result.ok ? 0 : 1);
