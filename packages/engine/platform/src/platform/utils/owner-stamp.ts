/**
 * A derived copy carries its owner's stamp.
 *
 * Every list, index, cache, mirror, projection or preview built from a fact
 * records which owner it came from and that owner's revision when it was
 * built (a content hash, a sequence number, an incarnation). A reader takes
 * the copy only while its stamp equals the owner's current one; otherwise it
 * rebuilds the copy or reads the owner. A copy that cannot say where it came
 * from cannot be used, so a copy that disagrees with its owner is never shown.
 *
 * For in-process counters that only move up, `revision.ts` is the cheaper
 * tool; this is for copies that are stored or sent (a file, a row, a message)
 * and must carry their stamp with them.
 */

/** Which owner a copy was built from, and the owner's revision at that moment. */
export interface OwnerStamp {
  readonly owner: string;
  readonly revision: string;
}

/** A copy and the stamp of what it was built from. */
export interface Derived<T> {
  readonly value: T;
  readonly from: OwnerStamp;
}

/** Stamp a value built from `from`. */
export function stamp<T>(value: T, from: OwnerStamp): Derived<T> {
  return Object.freeze({ value, from: Object.freeze({ owner: from.owner, revision: from.revision }) });
}

/** True when the two stamps name the same owner at the same revision. */
export function sameStamp(a: OwnerStamp, b: OwnerStamp): boolean {
  return a.owner === b.owner && a.revision === b.revision;
}

/** The copy when its stamp equals the owner's, else undefined: the caller rebuilds or reads the owner. */
export function current<T>(copy: Derived<T> | undefined, owner: OwnerStamp): T | undefined {
  return copy !== undefined && sameStamp(copy.from, owner) ? copy.value : undefined;
}
