/**
 * The Telegram getUpdates confirmation cursor: one small document holding, for
 * each bot, the next update id to ask for, plus the payment receive spans that
 * wait on that bot's queue.
 *
 * Telegram keeps the queue and forgets an update once getUpdates is called with
 * a higher offset, and it answers 409 to a second consumer of the same bot. So
 * this file decides nothing about who receives: it only spares a restart from
 * processing the last confirmed updates again. The document is read once, held
 * in memory and written whole (one temp file and one rename) on a real change.
 * An unreadable file is moved aside and receiving starts without an offset,
 * which costs at most the last batch being delivered again.
 *
 * A cursor saved by an earlier version (`version: 1`) names no bot. It is bound
 * to the bot this host last discovered (`surfaces.telegram.discoveredBotTokenId`)
 * without asking, see {@link bindEarlierTelegramCursor}; only when no bot was
 * ever discovered does it wait for the owner's review (`cursor-migration.ts`).
 */
import { readDocument, writeDocument } from '../../utils/atomic-json-store.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { readTelegramPaymentReceiveSpan, MAX_TELEGRAM_PAYMENT_RECEIVE_SPANS, type TelegramPaymentReceiveSpan } from './payment-receive-span.js';
import { TelegramReceiveCoverageError } from './receive-progress.js';

const offsetValue = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const accountValue = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export type TelegramOffsetFailure = 'unavailable' | 'unbound' | 'invalid-request' | 'identity-unavailable' | 'write-failed';

const FAILURE_MESSAGES: Record<TelegramOffsetFailure, string> = {
  unbound: 'The saved Telegram cursor was written by an earlier version and does not say which bot it belongs to, so polling waits. '
    + 'Review it with "Telegram\'s reading position" on the Channels tab of Mail, calendar and channels, or Settings → Surfaces → Telegram cursor recovery.',
  unavailable: 'Telegram cursor recovery is not available right now: Telegram ingress is not running. Check channel status, then open it again.',
  'invalid-request': 'The Telegram cursor request is invalid.',
  'identity-unavailable': 'Telegram could not confirm which bot this is right now (network or token). The saved cursor was not touched; try again shortly.',
  'write-failed': 'The Telegram cursor could not be saved.',
};

export class TelegramOffsetStoreError extends Error {
  override readonly name = 'TelegramOffsetStoreError';
  constructor(readonly kind: TelegramOffsetFailure, detail?: string) {
    super(detail ? `${FAILURE_MESSAGES[kind]} ${detail}` : FAILURE_MESSAGES[kind]);
  }
}

export type TelegramOffsetStart = { readonly mode: 'resume'; readonly offset: number } | { readonly mode: 'fresh' }
  | { readonly mode: 'blocked'; readonly reason: string; readonly kind: TelegramOffsetFailure };

/** Queue facts only: which bot, and the next update id to ask for (null before the first confirmation). */
export interface TelegramCursorObservation {
  readonly accountId: string;
  readonly offset: number | null;
}

/**
 * One receiving session's handle on its bot's cursor. `assertCurrent` (and the
 * capture's) throws only once the handle was released; the `assertCurrent`
 * callbacks callers pass are their own "is this still wanted" check, run once
 * before the write.
 */
export interface TelegramPollingCursor {
  capture(): { readonly observation: TelegramCursorObservation; assertCurrent(): void };
  assertCurrent(): void;
  /** Record the next offset. Never moves back; a failed write keeps it in memory and is retried by the next save. */
  save(offset: number, assertCurrent?: () => void): number;
  receiveSpans(): readonly TelegramPaymentReceiveSpan[];
  /** Replace this bot's receive spans; a failed write throws and leaves them as they were. */
  replaceReceiveSpans(spans: readonly TelegramPaymentReceiveSpan[], assertCurrent?: () => void): void;
  release(): void;
}

interface AccountCursor { readonly accountId: string; readonly offset: number; readonly updatedAt: string; readonly receiveSpans?: readonly TelegramPaymentReceiveSpan[] }
type CursorDocument =
  | { readonly kind: 'accounts'; readonly accounts: readonly AccountCursor[]; readonly spanFormat: boolean }
  | { readonly kind: 'earlier'; readonly offset: number; readonly updatedAt: string };

const EMPTY: CursorDocument = { kind: 'accounts', accounts: [], spanFormat: false };

/** Spans that do not parse, belong to another bot or repeat an id are dropped: their purchase then reports coverage unavailable. */
function readSpans(accountId: string, value: unknown, seen: Set<string>): readonly TelegramPaymentReceiveSpan[] {
  if (!Array.isArray(value)) return [];
  const spans: TelegramPaymentReceiveSpan[] = [];
  for (const entry of value) {
    let span: TelegramPaymentReceiveSpan;
    try { span = readTelegramPaymentReceiveSpan(entry); } catch { continue; }
    if (span.accountId !== accountId || seen.has(span.id) || seen.size >= MAX_TELEGRAM_PAYMENT_RECEIVE_SPANS) continue;
    seen.add(span.id); spans.push(span);
  }
  return Object.freeze(spans);
}

function parseCursorDocument(row: unknown): CursorDocument {
  if (!object(row)) throw new Error('the cursor file is not an object');
  if (row['version'] === 1) {
    if (!offsetValue(row['offset']) || typeof row['updatedAt'] !== 'string') throw new Error('the earlier cursor has no valid offset');
    return { kind: 'earlier', offset: row['offset'], updatedAt: row['updatedAt'] };
  }
  if ((row['version'] !== 2 && row['version'] !== 3) || !Array.isArray(row['accounts'])) throw new Error('the cursor file has an unknown format');
  const accounts: AccountCursor[] = [], bots = new Set<string>(), spanIds = new Set<string>();
  // A damaged entry costs only that bot its offset; the others are kept.
  for (const entry of row['accounts']) {
    if (!object(entry) || !accountValue(entry['accountId']) || bots.has(entry['accountId']) || !offsetValue(entry['offset'])) continue;
    bots.add(entry['accountId']);
    const updatedAt = typeof entry['updatedAt'] === 'string' ? entry['updatedAt'] : new Date(0).toISOString();
    const receiveSpans = Object.hasOwn(entry, 'receiveSpans') ? readSpans(entry['accountId'], entry['receiveSpans'], spanIds) : undefined;
    accounts.push(Object.freeze({ accountId: entry['accountId'], offset: entry['offset'], updatedAt, ...(receiveSpans ? { receiveSpans } : {}) }));
  }
  return { kind: 'accounts', accounts: Object.freeze(accounts), spanFormat: row['version'] === 3 };
}

function readCursorDocument(filePath: string): CursorDocument {
  try {
    return readDocument(filePath, {
      label: 'channels/telegram-cursor',
      validate: parseCursorDocument,
      recovery: 'Telegram receiving starts without a saved offset; at most the last batch of updates is delivered again.',
    }) ?? EMPTY;
  } catch (error) {
    logger.warn('Telegram cursor could not be read; receiving starts without a saved offset', { error: summarizeError(error) });
    return EMPTY;
  }
}

declare const legacyMigrationHandle: unique symbol;
export interface TelegramLegacyCursorHandle { readonly [legacyMigrationHandle]: true; }
interface EarlierCursor { readonly offset: number; readonly updatedAt: string }

export class TelegramOffsetStore {
  private document: CursorDocument | undefined;
  private readonly migrations = new WeakMap<TelegramLegacyCursorHandle, EarlierCursor>();
  private declaredCursorFormat = false;
  private declaredSpanFormat = false;
  /** Set while offset writes fail, so the failure is logged once and its end once. */
  private offsetWriteFailing = false;

  /**
   * `beforeWrite` and `beforeReceiveSpanWrite` declare the file format to the
   * host's reader-compatibility owner; each runs once, before the first write
   * of that format, and a refusal fails that write.
   */
  constructor(private readonly filePath: string, private readonly accountId: string, private readonly beforeWrite?: () => void,
    private readonly beforeReceiveSpanWrite?: () => void) {
    if (!accountValue(accountId)) throw new TelegramOffsetStoreError('invalid-request');
  }

  private read(): CursorDocument {
    return this.document ??= readCursorDocument(this.filePath);
  }

  private publish(document: Extract<CursorDocument, { kind: 'accounts' }>): void {
    if (!this.declaredCursorFormat) { this.beforeWrite?.(); this.declaredCursorFormat = true; }
    const spanFormat = document.spanFormat || document.accounts.some(account => account.receiveSpans !== undefined);
    if (spanFormat && !this.declaredSpanFormat) { this.beforeReceiveSpanWrite?.(); this.declaredSpanFormat = true; }
    writeDocument(this.filePath, { version: spanFormat ? 3 : 2, accounts: document.accounts }, { mode: 0o600, indent: null });
  }

  private withAccount(document: Extract<CursorDocument, { kind: 'accounts' }>, update: (previous: AccountCursor | undefined) => AccountCursor):
    Extract<CursorDocument, { kind: 'accounts' }> {
    const previous = document.accounts.find(entry => entry.accountId === this.accountId);
    const next = Object.freeze(update(previous));
    const accounts = previous ? document.accounts.map(entry => entry === previous ? next : entry) : [...document.accounts, next];
    return { kind: 'accounts', accounts: Object.freeze(accounts), spanFormat: document.spanFormat || next.receiveSpans !== undefined };
  }

  load(): TelegramOffsetStart {
    const document = this.read();
    if (document.kind === 'earlier') {
      const failure = new TelegramOffsetStoreError('unbound');
      return { mode: 'blocked', reason: failure.message, kind: failure.kind };
    }
    const cursor = document.accounts.find(entry => entry.accountId === this.accountId);
    return cursor ? { mode: 'resume', offset: cursor.offset } : { mode: 'fresh' };
  }

  /** The receiving session's handle. Refuses only a cursor from an earlier version still waiting for review. */
  retainPolling(): TelegramPollingCursor {
    if (this.read().kind === 'earlier') throw new TelegramOffsetStoreError('unbound');
    let released = false;
    const assertCurrent = (): void => { if (released) throw new TelegramOffsetStoreError('unavailable'); };
    const accounts = (): Extract<CursorDocument, { kind: 'accounts' }> => this.read() as Extract<CursorDocument, { kind: 'accounts' }>;
    const own = (): AccountCursor | undefined => accounts().accounts.find(entry => entry.accountId === this.accountId);
    return Object.freeze({
      assertCurrent,
      capture: () => {
        assertCurrent();
        return Object.freeze({ observation: Object.freeze({ accountId: this.accountId, offset: own()?.offset ?? null }), assertCurrent });
      },
      receiveSpans: () => { assertCurrent(); return own()?.receiveSpans ?? []; },
      replaceReceiveSpans: (input: readonly TelegramPaymentReceiveSpan[], current?: () => void) => {
        assertCurrent();
        const spans = Object.freeze(input.map(readTelegramPaymentReceiveSpan));
        if (spans.some(span => span.accountId !== this.accountId) || new Set(spans.map(span => span.id)).size !== spans.length) {
          throw new TelegramOffsetStoreError('invalid-request');
        }
        // The cap bounds the one file every bot shares, so it counts them all.
        const others = accounts().accounts.reduce((count, entry) => count + (entry.accountId === this.accountId ? 0 : entry.receiveSpans?.length ?? 0), 0);
        if (others + spans.length > MAX_TELEGRAM_PAYMENT_RECEIVE_SPANS) throw new TelegramReceiveCoverageError();
        current?.();
        const next = this.withAccount(accounts(), previous => ({
          accountId: this.accountId, offset: previous?.offset ?? 0, updatedAt: new Date().toISOString(), receiveSpans: spans,
        }));
        // Payment custody must not be claimed from memory alone: the write has to land.
        try { this.publish(next); }
        catch (error) { throw new TelegramOffsetStoreError('write-failed', `${summarizeError(error)}. Receiving resumes on the backoff.`); }
        this.document = next;
      },
      save: (offset: number, current?: () => void) => {
        assertCurrent();
        if (!offsetValue(offset)) throw new TelegramOffsetStoreError('invalid-request');
        const previous = own();
        if (previous && offset <= previous.offset) return previous.offset;
        current?.();
        const next = this.withAccount(accounts(), before => ({ ...before, accountId: this.accountId, offset, updatedAt: new Date().toISOString() }));
        // Telegram confirms by the offset this process sends next, which is the
        // one in memory; the file only matters after a restart, so a failed
        // write is logged and the next save writes the newer offset.
        this.document = next;
        try {
          this.publish(next);
          if (this.offsetWriteFailing) {
            this.offsetWriteFailing = false;
            logger.info('Telegram cursor is being saved again', { surface: 'telegram' });
          }
        } catch (error) {
          if (!this.offsetWriteFailing) {
            this.offsetWriteFailing = true;
            logger.error('Telegram cursor could not be saved; receiving continues, and after a restart the updates since the last save are processed again', {
              surface: 'telegram', error: summarizeError(error),
            });
          }
        }
        return offset;
      },
      release: () => { released = true; },
    });
  }

  /** Read the earlier-version cursor afresh for the owner's review; null when there is none. */
  prepareLegacyMigration(): (EarlierCursor & { readonly handle: TelegramLegacyCursorHandle }) | null {
    this.document = undefined;
    const document = this.read();
    if (document.kind !== 'earlier') return null;
    const cursor = Object.freeze({ offset: document.offset, updatedAt: document.updatedAt });
    const handle = Object.freeze({}) as TelegramLegacyCursorHandle;
    this.migrations.set(handle, cursor);
    return Object.freeze({ ...cursor, handle });
  }

  /**
   * Bind the reviewed earlier-version cursor to this bot, keeping its offset.
   * Refused when the file no longer holds the cursor the owner reviewed.
   */
  migrateLegacy(handle: TelegramLegacyCursorHandle, assertCurrent: () => void): number {
    const prepared = this.migrations.get(handle);
    this.migrations.delete(handle);
    if (!prepared) throw new TelegramOffsetStoreError('invalid-request');
    assertCurrent();
    this.document = undefined;
    const document = this.read();
    if (document.kind !== 'earlier' || document.offset !== prepared.offset || document.updatedAt !== prepared.updatedAt) {
      throw new TelegramOffsetStoreError('invalid-request', 'The saved cursor changed since it was reviewed; review it again.');
    }
    const next = { kind: 'accounts', spanFormat: false,
      accounts: Object.freeze([Object.freeze({ accountId: this.accountId, offset: prepared.offset, updatedAt: prepared.updatedAt })]) } as const;
    try { this.publish(next); }
    catch (error) { throw new TelegramOffsetStoreError('write-failed', summarizeError(error)); }
    this.document = next;
    return prepared.offset;
  }
}

/**
 * Bind a cursor saved by an earlier version to the bot it belongs to.
 *
 * That version kept one offset for whichever bot was polling, and the bot it
 * last polled for is the one recorded in `discoveredBotTokenId`, so the offset
 * is filed under that bot (the current bot, or an earlier one whose entry is
 * then simply unused). Call before anything rewrites `discoveredBotTokenId`.
 * Returns `held` when no bot was ever recorded: the cursor then waits for the
 * owner's review, and the caller must not record a bot until it is reviewed.
 */
export function bindEarlierTelegramCursor(filePath: string, discoveredBotId: string, beforeWrite?: () => void): 'none' | 'bound' | 'held' {
  const document = readCursorDocument(filePath);
  if (document.kind !== 'earlier') return 'none';
  if (!accountValue(discoveredBotId)) return 'held';
  try {
    beforeWrite?.();
    writeDocument(filePath, { version: 2, accounts: [{ accountId: discoveredBotId, offset: document.offset, updatedAt: document.updatedAt }] },
      { mode: 0o600, indent: null });
  } catch (error) {
    logger.warn('Telegram cursor from an earlier version could not be bound to its bot; polling waits and the next start tries again', {
      surface: 'telegram', error: summarizeError(error),
    });
    return 'held';
  }
  logger.info('Telegram cursor from an earlier version was bound to the bot it belongs to', { surface: 'telegram', botId: discoveredBotId, offset: document.offset });
  return 'bound';
}
