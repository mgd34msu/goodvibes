import { drainOwned } from '@goodvibes-jev/judgment/decisions';
/** Actual configuration-owner epochs. File contents alone cannot preserve A -> B -> A history. */
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmdirSync, type BigIntStats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { confirmFileDurable, writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { readFileObservation } from '../utils/file-observation.js';

interface Epoch { readonly version: 1 | 2; readonly incarnation: string; readonly fileIdentity: string; }
// A persisted continuation must compare the effective configuration after a
// restart, including CLI/default/runtime contributions. Retaining the plaintext
// frame in a sidecar would duplicate private configuration values. Keep one
// compact, non-reversible commitment; it is not an authorization signature.
// Physical file observations below need no additional content hashes.
const digest = (serialized: string) => createHash('sha256').update(serialized).digest('hex');
interface FilePin { readonly observation: string; readonly identity: string }
interface EpochPin { readonly observation: string; readonly value: Epoch }
interface PolicyObservations {
  readonly files: Map<string, FilePin>;
  readonly epochs: Map<string, EpochPin>;
}
const MAX_RETAINED_POLICY_FRAME = 256 * 1024;
function fileFacts(value: BigIntStats): readonly string[] {
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String);
}
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
function locked<T>(path: string, operation: () => T): T {
  ancestry(path, true); // Do not create directories through an existing alias.
  mkdirSync(dirname(path), { recursive: true }); const rootIdentity = ancestry(path); const lock = `${path}.owner-lock`;
  mkdirSync(lock); const owned = lstatSync(lock);
  const assertOwned = () => {
    if (!isDeepStrictEqual(ancestry(path), rootIdentity)) throw new Error('Durable policy epoch root changed');
    const current = lstatSync(lock);
    if (!current.isDirectory() || current.dev !== owned.dev || current.ino !== owned.ino || current.birthtimeMs !== owned.birthtimeMs) throw new Error('Durable policy epoch ownership changed');
  };
  try { assertOwned(); const result = operation(); assertOwned(); return result; }
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
  /** At most one bounded private frame. Never log/persist configuration values. */
  #binding: { readonly frame: string; readonly value: string } | undefined;
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
  constructor(roots: readonly string[], initialize: boolean, private readonly beforeV2Write: () => void = () => {}) {
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

  private declareV2Write(): void {
    const result: unknown = this.beforeV2Write();
    if (result !== undefined) { drainOwned(result); throw new Error('Configuration reader ownership must complete synchronously'); }
  }

  /** Explicit fresh-source issuance establishes history; recovery never does. */
  capture(effective: unknown): string {
    if (!this.enabled) throw new Error('Durable configuration policy ownership is unavailable');
    if (this.active) return this.current(effective);
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
    return this.current(effective);
  }

  /** Called BEFORE every actual mutation/reload attempt, including failed/no-op changes. */
  advance(): void {
    this.#binding = undefined;
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

  /** Reads never establish missing history or refresh a stale external image. */
  current(effective: unknown): string {
    if (!this.active || this.failed) throw new Error('Durable configuration policy ownership is unavailable');
    try {
      const identities = this.roots.map(root => {
        const path = `${root}.policy-epoch.json`; assertUnlocked(path);
        const row = read(path, this.#observations);
        if (JSON.stringify(row) !== JSON.stringify(this.accepted.get(root))) throw new Error('Configuration policy owner changed');
        if (row.fileIdentity !== fileIdentity(root, this.#observations, row.version)) throw new Error('Configuration policy image changed');
        assertUnlocked(path); return [root, row.incarnation, row.fileIdentity];
      });
      const frame = JSON.stringify([identities, effective]);
      if (this.#binding?.frame === frame) return this.#binding.value;
      const value = digest(frame);
      this.#binding = Buffer.byteLength(frame) <= MAX_RETAINED_POLICY_FRAME ? { frame, value } : undefined;
      return value;
    } catch (error) { this.#binding = undefined; this.failed = true; throw new Error('Durable configuration policy ownership is unavailable', { cause: error }); }
  }

  /** Preserve the advanced nonce while adopting this owner's completed write image. */
  reconcile(): void {
    this.#binding = undefined;
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
