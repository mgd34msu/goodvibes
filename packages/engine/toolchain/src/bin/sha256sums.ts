#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { consoleLogger } from '../lib/effects.js';
import { parseArgs, UsageError, withUsage } from '../lib/cli-args.js';
import { generateSha256Sums, verifySha256Sums, type ReadBytes, type HashBytes } from '../lib/sha256sums.js';

// Manifest convention: a SHA256SUMS file records BARE BASENAMES and is consumed
// from a directory holding the assets it covers, so `sha256sum -c SHA256SUMS.txt`
// in a download directory just works (a GitHub release flattens paths, so
// generating from `dist/goodvibes-*` and verifying beside the downloads is the
// same name set). --out records basenames, and --verify resolves every recorded
// name against the MANIFEST'S OWN directory.

const USAGE = 'sha256sums [--out <manifest>] <asset...> | sha256sums --verify <manifest> [--exact <payload...> | --exact-dir]';
const root = process.cwd();
const hashBytes: HashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Bytes of a regular file (never a symlink or directory), or null. */
const regularFile: ReadBytes = (path) => {
  try { return lstatSync(path).isFile() ? new Uint8Array(readFileSync(path)) : null; }
  catch { return null; }
};

const args = withUsage('sha256sums', USAGE, () => {
  const parsed = parseArgs(process.argv.slice(2), { '--verify': 'value', '--out': 'value', '--exact': 'rest', '--exact-dir': 'switch' });
  const verify = parsed.values.get('--verify');
  const exact = parsed.rest.get('--exact');
  const exactDir = parsed.switches.has('--exact-dir');
  if (verify === undefined) {
    if (exact !== undefined || exactDir) throw new UsageError('--exact and --exact-dir only apply to --verify');
    if (parsed.positional.length === 0) throw new UsageError('no assets to checksum');
    return { mode: 'generate' as const, out: parsed.values.get('--out') ?? 'SHA256SUMS.txt', assets: parsed.positional };
  }
  if (parsed.values.has('--out')) throw new UsageError('--out does not apply to --verify');
  if (parsed.positional.length > 0) throw new UsageError(`unexpected argument ${parsed.positional[0]}; name payloads with --exact`);
  if (exact !== undefined && exactDir) throw new UsageError('use --exact or --exact-dir, not both');
  return { mode: 'verify' as const, manifest: verify, exact, exactDir };
});

if (args.mode === 'verify') {
  const manifestPath = resolve(root, args.manifest);
  const manifestDir = dirname(manifestPath);
  let manifestText: string;
  try {
    if (!lstatSync(manifestPath).isFile()) throw new Error('not a regular file');
    manifestText = readFileSync(manifestPath, 'utf8');
  } catch (error) {
    consoleLogger.error(`sha256sums: cannot read manifest ${args.manifest}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  let payloads: string[] | undefined;
  if (args.exact !== undefined) {
    const away = args.exact.filter(path => dirname(resolve(root, path)) !== manifestDir);
    if (away.length > 0) {
      consoleLogger.error(`sha256sums: payloads must sit beside ${args.manifest}: ${away.join(', ')}`);
      process.exit(1);
    }
    payloads = args.exact.map(path => basename(path));
  } else if (args.exactDir) {
    payloads = readdirSync(manifestDir).filter(name => name !== basename(manifestPath));
  }
  if (payloads !== undefined && new Set(payloads).size !== payloads.length) {
    consoleLogger.error('sha256sums: payload names must be unique');
    process.exit(1);
  }
  let result: ReturnType<typeof verifySha256Sums>;
  try {
    result = verifySha256Sums(manifestText, (name) => regularFile(join(manifestDir, name)), hashBytes, payloads);
  } catch (error) {
    consoleLogger.error(`sha256sums: ${args.manifest}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (!result.ok) {
    consoleLogger.error(`sha256sums: verifying ${args.manifest} against ${manifestDir}`);
    if (result.missing.length > 0) consoleLogger.error(`sha256sums: missing ${result.missing.join(', ')}`);
    if (result.mismatched.length > 0) consoleLogger.error(`sha256sums: mismatched ${result.mismatched.join(', ')}`);
    if (result.unlisted.length > 0) consoleLogger.error(`sha256sums: not listed in the manifest ${result.unlisted.join(', ')}`);
    if (result.unexpected.length > 0) consoleLogger.error(`sha256sums: listed but not a payload ${result.unexpected.join(', ')}`);
    process.exit(1);
  }
  consoleLogger.info(`sha256sums: all assets verified${payloads === undefined ? '' : ', and the manifest lists exactly the payloads'}`);
  process.exit(0);
}

const entries = args.assets.map((path) => ({ name: basename(path), path: resolve(root, path) }));
const manifestName = basename(args.out);

// Two assets sharing a basename would write two same-named lines, and neither
// this bin nor `sha256sum -c` could say which file either line meant.
const byName = new Map<string, string>();
const refusals: string[] = [];
for (const entry of entries) {
  const seen = byName.get(entry.name);
  if (seen !== undefined && seen !== entry.path) refusals.push(`distinct assets share the name ${entry.name}`);
  else byName.set(entry.name, entry.path);
  if (entry.name === manifestName) refusals.push(`${entry.name} is the manifest itself`);
}
if (refusals.length > 0) {
  consoleLogger.error(`sha256sums: refusing to write: ${refusals.join('; ')}`);
  process.exit(1);
}

const result = generateSha256Sums([...byName].map(([name, path]) => ({ name, path })), regularFile, hashBytes);
if (!result.ok) {
  if (result.invalid.length > 0) consoleLogger.error(`sha256sums: refusing to write, not a plain file name: ${result.invalid.join(', ')}`);
  if (result.missing.length > 0) consoleLogger.error(`sha256sums: refusing to write, missing or not a regular file: ${result.missing.join(', ')}`);
  process.exit(1);
}
writeFileSync(resolve(root, args.out), result.manifest);
consoleLogger.info(`sha256sums: wrote ${byName.size} checksum(s) to ${args.out}`);
process.exit(0);
