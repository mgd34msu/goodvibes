#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { consoleLogger } from '../lib/effects.js';
import { parseLedgerAreas, renderLedgerJson, renderLedgerMarkdown } from '../lib/verification-ledger.js';
import { flagValue } from '../lib/cli-args.js';

function argValue(flag: string): string | undefined {
  try {
    return flagValue(process.argv.slice(2), flag);
  } catch (error) {
    consoleLogger.error(`verification-ledger: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

const root = process.cwd();
const areasPath = argValue('--areas');
if (!areasPath) {
  consoleLogger.error('verification-ledger: --areas <file.json> is required (the repo-collected area inventory)');
  process.exit(1);
}
let areas: ReturnType<typeof parseLedgerAreas>;
try {
  areas = parseLedgerAreas(JSON.parse(readFileSync(resolve(root, areasPath), 'utf8')));
} catch (error) {
  consoleLogger.error(`verification-ledger: cannot use ${areasPath}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const json = process.argv.includes('--json');
const rendered = json ? renderLedgerJson(areas) : renderLedgerMarkdown(areas);
const outDir = argValue('--out');
if (outDir && !(() => { try { return statSync(resolve(root, outDir)).isDirectory(); } catch { return false; } })()) {
  consoleLogger.error(`verification-ledger: --out ${outDir} is not an existing directory`);
  process.exit(1);
}
if (outDir) {
  writeFileSync(resolve(root, outDir, 'verification-ledger.json'), renderLedgerJson(areas));
  writeFileSync(resolve(root, outDir, 'verification-ledger.md'), renderLedgerMarkdown(areas));
  consoleLogger.info(`verification-ledger: wrote verification-ledger.{json,md} to ${outDir}`);
} else {
  consoleLogger.info(rendered);
}
process.exit(0);
