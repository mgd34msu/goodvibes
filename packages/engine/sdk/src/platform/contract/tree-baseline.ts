/** Dirty baselines survive checkpoints without saving dirty file contents.
 * Fresh local equality uses private exact bytes. A digest exists only as the
 * compact saved baseline commitment used after a restart; it is neither a model
 * question nor authority and is dictionary-recoverable, not anonymization. */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { captureDirtyFile, captureDirtyTreeRoot, equalDirtyFiles, type CapturedDirtyFile, type DirtyTreeRoot } from '../orchestration/dirty-file-observation.js';
import { nativeDirtySnapshotEntries, nativeDirtySnapshotRoot, snapshotDirtyTree, type ScopedCommitExclusion } from '../orchestration/dirty-guard.js';
import { ownedContractCheckpointText, type OwnedContractCheckpointRead } from './owned-checkpoint-read.js';
import type { Contract, TreeBaseline } from './types.js';

type Comparable = Exclude<CapturedDirtyFile, { readonly kind: 'unavailable' }>;
interface BaselineOwner {
  root: string;
  selection: DirtyTreeRoot | undefined;
  readonly native: boolean;
  retainBytes: boolean;
  historicalUnitRootPending: boolean;
  readonly initial: Map<string, CapturedDirtyFile>;
  readonly latest: Map<string, { readonly file: Comparable; readonly equal?: boolean }>;
  readonly settledComparisons: Map<string, { readonly assertCurrent: () => void; readonly equal: boolean }>;
}
const owners = new WeakMap<TreeBaseline, BaselineOwner>();
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function commitment(file: Comparable): string | null {
  if (file.kind === 'missing') return null;
  // Actual saved Contract/Group/Unit baseline consumer only: a restarted
  // process cannot recover the original bytes from physical facts or an opaque
  // ID. Keeping a digest avoids newly persisting possibly-secret dirty bytes.
  return (file.kind === 'file' && file.executable ? 'executable' : file.kind) + ':' + createHash('sha256').update(file.bytes).digest('hex');
}
export function createTreeBaseline(cwd: string, head: string | null): TreeBaseline {
  const snapshot = snapshotDirtyTree(cwd), entries = nativeDirtySnapshotEntries(snapshot, cwd), selection = nativeDirtySnapshotRoot(snapshot, cwd), dirty: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  for (const [path, file] of entries) {
    if (file.kind === 'unavailable') throw new Error('Original dirty baseline is unavailable; owner edits remain uncommitted');
    dirty[path] = commitment(file);
  }
  const baseline: TreeBaseline = Object.freeze({ version: 2, head, dirty: Object.freeze(dirty) });
  owners.set(baseline, { root: resolve(cwd), selection, native: true, retainBytes: true, historicalUnitRootPending: false, initial: new Map(entries), latest: new Map(), settledComparisons: new Map() }); return baseline;
}
function current(owner: BaselineOwner, path: string): CapturedDirtyFile {
  if (!owner.retainBytes) return owner.selection ? captureDirtyFile(owner.root, path, owner.selection) : { kind: 'unavailable', revision: null };
  const initial = owner.initial.get(path);
  let previous = owner.latest.get(path)?.file;
  if (!previous && initial && initial.kind !== 'unavailable' && initial.root === owner.root) previous = initial;
  if (previous) { try { previous.assertCurrent(); return previous; } catch { /* Read the new actual source, never adopt its old physical identity. */ } }
  const file = owner.selection ? captureDirtyFile(owner.root, path, owner.selection) : { kind: 'unavailable' as const, revision: null };
  if (file.kind !== 'unavailable') owner.latest.set(path, { file });
  return file;
}
function comparisonOwner(cwd: string, baseline: TreeBaseline): BaselineOwner | undefined {
  const owner = owners.get(baseline);
  if (!owner?.native || owner.historicalUnitRootPending || owner.root !== resolve(cwd) || !owner.selection) return undefined;
  try { owner.selection.assertCurrent(); return owner; } catch { return undefined; }
}
/** Retain the already selected comparison-root guard for a real Git commit.
 * It remains separate from accepted output/source checks and issues no bytes. */
export function assertBaselineExecutionRootCurrent(cwd: string, baseline: TreeBaseline): void {
  if (!comparisonOwner(cwd, baseline)) throw new Error('Original tree baseline comparison root is unavailable');
}
/** True/false compare content; undefined preserves uncertainty. A copied public
 * baseline has no private originals and cannot certify source equality. */
export function baselinePathUnchanged(cwd: string, baseline: TreeBaseline, path: string): boolean | undefined {
  const owner = comparisonOwner(cwd, baseline);
  if (!owner) return undefined;
  if (!Object.hasOwn(baseline.dirty, path)) return false;
  if (!owner.retainBytes) {
    const previous = owner.settledComparisons.get(path);
    if (previous) { try { previous.assertCurrent(); return previous.equal; } catch { owner.settledComparisons.delete(path); } }
  }
  const now = current(owner, path);
  if (now.kind === 'unavailable') return undefined;
  const initial = owner.initial.get(path);
  if (initial !== undefined) {
    if (baseline.version === undefined && initial.kind === 'file' && now.kind === 'file') return initial.bytes.equals(now.bytes);
    return equalDirtyFiles(initial, now);
  }
  const cached = owner.latest.get(path);
  if (cached?.file === now && cached.equal !== undefined) return cached.equal;
  const saved = baseline.dirty[path];
  let equal: boolean;
  if (baseline.version === 2) {
    if (saved === null) equal = now.kind === 'missing';
    else if (now.kind === 'missing') equal = false;
    else if (!saved?.startsWith((now.kind === 'file' && now.executable ? 'executable' : now.kind) + ':')) equal = false;
    else equal = commitment(now) === saved;
  } else {
    // Old null conflated deletion with failed reads; old symlinks hashed their
    // external target. Neither can certify an original source after restart.
    if (saved === null || now.kind === 'symlink') return undefined;
    // Only an actual owned pre-v2 checkpoint can reach this compatibility
    // digest. Fresh launches and JSON/import copies never hash through here.
    equal = now.kind !== 'missing' && createHash('sha256').update(now.bytes).digest('hex') === saved;
  }
  if (owner.retainBytes) owner.latest.set(path, { file: now, equal });
  else owner.settledComparisons.set(path, { assertCurrent: now.assertCurrent, equal }); // Metadata-only; the closure captures no leaf-byte scope.
  if (equal && owner.retainBytes) owner.initial.set(path, now); // Actual verified adoption once, not a raw-content global cache.
  return equal;
}
export function partitionBaselinePaths(cwd: string, candidatePaths: readonly string[], baseline: TreeBaseline | undefined): ScopedCommitExclusion {
  const included: string[] = [], excluded: string[] = [], uncertain: string[] = [];
  const verified = baseline === undefined || comparisonOwner(cwd, baseline) !== undefined;
  for (const path of candidatePaths) {
    if (!verified) { excluded.push(path); uncertain.push(path); continue; }
    if (!baseline || !Object.hasOwn(baseline.dirty, path)) { included.push(path); continue; }
    const equal = baselinePathUnchanged(cwd, baseline, path);
    if (equal === false) included.push(path);
    else { excluded.push(path); if (equal === undefined) uncertain.push(path); }
  }
  return { included, excluded, uncertain };
}
export function baselineChangedPaths(cwd: string, paths: readonly string[], baseline: TreeBaseline | undefined): readonly string[] {
  if (baseline !== undefined && !comparisonOwner(cwd, baseline)) throw new Error('Original dirty baseline cannot be verified; preserve owner edits and inspect or re-establish the original work baseline before continuing');
  const candidates = [...new Set([...paths, ...Object.keys(baseline?.dirty ?? {})])];
  const result = partitionBaselinePaths(cwd, candidates, baseline);
  if (result.uncertain.length) throw new Error('Original dirty baseline cannot be verified; preserve owner edits and inspect or re-establish the original work baseline before continuing');
  return result.included;
}
function parsed(value: unknown): TreeBaseline {
  if (!record(value) || !Object.keys(value).every(key => key === 'head' || key === 'dirty' || key === 'version')
    || !(value['head'] === null || typeof value['head'] === 'string') || !record(value['dirty']) || !(value['version'] === undefined || value['version'] === 2)) throw new Error('Invalid original tree baseline');
  const dirty: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  for (const [path, saved] of Object.entries(value['dirty'])) {
    if (!path || path.startsWith('/') || path.includes('\0') || path.split('/').some(part => part === '' || part === '.' || part === '..' || part === '.git' || part === '.goodvibes')
      || !(saved === null || typeof saved === 'string' && (value['version'] === 2 ? /^(?:file|executable|symlink):[a-f0-9]{64}$/ : /^[a-f0-9]{64}$/).test(saved))) throw new Error('Invalid original tree baseline');
    dirty[path] = saved;
  }
  return Object.freeze({ head: value['head'], dirty: Object.freeze(dirty), ...(value['version'] === 2 ? { version: 2 as const } : {}) });
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
/** Checkpoint-only provenance. It contains no file bytes or source facts. */
export function storedTreeBaselineOrigins(contract: Contract) {
  return { version: 1, entries: locations(contract).flatMap(location => {
    const baseline = location.get(); if (!baseline) return [];
    parsed(baseline);
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
    const root = origin?.root ?? resolve(location.root);
    let selection: DirtyTreeRoot | undefined;
    if (eligible) { try { selection = captureDirtyTreeRoot(root); } catch { /* Unavailable current roots cannot become file deletions or native byte proof. */ } }
    owners.set(baseline, { root, selection, native: eligible, retainBytes: true, historicalUnitRootPending: eligible && historicalUnitRootPending, initial: new Map(), latest: new Map(), settledComparisons: new Map() });
  }
  if (origins.size) throw new Error('Tree baseline provenance names an unknown original');
  if (receipt !== undefined && ownedContractCheckpointText(receipt) !== serialized) throw new Error('Original tree baseline checkpoint changed');
}
/** Actual executor/correction lifecycle only: select the current comparison
 * tree, including an integrated item's contract branch. Original bytes and
 * saved commitments stay unchanged; another tree is not promoted to original
 * physical ownership, and JSON/import cannot acquire native provenance. */
export function selectBaselineExecutionRoot(baseline: TreeBaseline | undefined, cwd: string): void {
  if (!baseline) return;
  const owner = owners.get(baseline);
  if (!owner?.native) return;
  const selected = resolve(cwd);
  if (owner.root === selected && owner.selection) {
    owner.selection.assertCurrent(); owner.historicalUnitRootPending = false; return;
  }
  if (owner.root === selected && !owner.historicalUnitRootPending) throw new Error('Original tree baseline comparison root is unavailable');
  const selection = captureDirtyTreeRoot(selected);
  owner.latest.clear(); owner.settledComparisons.clear(); owner.root = selected; owner.selection = selection; owner.historicalUnitRootPending = false;
}
/** An actual runtime owner's disposal clone retains original immutable byte
 * observations with an independent comparison-context/cache map. Arbitrary
 * structuredClone/JSON cannot inherit native byte originals. */
export function retainOriginalTreeBaselines(original: Contract, copy: Contract): void {
  const targets = new Map(locations(copy).map(location => [location.key, location]));
  for (const location of locations(original)) {
    const baseline = location.get(), target = targets.get(location.key);
    if (!target) throw new Error('Original tree baseline copy has different locations');
    if (baseline) {
      const copied: TreeBaseline = Object.freeze({ head: baseline.head, dirty: baseline.dirty, ...(baseline.version === 2 ? { version: 2 as const } : {}) });
      const owner = owners.get(baseline);
      if (owner) owners.set(copied, { ...owner, initial: new Map(owner.initial), latest: new Map(owner.latest), settledComparisons: new Map(owner.settledComparisons) });
      target.set(copied);
    }
  }
}

/** Executor settlement ends private byte/cache retention, even though terminal
 * history keeps the public Contract. Saved commitments and native provenance
 * remain available for an explicit later read. Its temporary bytes are not
 * cached on terminal history; cleanup itself performs no I/O. */
export function releaseTreeBaselineBytes(contract: Contract): void {
  const released = new Set<BaselineOwner>();
  for (const location of locations(contract)) {
    const baseline = location.get(), owner = baseline && owners.get(baseline);
    if (!owner || released.has(owner)) continue;
    owner.initial.clear(); owner.latest.clear(); owner.settledComparisons.clear(); owner.retainBytes = false; released.add(owner);
  }
}
