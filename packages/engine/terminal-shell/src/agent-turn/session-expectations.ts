/**
 * The session's open verification expectations.
 *
 * `VerificationExpectationBook` is the narrow hole that lets a verification
 * email the agent itself provoked establish one thing: whoever controls the
 * minted alias received this token. It had no caller, so the hole was never
 * opened and the aliasing that feeds it was never used.
 *
 * Used only when no daemon is reachable: with a daemon, its expectation book
 * (below, `DaemonExpectationClient`) is the one book.
 *
 * The book is session-scoped and in memory on purpose. An expectation is a
 * fifteen-minute window around a signup the agent is performing right now;
 * persisting it across restarts would keep a matching window open long after
 * the signup it belonged to, which is the opposite of narrow. Losing the book
 * on exit means an unfinished signup simply cannot be auto-verified, which is
 * the safe direction to fail in.
 *
 * Shared between the tool that mints the alias and the tool that reads the
 * mail, exactly like the untrusted-content ledger.
 */

import { VerificationExpectationBook } from '@goodvibes/engine/platform/platform/google';
import { surfaceHasCommandAuthority } from '@goodvibes/engine/platform/platform/security';
import type { DaemonVerbCaller } from '@goodvibes/engine/platform/platform/runtime/client';

let book: VerificationExpectationBook | null = null;

/**
 * The session book. Constructed with the real surface-authority probe, so if
 * email ever gains command authority, opening an expectation fails loudly
 * rather than quietly widening the hole.
 */
export function getSessionExpectationBook(): VerificationExpectationBook {
  if (book === null) {
    book = new VerificationExpectationBook({
      surfaceHasCommandAuthority: (surface: string) => surface === 'email' && surfaceHasCommandAuthority('email'),
    });
  }
  return book;
}

/** A link or code the daemon took from the matching message. */
export type DaemonExpectationToken =
  | { readonly kind: 'link'; readonly url: string; readonly linkHost: string }
  | { readonly kind: 'code'; readonly code: string };

/** Where one daemon expectation stands, as `email.expectation.wait` answers. */
export interface DaemonExpectationState {
  readonly state: 'waiting' | 'arrived' | 'expired' | 'capability-lost' | 'cancelled' | 'unknown';
  readonly expectation?: { readonly id: string; readonly serviceDomain: string; readonly recipientAddress: string; readonly expiresAt: string; readonly remainingMs?: number | undefined } | undefined;
  readonly token?: DaemonExpectationToken | undefined;
  readonly detail?: string | undefined;
  readonly arrivals?: readonly { readonly messageId: string; readonly at: string; readonly reason: string }[] | undefined;
  readonly watching?: { readonly running: boolean; readonly reason: string } | undefined;
}

/**
 * The daemon's expectation book, reached through the connected host. When a
 * daemon is reachable it is the one book: it watches the mailbox, takes the
 * link or code from the matching message, and reports expiry and a lost
 * mailbox. The session book above is used only when no daemon is reachable.
 */
export interface DaemonExpectationClient {
  /** Null when no daemon is reachable, with the reason. */
  unreachable(): string | null;
  open(input: { readonly serviceDomain: string; readonly recipientAddress: string; readonly purpose: string }): Promise<{
    readonly id: string;
    readonly expiresAt: string;
    readonly watching?: { readonly running: boolean; readonly reason: string } | undefined;
  }>;
  wait(id: string, timeoutMs: number): Promise<DaemonExpectationState>;
}

export function createDaemonExpectationClient(verbs: Pick<DaemonVerbCaller, 'probe' | 'invoke'>): DaemonExpectationClient {
  return {
    unreachable: () => {
      const reachability = verbs.probe();
      return reachability.available ? null : reachability.reason;
    },
    open: (input) => verbs.invoke<Awaited<ReturnType<DaemonExpectationClient['open']>>>('email.expectation.open', { ...input, kind: 'signup' }),
    wait: (id, timeoutMs) => verbs.invoke<DaemonExpectationState>('email.expectation.wait', { id, timeoutMs }),
  };
}

/** One answer for the model from a daemon expectation's state. */
export function describeDaemonExpectationState(id: string, result: DaemonExpectationState): { readonly ok: boolean; readonly text: string } {
  const domain = result.expectation?.serviceDomain ?? 'the service';
  const watching = result.watching && !result.watching.running ? ` No mailbox is being read right now: ${result.watching.reason}.` : '';
  if (result.state === 'arrived' && result.token?.kind === 'link') return { ok: true, text: `Verification link for ${domain}: ${result.token.url}` };
  if (result.state === 'arrived' && result.token?.kind === 'code') return { ok: true, text: `Verification code for ${domain}: ${result.token.code}` };
  if (result.state === 'waiting') {
    const arrivals = result.arrivals ?? [];
    const seen = arrivals.length === 0 ? '' : ` ${arrivals.length} matching message(s) held no link or code (latest ${arrivals[arrivals.length - 1]!.messageId}: ${arrivals[arrivals.length - 1]!.reason}); read one with google action:"mail.read" if the service sent it there.`;
    const left = result.expectation?.remainingMs === undefined ? '' : ` ${Math.ceil(result.expectation.remainingMs / 1000)}s left in the window.`;
    return { ok: false, text: `No verification mail for ${domain} yet.${left}${seen}${watching} Call google action:"mail.verification" expectationId:"${id}" again to keep waiting.` };
  }
  if (result.state === 'unknown') return { ok: false, text: `No verification expectation ${id} is open or remembered by the daemon. Open one with accounts action:"alias".` };
  if (result.state === 'cancelled') return { ok: false, text: `Verification expectation ${id} for ${domain} was cancelled.` };
  return { ok: false, text: `${result.detail ?? `Verification expectation ${id} for ${domain} ended (${result.state}).`}${watching}` };
}

/** Test seam: drops every open expectation between cases. */
export function resetSessionExpectationBookForTests(): void {
  book = null;
}
