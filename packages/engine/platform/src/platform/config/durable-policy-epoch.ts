import { drainOwned } from '@goodvibes-jev/judgment/decisions';
/** Actual configuration-owner epochs. File contents alone cannot preserve A -> B -> A history. */
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmdirSync, type BigIntStats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { confirmFileDurable, writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { readFileObservation } from '../utils/file-observation.js';
import { VERSION } from '../version.js';

interface Epoch { readonly version: 1 | 2; readonly incarnation: string; readonly fileIdentity: string; }
export type ConfigurationPolicyFormat = 'configuration-policy-epochs-v2' | 'configuration-policy-snapshots-v3' | 'configuration-private-policy-snapshots-v1';
interface EpochPin { readonly observation: string; readonly value: Epoch }
interface FilePin { readonly observation: string; readonly identity: string }
interface PolicyObservations { readonly files: Map<string, FilePin>; readonly epochs: Map<string, EpochPin> }
// Actual saved expectations select this recipe: old v1 receipts, or a private
// effective frame that cannot be stored/reconstructed as a public replay recipe.
const digest = (serialized: string) => createHash('sha256').update(serialized).digest('hex');
function fileFacts(value: BigIntStats): readonly string[] {
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String);
}
type PolicySnapshot = { readonly revision: string; readonly epochs: readonly (readonly string[])[]; readonly snapshot: unknown }
  & ({ readonly version: 1 } | { readonly version: 2; readonly privateFrame: string });
interface SnapshotPin { readonly observation: string | null; readonly value: PolicySnapshot | undefined }
interface LocalBinding { readonly epochs: readonly (readonly string[])[]; readonly snapshot: unknown; readonly revision: string; readonly private: boolean; readonly privateFrame?: string }
/** Private JSON-shaped configuration includes -0/undefined; neither may alias
 * another effective frame. Tags also keep user objects distinct from numbers. */
function privateFrameValue(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === undefined) return ['undefined'];
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
  if (typeof value === 'number' && Number.isFinite(value)) return ['number', Object.is(value, -0) ? '-0' : value];
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('Unsupported private configuration frame');
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error('Unsupported private configuration frame');
  ancestors.add(value);
  try {
    const entries = Reflect.ownKeys(value).filter(key => !Array.isArray(value) || key !== 'length').map(key => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !field || !('value' in field) || !field.enumerable) throw new Error('Unsupported private configuration frame');
      return [key, privateFrameValue(field.value, ancestors)] as const;
    }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return [Array.isArray(value) ? 'array' : 'object', Array.isArray(value) ? value.length : null, entries];
  } finally { ancestors.delete(value); }
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function physical(path: string): string {
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isFile() || entry.nlink !== 1n) throw new Error('Policy source is not an ordinary file');
  return JSON.stringify([ancestry(path), entry.dev.toString(), entry.ino.toString(), entry.mode.toString(), entry.uid.toString(),
    entry.gid.toString(), entry.nlink.toString(), entry.size.toString(), entry.mtimeNs.toString(), entry.ctimeNs.toString(), entry.birthtimeNs.toString()]);
}
function ancestry(path: string, allowMissing = false): readonly unknown[] {
  const result: unknown[] = [];
  for (let parent = dirname(resolve(path));;) {
    try {
      const entry = lstatSync(parent, { bigint: true });
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Policy ancestor changed');
      result.push([parent, String(entry.dev), String(entry.ino), String(entry.birthtimeNs)]);
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const next = dirname(parent); if (next === parent) break; parent = next;
  }
  return result;
}
/** Only actual earlier v1 epoch records select this published representation. */
function savedV1FileIdentity(path: string, observations: PolicyObservations): string {
  const ancestors = ancestry(path);
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new Error('Policy source is not an ordinary file');
    const observed = physical(path), retained = observations.files.get(path);
    if (retained?.observation === observed) return retained.identity;
    const { bytes } = readFileObservation(path);
    const after = lstatSync(path, { bigint: true });
    if (JSON.stringify(fileFacts(before)) !== JSON.stringify(fileFacts(after)) || physical(path) !== observed
      || !isDeepStrictEqual(ancestry(path), ancestors)) throw new Error('Policy source changed while reading');
    const identity = digest(JSON.stringify([ancestors, fileFacts(after), createHash('sha256').update(bytes).digest('hex')]));
    observations.files.set(path, { observation: observed, identity });
    return identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Absence is also bound to its actual directory owners. A file lost
      // during the read must not inherit the original cached present image.
      try { lstatSync(path); }
      catch (absent) {
        if ((absent as NodeJS.ErrnoException).code !== 'ENOENT' || !isDeepStrictEqual(ancestry(path), ancestors)) throw absent;
        const observed = JSON.stringify([ancestors, 'absent']), retained = observations.files.get(path);
        if (retained?.observation === observed) return retained.identity;
        const identity = digest(observed); observations.files.set(path, { observation: observed, identity }); return identity;
      }
    }
    throw error;
  }
}
const FILE_OBSERVATION_PREFIX = 'policy-file-v2:';
function physicalIdentityShape(value: string): boolean {
  if (!value.startsWith(FILE_OBSERVATION_PREFIX)) return false;
  try {
    const text = value.slice(FILE_OBSERVATION_PREFIX.length), parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || JSON.stringify(parsed) !== text || !Array.isArray(parsed[0]) || parsed[0].length === 0) return false;
    const integer = (field: unknown): boolean => typeof field === 'string' && /^-?\d+$/.test(field);
    if (!parsed[0].every((entry: unknown) => Array.isArray(entry) && entry.length === 4
      && typeof entry[0] === 'string' && resolve(entry[0]) === entry[0] && entry.slice(1).every(integer))) return false;
    return (parsed.length === 2 && parsed[1] === 'absent') || (parsed.length === 11 && parsed.slice(1).every(integer));
  } catch { return false; }
}
/** Private durable physical facts, not a checksum or public identifier.
 * Nanosecond ctime also catches a same-size rewrite with restored mtime.
 * Absence remains bound to its original physical directory owners. */
function fileIdentity(path: string, observations: PolicyObservations, version: Epoch['version']): string {
  if (version === 1) return savedV1FileIdentity(path, observations);
  const ancestors = ancestry(path);
  let observed: string;
  try { observed = physical(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A source that disappeared during a read is not a confirmed absence.
    try { lstatSync(path); }
    catch (absent) {
      if ((absent as NodeJS.ErrnoException).code !== 'ENOENT' || !isDeepStrictEqual(ancestry(path), ancestors)) throw absent;
      return FILE_OBSERVATION_PREFIX + JSON.stringify([ancestors, 'absent']);
    }
    throw new Error('Policy source changed while observing absence');
  }
  if (!isDeepStrictEqual(ancestry(path), ancestors)) throw new Error('Policy source owner changed during observation');
  return FILE_OBSERVATION_PREFIX + observed;
}
function assertUnlocked(path: string): void {
  try { lstatSync(`${path}.owner-lock`); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new Error('Durable policy epoch has outstanding ownership');
}
function read(path: string, observations: PolicyObservations): Epoch {
  const observed = physical(path), retained = observations.epochs.get(path);
  if (retained?.observation === observed) return retained.value;
  const file = lstatSync(path, { bigint: true });
  if (!file.isFile() || file.nlink !== 1n) throw new Error('Durable policy epoch is not an ordinary file');
  const before = readFileSync(path, 'utf8'); const value = JSON.parse(before) as Epoch;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 || (value.version !== 1 && value.version !== 2)
    || typeof value.incarnation !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.incarnation)
    || typeof value.fileIdentity !== 'string'
    || (value.version === 1 ? !/^[0-9a-f]{64}$/.test(value.fileIdentity)
      : !physicalIdentityShape(value.fileIdentity))) throw new Error('Invalid durable policy epoch');
  confirmFileDurable(path);
  if (readFileSync(path, 'utf8') !== before) throw new Error('Durable policy epoch changed');
  const after = lstatSync(path, { bigint: true });
  if (!after.isFile() || after.nlink !== 1n || after.dev !== file.dev || after.ino !== file.ino || after.size !== file.size
    || after.mtimeNs !== file.mtimeNs || after.ctimeNs !== file.ctimeNs) throw new Error('Durable policy epoch identity changed');
  if (physical(path) !== observed) throw new Error('Durable policy epoch owner changed');
  const captured: Epoch = Object.freeze({ version: value.version, incarnation: value.incarnation, fileIdentity: value.fileIdentity });
  observations.epochs.set(path, { observation: observed, value: captured });
  return captured;
}
function locked<T>(path: string, operation: (assertOwned: () => void) => T): T {
  ancestry(path, true); // Do not create directories through an existing alias.
  mkdirSync(dirname(path), { recursive: true }); const rootIdentity = ancestry(path); const lock = `${path}.owner-lock`;
  mkdirSync(lock); const owned = lstatSync(lock);
  const assertOwned = () => {
    if (!isDeepStrictEqual(ancestry(path), rootIdentity)) throw new Error('Durable policy epoch root changed');
    const current = lstatSync(lock);
    if (!current.isDirectory() || current.dev !== owned.dev || current.ino !== owned.ino || current.birthtimeMs !== owned.birthtimeMs) throw new Error('Durable policy epoch ownership changed');
  };
  try { assertOwned(); const result = operation(assertOwned); assertOwned(); return result; }
  finally { assertOwned(); rmdirSync(lock); }
}

/**
 * Created only from ConfigManager's own resolved roots. Ordinary fresh config
 * does not create continuation history. Explicit new-source capture activates
 * it; subsequent owners read existing history without manufacturing or repairing
 * it. Once history is observed, mutation intent must commit before effects.
 * Existing lock ambiguity is never stolen.
 */
export class DurablePolicyEpochOwner {
  private failed = false;
  private active = false;
  private readonly roots: readonly string[];
  private readonly enabled: boolean;
  private accepted = new Map<string, Epoch>();
  private readonly ownerRoots = new Map<string, readonly unknown[]>();
  readonly #observations: PolicyObservations = { files: new Map(), epochs: new Map() };
  readonly #snapshotPins = new Map<string, SnapshotPin>();
  readonly #snapshots = new Map<string, LocalBinding>();
  #legacyBinding: { readonly frame: string; readonly value: string } | undefined;
  #captureIssued = false;
  /** Exact private frame belongs only to this owner. Never written to a sidecar. */
  #binding: { readonly effective: unknown; readonly replay: unknown; readonly epochs: readonly (readonly string[])[]; readonly value: string; readonly privateFrame: (() => string) | undefined } | undefined;
  private assertRoot(root: string): void {
    const identity = ancestry(root); const expected = this.ownerRoots.get(root);
    if (expected && !isDeepStrictEqual(expected, identity)) throw new Error('Durable policy owner root changed');
    this.ownerRoots.set(root, identity);
  }
  private historyExists(): boolean {
    return this.roots.some(root => {
      try { lstatSync(`${root}.policy-epoch.json`); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    });
  }
  constructor(roots: readonly string[], initialize: boolean, private readonly beforeV2Write: (format: ConfigurationPolicyFormat) => void = () => {}) {
    this.roots = Object.freeze([...new Set(roots)].sort());
    this.enabled = initialize;
    if (!initialize) { this.failed = true; return; }
    // Ordinary configuration does not create durable continuation state. Once
    // any owner history exists, however, every later mutation must honor it,
    // including before this process has attempted recovery or new issuance.
    try {
      this.active = this.historyExists();
      if (!this.active) return;
      for (const root of this.roots) {
        const path = `${root}.policy-epoch.json`; assertUnlocked(path); this.assertRoot(root);
        const current = read(path, this.#observations);
        if (current.fileIdentity !== fileIdentity(root, this.#observations, current.version)) throw new Error('Configuration policy image changed');
        assertUnlocked(path); this.accepted.set(root, current);
      }
    } catch { this.failed = true; }
  }

  private declareV2Write(format: ConfigurationPolicyFormat = 'configuration-policy-epochs-v2'): void {
    let result: unknown;
    try { result = this.beforeV2Write(format); } catch (error) { drainOwned(error); throw error; }
    if (result !== undefined) { drainOwned(result); throw new Error('Configuration reader ownership must complete synchronously'); }
  }

  /** Explicit fresh-source issuance establishes history; recovery never does. */
  capture(effective: unknown, replay?: unknown): string {
    if (!this.enabled) throw new Error('Durable configuration policy ownership is unavailable');
    if (this.active) {
      const value = this.current(effective, replay); this.#captureIssued = true;
      this.configurationRevision(effective, replay, this.#binding?.privateFrame);
      return value;
    }
    // Another manager introduced policy history after this one hydrated. Do
    // not stamp that owner's new file state onto this owner's stale values.
    if (this.historyExists()) {
      this.active = true; this.failed = true;
      throw new Error('Configuration policy owner changed; reload before new issuance');
    }
    this.active = true;
    try {
      for (const root of this.roots) {
        const path = `${root}.policy-epoch.json`;
        locked(path, () => {
          this.assertRoot(root);
          let current: Epoch | undefined;
          try { current = read(path, this.#observations); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (current) throw new Error('Configuration policy owner changed during issuance');
          const identity = fileIdentity(root, this.#observations, 2);
          current = { version: 2, incarnation: randomUUID(), fileIdentity: identity };
          this.declareV2Write();
          writeJsonFileAtomic(path, current, { durable: true, mode: 0o600 });
          this.accepted.set(root, current);
        });
      }
      this.failed = false;
    } catch { this.failed = true; }
    const value = this.current(effective, replay); this.#captureIssued = true;
    this.configurationRevision(effective, replay, this.#binding?.privateFrame);
    return value;
  }

  /** Called BEFORE every actual mutation/reload attempt, including failed/no-op changes. */
  advance(): void {
    this.#binding = undefined; this.#legacyBinding = undefined; this.#captureIssued = false; this.#snapshots.delete('configuration');
    // A read-only manager never issued durable history and keeps its ordinary
    // runtime-overlay API. A writable owner must durably revoke old history
    // before any effect, even if a preceding read or partial write faulted.
    if (!this.enabled) return;
    if (!this.active) {
      try { this.active = this.historyExists(); }
      catch {
        // This serving owner has neither issued nor observed durable history.
        // Discovery failure withholds that capability, while ordinary config
        // keeps its existing fail-restrictive/read-error handling. No durable
        // source can have been captured from this owner in this state.
        this.failed = true; return;
      }
      if (!this.active) return;
    }
    try {
      const accepted = new Map<string, Epoch>();
      for (const root of this.roots) {
        const path = `${root}.policy-epoch.json`;
        locked(path, () => {
          this.assertRoot(root);
          try {
            const source = lstatSync(root);
            if (!source.isFile() || source.nlink !== 1) throw new Error('Policy source is not an ordinary file');
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          read(path, this.#observations);
          // Do not read the possibly malformed/unreadable policy here. The
          // actual ConfigManager mutation owns restrictive fallback/error
          // handling. Its prior image is obsolete as soon as the nonce moves.
          // Mutation intent already retires the previous incarnation. Advance
          // an earlier v1 owner to physical observations only at that real
          // mutation boundary, never while merely recovering an old grant.
          const next: Epoch = { version: 2, incarnation: randomUUID(), fileIdentity: fileIdentity(root, this.#observations, 2) };
          this.declareV2Write();
          writeJsonFileAtomic(path, next, { durable: true, mode: 0o600 });
          accepted.set(root, next);
        });
      }
      this.accepted = accepted;
      this.failed = false;
    } catch (error) {
      this.failed = true;
      throw new Error('Durable configuration mutation intent could not be persisted', { cause: error });
    }
  }

  private epochs(): readonly (readonly string[])[] {
    if (!this.active || this.failed) throw new Error('Durable configuration policy ownership is unavailable');
    return this.roots.map(root => {
      const path = `${root}.policy-epoch.json`; assertUnlocked(path); this.assertRoot(root);
      const row = read(path, this.#observations);
      if (!isDeepStrictEqual(row, this.accepted.get(root)) || row.fileIdentity !== fileIdentity(root, this.#observations, row.version)) throw new Error('Configuration policy owner changed');
      assertUnlocked(path); return [root, row.incarnation];
    });
  }

  private snapshotPath(kind: string): string {
    const root = this.roots[0]; if (!root) throw new Error('Configuration policy has no source owner');
    return `${root}.policy-${kind}-v3.json`;
  }
  private readSnapshot(path: string): PolicySnapshot | undefined {
    assertUnlocked(path); this.assertRoot(path);
    const previous = this.#snapshotPins.get(path);
    let observed: string;
    try { observed = physical(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || previous?.observation) throw error;
      this.#snapshotPins.set(path, { observation: null, value: undefined }); return undefined;
    }
    if (previous) {
      if (previous.observation !== observed) throw new Error('Configuration policy snapshot owner changed');
      return previous.value;
    }
    const original = readFileObservation(path), value: unknown = JSON.parse(original.bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid configuration policy snapshot');
    const data = value as Record<string, unknown>;
    if ((data.version === 1 ? Object.keys(data).sort().join(',') !== 'epochs,revision,snapshot,version'
      : data.version !== 2 || Object.keys(data).sort().join(',') !== 'epochs,privateFrame,revision,snapshot,version'
        || typeof data.privateFrame !== 'string' || !/^[0-9a-f]{64}$/.test(data.privateFrame)) || !uuid(data.revision)
      || !Array.isArray(data.epochs) || !data.epochs.every(row => Array.isArray(row) && row.length === 2 && row.every(field => typeof field === 'string'))) throw new Error('Invalid configuration policy snapshot');
    confirmFileDurable(path);
    if (physical(path) !== observed) throw new Error('Configuration policy snapshot changed');
    const retained = value as PolicySnapshot;
    this.#snapshotPins.set(path, { observation: observed, value: retained }); return retained;
  }

  /** Only the actual manager supplies public replay/catalog data. Missing or
   * changed snapshots are cold on recovery; explicit fresh capture may publish. */
  snapshotRevision(kind: 'configuration' | 'gateway', snapshot: unknown): string {
    return this.selectSnapshotRevision(kind, snapshot);
  }

  private configurationRevision(effective: unknown, replay: unknown, privateFrame?: () => string): string {
    return replay === undefined
      ? this.selectSnapshotRevision('configuration', { code: 1, platformVersion: VERSION }, privateFrame, () => {
        if (!isDeepStrictEqual(this.#binding?.effective, effective)) throw new Error('Private configuration changed during publication');
      })
      : this.selectSnapshotRevision('configuration', replay);
  }

  private selectSnapshotRevision(kind: 'configuration' | 'gateway', snapshot: unknown, privateFrame?: () => string, assertEffective: () => void = () => {}): string {
    if (kind === 'gateway' && !this.active && !this.failed) {
      if (!this.active && this.historyExists()) { this.failed = true; throw new Error('Configuration policy owner changed before catalog capture'); }
      const previous = this.#snapshots.get(kind);
      if (previous && isDeepStrictEqual(previous.snapshot, snapshot)) return previous.revision;
      const local = { epochs: [], snapshot: structuredClone(snapshot), revision: randomUUID(), private: false };
      this.#snapshots.set(kind, local); return local.revision;
    }
    const epochs = this.epochs(), path = this.snapshotPath(kind), stored = this.readSnapshot(path);
    let local = this.#snapshots.get(kind);
    if (!local || local.private !== (privateFrame !== undefined) || !isDeepStrictEqual(local.epochs, epochs) || !isDeepStrictEqual(local.snapshot, snapshot)) {
      const sameSources = stored && (kind === 'gateway'
        ? isDeepStrictEqual(stored.epochs.map(row => row[0]), epochs.map(row => row[0]))
        : isDeepStrictEqual(stored.epochs, epochs));
      const matches = sameSources && isDeepStrictEqual(stored!.snapshot, snapshot)
        && (privateFrame ? stored!.version === 2 && stored!.privateFrame === privateFrame() : stored!.version === 1);
      const unissued = kind === 'gateway' && local?.epochs.length === 0 && isDeepStrictEqual(local.snapshot, snapshot) ? local.revision : undefined;
      local = { epochs, snapshot: structuredClone(snapshot), private: privateFrame !== undefined, revision: unissued ?? (matches ? stored!.revision : randomUUID()) };
      this.#snapshots.set(kind, local);
    }
    if (this.#captureIssued && (!stored || stored.revision !== local.revision)) {
      if (privateFrame && local.privateFrame === undefined) { local = { ...local, privateFrame: privateFrame() }; this.#snapshots.set(kind, local); }
      const selected = local;
      locked(path, assertOwned => {
        const check = () => {
          assertOwned(); this.assertRoot(path); assertEffective();
          if (!isDeepStrictEqual(this.epochs(), epochs) || !isDeepStrictEqual(snapshot, selected.snapshot)) throw new Error('Configuration policy snapshot changed during publication');
          const pin = this.#snapshotPins.get(path);
          try { if (physical(path) !== pin?.observation) throw new Error('Configuration policy snapshot changed before publication'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || pin?.observation !== null) throw error; }
        };
        check(); this.declareV2Write(privateFrame ? 'configuration-private-policy-snapshots-v1' : 'configuration-policy-snapshots-v3'); check();
        const base = { revision: selected.revision, epochs, snapshot: selected.snapshot };
        if (privateFrame && selected.privateFrame === undefined) throw new Error('Private configuration expectation is unavailable');
        const value: PolicySnapshot = selected.privateFrame === undefined ? { ...base, version: 1 } : { ...base, version: 2, privateFrame: selected.privateFrame };
        try {
          writeJsonFileAtomic(path, value, { durable: true, mode: 0o600, assertCurrent: check, onEffect: published => {
            if (published) this.#snapshotPins.set(path, { observation: physical(path), value });
          } });
        } catch (error) { this.failed = true; throw error; }
      });
    }
    assertEffective();
    if (!isDeepStrictEqual(this.epochs(), epochs)) throw new Error('Configuration policy source changed');
    return local.revision;
  }

  /** Source epochs bind persisted contributions. An actual manager supplies
   * the public loading/default/overlay recipe needed for restart equality.
   * Only unreconstructible private overlays use a one-way saved expectation;
   * their original plaintext remains in this live owner, never the sidecar. */
  current(effective: unknown, replay?: unknown, version: 1 | 2 = 2): string {
    if (version === 1) return this.currentSavedV1(effective);
    try {
      const epochs = this.epochs(), previous = this.#binding;
      if (previous && isDeepStrictEqual(previous.epochs, epochs) && !isDeepStrictEqual(previous.effective, effective)) throw new Error('Effective configuration changed without native mutation ownership');
      if (previous && isDeepStrictEqual(previous.epochs, epochs) && isDeepStrictEqual(previous.effective, effective)
        && isDeepStrictEqual(previous.replay, replay)) {
        if (this.configurationRevision(effective, replay, previous.privateFrame) !== previous.value) throw new Error('Configuration policy snapshot changed');
        return previous.value;
      }
      const captured = structuredClone(effective);
      let commitment: string | undefined;
      const privateFrame = replay === undefined ? () => commitment ??= digest(JSON.stringify([epochs, privateFrameValue(captured)])) : undefined;
      // Install the exact live frame before any publication guard can run.
      this.#binding = { effective: captured, replay: structuredClone(replay), epochs, value: '', privateFrame };
      const value = this.configurationRevision(effective, replay, privateFrame);
      this.#binding = { ...this.#binding, value };
      return value;
    } catch (error) { this.#binding = undefined; this.failed = true; throw new Error('Durable configuration policy ownership is unavailable', { cause: error }); }
  }

  /** Actual already-saved CI1 grants compare this private full-frame value.
   * This reader never issues a fresh old-format grant or writes a digest cache. */
  private currentSavedV1(effective: unknown): string {
    if (!this.active || this.failed) throw new Error('Durable configuration policy ownership is unavailable');
    try {
      const identities = this.roots.map(root => {
        const path = `${root}.policy-epoch.json`; assertUnlocked(path); this.assertRoot(root);
        const row = read(path, this.#observations);
        if (!isDeepStrictEqual(row, this.accepted.get(root)) || row.fileIdentity !== fileIdentity(root, this.#observations, row.version)) throw new Error('Configuration policy owner changed');
        assertUnlocked(path); return [root, row.incarnation, row.fileIdentity];
      });
      const frame = JSON.stringify([identities, effective]);
      if (this.#legacyBinding?.frame === frame) return this.#legacyBinding.value;
      const value = digest(frame);
      this.#legacyBinding = Buffer.byteLength(frame) <= 256 * 1024 ? { frame, value } : undefined;
      return value;
    } catch (error) { this.#legacyBinding = undefined; this.failed = true; throw new Error('Durable configuration policy ownership is unavailable', { cause: error }); }
  }

  /** Preserve the advanced nonce while adopting this owner's completed write image. */
  reconcile(): void {
    this.#binding = undefined; this.#legacyBinding = undefined; this.#captureIssued = false; this.#snapshots.delete('configuration');
    if (!this.active || this.failed) return;
    try {
      for (const root of this.roots) {
        const path = `${root}.policy-epoch.json`;
        locked(path, () => {
          this.assertRoot(root);
          const row = read(path, this.#observations); const identity = fileIdentity(root, this.#observations, row.version);
          const expected = this.accepted.get(root);
          if (!expected || row.incarnation !== expected.incarnation) throw new Error('Configuration policy owner changed');
          const next = { ...row, fileIdentity: identity };
          if (row.fileIdentity !== identity) {
            if (next.version === 2) this.declareV2Write();
            writeJsonFileAtomic(path, next, { durable: true, mode: 0o600 });
          }
          this.accepted.set(root, next);
        });
      }
    } catch { this.failed = true; }
  }
}
