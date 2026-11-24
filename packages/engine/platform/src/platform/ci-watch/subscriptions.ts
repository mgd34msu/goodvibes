/**
 * ci-watch/subscriptions.ts
 *
 * Durable storage for standing CI watches, over the same PersistentStore
 * snapshot pattern the other registries use.
 */
import { PersistentStore } from '../state/persistent-store.js';
import type { CiWatchSubscription } from './types.js';
import { noteListChanged } from '../runtime/list-changes.js';

interface CiWatchSnapshot extends Record<string, unknown> {
  version: 1;
  subscriptions: CiWatchSubscription[];
}

function validateSnapshot(snapshot: CiWatchSnapshot | null): CiWatchSnapshot {
  if (!snapshot) return { version: 1, subscriptions: [] };
  if (snapshot.version !== 1 || !Array.isArray(snapshot.subscriptions)) {
    throw new Error('CI watch store snapshot is invalid.');
  }
  return { version: 1, subscriptions: snapshot.subscriptions };
}

export class CiWatchStore {
  private readonly store: PersistentStore<CiWatchSnapshot>;

  constructor(path: string) {
    this.store = new PersistentStore<CiWatchSnapshot>(path);
  }

  async load(): Promise<CiWatchSubscription[]> {
    return validateSnapshot(await this.store.load()).subscriptions;
  }

  /** Every watch change (created, its state, deleted) is written here, then announced (runtime/list-changes.ts). */
  async save(subscriptions: readonly CiWatchSubscription[]): Promise<void> {
    await this.store.persist({ version: 1, subscriptions: [...subscriptions] });
    noteListChanged({ list: 'ci-watches', change: 'changed' });
  }
}
