#!/usr/bin/env node
import { loadToolchainConfig } from '../lib/load-config.js';
import { realFsReader, consoleLogger } from '../lib/effects.js';
import { runEnginePinGate } from '../lib/engine-pin-gate.js';
import { parseArgs, UsageError, withUsage } from '../lib/cli-args.js';

withUsage('engine-pin-gate', 'engine-pin-gate', () => {
  const parsed = parseArgs(process.argv.slice(2), {});
  if (parsed.positional.length > 0) throw new UsageError(`unexpected argument ${parsed.positional[0]}`);
});
const root = process.cwd();
const config = loadToolchainConfig(root);
const results = runEnginePinGate(realFsReader(root), config.enginePin);
if (results.length === 0) {
  consoleLogger.error('engine-pin-gate: no gate ran, so nothing was verified');
  process.exit(1);
}
let failed = 0;
for (const result of results) {
  consoleLogger.info(`${result.ok ? 'PASS' : 'FAIL'}  ${result.id}, ${result.detail}`);
  if (!result.ok) failed += 1;
}
consoleLogger.info(`engine-pin-gate: ${results.length - failed}/${results.length} gates passed`);
process.exit(failed > 0 ? 1 : 0);
