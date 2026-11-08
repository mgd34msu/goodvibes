import { randomUUID, timingSafeEqual } from 'node:crypto';

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
}

export interface TelegramSourceAccountOwner {
  readonly reader: TelegramSourceAccountReader;
  attach(session: TelegramSourceAccountSession): TelegramSourceAccountLease;
  /** Called only after the original Bot API acknowledges this registration. */
  attachWebhook?(session: TelegramSourceAccountSession & { readonly secret: string }): TelegramWebhookAccountLease;
  /** A configured shared secret or serialized account ID cannot mint this lease. */
  authorizeWebhook?(secret: string): TelegramWebhookAccountLease | null;
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
export function createTelegramSourceAccountOwner(): TelegramSourceAccountOwner {
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
    invalidate,
  });
}
