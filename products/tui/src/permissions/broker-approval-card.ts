/**
 * broker-approval-card, render a broker-originated approval ask as a real
 * TUI approval card.
 *
 * The approval broker publishes every ask (local runtime asks, plus
 * broker-originated ones like the CI fix-session offer). Local asks carry a
 * `localPrompt` that opens their own card; broker-originated asks do not, so
 * before this they were invisible in the TUI, the ask sat pending with no
 * surface. This helper opens a card straight from broker state for those.
 *
 * A local ask's own prompt is opened by the broker immediately AFTER it
 * publishes (see ApprovalBroker.requestApproval), so the open here is deferred
 * one microtask and re-checks: if a card (the local one, or another broker
 * card) is already up, it does nothing, only a genuinely unhandled ask surfaces.
 * The card's resolve answers the broker directly via resolveApproval, so a TUI
 * decision on a broker-originated ask reaches every waiter on that record.
 */

import { buildPendingPermissionExtras } from './hunk-selection.ts';
import type { ApprovalRequesterLookup } from './hunk-selection.ts';
import type { PendingPermissionState } from '../shell/blocking-input.ts';
import type { PermissionPromptDecision, PermissionPromptRequest, RememberTier } from '@goodvibes/engine/platform/platform/permissions';

/** The broker seam this helper answers through, a subset of ApprovalBroker. */
export interface BrokerApprovalCardBroker extends ApprovalRequesterLookup {
  getApproval(approvalId: string): BrokerCardRecord | null;
  resolveApproval(
    approvalId: string,
    input: {
      readonly approved: boolean;
      readonly disposition?: 'approved' | 'denied';
      readonly remember?: boolean;
      readonly rememberTier?: RememberTier;
      readonly reason?: string;
      readonly modifiedArgs?: Record<string, unknown>;
      /** The hunks the owner kept; the broker builds the applied edit list from its own copy of the request. */
      readonly selectedHunks?: readonly number[];
      readonly actor: string;
      readonly actorSurface?: string;
      /** The revision of the record the card showed. */
      readonly expectedRevision: number | undefined;
    },
  ): Promise<BrokerCardOutcome>;
}

/** The record a card is drawn from. */
export interface BrokerCardRecord {
  readonly id: string;
  readonly callId: string;
  readonly status: string;
  readonly revision: number;
  readonly request: PermissionPromptRequest;
}

/** What the broker did with the card's answer: applied, or refused with the record as it is now. */
export type BrokerCardOutcome =
  | { readonly applied: true; readonly record: BrokerCardRecord }
  | { readonly applied: false; readonly record: BrokerCardRecord | null; readonly refusal: { readonly code: string; readonly reason: string } };

export interface BrokerApprovalChangeParams {
  readonly approval: BrokerCardRecord;
  readonly getPending: () => PendingPermissionState | null;
  readonly setPending: (pending: PendingPermissionState | null) => void;
  readonly broker: BrokerApprovalCardBroker;
  readonly render: () => void;
  /** Defers the open (default queueMicrotask); injectable so tests run it synchronously. */
  readonly defer?: (callback: () => void) => void;
  /** Tells the owner their answer did not reach the broker; the card is offered again if the ask is still waiting. */
  readonly notify?: (message: string) => void;
}

const isActiveStatus = (status: string): boolean => status === 'pending' || status === 'claimed';

/**
 * React to one broker approval change: clear the active card when ITS approval
 * resolves, or open a card for a newly-pending broker-originated ask that no
 * local prompt is handling.
 */
export function handleBrokerApprovalChange(params: BrokerApprovalChangeParams): void {
  const { approval, getPending, setPending, broker, render } = params;
  const defer = params.defer ?? queueMicrotask;
  const active = isActiveStatus(approval.status);

  const pending = getPending();
  if (pending && pending.callId === approval.callId) {
    // This is the card already on screen, clear it once its approval resolves.
    if (!active) { setPending(null); render(); }
    return;
  }
  if (!active) return;

  defer(() => {
    if (getPending()) return; // a local card (or another broker card) is already up
    const current = broker.getApproval(approval.id);
    if (!current || !isActiveStatus(current.status)) return;
    setPending({
      ...current.request,
      ...buildPendingPermissionExtras(current.request, (decision) => {
        void broker.resolveApproval(approval.id, {
          approved: decision.approved,
          // The owner answered this card: an explicit decision, which owner-only asks (workspace trust) require.
          disposition: decision.approved ? 'approved' : 'denied',
          remember: decision.remember ?? false,
          ...(decision.rememberTier ? { rememberTier: decision.rememberTier } : {}),
          ...(decision.reason ? { reason: decision.reason } : {}),
          ...(decision.modifiedArgs ? { modifiedArgs: decision.modifiedArgs } : {}),
          ...(decision.selectedHunks ? { selectedHunks: decision.selectedHunks } : {}),
          actor: 'tui',
          actorSurface: 'tui',
          // The record this card was drawn from: a stale answer is refused and the card is drawn again from the current one.
          expectedRevision: current.revision,
        }).then((outcome) => {
          if (outcome.applied || !outcome.record || !isActiveStatus(outcome.record.status)) return;
          params.notify?.(`Your answer was not taken: ${outcome.refusal.reason} The request is shown again.`);
          const latest = outcome.record;
          defer(() => handleBrokerApprovalChange({ ...params, approval: latest }));
        }, (error: unknown) => {
          // The card is already cleared, so without this the answer would vanish and the tool call would keep waiting.
          params.notify?.(`Your answer was not recorded (${error instanceof Error ? error.message : String(error)}). The request is asked again if it is still waiting.`);
          defer(() => handleBrokerApprovalChange(params));
        });
      }, broker),
    } as PendingPermissionState);
    render();
  });
}

/**
 * Re-offer every waiting record after a change. A broker-originated ask that
 * published while another card was up was skipped by the deferred open above,
 * and nothing published for it again, so without a sweep it never got a card.
 */
export function sweepBrokerApprovals(
  params: Omit<BrokerApprovalChangeParams, 'approval'> & {
    readonly listApprovals: () => readonly BrokerApprovalChangeParams['approval'][];
  },
): void {
  const { listApprovals, ...rest } = params;
  for (const waiting of listApprovals()) {
    if (isActiveStatus(waiting.status)) handleBrokerApprovalChange({ ...rest, approval: waiting });
  }
}

/** A broker record, as far as settling a queued local ask needs it. */
export interface SettledApprovalRecord {
  readonly callId: string;
  readonly status: string;
  readonly updatedAt: number;
  readonly resolvedAt?: number | undefined;
  readonly decision?: {
    readonly approved: boolean;
    readonly remember?: boolean | undefined;
    readonly rememberTier?: RememberTier | undefined;
    readonly reason?: string | undefined;
    readonly modifiedArgs?: Record<string, unknown> | undefined;
  } | undefined;
}

/**
 * The answer another surface already gave to a local ask that was waiting for its
 * card, or null when none did. Only a record settled after the ask was queued
 * counts (a call id from an earlier turn must not answer a new ask), the newest
 * wins, and the whole decision is carried over so a per-hunk or amended approval
 * is applied as granted, not as the original arguments.
 */
export function settledAskDecision(
  records: readonly SettledApprovalRecord[],
  callId: string,
  queuedAt: number,
): PermissionPromptDecision | null {
  let newest: SettledApprovalRecord | null = null;
  for (const record of records) {
    if (record.callId !== callId || isActiveStatus(record.status)) continue;
    const settledAt = record.resolvedAt ?? record.updatedAt;
    if (settledAt < queuedAt) continue;
    if (newest === null || settledAt >= (newest.resolvedAt ?? newest.updatedAt)) newest = record;
  }
  if (newest === null) return null;
  const decision = newest.decision;
  const approved = newest.status === 'approved' && decision?.approved === true;
  return {
    approved,
    remember: decision?.remember ?? false,
    ...(decision?.rememberTier ? { rememberTier: decision.rememberTier } : {}),
    ...(decision?.reason ? { reason: decision.reason } : {}),
    ...(approved && decision?.modifiedArgs ? { modifiedArgs: decision.modifiedArgs } : {}),
  };
}

/** The surface's single approval card slot, as the local-ask queue reads it. */
export interface ApprovalCardQueue<T> {
  /** Show this ask now, or after the cards ahead of it are answered. */
  readonly offer: (entry: T) => void;
  /** Call whenever the card slot may have emptied. */
  readonly next: () => void;
  readonly size: () => number;
}

/**
 * One card is on screen at a time. A second local ask arriving while a card is
 * up waits its turn instead of replacing it: a replaced card's resolver is gone,
 * so the tool call that raised it would wait forever. The same ask arriving
 * again (its broker card opened a microtask before its local prompt) replaces
 * its own card. `show` returns false when the ask no longer needs a card (it
 * was settled elsewhere while waiting), and the next one is offered instead.
 */
export function createApprovalCardQueue<T>(deps: {
  readonly getPending: () => { readonly callId: string } | null;
  readonly callIdOf: (entry: T) => string;
  readonly show: (entry: T) => boolean;
}): ApprovalCardQueue<T> {
  const waiting: T[] = [];
  const next = (): void => {
    while (deps.getPending() === null && waiting.length > 0) {
      if (deps.show(waiting.shift()!)) return;
    }
  };
  return {
    offer: (entry) => {
      const pending = deps.getPending();
      if (pending === null || pending.callId === deps.callIdOf(entry)) {
        if (!deps.show(entry)) next();
        return;
      }
      waiting.push(entry);
    },
    next,
    size: () => waiting.length,
  };
}
