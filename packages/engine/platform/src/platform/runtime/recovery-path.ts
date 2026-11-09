/** Recovery filenames are labels. The existing JSONL header binds a saved label
 * to its session; arbitrary session identifiers never become reversible paths. */
import { drainOwned } from '@goodvibes-jev/judgment';
import type { NativeDataWriteOwner } from './native-reader-compatibility.js';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BigIntStats } from 'node:fs';
import { fileObservationIdentity } from '../utils/file-observation.js';
import { tryAcquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';

export const RECOVERY_HEADER_LIMIT = 1024 * 1024;
const OWNER_PATH_LIMIT = 128;
const LEGACY_DIRECTORY_LIMIT = 32;

function regularIdentity(stat: BigIntStats): string {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('Recovery source is not a regular original file');
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
}

/** Read only the complete first line, not an arbitrary 4 KiB prefix or the
 * conversation body. Replacement while reading refuses this observation. */
export function readRecoveryHeaderObservation(path: string): { readonly header: Record<string, unknown>; readonly physical: string; readonly mtimeMs: number } {
  const stat = lstatSync(path, { bigint: true });
  const original = regularIdentity(stat);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (regularIdentity(fstatSync(fd, { bigint: true })) !== original) throw new Error('Recovery source changed');
    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= RECOVERY_HEADER_LIMIT) {
      const chunk = Buffer.allocUnsafe(Math.min(4096, RECOVERY_HEADER_LIMIT + 1 - length));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      const newline = chunk.subarray(0, count).indexOf(10);
      const used = newline < 0 ? count : newline;
      chunks.push(chunk.subarray(0, used)); length += used;
      if (newline >= 0) break;
    }
    if (length > RECOVERY_HEADER_LIMIT) throw new Error('Recovery header exceeds its supported limit');
    if (regularIdentity(fstatSync(fd, { bigint: true })) !== original
      || regularIdentity(lstatSync(path, { bigint: true })) !== original) throw new Error('Recovery source changed');
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))); }
    catch { throw new Error('Invalid recovery header'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid recovery header');
    return { header: parsed as Record<string, unknown>, physical: original, mtimeMs: Number(stat.mtimeNs) / 1e6 };
  } finally { closeSync(fd); }
}

export function readRecoveryHeader(path: string): Record<string, unknown> {
  return readRecoveryHeaderObservation(path).header;
}

export function safeRecoverySessionSegment(id: string): string | undefined {
  if (typeof id !== 'string' || !id || id === '.' || id === '..') throw new Error('Session persistence requires a non-empty recovery session id.');
  // Leave room for the filename prefix/suffix within the usual 255-byte leaf.
  return id.length <= 220 && /^[A-Za-z0-9._-]+$/.test(id) ? id : undefined;
}

function belongsTo(path: string, id: string): boolean {
  try { const header = readRecoveryHeader(path); return header['type'] === 'meta' && header['sessionId'] === id; }
  catch { return false; }
}

/** Existing files, including previously SHA-suffixed names, are selected by
 * their actual original header. Never recompute an old filename commitment. */
function existingRecoveryPath(directory: string, id: string): string | undefined {
  let names: string[];
  try { names = readdirSync(directory); } catch { return undefined; }
  const matches: Array<{ path: string; at: bigint }> = [];
  for (const name of names) {
    if (!name.startsWith('recovery-') || !name.endsWith('.jsonl')) continue;
    const path = join(directory, name);
    if (!belongsTo(path, id)) continue;
    try { matches.push({ path, at: lstatSync(path, { bigint: true }).mtimeNs }); } catch { /* Retired snapshot. */ }
  }
  matches.sort((a, b) => a.at === b.at ? a.path.localeCompare(b.path) : a.at > b.at ? -1 : 1);
  return matches[0]?.path;
}

/** One actual surface owns its small path-label cache, never conversation text.
 * Unpublished suggestions are not durable identities: publication re-resolves
 * under the common directory lock. Saved headers remain authoritative after GC,
 * eviction, restart, or an old process writing its original filename. */
const publicationOwners = new WeakMap<(id: string) => string, { readonly writer: NativeDataWriteOwner; readonly declare: NativeDataWriteOwner['declare'] }>();
const publicationAdopters = new WeakMap<(id: string) => string, (id: string, path: string) => void>();

function directoryVersion(path: string): string | undefined {
  try { const stat = statSync(path, { bigint: true }); return [stat.dev, stat.ino, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(':'); }
  catch { return undefined; }
}

export function createRecoveryPathResolver(directory: string, nativeDataWriter?: NativeDataWriteOwner): (id: string) => string {
  const paths = new Map<string, string>();
  const versions = new Map<string, string | undefined>();
  const remember = (id: string, path: string) => {
    // Oversized caller metadata remains supported in the saved header, but is
    // not retained by a process-wide compatibility convenience cache.
    if (id.length <= 4096) { paths.set(id, path); versions.set(id, directoryVersion(directory)); }
    while (paths.size > OWNER_PATH_LIMIT) { const oldest = paths.keys().next().value!; paths.delete(oldest); versions.delete(oldest); }
    return path;
  };
  const resolve = (id: string): string => {
    const safe = safeRecoverySessionSegment(id);
    const canonical = safe === undefined ? undefined : join(directory, `recovery-${safe}.jsonl`);
    if (canonical !== undefined && belongsTo(canonical, id)) return canonical;
    const cached = paths.get(id);
    if (cached !== undefined && versions.get(id) === directoryVersion(directory) && belongsTo(cached, id)) return cached;
    const existing = existingRecoveryPath(directory, id);
    if (existing !== undefined) return remember(id, existing);
    // Even a safe caller ID must not overwrite an unrelated opaque filename.
    if (canonical !== undefined) {
      try { lstatSync(canonical); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return canonical; throw error; }
    }
    if (cached !== undefined) {
      try { lstatSync(cached); paths.delete(id); versions.delete(id); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return cached; throw error; }
    }
    const selected = join(directory, `recovery-opaque-${opaqueUuid()}.jsonl`);
    return remember(id, selected);
  };
  if (nativeDataWriter) publicationOwners.set(resolve, { writer: nativeDataWriter, declare: nativeDataWriter.declare });
  publicationAdopters.set(resolve, remember);
  return resolve;
}

// Deprecated stateless callers have no declared surface owner. Keep only a
// bounded convenience cache; on-disk identity never depends on this cache.
const legacyResolvers = new Map<string, (id: string) => string>();
export function recoveryPathResolver(directory: string): (id: string) => string {
  let resolve = legacyResolvers.get(directory);
  if (!resolve) {
    resolve = createRecoveryPathResolver(directory); legacyResolvers.set(directory, resolve);
    while (legacyResolvers.size > LEGACY_DIRECTORY_LIMIT) legacyResolvers.delete(legacyResolvers.keys().next().value!);
  }
  return resolve;
}

export function recoveryFilePath(directory: string, id: string): string {
  return recoveryPathResolver(directory)(id);
}

function directoryIdentity(path: string): string {
  const stat = statSync(path, { bigint: true });
  if (!stat.isDirectory()) throw new Error('Recovery parent is not a directory');
  return [realpathSync(path), stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.birthtimeNs].join(':');
}

/** Explicit permissions apply only to directories this operation created. */
function prepareRecoveryDirectory(directory: string): () => void {
  const missing: string[] = [];
  let current = directory;
  for (;;) {
    try { directoryIdentity(current); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) throw new Error('Recovery root is unavailable');
      current = parent;
    }
  }
  const retained = new Map([[current, directoryIdentity(current)]]);
  const assertCurrent = () => {
    for (const [path, identity] of retained) if (directoryIdentity(path) !== identity) throw new Error('Recovery parent changed');
  };
  for (const path of missing.reverse()) {
    assertCurrent(); mkdirSync(path, { mode: 0o700 });
    const created = lstatSync(path, { bigint: true });
    if (!created.isDirectory() || created.isSymbolicLink()) throw new Error('Recovery parent changed');
    retained.set(path, directoryIdentity(path)); assertCurrent();
    chmodSync(path, Number(created.mode & 0o7777n) | 0o700);
    const after = lstatSync(path, { bigint: true });
    if (after.dev !== created.dev || after.ino !== created.ino) throw new Error('Recovery created parent changed');
    retained.set(path, directoryIdentity(path)); assertCurrent();
  }
  return assertCurrent;
}

/** Only first opaque-name publication needs allocation serialization. Existing
 * snapshots and ordinary machine-ID writes keep the normal atomic writer path. */
export function publishRecoveryPath(directory: string, id: string, resolve: (id: string) => string,
  publish: (path: string, assertCurrent: () => void) => void): void {
  let path = resolve(id);
  const safe = safeRecoverySessionSegment(id);
  const canonical = safe === undefined ? undefined : join(directory, `recovery-${safe}.jsonl`);
  let assertDirectory = () => {}, release: (() => void) | undefined;
  try {
    if (path !== canonical && !belongsTo(path, id)) {
      assertDirectory = prepareRecoveryDirectory(directory);
      release = tryAcquireCrossProcessLock(join(directory, '.recovery-writer.lock'), { assertCurrent: assertDirectory }) ?? undefined;
      if (!release) throw new Error('Recovery filename allocation is busy');
      assertDirectory(); path = resolve(id);
    }
    let source: string | null;
    try {
      const selected = readRecoveryHeaderObservation(path);
      if (selected.header['type'] !== 'meta' || selected.header['sessionId'] !== id) throw new Error('Recovery destination belongs to another session');
      source = selected.physical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      source = null;
    }
    const assertCurrent = () => {
      assertDirectory();
      let current: string | null;
      try { current = fileObservationIdentity(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; current = null; }
      if (current !== source) throw new Error('Recovery destination changed');
    };
    assertCurrent();
    if (path !== canonical && (source === null || /^recovery-opaque-[a-p]{8}-[a-p]{4}-[a-p]{4}-[a-p]{4}-[a-p]{12}\.jsonl$/.test(basename(path)))) {
      const owner = publicationOwners.get(resolve);
      if (owner) {
        if (owner.writer.declare !== owner.declare) throw new Error('Recovery installation owner changed');
        let result: unknown;
        try { result = owner.declare.call(owner.writer, 'session-recovery-opaque-paths-v1'); }
        catch { throw new Error('Recovery installation owner is unavailable'); }
        if (result !== undefined) { drainOwned(result); throw new Error('Recovery installation owner did not finish synchronously'); }
        if (owner.writer.declare !== owner.declare) throw new Error('Recovery installation owner changed');
        assertCurrent();
      }
    }
    publish(path, assertCurrent);
    publicationAdopters.get(resolve)?.(id, path);
  } finally { release?.(); }
}
