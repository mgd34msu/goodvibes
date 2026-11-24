/**
 * One mailbox reader, several consumers.
 *
 * The inbound reader (IMAP watcher or Gmail source) is the only thing that
 * reads a mailbox. Everything that wants that mailbox's mail, inbound notices
 * and the inbox, is a consumer here: the reader hands each batch to every
 * consumer and moves its one cursor past exactly the messages every consumer
 * settled. A consumer is idempotent on the message key, so a batch handed over
 * again after a failure or a restart has its effect once.
 *
 * Consumers run one after another over the whole batch rather than message by
 * message, so a consumer that is slow per message (the inbox screens text)
 * never holds back another's notice for the next message. A consumer that
 * fails stops at that message; the others go on, and the cursor stays below
 * it, so the next drain hands it over again.
 */

import { InboundNoticeTransportError } from './intake.js';
import { noteListChanged } from '../../runtime/list-changes.js';
import type { InboundCapabilityVerdict } from './capability-types.js';
import type {
  InboundMailboxMessage,
  InboundMailSink,
  MailboxBatchOutcome,
  MailboxReadPosition,
} from './ports.js';

/** Something that wants a mailbox's mail. */
export interface MailboxConsumer {
  readonly id: string;
  /** True when the newest messages already in the mailbox should be kept as history on first run. */
  readonly wantsHistory?: boolean | undefined;
  /** The mailbox generation (IMAP UIDVALIDITY), at every connection before any of its messages. Idempotent. */
  generation?(uidValidity: number): Promise<void>;
  /** Handle one message; resolving means handled (or buffered until `settle`). Idempotent on the message key. */
  deliver(message: InboundMailboxMessage): Promise<void>;
  /** Make durable what `deliver` buffered for this batch. Called once per batch, after a failure too. */
  settle?(): Promise<void>;
  /** Where the reader's position stands. Must not throw. */
  position?(position: MailboxReadPosition): void;
  /** Whether the reader runs and what it last concluded. Must not throw. */
  readerState?(state: MailboxReaderState): void;
}

export interface MailboxReaderState {
  readonly running: boolean;
  readonly verdict: InboundCapabilityVerdict | null;
  /** The reader's own sentence about what it is doing. */
  readonly reason: string;
}

/**
 * A consumer that cannot take mail right now for a reason outside the message
 * (its route is down, the store is closing). Retried on the reader's delivery
 * backoff on the same connection; it never steps a message over.
 */
export class MailboxConsumerUnavailableError extends Error {
  readonly retryable = true;
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'MailboxConsumerUnavailableError';
  }
}

/** Reading a message's content on the reader's session failed; the session may be gone. */
export class MailboxReadError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'MailboxReadError';
  }
}

/** A failure the reader waits out on the same connection rather than counting as its own. */
export function isConsumerUnavailable(error: unknown): boolean {
  return error instanceof MailboxConsumerUnavailableError || error instanceof InboundNoticeTransportError;
}

/** A message the reader stepped over, or one already in the mailbox at establishment. */
export function isHistoryOrStandIn(message: InboundMailboxMessage): boolean {
  return message.history === true || message.unreadable !== undefined;
}

/** The reader's sink: every consumer, in order, over each batch. */
export class MailboxFanOut implements InboundMailSink {
  constructor(private readonly consumers: () => readonly MailboxConsumer[]) {}

  wantsHistory(): boolean {
    return this.consumers().some((consumer) => consumer.wantsHistory === true);
  }

  async generation(uidValidity: number): Promise<void> {
    for (const consumer of this.consumers()) await consumer.generation?.(uidValidity);
  }

  position(position: MailboxReadPosition): void {
    for (const consumer of this.consumers()) {
      try { consumer.position?.(position); } catch { /* A reporting consumer cannot stop the reader. */ }
    }
  }

  readerState(state: MailboxReaderState): void {
    for (const consumer of this.consumers()) {
      try { consumer.readerState?.(state); } catch { /* A reporting consumer cannot stop the reader. */ }
    }
  }

  async deliver(message: InboundMailboxMessage): Promise<void> {
    const outcome = await this.deliverBatch([message]);
    if (outcome.failed) throw outcome.error;
  }

  async deliverBatch(messages: readonly InboundMailboxMessage[], signal?: AbortSignal): Promise<MailboxBatchOutcome> {
    let done = messages.length;
    let failed = false;
    let error: unknown = null;
    const fail = (at: number, cause: unknown): void => {
      if (!failed || at < done) { done = Math.min(done, at); error = cause; }
      failed = true;
    };
    const consumers = this.consumers();
    for (const consumer of consumers) {
      for (let index = 0; index < messages.length; index += 1) {
        // A reader retired part-way through hands nothing more on.
        if (signal?.aborted) { fail(index, signal.reason); break; }
        try {
          await consumer.deliver(messages[index]!);
        } catch (cause) {
          fail(index, cause);
          break;
        }
      }
    }
    // Every consumer settles, the failed one included: what it handled before
    // the failure is kept, and only the batch's settled prefix is passed.
    for (const consumer of consumers) {
      if (!consumer.settle) continue;
      try { await consumer.settle(); } catch (cause) { fail(0, cause); }
    }
    // New mail reached the mailbox: a client showing it reads it again.
    if (messages.slice(0, done).some((message) => !isHistoryOrStandIn(message))) noteListChanged({ list: 'mail', change: 'created' });
    return { done, failed, error };
  }
}

/** What a reader registers so consumers can reach it. */
export interface MailboxReaderHandle {
  /** A consumer that shows the mailbox attached late and wants the history window once. */
  requestHistory(): void;
  /** Consumers changed: decide again whether to read at all. */
  consumersChanged(): void;
}

/**
 * The key a reader and its consumers meet on: the IMAP host, the user and the
 * folder, as the mail settings name them. Null when any is missing.
 */
export function mailboxReaderKey(input: {
  readonly host?: string | undefined;
  readonly user?: string | undefined;
  readonly mailbox?: string | undefined;
}): string | null {
  const host = input.host?.trim().toLowerCase() ?? '';
  const user = input.user?.trim().toLowerCase() ?? '';
  if (host.length === 0 || user.length === 0) return null;
  const mailbox = input.mailbox?.trim() || 'INBOX';
  return `${host}\n${user}\n${mailbox}`;
}

/**
 * The daemon's meeting point between readers and consumers.
 *
 * The inbox is built before the daemon facade composes its readers, so a
 * consumer may attach before its reader exists; it is handed over when the
 * reader registers. One reader per key: a second registration is refused.
 */
export class MailboxReaders {
  private readonly attached = new Map<string, Map<string, MailboxConsumer>>();
  private readonly readers = new Map<string, MailboxReaderHandle>();
  private readonly historyWanted = new Set<string>();

  register(key: string, handle: MailboxReaderHandle): () => void {
    if (this.readers.has(key)) throw new Error('This mailbox already has a reader in this process.');
    this.readers.set(key, handle);
    if (this.historyWanted.delete(key)) handle.requestHistory();
    if ((this.attached.get(key)?.size ?? 0) > 0) handle.consumersChanged();
    return () => { if (this.readers.get(key) === handle) this.readers.delete(key); };
  }

  /**
   * Attach a consumer to the mailbox `key`. With `requestHistory`, the reader
   * keeps the history window for it once (now, or when the reader registers).
   */
  attach(key: string, consumer: MailboxConsumer, options: { readonly requestHistory?: boolean } = {}): () => void {
    const list = this.attached.get(key) ?? new Map<string, MailboxConsumer>();
    // A consumer rebuilt for the same account (a settings change) replaces the one it succeeds.
    list.set(consumer.id, consumer);
    this.attached.set(key, list);
    const reader = this.readers.get(key);
    if (options.requestHistory) {
      if (reader) reader.requestHistory(); else this.historyWanted.add(key);
    }
    reader?.consumersChanged();
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      const current = this.attached.get(key);
      if (current?.get(consumer.id) === consumer) current.delete(consumer.id);
      if (current?.size === 0) this.attached.delete(key);
      this.readers.get(key)?.consumersChanged();
    };
  }

  consumers(key: string): readonly MailboxConsumer[] {
    return [...(this.attached.get(key)?.values() ?? [])];
  }

  hasReader(key: string): boolean {
    return this.readers.has(key);
  }
}
