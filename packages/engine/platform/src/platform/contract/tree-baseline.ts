/**
 * Tree baselines: what the working tree held when a contract, a group or a
 * unit started, so its diff and its shared-tree commit leave out the owner's
 * own uncommitted edits. A baseline is HEAD plus the git object id of every
 * path that was uncommitted then (orchestration/dirty-guard.ts): one
 * `git status` and one `git hash-object`, run as child processes, with no file
 * bytes read into or held by this process. Comparing later hashes the
 * candidate paths again and compares ids.
 *
 * Provenance: only a baseline this process captured, or one read back from an
 * owned checkpoint file that recorded it as captured, can certify that a path
 * is unchanged. A baseline from an imported snapshot cannot: its paths read as
 * uncertain, so they are kept out of commits and the evidence step refuses.
 */
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { captureDirtyTreeIds, captureDirtyTreeIdsSync, type DirtyTreeIds, type ScopedCommitExclusion } from '../orchestration/dirty-guard.js';
import { dirtyPathIds, legacyPathCommitment, sameDirtyPathId, type DirtyPathId } from '../orchestration/dirty-file-observation.js';
import { ownedContractCheckpointText, type OwnedContractCheckpointRead } from './owned-checkpoint-read.js';
import type { Contract, TreeBaseline } from './types.js';

interface BaselineOwner {
  /** The working tree comparisons run in: where it was taken, or the tree the work moved to. */
  root: string;
  /** Captured here, or read back from an owned checkpoint that recorded it as captured. */
  readonly native: boolean;
  /** A unit baseline from before units recorded their root: comparable once its execution root is selected. */
  historicalUnitRootPending: boolean;
}
const owners = new WeakMap<TreeBaseline, BaselineOwner>();
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const UNAVAILABLE = 'Original dirty baseline cannot be verified; preserve owner edits and inspect or re-establish the original work baseline before continuing';

function runGit(cwd: string, args: readonly string[]): Promise<{ readonly code: number; readonly stdout: string }> {
  return new Promise((resolveRun) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.on('error', () => resolveRun({ code: -1, stdout: '' }));
    child.on('close', (code) => resolveRun({ code: code ?? -1, stdout }));
  });
}

/**
 * HEAD and the ids of every uncommitted path of `cwd`; undefined outside a git
 * repository. Taken off the event loop; a capture already running for the
 * same tree (the engine's launch capture) is shared.
 */
export async function captureTreeBaseline(cwd: string): Promise<TreeBaseline | undefined> {
  const repository = await runGit(cwd, ['rev-parse', '--git-dir']);
  if (repository.code !== 0) return undefined;
  const head = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return baselineOf(cwd, head, await captureDirtyTreeIds(cwd));
}

/**
 * The same baseline taken synchronously, for a caller that cannot wait (a
 * session turn that found none). Still no file bytes: git hashes them.
 */
export function captureTreeBaselineSync(cwd: string): TreeBaseline | undefined {
  if (spawnSync('git', ['-C', cwd, 'rev-parse', '--git-dir'], { stdio: 'ignore' }).status !== 0) return undefined;
  const head = spawnSync('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', 'HEAD'], { encoding: 'utf-8' });
  return baselineOf(cwd, { code: head.status ?? -1, stdout: head.stdout ?? '' }, captureDirtyTreeIdsSync(cwd));
}

function baselineOf(cwd: string, head: { readonly code: number; readonly stdout: string }, tree: DirtyTreeIds): TreeBaseline {
  const value = head.code === 0 ? head.stdout.trim() : null;
  if ((head.code !== 0 && head.code !== 1) || value !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error('Original Git baseline HEAD could not be read');
  if (!tree.available) throw new Error('The uncommitted files could not be listed for the baseline; owner edits remain uncommitted');
  const dirty: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  for (const [path, id] of tree.ids) dirty[path] = id;
  const baseline: TreeBaseline = Object.freeze({ version: 4, head: value, dirty: Object.freeze(dirty) });
  owners.set(baseline, { root: resolve(cwd), native: true, historicalUnitRootPending: false });
  return baseline;
}

function comparisonOwner(cwd: string, baseline: TreeBaseline): BaselineOwner | undefined {
  const owner = owners.get(baseline);
  return owner?.native && !owner.historicalUnitRootPending && owner.root === resolve(cwd) ? owner : undefined;
}

/** A real Git commit compares against this baseline in `cwd`: refused when the baseline cannot certify it. */
export function assertBaselineExecutionRootCurrent(cwd: string, baseline: TreeBaseline): void {
  if (!comparisonOwner(cwd, baseline)) throw new Error('Original tree baseline comparison root is unavailable');
}

/** Whether each saved path is unchanged now: true or false compare content, undefined is uncertain. */
async function unchangedPaths(cwd: string, baseline: TreeBaseline, paths: readonly string[]): Promise<Map<string, boolean | undefined>> {
  const result = new Map<string, boolean | undefined>();
  if (baseline.version === 4) {
    const now = await dirtyPathIds(cwd, paths);
    for (const path of paths) result.set(path, sameDirtyPathId(baseline.dirty[path] as DirtyPathId, now.get(path)));
    return result;
  }
  // Older baselines saved sha256 commitments of the bytes (version 2, or bare
  // digests before versions); version 3 saved physical facts that cannot
  // prove content after a restart, so its paths stay uncertain.
  for (const path of paths) {
    const saved = baseline.dirty[path];
    if (baseline.version === 3) { result.set(path, undefined); continue; }
    const now = await legacyPathCommitment(cwd, path);
    if (now === undefined) { result.set(path, undefined); continue; }
    if (baseline.version === 2) { result.set(path, saved === null ? now === null : now !== null && now === saved); continue; }
    // Unversioned: null conflated deletion with a failed read, and symlinks were digested through their target.
    if (saved === null || saved === undefined || now?.startsWith('symlink:') === true) { result.set(path, undefined); continue; }
    result.set(path, now !== null && now.slice(now.indexOf(':') + 1) === saved);
  }
  return result;
}

/** Splits candidate paths into the work's changes (included) and owner edits the work left as they were (excluded). */
export async function partitionBaselinePaths(cwd: string, candidatePaths: readonly string[], baseline: TreeBaseline | undefined): Promise<ScopedCommitExclusion> {
  const included: string[] = [], excluded: string[] = [], uncertain: string[] = [];
  if (baseline !== undefined && comparisonOwner(cwd, baseline) === undefined) return { included, excluded: [...candidatePaths], uncertain: [...candidatePaths] };
  const saved = baseline === undefined ? [] : candidatePaths.filter((path) => Object.hasOwn(baseline.dirty, path));
  const unchanged = baseline === undefined ? new Map<string, boolean | undefined>() : await unchangedPaths(cwd, baseline, saved);
  for (const path of candidatePaths) {
    if (!unchanged.has(path)) { included.push(path); continue; }
    const equal = unchanged.get(path);
    if (equal === false) included.push(path);
    else { excluded.push(path); if (equal === undefined) uncertain.push(path); }
  }
  return { included, excluded, uncertain };
}

/** The paths the work changed since the baseline: the given ones and every saved one, less the unchanged owner edits. */
export async function baselineChangedPaths(cwd: string, paths: readonly string[], baseline: TreeBaseline | undefined): Promise<readonly string[]> {
  if (baseline !== undefined && !comparisonOwner(cwd, baseline)) throw new Error(UNAVAILABLE);
  const candidates = [...new Set([...paths, ...Object.keys(baseline?.dirty ?? {})])];
  const result = await partitionBaselinePaths(cwd, candidates, baseline);
  if (result.uncertain.length) throw new Error(UNAVAILABLE);
  return result.included;
}

const SAVED_V4 = /^(?:(?:file|executable):[a-f0-9]{40}(?:[a-f0-9]{24})?|symlink:[a-f0-9]{64}|other)$/;
const SAVED_V3 = 'dirty-file-v3:';

function savedValueValid(version: unknown, saved: unknown): boolean {
  if (saved === null) return true;
  if (typeof saved !== 'string') return false;
  if (version === 4) return SAVED_V4.test(saved);
  if (version === 3) return saved.startsWith(SAVED_V3);
  if (version === 2) return /^(?:file|executable|symlink):[a-f0-9]{64}$/.test(saved);
  return /^[a-f0-9]{64}$/.test(saved);
}

function parsed(value: unknown): TreeBaseline {
  if (!record(value) || !Object.keys(value).every(key => key === 'head' || key === 'dirty' || key === 'version')
    || !(value['head'] === null || typeof value['head'] === 'string') || !record(value['dirty'])
    || !(value['version'] === undefined || value['version'] === 2 || value['version'] === 3 || value['version'] === 4)) throw new Error('Invalid original tree baseline');
  const dirty: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  for (const [path, saved] of Object.entries(value['dirty'])) {
    if (!path || path.startsWith('/') || path.includes('\0') || path.split('/').some(part => part === '' || part === '.' || part === '..' || part === '.git' || part === '.goodvibes')
      || !savedValueValid(value['version'], saved)) throw new Error('Invalid original tree baseline');
    dirty[path] = saved as string | null;
  }
  return Object.freeze({ head: value['head'], dirty: Object.freeze(dirty), ...(value['version'] === undefined ? {} : { version: value['version'] as 2 | 3 | 4 }) });
}

function locations(contract: Contract): Array<{ readonly key: string; readonly root: string; readonly get: () => TreeBaseline | undefined; readonly set: (baseline: TreeBaseline) => void }> {
  const contractRoot = contract.worktreePath ?? contract.projectRoot;
  const units = [...contract.units], ids = new Set<string>();
  for (const unit of units) {
    if (ids.has(unit.id)) throw new Error('Tree baseline units have duplicate identities');
    ids.add(unit.id); if (unit.attemptUnits) units.push(...unit.attemptUnits);
  }
  return [{ key: 'contract', root: contractRoot, get: () => contract.baseline, set: baseline => { contract.baseline = baseline; } },
    ...contract.groups.map(group => ({ key: 'group:' + group.id, root: contractRoot, get: () => group.baseline, set: (baseline: TreeBaseline) => { group.baseline = baseline; } })),
    ...units.map(unit => ({ key: 'unit:' + unit.id, root: contractRoot, get: () => unit.baseline, set: (baseline: TreeBaseline) => { unit.baseline = baseline; } }))];
}

/** Checkpoint-only provenance: where each baseline compares and whether it was captured here. */
export function storedTreeBaselineOrigins(contract: Contract) {
  return { version: 1, entries: locations(contract).flatMap(location => {
    const baseline = location.get(); if (!baseline) return [];
    const owner = owners.get(baseline);
    return [{ location: location.key, root: owner?.root ?? resolve(location.root), origin: owner?.native ? owner.historicalUnitRootPending ? 'owned-historical-unbound-unit' : 'native-snapshot' : 'unverified-import' }];
  }) };
}

export function hydrateTreeBaselines(contract: Contract, serialized: string, receipt?: OwnedContractCheckpointRead): void {
  const envelope: unknown = JSON.parse(serialized);
  if (!record(envelope)) throw new Error('Invalid tree baseline checkpoint');
  const table = envelope['treeBaselineOrigins'], origins = new Map<string, { readonly origin: string; readonly root: string }>();
  if (table !== undefined) {
    if (!record(table) || Object.keys(table).sort().join(',') !== 'entries,version' || table['version'] !== 1 || !Array.isArray(table['entries'])) throw new Error('Invalid tree baseline provenance');
    for (const row of table['entries']) {
      if (!record(row) || Object.keys(row).sort().join(',') !== 'location,origin,root' || typeof row['location'] !== 'string' || typeof row['root'] !== 'string' || !row['root'].startsWith('/') || row['root'].includes('\0') || resolve(row['root']) !== row['root']
        || (row['origin'] !== 'native-snapshot' && row['origin'] !== 'unverified-import' && row['origin'] !== 'owned-historical-unbound-unit') || origins.has(row['location'])) throw new Error('Invalid tree baseline provenance');
      origins.set(row['location'], { origin: row['origin'], root: row['root'] });
    }
  }
  const native = receipt !== undefined && ownedContractCheckpointText(receipt) === serialized;
  for (const location of locations(contract)) {
    const source = location.get(); if (source === undefined) continue;
    const baseline = parsed(source), origin = origins.get(location.key);
    if (table !== undefined && origin === undefined) throw new Error('Missing tree baseline provenance');
    origins.delete(location.key); location.set(baseline);
    const historicalUnitRootPending = baseline.version === undefined && location.key.startsWith('unit:')
      && (table === undefined || origin?.origin === 'owned-historical-unbound-unit');
    if (origin?.origin === 'owned-historical-unbound-unit' && !historicalUnitRootPending) throw new Error('Invalid historical unit baseline provenance');
    const eligible = native && (origin?.origin === 'native-snapshot' || historicalUnitRootPending || table === undefined && baseline.version === undefined);
    owners.set(baseline, { root: origin?.root ?? resolve(location.root), native: eligible, historicalUnitRootPending: eligible && historicalUnitRootPending });
  }
  if (origins.size) throw new Error('Tree baseline provenance names an unknown original');
}

/**
 * The work moved to another tree (an item worktree, or the contract branch it
 * integrated into): later comparisons run there. A baseline that cannot
 * certify anything stays that way.
 */
export function selectBaselineExecutionRoot(baseline: TreeBaseline | undefined, cwd: string): void {
  if (!baseline) return;
  const owner = owners.get(baseline);
  if (!owner?.native) return;
  owner.root = resolve(cwd);
  owner.historicalUnitRootPending = false;
}

/** A copy of a live contract (for disposal) keeps its baselines' provenance; a JSON copy does not. */
export function retainOriginalTreeBaselines(original: Contract, copy: Contract): void {
  const targets = new Map(locations(copy).map(location => [location.key, location]));
  for (const location of locations(original)) {
    const baseline = location.get(), target = targets.get(location.key);
    if (!target) throw new Error('Original tree baseline copy has different locations');
    if (baseline) {
      const copied: TreeBaseline = Object.freeze({ head: baseline.head, dirty: baseline.dirty, ...(baseline.version === undefined ? {} : { version: baseline.version }) });
      const owner = owners.get(baseline);
      if (owner) owners.set(copied, { ...owner });
      target.set(copied);
    }
  }
}
