/**
 * The id of an owner-mail intake row: the one form the email-owner provider
 * writes and every lookup builds (a `uids` query of the intake feed), so an
 * indexed message is found from its ordinary IMAP UID.
 */
import { defineFormat } from '../utils/format-codec.js';

/** The intake provider id the owner's mailbox reports under. */
export const EMAIL_OWNER_PROVIDER_ID = 'email';

export interface EmailItemAddress {
  /** The account scope the provider reports (`mailboxScope`). */
  readonly scope: string;
  /** The mailbox generation (IMAP UIDVALIDITY). */
  readonly generation: number;
  readonly uid: number;
}

const PATTERN = /^email:(.+):(\d{10}):(\d{10})$/;

/** `email:<scope>:<generation, 10 digits>:<uid, 10 digits>`: fixed-width numbers, so ids sort in mailbox order. */
export const EMAIL_ITEM_ID = defineFormat<EmailItemAddress>({
  name: 'intake email item id',
  parse(raw) {
    const match = typeof raw === 'string' ? PATTERN.exec(raw) : null;
    if (!match) return { ok: false, reason: 'not an owner-mail item id' };
    return { ok: true, value: { scope: match[1]!, generation: Number(match[2]), uid: Number(match[3]) } };
  },
  render({ scope, generation, uid }) {
    return `${EMAIL_OWNER_PROVIDER_ID}:${scope}:${String(generation).padStart(10, '0')}:${String(uid).padStart(10, '0')}`;
  },
});

/** The row id of one message of the owner's mailbox. */
export function emailItemId(scope: string, generation: number, uid: number): string {
  return EMAIL_ITEM_ID.render({ scope, generation, uid }) as string;
}
