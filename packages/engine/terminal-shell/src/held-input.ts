/**
 * Held input: what a person typed stays until the action carrying it is accepted.
 *
 * The composer may clear its box at send (the person sees the pending entry),
 * but the held entry is the truth until the daemon returns a receipt for it:
 * a refusal puts it back with the reason, and a send whose answer never came
 * (or could not be read) stays held as "may have been sent" and is resent only
 * with its own `clientMessageId`, so the daemon answers a resend of a message
 * it already recorded with the first one's receipt.
 *
 * The web UI keeps the same contract in `products/webui/src/lib/held-input.ts`.
 * In the terminal products the store lives in memory for the process.
 *
 * Cost: memory only; no request, no write.
 */
import { randomUUID } from 'node:crypto';

export interface HeldAttachment {
  readonly name: string;
  /** Set as the file's upload succeeds; a resend uploads only the files without one. */
  readonly artifactId?: string | undefined;
}

export interface HeldInput {
  /** Minted once when the input is held; every resend uses it. */
  readonly clientMessageId: string;
  readonly sessionId: string | 'new-chat';
  readonly text: string;
  readonly attachments: readonly HeldAttachment[];
  readonly flags: { readonly steer?: true | undefined; readonly turnId?: string | undefined };
  /** `sending`: on its way or being resent; `refused`: the daemon said no (back in the composer); `unknown`: no readable answer, may have been sent. */
  readonly state: 'sending' | 'refused' | 'unknown';
  readonly reason?: string | undefined;
}

export interface HeldInputs {
  hold(input: Omit<HeldInput, 'clientMessageId' | 'state'>): HeldInput;
  /** The server returned a receipt (messageId / input id): the entry is dropped. */
  accepted(clientMessageId: string): void;
  /** Refused (4xx with a refusal): the entry goes back to the composer with the reason. */
  refused(clientMessageId: string, reason: string): HeldInput | undefined;
  /** No answer, or an unreadable one: kept, shown as "may have been sent", resent only with its own id. */
  unknown(clientMessageId: string, reason: string): void;
  /** A resend of the entry starts: it is `sending` again, under the same id. */
  resending(clientMessageId: string): HeldInput | undefined;
  /** One attachment's upload succeeded: its artifact id is kept on the entry. */
  attachmentUploaded(clientMessageId: string, name: string, artifactId: string): void;
  get(clientMessageId: string): HeldInput | undefined;
  list(sessionId: string): readonly HeldInput[];
  /** A new chat's held entry moves to the session the daemon created for it. */
  moveToSession(clientMessageId: string, sessionId: string): void;
}

/** The terminal products' held-input store: in memory for the process. */
export function createHeldInputs(mintId: () => string = randomUUID): HeldInputs {
  const entries = new Map<string, HeldInput>();
  const update = (id: string, change: (entry: HeldInput) => HeldInput): HeldInput | undefined => {
    const entry = entries.get(id);
    if (!entry) return undefined;
    const next = change(entry);
    entries.set(id, next);
    return next;
  };
  return {
    hold(input) {
      const held: HeldInput = { ...input, clientMessageId: mintId(), state: 'sending' };
      entries.set(held.clientMessageId, held);
      return held;
    },
    accepted(clientMessageId) { entries.delete(clientMessageId); },
    refused(clientMessageId, reason) { return update(clientMessageId, (entry) => ({ ...entry, state: 'refused', reason })); },
    unknown(clientMessageId, reason) { update(clientMessageId, (entry) => ({ ...entry, state: 'unknown', reason })); },
    resending(clientMessageId) {
      return update(clientMessageId, ({ reason: _reason, ...entry }) => ({ ...entry, state: 'sending' }));
    },
    attachmentUploaded(clientMessageId, name, artifactId) {
      update(clientMessageId, (entry) => ({
        ...entry,
        attachments: entry.attachments.map((attachment) => attachment.name === name ? { ...attachment, artifactId } : attachment),
      }));
    },
    get(clientMessageId) { return entries.get(clientMessageId); },
    list(sessionId) { return [...entries.values()].filter((entry) => entry.sessionId === sessionId); },
    moveToSession(clientMessageId, sessionId) { update(clientMessageId, (entry) => ({ ...entry, sessionId })); },
  };
}
