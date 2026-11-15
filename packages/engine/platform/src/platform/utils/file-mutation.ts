import { lstatSync, readFileSync, type BigIntStats } from 'node:fs';
import { resolve } from 'node:path';
import { types as nodeTypes } from 'node:util';

/** A native producer can add a publication restriction, never grant authority. */
export type MutationPublication = <T>(operation: (assertCurrent: () => void) => T | Promise<T>) => Promise<T>;

/** Require the producer to finish the exact publication before releasing it. */
export async function publishFileMutation(publication: MutationPublication | undefined,
  operation: (assertCurrent: () => void) => void | Promise<void>): Promise<void> {
  if (!publication) { await operation(() => {}); return; }
  let active = true, started = false, completed = false;
  try {
    await publication(async assertCurrent => {
      if (!active || started) throw new Error('Mutation publication is not current.');
      started = true;
      const current = () => { if (!active) throw new Error('Mutation publication retired.'); assertCurrent(); };
      current(); await operation(current); current(); completed = true;
    });
    if (!completed) throw new Error('Mutation publication did not finish.');
  } finally { active = false; }
}

/** Retain the actual prepared file, so an awaited rename cannot adopt foreign bytes. */
export function capturePreparedFilePublication(path: string): (publishedPath: string) => void {
  const snapshot = (filePath: string) => {
    const before = lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
    if (!before || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new Error('Prepared publication is unavailable.');
    const identity = (stat: BigIntStats) => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.gid}:${stat.nlink}:${stat.size}:${stat.mtimeNs}`;
    const bytes = readFileSync(filePath);
    const after = lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
    if (!after || identity(before) !== identity(after) || before.ctimeNs !== after.ctimeNs) throw new Error('Prepared publication changed.');
    return { identity: identity(after), bytes };
  };
  const prepared = snapshot(path);
  return publishedPath => {
    const published = snapshot(publishedPath);
    if (published.identity !== prepared.identity || !published.bytes.equals(prepared.bytes)) throw new Error('File publication does not match its prepared source.');
  };
}

/** Compare trusted backend descriptors before reading any replacement accessor. */
export function captureMutationDescriptors(subject: object, keys: readonly string[]): () => void {
  const snapshot = () => {
    const owners: object[] = [];
    for (let owner: object | null = subject; owner; owner = Object.getPrototypeOf(owner)) {
      if (nodeTypes.isProxy(owner) || owners.length >= 64) throw new Error('Mutation owner is unavailable.');
      owners.push(owner);
    }
    return { owners, fields: keys.map(key => owners.map(owner => Object.getOwnPropertyDescriptor(owner, key))) };
  };
  const captured = snapshot();
  if (captured.fields.some(chain => chain.some(field => field && !('value' in field)))) throw new Error('Mutation owner accessor is unavailable.');
  return () => {
    const current = snapshot();
    if (current.owners.length !== captured.owners.length || current.owners.some((owner, index) => owner !== captured.owners[index])
      || captured.fields.some((chain, index) => chain.some((field, depth) => {
        const next = current.fields[index]?.[depth];
        return field?.value !== next?.value || field?.get !== next?.get || field?.set !== next?.set
          || field?.writable !== next?.writable || field?.enumerable !== next?.enumerable || field?.configurable !== next?.configurable;
      }))) throw new Error('Mutation owner changed.');
  };
}

/**
 * Detects a foreign write to one file between capture and publication by
 * comparing that file's own identity (device, inode, size, modification time):
 * one `lstat` per check, no read, no parent directories. Another store saving
 * in the same directory does not disturb it. `onEffect(true)` after this
 * writer's own publication adopts the new identity. It never authorizes an
 * operation.
 */
export function captureFileMutation(path: string): { readonly assertCurrent: () => void; readonly onEffect: (published?: boolean) => void } {
  const target = resolve(path);
  const identity = (): string | null => {
    const stat = lstatSync(target, { bigint: true, throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile()) throw new Error(`File mutation target is not a regular file: ${target}`);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  };
  let expected = identity();
  return {
    assertCurrent() {
      if (identity() !== expected) throw new Error(`The file changed on disk while this write was in progress, so nothing was written: ${target}. Read it again and retry.`);
    },
    onEffect(published = false) {
      if (published) expected = identity();
    },
  };
}
