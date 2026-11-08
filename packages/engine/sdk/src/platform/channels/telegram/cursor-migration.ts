import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { OwnedWork } from '../../utils/owned-work.js';
import { TelegramOffsetStore, TelegramOffsetStoreError, type TelegramLegacyCursorHandle } from './offset-store.js';
import type { TelegramCursorPreview } from './cursor-migration-data.js';

interface MigrationIdentity { readonly id: string; readonly username: string; readonly assertCurrent: () => void; }
interface Preparation {
  readonly view: Extract<TelegramCursorPreview, { readonly state: 'unbound' }>;
  readonly store: TelegramOffsetStore;
  readonly handle: TelegramLegacyCursorHandle;
  readonly current: () => void;
}
/** One serving ingress owns the verified bot, exact cursor file preparation
 * and preview lifetime. No bearer, raw cursor bytes or file path enter views. */
export class TelegramCursorMigration {
  private readonly work = new OwnedWork();
  private readonly abort = new AbortController();
  private preparation: Preparation | undefined;
  private closing: Promise<void> | undefined;
  private sequence = 0;
  constructor(private readonly deps: {
    readonly filePath: string;
    readonly identity: (owner: { readonly signal: AbortSignal; readonly assertCurrent: () => void }) => Promise<MigrationIdentity>;
    readonly beforeWrite?: (() => void) | undefined;
    readonly now?: (() => number) | undefined;
  }) { this.deps = Object.freeze({ ...deps, identity: deps.identity.bind(deps), beforeWrite: deps.beforeWrite?.bind(deps), now: deps.now?.bind(deps) }); }
  private current(): void { this.abort.signal.throwIfAborted(); if (this.closing) throw new TelegramOffsetStoreError('unavailable'); }
  preview(): Promise<TelegramCursorPreview> {
    this.current();
    const sequence = ++this.sequence;
    this.preparation = undefined;
    return this.work.run(async () => {
      const current = () => { this.current(); if (sequence !== this.sequence) throw new TelegramOffsetStoreError('unavailable'); };
      try {
        current(); const identity = await this.deps.identity({ signal: this.abort.signal, assertCurrent: current });
        const assertIdentity = identity.assertCurrent.bind(identity);
        current(); assertIdentity();
        const store = new TelegramOffsetStore(this.deps.filePath, identity.id, this.deps.beforeWrite);
        const prepared = store.prepareLegacyMigration(); current(); assertIdentity();
        if (!prepared) return Object.freeze({ state: 'not-needed', message: 'No unbound cursor needs migration for the selected bot.' });
        const now = (this.deps.now ?? Date.now)();
        if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + 300_000)) throw new Error();
        const view = Object.freeze({ state: 'unbound' as const, previewId: `telegram-cursor:${opaqueUuid()}`,
          accountId: identity.id, username: identity.username, offset: prepared.offset, updatedAt: prepared.updatedAt, expiresAtMs: now + 300_000 });
        this.preparation = { view, store, handle: prepared.handle, current: () => { current(); assertIdentity();
          const at = (this.deps.now ?? Date.now)(); if (!Number.isSafeInteger(at) || at < now || at >= view.expiresAtMs) throw new TelegramOffsetStoreError('unavailable'); } };
        return view;
      } catch { throw new TelegramOffsetStoreError('unavailable'); }
    });
  }
  commit(input: { readonly previewId: string; readonly confirm: true }): Promise<{ readonly accountId: string; readonly offset: number }> {
    this.current();
    const prepared = this.preparation;
    if (!prepared || input.confirm !== true || input.previewId !== prepared.view.previewId) return Promise.reject(new TelegramOffsetStoreError('invalid-request'));
    // Consume before entering any publication callback, including reentry.
    this.preparation = undefined;
    return this.work.run(() => {
      prepared.current();
      const offset = prepared.store.migrateLegacy(prepared.handle, prepared.current);
      prepared.current(); return Object.freeze({ accountId: prepared.view.accountId, offset });
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    this.preparation = undefined; this.abort.abort(new TelegramOffsetStoreError('unavailable'));
    void this.work.join().then(resolve, reject); return this.closing;
  }
}
