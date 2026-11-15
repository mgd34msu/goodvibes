#!/usr/bin/env node
import { loadToolchainConfig } from '../lib/load-config.js';
import { consoleLogger } from '../lib/effects.js';
import { runPackageInstallCheck } from '../lib/package-install-check.js';
import { parseArgs, UsageError, withUsage } from '../lib/cli-args.js';

withUsage('package-install-check', 'package-install-check', () => {
  const parsed = parseArgs(process.argv.slice(2), {});
  if (parsed.positional.length > 0) throw new UsageError(`unexpected argument ${parsed.positional[0]}`);
});
const root = process.cwd();
const config = loadToolchainConfig(root);
if (!config.publish) {
  consoleLogger.error('package-install-check: no `publish` section in toolchain.config.json');
  process.exit(1);
}
const result = runPackageInstallCheck({ cwd: root, config: config.publish, ...(config.publish.bins ? { bins: config.publish.bins } : {}), logger: consoleLogger });
for (const issue of result.issues) consoleLogger.error(`  - ${issue}`);
process.exit(result.ok ? 0 : 1);
