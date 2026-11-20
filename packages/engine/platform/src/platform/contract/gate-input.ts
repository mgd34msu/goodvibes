/**
 * The identity of the source a gate ran against, as plain data that can be
 * stored on a check and compared after a restart.
 *
 * In git the identity is the content: the tree id of the working tree
 * (`tree-identity.ts`), or, when a check names the paths it is about (a shared
 * tree the owner keeps working in), the blob ids of exactly those paths. An
 * unrelated save elsewhere does not change it; a touch that leaves the bytes
 * alone does not either. Outside git a stat walk of the tree gives a digest of
 * every file's stat facts. Git runs without the caller's GIT_* routing.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, type BigIntStats } from 'node:fs';
import { join } from 'node:path';
import { CONTRACT_INPUT_EXCLUSIONS, listContractInputPaths } from './input-snapshot.js';
import { workingTreeIdentity } from './tree-identity.js';
import { canonicalJson } from '../utils/target-ref.js';

export interface GateSourceInputIdentity {
  /** `tree:<id>` or `paths:<sha256>` (content), or outside git `stat:<sha256>` of the files' stat facts. */
  readonly source: string;
  readonly packageScripts: Readonly<Record<string, string>>;
}

/** The scripts of `root`'s package.json, read once; empty when absent or unreadable. */
function readPackageScripts(root: string): Readonly<Record<string, string>> {
  try { return packageScripts(readFileSync(join(root, 'package.json'))); } catch { return Object.freeze({}); }
}

/**
 * Content id of `paths` under `root`: each path's git blob id (a symlink by its
 * target text), or "missing". One `git hash-object` for all existing files.
 */
/** The environment for git here: the caller's GIT_* routing (a hook's GIT_DIR, an index override) never redirects it. */
function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

function pathsIdentity(root: string, paths: readonly string[]): string | null {
  const sorted = [...new Set(paths)].sort();
  const files: string[] = [], rows = new Map<string, string>();
  for (const path of sorted) {
    const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
    if (stat === undefined) rows.set(path, 'missing');
    else if (stat.isSymbolicLink()) rows.set(path, `link:${readlinkSync(join(root, path))}`);
    else if (stat.isFile()) files.push(path);
    else rows.set(path, 'not-a-file');
  }
  if (files.length > 0) {
    const hashed = spawnSync('git', ['-C', root, 'hash-object', '--stdin-paths'], { input: files.join('\n') + '\n', encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, env: gitEnv() });
    const ids = hashed.status === 0 ? hashed.stdout.trim().split('\n') : [];
    if (ids.length !== files.length) return null;
    files.forEach((path, index) => rows.set(path, ids[index]!));
  }
  return createHash('sha256').update(JSON.stringify(sorted.map(path => [path, rows.get(path)]))).digest('hex');
}

/**
 * The source identity of `cwd`. With `scope`, only those paths (relative to
 * `cwd`) and the package.json scripts a gate selects are identified (without
 * a scope the tree id already covers package.json). Outside git, falls back to the stat walk. `_previous` is accepted
 * from callers that hold an earlier identity; identities compare as strings.
 */
export function captureGateInput(cwd: string, _previous?: GateSourceInputIdentity, scope?: readonly string[]): GateSourceInputIdentity {
  const root = realpathSync(cwd);
  const content = scope === undefined ? workingTreeIdentity(root) : isGitWorkTree(root) ? pathsIdentity(root, scope) : null;
  if (content !== null) {
    const scripts = readPackageScripts(root);
    if (scope === undefined) return Object.freeze({ source: `tree:${content}`, packageScripts: scripts });
    // The scripts are what a gate runs, and with a scope package.json is not
    // one of the identified paths: they are part of the identity, so a gate
    // that passed stops being current when the script it ran is changed.
    const source = createHash('sha256').update(JSON.stringify([content, canonicalJson(scripts)])).digest('hex');
    return Object.freeze({ source: `paths:${source}`, packageScripts: scripts });
  }
  return captureStatIdentity(cwd);
}

function isGitWorkTree(root: string): boolean {
  return spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf-8', env: gitEnv() }).stdout?.trim() === 'true';
}

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

/** Outside git: observe the current physical tree under a running check's original owner.
 * Same-byte replacement and a rewrite followed by restored mtime both retire
 * the observation (inode/ctime are included). Only package.json is read, for
 * selecting the actual script; ordinary source bytes are never scanned here.
 * The label is meaningful only with its private prior observation. Historical
 * receipts have no such owner and must execute their checks again.
 * Ignored Git outputs and runtime/dependency directories remain excluded. */
function captureStatIdentity(cwd: string): GateSourceInputIdentity {
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
    let missingParent = false;
    for (let index = 1; index < parts.length; index++) {
      const parent = join(root, ...parts.slice(0, index));
      let stat: BigIntStats;
      try { stat = lstatSync(parent, { bigint: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const retained = directories.get(parent);
        if (retained !== undefined && retained !== 'missing') throw new Error('Gate source parent changed during capture');
        directories.set(parent, 'missing'); missingParent = true; break;
      }
      if (!stat.isDirectory()) {
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Gate source parent is not a physical directory');
        // Git can retain cached descendants after their directory becomes a
        // regular file. They are missing inputs, not permission to follow links.
        const identity = `file:${fileIdentity(stat)}`, retained = directories.get(parent);
        if (retained !== undefined && retained !== identity) throw new Error('Gate source parent changed during capture');
        directories.set(parent, identity); missingParent = true; break;
      }
      const identity = directoryIdentity(stat);
      const retained = directories.get(parent);
      if (retained !== undefined && retained !== identity) throw new Error('Gate source parent changed during capture');
      directories.set(parent, identity);
    }
    if (missingParent) { entries.push(JSON.stringify([path, 'missing'])); continue; }
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
    const stat = lstatSync(directory, { bigint: true, throwIfNoEntry: false });
    const matches = expected === 'missing' ? stat === undefined
      : expected.startsWith('file:') ? stat?.isFile() === true && !stat.isSymbolicLink() && `file:${fileIdentity(stat)}` === expected
      : stat?.isDirectory() === true && directoryIdentity(stat) === expected;
    if (!matches) throw new Error('Gate source directory changed during capture');
    entries.push(JSON.stringify([directory, expected]));
  }
  if (realpathSync(cwd) !== root) throw new Error('Gate source root changed during capture');
  // The label is a digest of the stat facts: equal while nothing was touched, comparable as plain data.
  const source = `stat:${createHash('sha256').update(root).update('\0').update(entries.join('\n')).digest('hex')}`;
  return Object.freeze({ source, packageScripts: Object.freeze(scripts) });
}
