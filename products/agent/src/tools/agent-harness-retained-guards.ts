/**
 * The guards a protected reading keeps until its publication: one per key.
 *
 * A reading that names the same source again (the same key) replaces its
 * earlier guard, so a long reading never accumulates one closure per read.
 * The replaced guard must still hold at that moment, so replacing never drops
 * a check that would have failed. A guard without a key is kept as given.
 */
export class RetainedGuards {
  readonly #keyed = new Map<string, () => void>();
  readonly #anonymous = new Set<() => void>();

  add(guard: () => void, key?: string): void {
    if (key === undefined) { this.#anonymous.add(guard); return; }
    const previous = this.#keyed.get(key);
    if (previous !== undefined && previous !== guard) previous();
    this.#keyed.set(key, guard);
  }

  get size(): number { return this.#keyed.size + this.#anonymous.size; }

  *values(): IterableIterator<() => void> {
    yield* [...this.#keyed.values()];
    yield* [...this.#anonymous];
  }

  [Symbol.iterator](): IterableIterator<() => void> { return this.values(); }
}
