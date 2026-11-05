/** Read-only identities for the exact source and check definitions observed by a gate. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACT_INPUT_EXCLUSIONS, listContractInputPaths } from './input-snapshot.js';
import type { QualityGate } from './gates.js';

export interface GateInputIdentity {
  readonly source: string;
  readonly definition: string;
  readonly packageScripts: Readonly<Record<string, string>>;
}

const excluded = new Set<string>([...CONTRACT_INPUT_EXCLUSIONS, 'node_modules']);
const visible = (path: string): boolean => !path.split('/').some(part => excluded.has(part));

export function gateDefinitionIdentity(gates: readonly QualityGate[]): string {
  return createHash('sha256').update(JSON.stringify(gates.map(gate => ({
    name: gate.name, command: gate.command, enabled: gate.enabled,
    required: gate.required, verification: gate.verification,
  })))).digest('hex');
}

function sourcePaths(root: string): string[] {
  try {
    const gitPaths = listContractInputPaths(root).filter(visible);
    // A standalone project can sit inside an unrelated repository's ignored
    // temporary directory. An empty parent inventory must not hide its inputs.
    if (gitPaths.length > 0) return [...new Set([...gitPaths, 'package.json'])].sort();
  } catch { /* Outside Git, inspect the requested directory directly. */ }
  const paths: string[] = [];
  const directories = [''];
  while (directories.length) {
    const directory = directories.pop()!;
    const absolute = join(root, directory);
    const before = lstatSync(absolute, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Gate source directory replaced during capture');
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (!visible(path)) continue;
      if (entry.isDirectory()) directories.push(path);
      else paths.push(path);
    }
    const after = lstatSync(absolute, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('Gate source directory changed during capture');
  }
  return [...new Set([...paths, 'package.json'])].sort();
}

function packageScripts(bytes: readonly Buffer[]): Readonly<Record<string, string>> {
  try {
    const value: unknown = JSON.parse(Buffer.concat(bytes).toString('utf8'));
    if (!value || typeof value !== 'object' || !('scripts' in value) || !value.scripts || typeof value.scripts !== 'object' || Array.isArray(value.scripts)) return {};
    const scripts: Record<string, string> = {};
    for (const [key, command] of Object.entries(value.scripts)) if (typeof command === 'string') scripts[key] = command;
    return Object.freeze(scripts);
  } catch { return {}; }
}

/** Ignored Git outputs and known runtime/dependency directories are not source inputs. */
export function captureGateInput(cwd: string, gates: readonly QualityGate[]): GateInputIdentity {
  const root = realpathSync(cwd);
  const rootStat = lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory()) throw new Error('Gate source root is not a directory');
  const hash = createHash('sha256');
  hash.update(`${rootStat.dev}:${rootStat.ino}\0`);
  const paths = sourcePaths(root);
  const bytes = Buffer.alloc(64 * 1024);
  let scripts: Readonly<Record<string, string>> = {};
  for (const path of paths) {
    const absolute = join(root, path);
    hash.update(`${Buffer.byteLength(path)}:${path}\0`);
    let before;
    try { before = lstatSync(absolute, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hash.update('missing\0');
      continue;
    }
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('Gate source contains an unsupported file or link');
    hash.update(`${before.mode}:${before.size}\0`);
    const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const packageBytes: Buffer[] = [];
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('Gate source file replaced during capture');
      for (;;) {
        const read = readSync(descriptor, bytes, 0, bytes.length, null);
        if (read === 0) break;
        hash.update(bytes.subarray(0, read));
        if (path === 'package.json') packageBytes.push(Buffer.from(bytes.subarray(0, read)));
      }
    } finally { closeSync(descriptor); }
    const after = lstatSync(absolute, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new Error('Gate source changed during capture');
    if (path === 'package.json') scripts = packageScripts(packageBytes);
  }
  if (JSON.stringify(paths) !== JSON.stringify(sourcePaths(root))) throw new Error('Gate source membership changed during capture');
  const rootAfter = lstatSync(root, { bigint: true });
  if (rootStat.dev !== rootAfter.dev || rootStat.ino !== rootAfter.ino) throw new Error('Gate source root changed during capture');
  return { source: hash.digest('hex'), packageScripts: scripts, definition: gateDefinitionIdentity(gates) };
}
