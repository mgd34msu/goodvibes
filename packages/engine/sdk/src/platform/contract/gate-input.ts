/** Read-only identities for the exact source and check definitions observed by a gate. */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, type BigIntStats } from 'node:fs';
import { join } from 'node:path';
import { CONTRACT_INPUT_EXCLUSIONS, listContractInputPaths } from './input-snapshot.js';

export interface GateSourceInputIdentity {
  readonly source: string;
  readonly packageScripts: Readonly<Record<string, string>>;
}

// Local check observations are not content addresses. Keep the actual file
// metadata private and let only the owning observation retain its label.
// Nothing is interned globally by project name or retained after its owner dies.
interface SourceObservation { readonly root: string; readonly entries: readonly string[] }
const observations = new WeakMap<GateSourceInputIdentity, SourceObservation>();
const fileIdentity = (stat: BigIntStats): string =>
  `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.gid}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const directoryIdentity = (stat: BigIntStats): string =>
  `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.gid}`;

const excluded = new Set<string>([...CONTRACT_INPUT_EXCLUSIONS, 'node_modules']);
const visible = (path: string): boolean => !path.split('/').some(part => excluded.has(part));

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

function packageScripts(bytes: Buffer): Readonly<Record<string, string>> {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || !('scripts' in value) || !value.scripts || typeof value.scripts !== 'object' || Array.isArray(value.scripts)) return {};
    const scripts: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, command] of Object.entries(value.scripts)) if (typeof command === 'string') scripts[key] = command;
    return Object.freeze(scripts);
  } catch { return {}; }
}

/** Observe the current physical tree under a running check's original owner.
 * Same-byte replacement and a rewrite followed by restored mtime both retire
 * the observation (inode/ctime are included). Only package.json is read, for
 * selecting the actual script; ordinary source bytes are never scanned here.
 * The label is meaningful only with its private prior observation. Historical
 * receipts have no such owner and must execute their checks again.
 * Ignored Git outputs and runtime/dependency directories remain excluded. */
export function captureGateInput(cwd: string, previous?: GateSourceInputIdentity): GateSourceInputIdentity {
  const root = realpathSync(cwd);
  const rootStat = lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory()) throw new Error('Gate source root is not a directory');
  const entries: string[] = [directoryIdentity(rootStat)];
  const directories = new Map<string, string>([[root, directoryIdentity(rootStat)]]);
  const paths = sourcePaths(root);
  let scripts: Readonly<Record<string, string>> = {};
  for (const path of paths) {
    const parts = path.split('/');
    if (parts.some(part => !part || part === '.' || part === '..') || path.includes('\\'))
      throw new Error('Gate source path is not a relative physical file');
    for (let index = 1; index < parts.length; index++) {
      const parent = join(root, ...parts.slice(0, index));
      const stat = lstatSync(parent, { bigint: true });
      if (!stat.isDirectory()) throw new Error('Gate source parent is not a physical directory');
      const identity = directoryIdentity(stat);
      const retained = directories.get(parent);
      if (retained !== undefined && retained !== identity) throw new Error('Gate source parent changed during capture');
      directories.set(parent, identity);
    }
    const absolute = join(root, path);
    let before;
    try { before = lstatSync(absolute, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      entries.push(JSON.stringify([path, 'missing']));
      continue;
    }
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('Gate source contains an unsupported file or link');
    entries.push(JSON.stringify([path, fileIdentity(before)]));
    if (path === 'package.json') {
      const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (fileIdentity(fstatSync(descriptor, { bigint: true })) !== fileIdentity(before))
          throw new Error('Gate package file replaced before reading');
        const bytes = readFileSync(descriptor);
        if (BigInt(bytes.length) !== before.size || fileIdentity(fstatSync(descriptor, { bigint: true })) !== fileIdentity(before))
          throw new Error('Gate package file changed while reading');
        scripts = packageScripts(bytes);
      } finally { closeSync(descriptor); }
    }
    const after = lstatSync(absolute, { bigint: true });
    if (fileIdentity(before) !== fileIdentity(after)) throw new Error('Gate source changed during capture');
  }
  if (JSON.stringify(paths) !== JSON.stringify(sourcePaths(root))) throw new Error('Gate source membership changed during capture');
  for (const [directory, expected] of directories) {
    const stat = lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || directoryIdentity(stat) !== expected) throw new Error('Gate source directory changed during capture');
    entries.push(JSON.stringify([directory, expected]));
  }
  if (realpathSync(cwd) !== root) throw new Error('Gate source root changed during capture');
  const retained = previous && observations.get(previous);
  const unchanged = retained && retained.root === root && retained.entries.length === entries.length
    && retained.entries.every((entry, index) => entry === entries[index]);
  const source = unchanged && previous ? previous.source : `gate-source-${randomUUID()
    .replace(/[0-9a-f]/g, nibble => String.fromCharCode(97 + Number.parseInt(nibble, 16)))}`;
  const captured = Object.freeze({ source, packageScripts: Object.freeze(scripts) });
  observations.set(captured, { root, entries });
  return captured;
}
