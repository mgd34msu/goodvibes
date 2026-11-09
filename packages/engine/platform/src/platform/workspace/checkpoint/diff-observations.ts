import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CHECKPOINT_DIFF_SOURCE_MAX_BYTES } from './diff-observation-contract.js';
import type { CheckpointDiff, CheckpointSessionChanges } from './types.js';

const MAX_VIEWS = 32;
const MAX_CHARACTERS = 8_388_608;
type View = CheckpointDiff & Partial<Pick<CheckpointSessionChanges, 'sessionId' | 'checkpointCount' | 'checkpointIds'>>;
type Snapshot = Omit<View, 'files' | 'checkpointIds'> & { readonly files: readonly string[]; readonly checkpointIds?: readonly string[] };
interface Observation { readonly view: Snapshot; readonly revision: string; readonly characters: number; }

/** One checkpoint manager's latest exact reads, never authority or durable source.
 * The manager admits and publishes these reads under its existing Git lock.
 * A refreshed equal view keeps its label. Changes, failed reads, retirement and
 * a different manager cannot reuse it. Bounded private retention makes an old
 * evicted view require refresh; already captured intake owns its durable hunk.
 */
export class CheckpointDiffObservations {
  readonly #owner = randomUUID().replace(/[0-9a-f]/g, nibble => String.fromCharCode(97 + Number.parseInt(nibble, 16)));
  readonly #views = new Map<string, Observation>();
  #revision = 0;
  #characters = 0;

  async read<T extends View>(scope: readonly string[], read: () => Promise<T>): Promise<T> {
    const key = JSON.stringify(scope);
    try {
      const result = await read();
      const view: View = {
        from: result.from, to: result.to, files: result.files, unifiedDiff: result.unifiedDiff, stat: result.stat,
        ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
        ...(result.checkpointCount === undefined ? {} : { checkpointCount: result.checkpointCount }),
        ...(result.checkpointIds === undefined ? {} : { checkpointIds: result.checkpointIds }),
      };
      const previous = this.#views.get(key);
      if (previous && isDeepStrictEqual(previous.view, view)) {
        this.#views.delete(key); this.#views.set(key, previous);
        return { ...result, nativeRevision: previous.revision };
      }
      this.forget(key);
      const characters = key.length + view.from.length + view.to.length + view.unifiedDiff.length + view.stat.length
        + view.files.reduce((sum, file) => sum + file.length, 0) + (view.sessionId?.length ?? 0)
        + (view.checkpointIds?.reduce((sum, id) => sum + id.length, 0) ?? 0);
      // Large diffs remain displayable. They cannot supply bounded selected-hunk context.
      if (characters > MAX_CHARACTERS || Buffer.byteLength(view.unifiedDiff) > CHECKPOINT_DIFF_SOURCE_MAX_BYTES) return result;
      if (!Number.isSafeInteger(++this.#revision)) throw new Error('Checkpoint diff revision exhausted');
      const revision = `checkpoint-diff:${this.#owner}:${this.#revision.toString(36)}`;
      const retained = Object.freeze({ ...view, files: Object.freeze([...view.files]),
        ...(view.checkpointIds === undefined ? {} : { checkpointIds: Object.freeze([...view.checkpointIds]) }) });
      this.#views.set(key, { view: retained, revision, characters }); this.#characters += characters;
      while (this.#views.size > MAX_VIEWS || this.#characters > MAX_CHARACTERS) {
        const oldest = this.#views.keys().next().value;
        if (oldest === undefined) break;
        this.forget(oldest);
      }
      return { ...result, nativeRevision: revision };
    } catch (error) { this.forget(key); throw error; }
  }

  private forget(key: string): void {
    const previous = this.#views.get(key);
    if (previous) { this.#characters -= previous.characters; this.#views.delete(key); }
  }

  clear(): void { this.#views.clear(); this.#characters = 0; }
}
