import { randomUUID, timingSafeEqual } from 'node:crypto';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import type { TelegramReceiveProgressOwner, TelegramReceiveScope } from './receive-progress.js';
import type { TelegramPaymentReceiveSelector } from './payment-receive-span.js';

export interface TelegramReceiveCoverageReservation {
  readonly selector?: TelegramPaymentReceiveSelector;
  waitFor(handle: TelegramSourceAccountHandle, sinceMs: number, throughMs: number, signal: AbortSignal, scope: TelegramReceiveScope): Promise<() => void>;
}

/** Public provider identity only. No token, token hash, or source text belongs here. */
export interface TelegramSourceAccountSnapshot {
  readonly id: string;
  readonly username: string;
  readonly revision: string;
}

declare const telegramSourceAccountHandle: unique symbol;
/** Authority is the owner's private WeakMap entry, never serialized fields. */
export interface TelegramSourceAccountHandle {
  readonly [telegramSourceAccountHandle]: true;
}

export interface TelegramSourceAccountReader {
  subscribeIdentityChange(listener: (account: TelegramSourceAccountSnapshot) => void): () => void;
  acquire(): Promise<TelegramSourceAccountHandle | null>;
  /** Startup-only wait for the first live ingress session. Acquires that exact
   * session, never a later replacement. Cancellation removes the attachment
   * listener; provider work already started must still be drained by its owner. */
  acquireWhenAvailable?(signal: AbortSignal): Promise<TelegramSourceAccountHandle | null>;
  read(handle: TelegramSourceAccountHandle): Promise<TelegramSourceAccountSnapshot | null>;
  /** Fence the await-to-capture gap after read; never substitutes for read. */
  assertCurrent(handle: TelegramSourceAccountHandle): TelegramSourceAccountSnapshot;
  /** Last verified live-session identity for display. Not an admission check. */
  current(): TelegramSourceAccountSnapshot | null;
  /** Synchronous pre-notice reservation of this exact receiving session.
   * A later attachment, including the same bot, cannot fill a prior gap. */
  retainReceiveCoverage?(purchaseId?: string, sinceMs?: number): TelegramReceiveCoverageReservation | null;
  restoreReceiveCoverage?(selector: TelegramPaymentReceiveSelector): TelegramReceiveCoverageReservation | null;
}

export interface TelegramSourceAccountLease {
  /** Bound to one transport; a retired session cannot borrow its replacement. */
  acquire(): Promise<TelegramSourceAccountHandle | null>;
}

export interface TelegramWebhookAccountLease extends TelegramSourceAccountLease {
  /** Fence body reads against retirement of the original registration. */
  assertCurrent(): void;
}

export interface TelegramSourceAccountSession {
  readonly readIdentity: (signal: AbortSignal) => Promise<Pick<TelegramSourceAccountSnapshot, 'id' | 'username'> | null>;
  /** The credential owner compares current credentials without disclosing them. */
  readonly isCurrent: () => Promise<boolean>;
  /** Required local-owner fence for the gap after an awaited credential read. */
  readonly isCurrentSync: () => boolean;
  readonly lifetime: AbortSignal;
  readonly receiveProgress?: TelegramReceiveProgressOwner;
}

export interface TelegramSourceAccountOwner {
  readonly reader: TelegramSourceAccountReader;
  attach(session: TelegramSourceAccountSession): TelegramSourceAccountLease;
  /** Called only after the original Bot API acknowledges this registration. */
  attachWebhook?(session: TelegramSourceAccountSession & { readonly secret: string }): TelegramWebhookAccountLease;
  /** A configured shared secret or serialized account ID cannot mint this lease. */
  authorizeWebhook?(secret: string): TelegramWebhookAccountLease | null;
  /** Native poll completion prunes only actual terminal payment operations. */
  prunePaymentReceiveSpans?(): void;
  invalidate(): void;
}

interface Session {
  readonly options: TelegramSourceAccountSession;
  readonly controller: AbortController;
  readonly onAbort: () => void;
  snapshot: TelegramSourceAccountSnapshot | null;
  pending: Promise<TelegramSourceAccountSnapshot | null> | null;
}

function validIdentity(value: Pick<TelegramSourceAccountSnapshot, 'id' | 'username'> | null): value is Pick<TelegramSourceAccountSnapshot, 'id' | 'username'> {
  return value !== null
    && typeof value.id === 'string' && /^[1-9]\d*$/.test(value.id)
    && Number.isSafeInteger(Number(value.id))
    && typeof value.username === 'string' && value.username.trim().length > 0;
}

/**
 * A lazy provenance seam for the actual ingress API session. Installing it does
 * no provider I/O. It owns identity capabilities only, never retained messages.
 */
export function createTelegramSourceAccountOwner(isPaymentSpanTerminal?: (purchaseId: string) => boolean): TelegramSourceAccountOwner {
  let active: Session | null = null;
  let webhook: { readonly secret: string; readonly session: Session; readonly lease: TelegramWebhookAccountLease } | null = null;
  let lastAccount: Pick<TelegramSourceAccountSnapshot, 'id' | 'revision'> | null = null;
  const identityListeners = new Set<(account: TelegramSourceAccountSnapshot) => void>();
  const attachmentListeners = new Set<(session: Session) => void>();
  const handles = new WeakMap<TelegramSourceAccountHandle, {
    readonly session: Session;
    readonly snapshot: TelegramSourceAccountSnapshot;
  }>();

  const live = (session: Session): boolean => {
    if (active !== session || session.controller.signal.aborted || session.options.lifetime.aborted) return false;
    let current = false;
    try { current = session.options.isCurrentSync() === true; } catch { /* unavailable is closed */ }
    if (!current && active === session) invalidate();
    return current && active === session && !session.controller.signal.aborted && !session.options.lifetime.aborted;
  };

  const invalidate = (): void => {
    const previous = active;
    active = null;
    webhook = null;
    if (!previous) return;
    previous.options.lifetime.removeEventListener('abort', previous.onAbort);
    previous.controller.abort();
  };

  const check = async (session: Session): Promise<boolean> => {
    if (!live(session)) return false;
    let current = false;
    try { current = await session.options.isCurrent(); } catch { /* unavailable is closed */ }
    if (!live(session)) return false;
    if (!current) {
      invalidate();
      return false;
    }
    return true;
  };

  const verify = async (session: Session): Promise<TelegramSourceAccountSnapshot | null> => {
    if (!await check(session) || !live(session)) return null;
    let identity: Pick<TelegramSourceAccountSnapshot, 'id' | 'username'> | null;
    try { identity = await session.options.readIdentity(session.controller.signal); } catch { return null; }
    if (!live(session) || !validIdentity(identity)) return null;
    if (!await check(session) || !live(session)) return null;
    const revision = lastAccount?.id === identity.id ? lastAccount.revision : randomUUID();
    const snapshot = Object.freeze({ id: identity.id, username: identity.username, revision });
    const changed = lastAccount !== null && (lastAccount.id !== snapshot.id || lastAccount.revision !== snapshot.revision);
    lastAccount = { id: snapshot.id, revision };
    session.snapshot = snapshot;
    if (changed) for (const listener of identityListeners) listener(snapshot);
    return snapshot;
  };

  const acquire = async (session: Session): Promise<TelegramSourceAccountHandle | null> => {
    if (!await check(session) || !live(session)) return null;
    let snapshot = session.snapshot;
    if (!snapshot) {
      session.pending ??= verify(session).finally(() => { session.pending = null; });
      snapshot = await session.pending;
    }
    if (!snapshot || !await check(session) || !live(session)) return null;
    const handle = Object.freeze({}) as TelegramSourceAccountHandle;
    handles.set(handle, { session, snapshot });
    return handle;
  };

  const attachSession = (options: TelegramSourceAccountSession): Session => {
    invalidate();
    const session: Session = {
      options,
      controller: new AbortController(),
      onAbort: () => { if (active === session) invalidate(); },
      snapshot: null,
      pending: null,
    };
    active = session;
    options.lifetime.addEventListener('abort', session.onAbort, { once: true });
    if (options.lifetime.aborted) invalidate();
    if (live(session)) for (const listener of [...attachmentListeners]) listener(session);
    return session;
  };

  const reserveCoverage = (purchaseId?: string, sinceMs?: number, selector?: TelegramPaymentReceiveSelector): TelegramReceiveCoverageReservation | null => {
    const session = active;
    if (!session || !live(session) || !session.options.receiveProgress) return null;
    // Only the native composition supplies terminal bookkeeping lookup. A
    // reader holding account identity cannot supply its own deletion verdict.
    if (isPaymentSpanTerminal) session.options.receiveProgress.prune?.(isPaymentSpanTerminal);
    const span = selector ? session.options.receiveProgress.restore?.(selector) : session.options.receiveProgress.retain(purchaseId, sinceMs);
    if (!span || typeof span.waitFor !== 'function') { drainOwned(span); return null; }
    const wait = span.waitFor.bind(span), retainedSelector = span.selector;
    if (!live(session)) return null;
    return Object.freeze({ ...(retainedSelector ? { selector: retainedSelector } : {}),
      waitFor: async (handle: TelegramSourceAccountHandle, sinceMs: number, throughMs: number, signal: AbortSignal, scope: TelegramReceiveScope) => {
        const originalScope = Object.freeze({ conversationId: scope.conversationId, threadId: scope.threadId });
        const record = handles.get(handle);
        if (!record || record.session !== session || retainedSelector && retainedSelector.accountId !== record.snapshot.id
          || !await check(session) || !live(session)) throw new Error('Telegram receive source is unavailable');
        const covered = await wait(sinceMs, throughMs, AbortSignal.any([signal, session.controller.signal]), originalScope);
        if (typeof covered !== 'function') { drainOwned(covered); throw new Error('Telegram receive assertion is unavailable'); }
        if (!await check(session) || !live(session)) throw new Error('Telegram receive source is unavailable');
        const assertCovered = () => {
          if (signal.aborted || !live(session)) throw new Error('Telegram receive source is unavailable');
          const result: unknown = covered();
          if (result !== undefined) { drainOwned(result); throw new Error('Telegram receive assertions must be synchronous'); }
        };
        assertCovered(); return assertCovered;
      } });
  };

  return Object.freeze({
    reader: Object.freeze({
      subscribeIdentityChange(listener: (account: TelegramSourceAccountSnapshot) => void): () => void { identityListeners.add(listener); return () => { identityListeners.delete(listener); }; },
      acquire: async () => active ? acquire(active) : null,
      async acquireWhenAvailable(signal: AbortSignal): Promise<TelegramSourceAccountHandle | null> {
        signal.throwIfAborted();
        const selected = active && live(active) ? active : await new Promise<Session>((resolve, reject) => {
          const cleanup = () => { attachmentListeners.delete(attached); signal.removeEventListener('abort', aborted); };
          const attached = (session: Session) => { cleanup(); resolve(session); };
          const aborted = () => { cleanup(); reject(new Error('Telegram source account wait was cancelled')); };
          attachmentListeners.add(attached);
          signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted) aborted();
        });
        signal.throwIfAborted();
        const handle = await acquire(selected);
        signal.throwIfAborted();
        return handle;
      },
      async read(handle: TelegramSourceAccountHandle): Promise<TelegramSourceAccountSnapshot | null> {
        const record = handles.get(handle);
        return record && await check(record.session) && live(record.session) ? record.snapshot : null;
      },
      assertCurrent(handle: TelegramSourceAccountHandle): TelegramSourceAccountSnapshot {
        const record = handles.get(handle);
        if (!record || !live(record.session)) throw new Error('Telegram source account is unavailable');
        return record.snapshot;
      },
      current: () => active && live(active) ? active.snapshot : null,
      retainReceiveCoverage: (purchaseId?: string, sinceMs?: number) => reserveCoverage(purchaseId, sinceMs),
      restoreReceiveCoverage: (selector: TelegramPaymentReceiveSelector) => reserveCoverage(undefined, undefined, selector),
    }),
    attach(options: TelegramSourceAccountSession): TelegramSourceAccountLease {
      const session = attachSession(options);
      return Object.freeze({ acquire: () => acquire(session) });
    },
    attachWebhook(options: TelegramSourceAccountSession & { readonly secret: string }): TelegramWebhookAccountLease {
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(options.secret)) throw new Error('Telegram webhook registration is invalid');
      const session = attachSession(options);
      const lease = Object.freeze({
        acquire: () => acquire(session),
        assertCurrent() {
          if (!live(session)) throw new Error('Telegram webhook registration is unavailable');
        },
      });
      if (live(session)) webhook = { secret: options.secret, session, lease };
      return lease;
    },
    authorizeWebhook(secret: string): TelegramWebhookAccountLease | null {
      const registered = webhook;
      if (!registered || !live(registered.session)) return null;
      // Registration credentials are ASCII and bounded; no digest or raw-token cache.
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret) || secret.length !== registered.secret.length) return null;
      return timingSafeEqual(Buffer.from(secret), Buffer.from(registered.secret)) ? registered.lease : null;
    },
    prunePaymentReceiveSpans() {
      const session = active;
      if (session && live(session) && isPaymentSpanTerminal) session.options.receiveProgress?.prune?.(isPaymentSpanTerminal);
    },
    invalidate,
  });
}
