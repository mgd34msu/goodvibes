/**
 * The seam between the mailbox poll and the payments composition, and the
 * record of every screened owner mail whose order check has not settled.
 *
 * The inbox and payments are composed independently and in no fixed order, so
 * neither can hold the other. The inbox calls `observe` for every screened
 * message; payments attaches its handler once it exists.
 *
 * The inbox commits a batch to its store before it hands the batch's mail here,
 * and never offers a committed mail again. So this relay keeps each observed
 * mail in a small durable pending list (the whole screened observation: the
 * inbox store keeps only a preview, and the check reads the full body) until
 * the attached handler's promise says its check settled, and removes it then.
 * A rejected check keeps it. Every pending mail is offered again when a handler
 * attaches and on each later observation, so a daemon stopped mid-check, a
 * failed check or a window with no handler attached is retried, not lost.
 * Costs one small atomic file write when a mail is observed and one when its
 * check settles; nothing per request.
 */
import type { OwnerMailObservation } from '@goodvibes/engine/platform/platform/intake';
import { logger, readDocument, writeDocument } from '@goodvibes/engine/platform/platform/utils';

/** Resolves when the mail's check settled (reported or found to need no report); rejects when it should be tried again. */
export type OwnerMailHandler = (mail: OwnerMailObservation) => Promise<void>;

/** Most owner mails kept pending; past it the oldest is dropped, and the log says so. */
export const OWNER_MAIL_MEMORY = 512;

/** The pending list's file name, beside the other payments stores. */
export const OWNER_MAIL_PENDING_FILE = 'payments-order-mail-pending.json';

export interface OwnerMailRelay {
  observe(mail: OwnerMailObservation): void;
  /** Returns the detach function. A later attach replaces an earlier handler; detaching a replaced handler does nothing. */
  attach(handler: OwnerMailHandler): () => void;
}

export interface OwnerMailRelayOptions {
  /** The pending list's file; absent keeps the list in memory only. */
  readonly pendingPath?: string | undefined;
}

function isObservation(value: unknown): value is OwnerMailObservation {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['id'] === 'string' && typeof record['senderAddress'] === 'string'
    && typeof record['subject'] === 'string' && typeof record['body'] === 'string'
    && typeof record['receivedAtMs'] === 'number' && Number.isFinite(record['receivedAtMs']);
}

function loadPending(path: string): OwnerMailObservation[] {
  try {
    return readDocument<OwnerMailObservation[]>(path, {
      label: 'payments/order-mail-pending',
      validate: (parsed) => {
        if (!Array.isArray(parsed)) throw new Error('the pending order mail list is not a list');
        return parsed.filter(isObservation).map((mail) => ({
          id: mail.id, senderAddress: mail.senderAddress, subject: mail.subject, body: mail.body, receivedAtMs: mail.receivedAtMs,
        }));
      },
      recovery: 'The order mails it held are not checked against purchases again; new mail is kept from now on.',
    }) ?? [];
  } catch (error) {
    // Fixed text and the error name only: the file holds mail text.
    logger.warn('The pending order mail list could not be read; it starts empty', { error: error instanceof Error ? error.name : 'unknown' });
    return [];
  }
}

export function createOwnerMailRelay(options: OwnerMailRelayOptions = {}): OwnerMailRelay {
  const pendingPath = options.pendingPath;
  const pending: OwnerMailObservation[] = pendingPath ? loadPending(pendingPath) : [];
  const checking = new Set<string>();
  let current: OwnerMailHandler | undefined;

  const save = (): void => {
    if (!pendingPath) return;
    try {
      writeDocument(pendingPath, pending, { indent: null });
    } catch (error) {
      logger.warn('The pending order mail list could not be saved; a mail not yet checked may be lost if the daemon stops now', { error: error instanceof Error ? error.name : 'unknown' });
    }
  };

  const settle = (id: string): void => {
    const index = pending.findIndex((kept) => kept.id === id);
    if (index < 0) return;
    pending.splice(index, 1);
    save();
  };

  const offer = (mail: OwnerMailObservation): void => {
    const handler = current;
    if (!handler || checking.has(mail.id)) return;
    checking.add(mail.id);
    let check: Promise<void>;
    try {
      check = handler(mail);
    } catch (error) {
      check = Promise.reject(error);
    }
    void check.then(
      () => settle(mail.id),
      // The handler logged why; the mail stays pending and is offered again.
      () => undefined,
    ).finally(() => { checking.delete(mail.id); });
  };

  const offerAll = (): void => {
    for (const mail of [...pending]) offer(mail);
  };

  return {
    observe(mail) {
      if (!pending.some((kept) => kept.id === mail.id)) {
        pending.push({ id: mail.id, senderAddress: mail.senderAddress, subject: mail.subject, body: mail.body, receivedAtMs: mail.receivedAtMs });
        if (pending.length > OWNER_MAIL_MEMORY) {
          pending.splice(0, pending.length - OWNER_MAIL_MEMORY);
          logger.warn('The pending order mail list is full; the oldest mail not yet checked against purchases was dropped', { limit: OWNER_MAIL_MEMORY });
        }
        save();
      }
      offerAll();
    },
    attach(handler) {
      current = handler;
      offerAll();
      return () => { if (current === handler) current = undefined; };
    },
  };
}
