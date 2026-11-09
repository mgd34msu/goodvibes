/** Durable owner identity for issued continuations. Directory facts are
 * compared exactly; a generated identifier is never a digest or a credential. */
import { randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { confirmFileDurable, writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { readFileObservation, type FileObservation } from '../utils/file-observation.js';

export type NativeContinuationParents = readonly (readonly string[])[];
interface OwnerRecord { readonly version: 1; readonly id: string; readonly parents: NativeContinuationParents }
const missing = (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

/** Same directory facts used by the published v1 reader, without hashing. */
export function nativeContinuationParents(filePath: string): NativeContinuationParents {
  const file = lstatSync(filePath);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error('Native continuation owner file is unavailable');
  const parents: string[][] = [];
  for (let path = dirname(filePath);;) {
    const entry = lstatSync(path, { bigint: true });
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Native continuation owner root is unavailable');
    parents.push([path, String(entry.dev), String(entry.ino), String(entry.birthtimeNs)]);
    const parent = dirname(path); if (parent === path) break; path = parent;
  }
  return Object.freeze(parents.map(parent => Object.freeze(parent)));
}

/** Call ensure under the pairing owner's existing writer lock. Lookups never
 * initialize, repair or rotate the identity. Losing observed evidence refuses. */
export class NativeContinuationOwner {
  private observed: { readonly file: FileObservation; readonly record: OwnerRecord } | undefined;
  private unavailable = false;
  private readonly path: string;
  constructor(private readonly pairingPath: string) { this.path = `${pairingPath}.native-owner`; }

  private read(): { readonly file: FileObservation; readonly record: OwnerRecord } | null {
    if (this.unavailable) throw new Error('Native continuation owner evidence is unavailable');
    let file: FileObservation;
    try { file = readFileObservation(this.path); }
    catch (error) {
      if (!this.observed && missing(error)) {
        try { lstatSync(this.path); } catch (absent) { if (missing(absent)) return null; }
      }
      this.unavailable = true; throw new Error('Native continuation owner evidence is unavailable');
    }
    if (this.observed?.file.physical === file.physical && this.observed.file.bytes.equals(file.bytes)) return this.observed;
    try {
      if ((lstatSync(this.path).mode & 0o077) !== 0 || file.bytes.length > 1024 * 1024) throw new Error();
      const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
      const value = raw as Record<string, unknown>;
      if (Object.keys(value).length !== 3 || value['version'] !== 1 || typeof value['id'] !== 'string' || !/^[0-9a-f]{64}$/.test(value['id'])
        || !Array.isArray(value['parents']) || !value['parents'].length || value['parents'].some(parent => !Array.isArray(parent)
          || parent.length !== 4 || parent.some(part => typeof part !== 'string' || !part.length))) throw new Error();
      const record: OwnerRecord = Object.freeze({ version: 1, id: value['id'],
        parents: Object.freeze(value['parents'].map(parent => Object.freeze([...parent] as string[]))) });
      confirmFileDurable(this.path);
      const confirmed = readFileObservation(this.path);
      if (confirmed.physical !== file.physical || !confirmed.bytes.equals(file.bytes)) throw new Error();
      return this.observed = { file, record };
    } catch { this.unavailable = true; throw new Error('Native continuation owner evidence is unavailable'); }
  }

  current(): string | null {
    const parents = nativeContinuationParents(this.pairingPath), retained = this.read();
    if (!isDeepStrictEqual(nativeContinuationParents(this.pairingPath), parents)) throw new Error('Native continuation owner root changed');
    return retained && isDeepStrictEqual(retained.record.parents, parents) ? retained.record.id : null;
  }

  ensure(): string {
    const parents = nativeContinuationParents(this.pairingPath), before = this.read();
    if (!isDeepStrictEqual(nativeContinuationParents(this.pairingPath), parents)) throw new Error('Native continuation owner root changed');
    if (before && isDeepStrictEqual(before.record.parents, parents)) return before.record.id;
    const record: OwnerRecord = { version: 1, id: randomBytes(32).toString('hex'), parents };
    const current = () => {
      if (!isDeepStrictEqual(nativeContinuationParents(this.pairingPath), parents)) throw new Error('Native continuation owner root changed');
      if (before) {
        const actual = readFileObservation(this.path);
        if (actual.physical !== before.file.physical || !actual.bytes.equals(before.file.bytes)) throw new Error('Native continuation owner record changed');
      } else {
        try { lstatSync(this.path); } catch (error) { if (missing(error)) return; throw error; }
        throw new Error('Native continuation owner record appeared');
      }
    };
    try {
      writeJsonFileAtomic(this.path, record, { mode: 0o600, durable: true, cleanupStaleTemps: false, assertCurrent: current });
      const after = this.read();
      if (!after || after.record.id !== record.id || !isDeepStrictEqual(after.record.parents, nativeContinuationParents(this.pairingPath))) throw new Error();
      return after.record.id;
    } catch (error) { this.unavailable = true; throw error; }
  }
}
