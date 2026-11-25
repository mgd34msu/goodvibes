/**
 * security-code-requests.ts, asking the owner for the card's security code at
 * the moment a purchase reaches payment, when `payments.cvvHandling` is
 * 'prompt'.
 *
 * Under 'prompt' the code is never stored. A purchase that has passed every
 * other check and been approved stops here: the owner is asked, on a surface
 * that may carry card details (the terminal apps or the local web UI, through
 * the paired operator method `payments.purchase.securityCode`), and has as long
 * as an approval window to answer. The code is held in memory for that one
 * fill and dropped; nothing here writes it anywhere, logs it, or returns it.
 *
 * While a code is awaited, a short number typed on a remote channel is read as
 * a possible security code (`isSecurityCodeAwaited`), so the owner is told to
 * delete it there instead of the number sitting in chat history.
 */
import { randomUUID } from 'node:crypto';
import type { CardMaterialStore } from './card-material.js';
import { noteListChanged } from '../runtime/list-changes.js';

/**
 * The code the owner typed, sealed: the only thing it can do is complete one
 * read of one card's material. The checkout flow never sees the digits.
 */
export interface TypedSecurityCode {
  withCard(cards: CardMaterialStore): CardMaterialStore;
}

function sealed(code: string): TypedSecurityCode {
  return Object.freeze({
    withCard: (cards: CardMaterialStore): CardMaterialStore => ({
      metadata: (cardId) => cards.metadata(cardId),
      read: (cardId) => cards.read(cardId, { securityCode: code }),
    }),
  });
}

/** One open request, as surfaces see it. Never carries a code. */
export interface SecurityCodeRequestView {
  readonly purchaseId: string;
  readonly windowId: string;
  readonly merchantDomain: string;
  readonly cardLast4: string;
  readonly deadlineMs: number;
}

/** Why a supplied code was not taken; the message names the next step. */
export class SecurityCodeRequestError extends Error {
  constructor(readonly kind: 'stale' | 'invalid') {
    super(kind === 'stale'
      ? 'That security-code request has closed or was replaced. Read payments.purchase.status for the current one.'
      : 'A card security code is three or four digits. Type only those digits.');
    this.name = 'SecurityCodeRequestError';
  }
}

interface Pending extends SecurityCodeRequestView {
  readonly settle: (code: string | null) => void;
}

/** Process-wide count of awaited codes, read by the remote-channel screen. */
let awaitedCodes = 0;

/** True while any purchase in this process is waiting for its security code. */
export function isSecurityCodeAwaited(): boolean {
  return awaitedCodes > 0;
}

const isDecimalDigit = (codePoint: number): boolean => /\p{Nd}/u.test(String.fromCodePoint(codePoint));

/**
 * Three or four decimal digits in any script, folded to ASCII; null otherwise.
 * Unicode lays every decimal-digit set out as runs of ten code points starting
 * at zero, so a digit's value is its distance from the start of its run, mod 10.
 */
export function normalizeSecurityCode(raw: string): string | null {
  const text = raw.trim();
  if (!/^\p{Nd}{3,4}$/u.test(text)) return null;
  let ascii = '';
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    let start = codePoint;
    while (start > 0 && isDecimalDigit(start - 1)) start -= 1;
    ascii += String((codePoint - start) % 10);
  }
  return ascii;
}

export class SecurityCodeRequests {
  readonly #pending = new Map<string, Pending>();

  /**
   * Wait for the owner to type the code for this purchase, until `deadlineMs`.
   * Resolves with the sealed code, or null when the deadline passes or `signal`
   * aborts. One request per purchase; a new one replaces an older one.
   */
  request(input: {
    readonly purchaseId: string;
    readonly merchantDomain: string;
    readonly cardLast4: string;
    readonly deadlineMs: number;
    readonly now: () => number;
    readonly signal?: AbortSignal | undefined;
  }): Promise<TypedSecurityCode | null> {
    this.#pending.get(input.purchaseId)?.settle(null);
    return new Promise<TypedSecurityCode | null>((resolve) => {
      let done = false;
      const timer = setTimeout(() => finish(null), Math.max(0, input.deadlineMs - input.now()));
      const onAbort = () => finish(null);
      const finish = (code: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', onAbort);
        if (this.#pending.get(input.purchaseId) === entry) this.#pending.delete(input.purchaseId);
        awaitedCodes -= 1;
        // Waiting for you's Purchases reads again: the code was given, or the purchase stopped waiting for it.
        noteListChanged({ list: 'payments', change: 'changed', id: input.purchaseId });
        resolve(code === null ? null : sealed(code));
      };
      const entry: Pending = Object.freeze({
        purchaseId: input.purchaseId, windowId: randomUUID(), merchantDomain: input.merchantDomain,
        cardLast4: input.cardLast4, deadlineMs: input.deadlineMs, settle: finish,
      });
      awaitedCodes += 1;
      this.#pending.set(input.purchaseId, entry);
      if (input.signal?.aborted) { finish(null); return; }
      // Waiting for you's Purchases reads again: a purchase now waits for its code.
      noteListChanged({ list: 'payments', change: 'created', id: input.purchaseId });
      input.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Hand the typed code to the waiting purchase. Throws `SecurityCodeRequestError`. */
  supply(input: { readonly purchaseId: string; readonly windowId: string; readonly code: string }): { readonly purchaseId: string; readonly windowId: string; readonly accepted: true } {
    const entry = this.#pending.get(input.purchaseId);
    if (!entry || entry.windowId !== input.windowId) throw new SecurityCodeRequestError('stale');
    const code = typeof input.code === 'string' ? normalizeSecurityCode(input.code) : null;
    if (code === null) throw new SecurityCodeRequestError('invalid');
    entry.settle(code);
    return Object.freeze({ purchaseId: entry.purchaseId, windowId: entry.windowId, accepted: true });
  }

  /** The open requests, optionally for one purchase. */
  inspect(purchaseId?: string): readonly SecurityCodeRequestView[] {
    return [...this.#pending.values()]
      .filter((entry) => purchaseId === undefined || entry.purchaseId === purchaseId)
      .map(({ purchaseId: id, windowId, merchantDomain, cardLast4, deadlineMs }) => Object.freeze({ purchaseId: id, windowId, merchantDomain, cardLast4, deadlineMs }));
  }

  /** Close every open request without a code. */
  close(): void {
    for (const entry of [...this.#pending.values()]) entry.settle(null);
  }
}
