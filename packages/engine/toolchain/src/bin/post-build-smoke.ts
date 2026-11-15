#!/usr/bin/env node
import { loadToolchainConfig } from '../lib/load-config.js';
import { consoleLogger } from '../lib/effects.js';
import { runPostBuildSmoke } from '../lib/post-build-smoke.js';
import { parseArgs, UsageError, withUsage } from '../lib/cli-args.js';

const root = process.cwd();
const config = loadToolchainConfig(root);
if (!config.smoke) {
  consoleLogger.error('post-build-smoke: no `smoke` section in toolchain.config.json');
  process.exit(1);
}
const binary = withUsage('post-build-smoke', 'post-build-smoke [--binary <path>]', () => {
  const parsed = parseArgs(process.argv.slice(2), { '--binary': 'value' });
  if (parsed.positional.length > 0) throw new UsageError(`unexpected argument ${parsed.positional[0]}`);
  return parsed.values.get('--binary');
});
const result = await runPostBuildSmoke({ binary: binary ?? config.smoke.binaryDefault, config: config.smoke, logger: consoleLogger });
process.exit(result.ok ? 0 : 1);
