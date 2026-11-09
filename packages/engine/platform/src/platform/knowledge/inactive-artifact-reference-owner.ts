/** An inactive configured family participates without creating a KnowledgeStore,
 * database, cache or background job. It uses the SAME strict writer lock as a
 * live SQLite owner, and only the closed native reference selector.
 */
import { lstatSync, readlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { captureExistingDirectory } from '../utils/atomic-json-store.js';
import { fileObservationIdentity, readFileObservation } from '../utils/file-observation.js';
import { inspectNativeArtifactReferenceImage } from '../state/sqlite-store.js';
import { acquireArtifactReferenceLock } from '../state/artifact-reference-lock.js';
import type { KnowledgeArtifactReferenceOwner } from './artifact-reference-owner.js';

/** A configured file alias is pinned once; normal subsequent SQLite atomic
 * saves may replace the canonical regular file, but may not introduce aliases
 * or replace original parents. Missing established files do not become empty.
 */
function selectFile(path: string, seen = new Set<string>()): { readonly path: string; assertCurrent(): void } {
  const absolute = resolve(path); if (seen.has(absolute) || seen.size >= 40) throw new Error('Knowledge artifact reference path is unavailable.'); seen.add(absolute);
  const parent = captureExistingDirectory(dirname(absolute));
  const leaf = lstatSync(absolute, { bigint: true, throwIfNoEntry: false });
  if (leaf?.isSymbolicLink()) {
    const target = readlinkSync(absolute), physical = [leaf.dev, leaf.ino, leaf.mode, leaf.uid, leaf.gid, leaf.size, leaf.mtimeNs, leaf.ctimeNs, leaf.birthtimeNs].join(':');
    const selected = selectFile(isAbsolute(target) ? target : join(dirname(absolute), target), seen);
    const assertCurrent = () => {
      parent.assertCurrent(); const actual = lstatSync(absolute, { bigint: true });
      if (!actual.isSymbolicLink() || readlinkSync(absolute) !== target || [actual.dev, actual.ino, actual.mode, actual.uid, actual.gid, actual.size, actual.mtimeNs, actual.ctimeNs, actual.birthtimeNs].join(':') !== physical) throw new Error('Knowledge artifact reference alias changed.');
      selected.assertCurrent();
    };
    assertCurrent(); return Object.freeze({ path: selected.path, assertCurrent });
  }
  let established = leaf !== undefined;
  const selected = join(parent.canonical, basename(absolute));
  const assertCurrent = () => {
    parent.assertCurrent(); const current = lstatSync(selected, { bigint: true, throwIfNoEntry: false });
    if (!current) { if (established) throw new Error('Established knowledge artifact reference file disappeared.'); return; }
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || (process.geteuid && current.uid !== BigInt(process.geteuid()))) throw new Error('Knowledge artifact reference file is unavailable.');
    established = true;
  };
  assertCurrent(); return Object.freeze({ path: selected, assertCurrent });
}
export function createInactiveArtifactReferenceOwner(path: string): KnowledgeArtifactReferenceOwner & { assertSelected(): void } {
  const selected = selectFile(path);
  return Object.freeze({ path: selected.path, assertSelected: selected.assertCurrent, async withReads<T>(ids: readonly string[], operation: (referenced: readonly string[], assertCurrent: () => void) => Promise<T>) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 64 || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new TypeError('Invalid artifact reference batch.');
    const requested = Object.freeze([...ids]);
    const lock = await acquireArtifactReferenceLock(selected.path, selected.assertCurrent);
    if (!lock) return { kind: 'local-changes' as const };
    try {
      const assertOwner = lock.assertCurrent;
      assertOwner(); const exists = lstatSync(selected.path, { throwIfNoEntry: false }) !== undefined;
      const source = exists ? readFileObservation(selected.path) : undefined;
      const assertCurrent = () => {
        assertOwner(); const current = lstatSync(selected.path, { throwIfNoEntry: false });
        if (source ? !current || fileObservationIdentity(selected.path) !== source.physical : current !== undefined) throw new Error('Knowledge artifact reference source changed.');
      };
      assertCurrent(); const referenced = source ? await inspectNativeArtifactReferenceImage(source.bytes, requested, assertCurrent) : Object.freeze([]);
      assertCurrent(); const value = await operation(referenced, assertCurrent); assertCurrent();
      return { kind: 'completed' as const, value };
    } finally { lock.release(); }
  } });
}
