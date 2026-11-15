/**
 * A record map that also answers "the record whose key is K" in one lookup.
 *
 * The knowledge store's in-memory maps are mutated from several write paths
 * (upserts, imports, deletes, history restores, reloads). The secondary index
 * is kept by the map itself, on every set, delete and clear, so no write path
 * can forget it and a lookup by canonical URI, by source, by kind and slug or
 * by edge endpoints is a map read instead of a walk over every record.
 *
 * Keys are unique where the database makes them unique (a source per URI, an
 * extraction per source, a node per kind and slug, an edge per endpoint
 * tuple); when two records share a key anyway, the first one indexed answers.
 */
export class IndexedRecordMap<V> extends Map<string, V> {
  readonly #keyOf: (value: V) => string | undefined;
  readonly #index = new Map<string, Set<string>>();

  constructor(keyOf: (value: V) => string | undefined, entries?: Iterable<readonly [string, V]>) {
    // super() takes no entries: Map's constructor would call set() before
    // the private fields above exist.
    super();
    this.#keyOf = keyOf;
    if (entries) for (const [id, value] of entries) this.set(id, value);
  }

  override set(id: string, value: V): this {
    const previous = super.get(id);
    if (previous !== undefined) this.#unindex(id, previous);
    super.set(id, value);
    const key = this.#keyOf(value);
    if (key !== undefined) {
      const ids = this.#index.get(key);
      if (ids) ids.add(id);
      else this.#index.set(key, new Set([id]));
    }
    return this;
  }

  override delete(id: string): boolean {
    const previous = super.get(id);
    if (previous !== undefined) this.#unindex(id, previous);
    return super.delete(id);
  }

  override clear(): void {
    super.clear();
    this.#index.clear();
  }

  /** The record indexed under `key`, or undefined. */
  lookup(key: string): V | undefined {
    const ids = this.#index.get(key);
    if (!ids) return undefined;
    for (const id of ids) return super.get(id);
    return undefined;
  }

  /** A staging copy that keeps the same index, for a change built before it is committed. */
  copy(): IndexedRecordMap<V> {
    return new IndexedRecordMap(this.#keyOf, this);
  }

  #unindex(id: string, value: V): void {
    const key = this.#keyOf(value);
    if (key === undefined) return;
    const ids = this.#index.get(key);
    if (!ids) return;
    ids.delete(id);
    if (ids.size === 0) this.#index.delete(key);
  }
}

/** Copy a record map for staging, keeping its index when it has one. */
export function copyRecordMap<V>(map: ReadonlyMap<string, V>): Map<string, V> {
  return map instanceof IndexedRecordMap ? (map as IndexedRecordMap<V>).copy() : new Map(map);
}

/** Look up by secondary key on an indexed map; a plain map is walked with `matches`. */
export function lookupRecord<V>(
  map: ReadonlyMap<string, V>,
  key: string,
  matches: (value: V) => boolean,
): V | undefined {
  if (map instanceof IndexedRecordMap) return (map as IndexedRecordMap<V>).lookup(key);
  for (const value of map.values()) if (matches(value)) return value;
  return undefined;
}

export function sourceUriKey(canonicalUri: string): string {
  return canonicalUri;
}

export function extractionSourceKey(sourceId: string): string {
  return sourceId;
}

export function nodeSlugKey(kind: string, slug: string): string {
  return `${kind}\u0000${slug}`;
}

export function edgeEndpointKey(edge: {
  readonly fromKind: string; readonly fromId: string; readonly toKind: string; readonly toId: string; readonly relation: string;
}): string {
  return `${edge.fromKind}\u0000${edge.fromId}\u0000${edge.toKind}\u0000${edge.toId}\u0000${edge.relation}`;
}
