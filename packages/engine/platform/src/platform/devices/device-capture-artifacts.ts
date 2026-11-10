/** Retained paired-device captures. Fresh bytes use their original native file
 * observation, not a content digest. Earlier saved v1 checksum rows verify that
 * published pin once when their bytes are adopted into v2. */
import { createHash } from 'node:crypto';
import { opaqueUuid, drainOwned } from '@goodvibes-jev/judgment/decisions';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, chmodSync, openSync, unlinkSync, writeFile, type BigIntStats } from 'node:fs';
import { join, resolve } from 'node:path';
import { PersistentStore } from '../state/persistent-store.js';
import { ArtifactStorageOwner, type ArtifactCreatedLeaf } from '../artifacts/storage-ownership.js';
import { fileObservationIdentity, readFileObservation, type FileObservation } from '../utils/file-observation.js';
import { tryAcquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
import { isDeviceCapabilityId, type DeviceArtifactKind, type DeviceCapabilityId } from './device-capability-contract.js';
import { resolveDevicePolicySource, type DevicePolicySource } from './device-policy-source.js';

export interface DeviceCaptureArtifact {
  readonly id: string;
  readonly nodeId: string;
  readonly capabilityId: DeviceCapabilityId;
  readonly kind: DeviceArtifactKind;
  readonly mediaType: string;
  readonly fileName: string;
  readonly byteLength: number;
  /** Compatibility metadata from an actual earlier saved capture. */
  readonly sha256?: string | undefined;
  readonly capturedAt: number;
  readonly expiresAt: number;
  readonly workId?: string | undefined;
  readonly reason?: string | undefined;
}
export type DeviceArtifactRemovalReason = 'expired' | 'file-missing' | 'content-mismatch' | 'orphan-file' | 'malformed' | 'count-cap';
export interface DeviceArtifactRemoval {
  readonly artifactId: string; readonly nodeId: string; readonly capabilityId: string; readonly fileName: string;
  readonly reason: DeviceArtifactRemovalReason; readonly removedAt: number; readonly byteLength: number;
}
export interface DeviceArtifactSweepReport { readonly sweptAt: number; readonly removed: readonly DeviceArtifactRemoval[]; readonly retained: number; readonly bytesReclaimed: number }
export interface DeviceArtifactPolicy { readonly retentionMs: number; readonly maxArtifacts: number }
export const DEFAULT_DEVICE_ARTIFACT_POLICY: DeviceArtifactPolicy = { retentionMs: 24 * 60 * 60 * 1000, maxArtifacts: 200 };
interface SavedArtifact extends DeviceCaptureArtifact { readonly sourceObservation?: string }
interface PendingCapture { readonly id: string; readonly fileName: string; readonly sourceIdentity: string; readonly capturedAt: number }
const pendingIdentity = (entry: BigIntStats): string => {
  if (!entry.isFile() || entry.nlink !== 1n || (entry.mode & 0o777n) !== 0o600n) throw new Error('Pending device capture source is unavailable');
  return [entry.dev, entry.ino, entry.uid, entry.gid, entry.mode, entry.nlink, entry.birthtimeNs].join(':');
};
interface DeviceArtifactSnapshot extends Record<string, unknown> {
  readonly version: 1 | 2; readonly artifacts: readonly SavedArtifact[];
  /** A real exclusively-created descriptor is bound before writing payload. */
  readonly pending?: readonly PendingCapture[];
  /** Rejected/replaced leaves are preserved for inspection, not later adopted
   * as our orphan files merely because their original index row was removed. */
  readonly preservedFiles?: readonly string[];
}
const ARTIFACT_KINDS: readonly DeviceArtifactKind[] = ['image', 'video', 'text', 'geo', 'none'];
const CAPTURE_FILE = /^[0-9a-p]{8}-[0-9a-p]{4}-[0-9a-p]{4}-[0-9a-p]{4}-[0-9a-p]{12}\.(?:png|webp|jpg|webm|bin)$/;
const MAX_PRESERVED_FILES = 2048;
const missing = (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
function validateArtifact(value: unknown): SavedArtifact | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id || typeof row.nodeId !== 'string' || !row.nodeId || typeof row.fileName !== 'string'
    || !CAPTURE_FILE.test(row.fileName) || !row.fileName.startsWith(`${row.id}.`) || !isDeviceCapabilityId(row.capabilityId)
    || typeof row.kind !== 'string' || !ARTIFACT_KINDS.includes(row.kind as DeviceArtifactKind)
    || typeof row.byteLength !== 'number' || !Number.isSafeInteger(row.byteLength) || row.byteLength < 0
    || typeof row.capturedAt !== 'number' || !Number.isFinite(row.capturedAt) || typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt)
    || row.sha256 !== undefined && (typeof row.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.sha256))
    || row.sourceObservation !== undefined && (typeof row.sourceObservation !== 'string' || !row.sourceObservation || row.sourceObservation.length > 1024)
    || row.sourceObservation === undefined && row.sha256 === undefined) return null;
  return { id: row.id, nodeId: row.nodeId, capabilityId: row.capabilityId, kind: row.kind as DeviceArtifactKind,
    mediaType: typeof row.mediaType === 'string' && row.mediaType ? row.mediaType : 'application/octet-stream', fileName: row.fileName,
    byteLength: row.byteLength, capturedAt: row.capturedAt, expiresAt: row.expiresAt,
    ...(typeof row.sha256 === 'string' ? { sha256: row.sha256 } : {}),
    ...(typeof row.sourceObservation === 'string' ? { sourceObservation: row.sourceObservation } : {}),
    ...(typeof row.workId === 'string' && row.workId ? { workId: row.workId } : {}), ...(typeof row.reason === 'string' && row.reason ? { reason: row.reason } : {}) };
}
const publicArtifact = (row: SavedArtifact): DeviceCaptureArtifact => { const { sourceObservation: _source, ...artifact } = row; return artifact; };
export interface DeviceCaptureStoreOptions {
  readonly policy?: DevicePolicySource<DeviceArtifactPolicy> | undefined;
  readonly now?: (() => number) | undefined;
  /** Native root declares device-capture-observations-v2 before publication. */
  readonly beforeObservationWrite?: (() => void) | undefined;
}
export type DeviceArtifactReadResult = { readonly ok: true; readonly artifact: DeviceCaptureArtifact; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'not-found' | 'expired' | 'file-missing' | 'content-mismatch' };
interface Mutation {
  readonly owner: ArtifactStorageOwner;
  readonly preserved: Set<string>;
  current(): void;
  declare(): void;
  retain(assertion: () => void): void;
  create(name: string): ArtifactCreatedLeaf;
  stage(capture: PendingCapture, assertion: () => void): Promise<void>;
  complete(id: string): void;
  readonly pending: Map<string, PendingCapture>;
  remove(path: string, assertion: () => void, removed?: () => void): void;
}
export class DeviceCaptureArtifactStore {
  private readonly directory: string;
  private readonly index: PersistentStore<DeviceArtifactSnapshot>;
  private readonly resolvePolicy: () => DeviceArtifactPolicy;
  private readonly now: () => number;
  private readonly beforeObservationWrite: (() => void) | undefined;
  private owner: ArtifactStorageOwner | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  constructor(directory: string, options: DeviceCaptureStoreOptions = {}) {
    this.directory = resolve(directory); this.index = new PersistentStore<DeviceArtifactSnapshot>(join(this.directory, 'capture-index.json'));
    this.resolvePolicy = resolveDevicePolicySource(options.policy, DEFAULT_DEVICE_ARTIFACT_POLICY);
    this.now = options.now ?? Date.now; this.beforeObservationWrite = options.beforeObservationWrite?.bind(options);
  }
  getPolicy(): DeviceArtifactPolicy { return this.resolvePolicy(); }
  getDirectory(): string { return this.directory; }
  private storage(): ArtifactStorageOwner {
    if (!this.owner) { mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700); this.owner = new ArtifactStorageOwner(this.directory); }
    this.owner.assertCurrent(); return this.owner;
  }
  private readIndex(): { rows: SavedArtifact[]; malformed: number; preserved: Set<string>; pending: Map<string, PendingCapture>; image: FileObservation | null; version: 1 | 2 } {
    let image: FileObservation;
    try { image = readFileObservation(join(this.directory, 'capture-index.json')); }
    catch (error) { if (missing(error)) return { rows: [], malformed: 0, preserved: new Set(), pending: new Map(), image: null, version: 1 }; throw error; }
    const raw: unknown = JSON.parse(image.bytes.toString('utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Device capture index is unavailable');
    const row = raw as Record<string, unknown>;
    if ((row.version !== 1 && row.version !== 2) || !Array.isArray(row.artifacts)
      || row.preservedFiles !== undefined && (!Array.isArray(row.preservedFiles) || row.preservedFiles.length > MAX_PRESERVED_FILES
        || row.preservedFiles.some(name => typeof name !== 'string' || !CAPTURE_FILE.test(name)))) throw new Error('Device capture index format is unavailable');
    const pending = new Map<string, PendingCapture>();
    if (row.pending !== undefined) {
      if (row.version !== 2 || !Array.isArray(row.pending) || row.pending.length > MAX_PRESERVED_FILES) throw new Error('Device pending capture format is unavailable');
      for (const value of row.pending) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Device pending capture is unavailable');
        const entry = value as Record<string, unknown>;
        if (typeof entry.id !== 'string' || typeof entry.fileName !== 'string' || !CAPTURE_FILE.test(entry.fileName) || !entry.fileName.startsWith(`${entry.id}.`)
          || typeof entry.sourceIdentity !== 'string' || !entry.sourceIdentity || entry.sourceIdentity.length > 1024
          || typeof entry.capturedAt !== 'number' || !Number.isFinite(entry.capturedAt) || pending.has(entry.id)) throw new Error('Device pending capture is unavailable');
        pending.set(entry.id, { id: entry.id, fileName: entry.fileName, sourceIdentity: entry.sourceIdentity, capturedAt: entry.capturedAt });
      }
      if (new Set([...pending.values()].map(entry => entry.fileName)).size !== pending.size) throw new Error('Device pending capture filenames conflict');
    }
    const preserved = new Set(row.preservedFiles as string[] | undefined);
    const rows = row.artifacts.map((value: unknown) => {
      const artifact = validateArtifact(value);
      if (row.version === 1 && artifact?.sourceObservation !== undefined) throw new Error('Device capture observation needs its v2 index format');
      if (!artifact && value && typeof value === 'object' && 'fileName' in value && typeof value.fileName === 'string' && CAPTURE_FILE.test(value.fileName)) preserved.add(value.fileName);
      return artifact;
    }).filter((entry): entry is SavedArtifact => entry !== null);
    if (rows.some(entry => preserved.has(entry.fileName) || pending.has(entry.id) || [...pending.values()].some(staged => staged.fileName === entry.fileName))
      || new Set(rows.map(entry => entry.id)).size !== rows.length || new Set(rows.map(entry => entry.fileName)).size !== rows.length) throw new Error('Device capture index has conflicting identities');
    return { rows, malformed: row.artifacts.length - rows.length, preserved, pending, image, version: row.version };
  }
  private mutate<T>(fn: (rows: SavedArtifact[], malformed: number, mutation: Mutation) => Promise<{ next: SavedArtifact[]; result: T }>, beforePublish?: () => void): Promise<T> {
    const run = this.writeChain.then(async () => {
      const owner = this.storage(), lock = this.index.lockPath; if (!lock) throw new Error('Device capture index requires native storage');
      const release = tryAcquireCrossProcessLock(lock, { assertCurrent: () => owner.assertCurrent() }); if (!release) throw new Error('Another device capture writer is active');
      const retained: (() => void)[] = [], created: ArtifactCreatedLeaf[] = [], removals: { path: string; assertion: () => void; removed?: (() => void) | undefined }[] = [];
      let finalPublished = false;
      try {
        const lease = fileObservationIdentity(lock), saved = this.readIndex(); let expected = saved.image;
        let beforeRows = JSON.stringify(saved.rows), beforePreserved = JSON.stringify([...saved.preserved].sort()), beforePending = JSON.stringify([...saved.pending.values()]);
        const physicalCurrent = () => {
          owner.assertCurrent(); if (fileObservationIdentity(lock) !== lease) throw new Error('Device capture writer lease changed');
          if (expected ? fileObservationIdentity(join(this.directory, 'capture-index.json')) !== expected.physical
            : lstatSync(join(this.directory, 'capture-index.json'), { throwIfNoEntry: false }) !== undefined) throw new Error('Device capture index changed');
        };
        const current = () => {
          physicalCurrent(); for (const assertion of retained) assertion();
          const returned: unknown = beforePublish?.(); if (returned !== undefined) { drainOwned(returned); throw new Error('Device capture owner assertions must be synchronous'); }
          physicalCurrent();
        };
        // Avoid a bare `declare()` statement: Bun's TypeScript parser treats it
        // as an ambient declaration and can erase the actual writer-floor call.
        const declareFormat = () => { current(); const result: unknown = this.beforeObservationWrite?.(); if (result !== undefined) { drainOwned(result); throw new Error('Device capture format declaration must be synchronous'); } current(); };
        const publish = async (rows: SavedArtifact[], final: boolean, additional?: () => void) => {
          current(); additional?.(); declareFormat();
          const guarded = () => { current(); additional?.(); };
          await this.index.persist({ version: 2, artifacts: rows, ...(saved.pending.size ? { pending: [...saved.pending.values()] } : {}),
            ...(saved.preserved.size ? { preservedFiles: [...saved.preserved].sort() } : {}) }, {
            synchronousPublish: true, durable: true, assertCurrent: guarded,
            onEffect: effect => { if (effect === true) { if (final) finalPublished = true; expected = readFileObservation(join(this.directory, 'capture-index.json')); } },
          }); guarded();
          beforeRows = JSON.stringify(rows); beforePreserved = JSON.stringify([...saved.preserved].sort()); beforePending = JSON.stringify([...saved.pending.values()]);
        };
        const mutation: Mutation = { owner, current, declare: declareFormat, pending: saved.pending, preserved: saved.preserved,
          retain(assertion) { assertion(); retained.push(assertion); },
          create(name) { current(); const leaf = owner.leaf(name); created.push(leaf); return leaf; },
          async stage(capture, assertion) {
            current(); assertion();
            if (saved.pending.has(capture.id) || saved.rows.some(row => row.id === capture.id || row.fileName === capture.fileName)
              || saved.pending.size >= MAX_PRESERVED_FILES) throw new Error('Device pending capture identity is unavailable');
            saved.pending.set(capture.id, Object.freeze({ ...capture }));
            // Actual descriptor proof is durable before a payload byte is
            // written. A crash spool can be reclaimed without trusting its name.
            await publish(saved.rows, false, assertion);
          },
          complete(id) { current(); saved.pending.delete(id); },
          remove(path, assertion, removed) { removals.push({ path, assertion, removed }); },
        };
        const { next, result } = await fn(saved.rows, saved.malformed, mutation); current();
        if (saved.preserved.size > MAX_PRESERVED_FILES) throw new Error('Device capture preserved evidence requires inspection before more captures');
        if (saved.malformed > 0 || beforeRows !== JSON.stringify(next) || beforePreserved !== JSON.stringify([...saved.preserved].sort())
          || beforePending !== JSON.stringify([...saved.pending.values()])) await publish(next, true);
        for (const removal of removals) { current(); try { removal.assertion(); unlinkSync(removal.path); removal.removed?.(); } catch { /* Replaced evidence remains under its pending original proof. */ } }
        if (beforePending !== JSON.stringify([...saved.pending.values()])) await publish(next, true);
        return result;
      } catch (error) {
        // A failed/cancelled owner cannot submit another capture. Its existing
        // durable pending proof remains for the next owner to clean only that
        // original inode; a foreign replacement never becomes an owned orphan.
        if (!finalPublished) for (const leaf of created) leaf.cleanup();
        throw error;
      } finally { release(); }
    });
    this.writeChain = run.then(() => undefined, () => undefined); return run;
  }
  async list(nodeId?: string): Promise<readonly DeviceCaptureArtifact[]> {
    this.storage(); const { rows } = this.readIndex(), now = this.now();
    return rows.filter(row => row.expiresAt > now && (!nodeId || row.nodeId === nodeId)).sort((a, b) => b.capturedAt - a.capturedAt).map(publicArtifact);
  }
  async retain(input: { readonly nodeId: string; readonly capabilityId: DeviceCapabilityId; readonly kind: DeviceArtifactKind; readonly mediaType: string;
    readonly bytes: Uint8Array; readonly workId?: string | undefined; readonly reason?: string | undefined; readonly ttlMs?: number | undefined; readonly assertCurrent?: (() => void) | undefined }): Promise<DeviceCaptureArtifact> {
    const assertion = input.assertCurrent;
    if (assertion !== undefined && typeof assertion !== 'function') throw new Error('Device capture owner is unavailable');
    const assertOriginal = assertion?.bind(input); assertOriginal?.();
    input = { ...input, bytes: Buffer.from(input.bytes), ...(assertOriginal ? { assertCurrent: assertOriginal } : {}) };
    if (!input.nodeId || !isDeviceCapabilityId(input.capabilityId) || !ARTIFACT_KINDS.includes(input.kind)) throw new Error('Device capture identity is invalid');
    const bytes = input.bytes, now = this.now(), id = opaqueUuid();
    const extension = input.mediaType.includes('png') ? 'png' : input.mediaType.includes('webp') ? 'webp' : /jpe?g/.test(input.mediaType) ? 'jpg' : input.mediaType.includes('webm') ? 'webm' : 'bin';
    const fileName = `${id}.${extension}`;
    return this.mutate(async (rows, _malformed, mutation) => {
      mutation.declare(); const leaf = mutation.create(fileName), fd = leaf.open();
      try { leaf.claim(fd); mutation.current();
        const sourceIdentity = pendingIdentity(fstatSync(fd, { bigint: true }));
        await mutation.stage({ id, fileName, sourceIdentity, capturedAt: now }, () => {
          leaf.assertWriting(fd); if (pendingIdentity(fstatSync(fd, { bigint: true })) !== sourceIdentity) throw new Error('Pending capture descriptor changed');
        }); mutation.current(); leaf.assertWriting(fd);
        await new Promise<void>((resolve, reject) => writeFile(fd, bytes, error => error ? reject(error) : resolve())); mutation.current();
        fsyncSync(fd); leaf.seal(fd);
      } finally { closeSync(fd); }
      mutation.current(); leaf.assertSealed(); mutation.retain(() => leaf.assertSealed());
      const ttl = input.ttlMs && input.ttlMs > 0 ? input.ttlMs : this.getPolicy().retentionMs;
      const row: SavedArtifact = { id, nodeId: input.nodeId, capabilityId: input.capabilityId, kind: input.kind, mediaType: input.mediaType, fileName,
        byteLength: bytes.byteLength, sourceObservation: mutation.owner.importedStamp(join(this.directory, fileName)), capturedAt: now, expiresAt: now + ttl,
        ...(input.workId ? { workId: input.workId } : {}), ...(input.reason ? { reason: input.reason } : {}) };
      mutation.complete(id); return { next: [...rows, row], result: publicArtifact(row) };
    }, input.assertCurrent);
  }
  pathFor(artifact: DeviceCaptureArtifact): string { if (!CAPTURE_FILE.test(artifact.fileName)) throw new Error('Invalid device capture filename'); return join(this.directory, artifact.fileName); }
  private adopt(row: SavedArtifact, mutation: Mutation, needBytes: boolean): { row: SavedArtifact; bytes?: Uint8Array } {
    mutation.current(); const path = this.pathFor(row);
    if (row.sourceObservation !== undefined) {
      mutation.owner.assertImported(path, row.sourceObservation);
      if (!needBytes) return { row };
      const bytes = readFileObservation(path).bytes; mutation.current(); mutation.owner.assertImported(path, row.sourceObservation);
      if (bytes.byteLength !== row.byteLength) throw new Error('Device capture size changed'); return { row, bytes };
    }
    const original = readFileObservation(path), stat = lstatSync(path, { bigint: true });
    // This branch is exclusively an actual saved v1 checksum contract. Fresh
    // captures never hash; after adoption the v2 row uses native observations.
    if (!row.sha256 || original.bytes.byteLength !== row.byteLength || createHash('sha256').update(original.bytes).digest('hex') !== row.sha256) throw new Error('Saved device capture checksum mismatch');
    mutation.current(); if (fileObservationIdentity(path) !== original.physical) throw new Error('Saved device capture source changed');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const opened = fstatSync(fd, { bigint: true }); if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.mtimeNs !== stat.mtimeNs || opened.ctimeNs !== stat.ctimeNs || fileObservationIdentity(path) !== original.physical) throw new Error('Saved device capture source changed');
      fchmodSync(fd, 0o600); fsyncSync(fd);
      const after = fstatSync(fd, { bigint: true });
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) throw new Error('Saved device capture changed during adoption');
    } finally { closeSync(fd); }
    mutation.current(); const sourceObservation = mutation.owner.importedStamp(path);
    return { row: { ...row, sourceObservation }, ...(needBytes ? { bytes: original.bytes } : {}) };
  }
  private retire(row: SavedArtifact, mutation: Mutation, removed?: () => void): void {
    const path = this.pathFor(row); mutation.current(); mutation.owner.assertImported(path, row.sourceObservation ?? '');
    const sourceIdentity = pendingIdentity(lstatSync(path, { bigint: true }));
    if (mutation.pending.has(row.id)) throw new Error('Device capture retirement conflicts with pending custody');
    mutation.pending.set(row.id, { id: row.id, fileName: row.fileName, sourceIdentity, capturedAt: row.capturedAt });
    mutation.remove(path, () => mutation.owner.assertImported(path, row.sourceObservation ?? ''), () => {
      mutation.pending.delete(row.id); removed?.();
    });
  }
  async read(artifactId: string): Promise<DeviceArtifactReadResult> {
    return this.mutate<DeviceArtifactReadResult>(async (rows, _malformed, mutation) => {
      const original = rows.find(row => row.id === artifactId); if (!original) return { next: rows, result: { ok: false as const, reason: 'not-found' as const } };
      let adopted: ReturnType<DeviceCaptureArtifactStore['adopt']>;
      try { adopted = this.adopt(original, mutation, original.expiresAt > this.now()); }
      catch (error) { mutation.current(); if (!missing(error)) mutation.preserved.add(original.fileName);
        return { next: rows.filter(row => row !== original), result: { ok: false as const, reason: missing(error) ? 'file-missing' as const : 'content-mismatch' as const } }; }
      const row = adopted.row;
      if (row.expiresAt <= this.now()) { this.retire(row, mutation);
        return { next: rows.filter(row => row !== original), result: { ok: false as const, reason: 'expired' as const } }; }
      mutation.retain(() => mutation.owner.assertImported(this.pathFor(row), row.sourceObservation ?? ''));
      if (!adopted.bytes) throw new Error('Device capture read did not acquire bytes');
      return { next: rows.map(candidate => candidate === original ? row : candidate), result: { ok: true as const, artifact: publicArtifact(row), bytes: adopted.bytes } };
    });
  }
  async sweep(): Promise<DeviceArtifactSweepReport> {
    const now = this.now(), policy = this.getPolicy();
    return this.mutate<DeviceArtifactSweepReport>(async (rows, malformed, mutation) => {
      const removals: DeviceArtifactRemoval[] = [], surviving: SavedArtifact[] = []; mutation.current();
      const known = new Set(rows.map(row => row.fileName)), interrupted = [...mutation.pending.values()];
      const report = { sweptAt: now, removed: removals, retained: 0, bytesReclaimed: 0 };
      const remove = (row: SavedArtifact, reason: DeviceArtifactRemovalReason, owned = false) => {
        removals.push({ artifactId: row.id, nodeId: row.nodeId, capabilityId: row.capabilityId, fileName: row.fileName, reason, removedAt: now, byteLength: row.byteLength });
        if (owned) this.retire(row, mutation, () => { report.bytesReclaimed += row.byteLength; });
      };
      if (malformed) removals.push({ artifactId: '(unreadable)', nodeId: '(unknown)', capabilityId: '(unknown)', fileName: '(unknown)', reason: 'malformed', removedAt: now, byteLength: 0 });
      for (const original of rows) {
        let row: SavedArtifact;
        try { row = this.adopt(original, mutation, false).row; }
        catch (error) { mutation.current(); if (!missing(error)) mutation.preserved.add(original.fileName); remove(original, missing(error) ? 'file-missing' : 'content-mismatch'); continue; }
        if (row.expiresAt <= now) remove(row, 'expired', true); else surviving.push(row);
      }
      surviving.sort((a, b) => a.capturedAt - b.capturedAt); const overflow = Math.max(0, surviving.length - policy.maxArtifacts), kept = surviving.slice(overflow);
      for (const row of surviving.slice(0, overflow)) remove(row, 'count-cap', true);
      for (const row of kept) mutation.retain(() => mutation.owner.assertImported(this.pathFor(row), row.sourceObservation ?? ''));
      for (const pending of interrupted) {
        if (mutation.preserved.has(pending.fileName)) { mutation.complete(pending.id); continue; }
        if (known.has(pending.fileName)) throw new Error('Pending device capture conflicts with retained history');
        const path = join(this.directory, pending.fileName); let size: number;
        try {
          const observed = lstatSync(path, { bigint: true });
          if (pendingIdentity(observed) !== pending.sourceIdentity) throw new Error('Pending capture original inode was replaced');
          size = Number(observed.size);
        } catch (error) {
          if (!missing(error)) mutation.preserved.add(pending.fileName);
          mutation.complete(pending.id); continue;
        }
        mutation.remove(path, () => {
          if (pendingIdentity(lstatSync(path, { bigint: true })) !== pending.sourceIdentity) throw new Error('Pending capture original inode changed');
        }, () => { mutation.pending.delete(pending.id); report.bytesReclaimed += size; });
        removals.push({ artifactId: pending.id, nodeId: '(interrupted)', capabilityId: '(interrupted)', fileName: pending.fileName,
          reason: 'orphan-file', removedAt: now, byteLength: size });
      }
      // UUID-shaped filenames do not prove original ownership. In particular,
      // an empty file created before pending-proof publication, a foreign
      // replacement and another application's files are not ours to unlink.
      report.retained = kept.length; return { next: kept, result: report };
    });
  }
}
