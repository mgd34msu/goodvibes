/**
 * approval-broker-raise.ts, raising an ask, as a free function.
 *
 * ── Why this is not a method ───────────────────────────────────────────────
 *
 * Two reasons, and the second is the load-bearing one.
 *
 * 1. approval-broker.ts sits within a few lines of the hand-authored source cap
 *    and this is its longest single body, so it follows the split the session
 *    broker already made (handleIntent → session-broker-intent.ts): a free
 *    function over an explicit deps object, with a thin delegating method left
 *    on the class.
 *
 * 2. Raising an ask now has TWO callers that want different things from it. The
 *    in-process one (`requestApproval`) wants the decision and nothing else,
 *    it is awaiting a human. The wire one (`approvals.raise`, routes/
 *    approvals-raise.ts) wants the RECORD, immediately, and must not hold an
 *    HTTP request open across a person's attention span. Both are the same act,
 *    so both go through this function; it returns the record AND the pending
 *    decision and lets each caller keep the half it needs.
 *
 * ── Write first, then let anyone see it ────────────────────────────────────
 *
 * A raise is written before it enters the record map: no waiter, timer, event
 * or receipt exists for an ask a restart could not find. An identical raise
 * that arrives while the first is being written waits for that write (the
 * `raising` map) and joins it when it lands, or gets the same error when it
 * fails, so two concurrent identical asks make one record and one prompt.
 *
 * ── The coalescing rule, restated because it is subtle ─────────────────────
 *
 * A second identical in-flight ask (same raiser, session, tool and args) does
 * not create a second record or a second prompt: it attaches to the first
 * record's pending promise, so one decision resolves both. The returned
 * `approval` is then the EXISTING record, which is exactly what a wire caller
 * needs, because the id it gets back is the id whose updates it will see on
 * the stream. `coalesced` says which happened, so a caller that raised an ask
 * and got back a record older than its call can tell that from a fresh one.
 * Asks of different raisers never coalesce, so no caller is handed a record or
 * a decision another caller raised (`approvalRaiser`).
 */

import { randomUUID } from 'node:crypto';
import type { PermissionPromptDecision } from '../permissions/prompt.js';
import type {
  RequestSharedApprovalInput,
  SharedApprovalAuditRecord,
  SharedApprovalRecord,
} from './approval-broker.js';
import { isOpenApprovalStatus, type ApprovalHold, type ApprovalRequester } from './approval-lifecycle.js';
import { ordinaryApprovalDecision } from './approval-disposition.js';
import { logger } from '../utils/logger.js';
import { assertPermissionActive } from '../permissions/cancellation.js';
import { currentGuestChannel } from '../security/turn-boundary.js';

/** A pending ask's resolvers and its expiry timer, as the broker holds them. */
export interface PendingApprovalEntry {
  readonly resolvers: ((decision: PermissionPromptDecision) => void)[];
  readonly timer?: ReturnType<typeof setTimeout> | undefined;
  readonly promptController?: AbortController | undefined;
  /** Restored and wire asks retain their durable owner even without local waiters. */
  readonly externallyOwned?: boolean | undefined;
  retired?: boolean | undefined;
}

/** Everything raising an ask needs from the broker that owns the state. */
export interface RaiseApprovalDeps {
  /** Load persisted state before touching it, the broker's own `start()`. */
  start(): Promise<void>;
  /** The live record map, keyed by approval id. Read here; written only by the broker after a write landed. */
  readonly approvals: ReadonlyMap<string, SharedApprovalRecord>;
  /** The live pending-resolver map, keyed by approval id. */
  readonly pendingResolvers: Map<string, PendingApprovalEntry>;
  /** Raises being written, by coalesce key. */
  readonly raising: Map<string, Promise<void>>;
  /** This broker's node, stamped on the record. */
  homeNode(): string;
  /** Write a new record, then put it in the map. Rejects with nothing visible when the write fails. */
  create(record: SharedApprovalRecord): Promise<void>;
  /** Record another wire raiser's hold on an open ask; null when the ask is no longer open. */
  addHold(approvalId: string, hold: ApprovalHold): Promise<SharedApprovalRecord | null>;
  /** Fan the record out: SSE `approval-update`, surface message, listeners. */
  publish(approval: SharedApprovalRecord): void;
  /** Expire an ask whose deadline passed. */
  expire(approvalId: string, note: string): Promise<void>;
  /** Cancel an ask every consumer left (`requester-left`). */
  cancel(approvalId: string): Promise<void>;
  /** Audit-entry factory, the broker's own, so entries stay identical. */
  buildAudit(
    action: SharedApprovalAuditRecord['action'],
    actor: string,
    actorSurface?: string,
    note?: string,
  ): SharedApprovalAuditRecord;
  /** The (session, project, tool, args) coalescing key, the broker's own. */
  coalesceKey(sessionId: string | undefined, tool: string, args: Record<string, unknown>, workingDirectory?: string | undefined): string;
}

/** A raised ask: the record it produced, and the decision still to come. */
export interface RaisedApproval {
  readonly approval: SharedApprovalRecord;
  readonly decision: Promise<PermissionPromptDecision>;
  /** True when this ask attached to an identical one already in flight. */
  readonly coalesced: boolean;
  /** The hold this wire raiser owns on the ask; pass it to `releaseApproval` when leaving or once the decision arrived. */
  readonly holdId?: string | undefined;
}

/** A consumer owns its waiter, never another consumer's shared prompt. */
function joinApproval(
  id: string,
  pending: PendingApprovalEntry,
  deps: RaiseApprovalDeps,
  signal?: AbortSignal,
): Promise<PermissionPromptDecision> {
  return new Promise((resolve) => {
    const complete = (decision: PermissionPromptDecision): void => {
      signal?.removeEventListener('abort', abort);
      resolve(decision);
    };
    const abort = (): void => {
      const index = pending.resolvers.indexOf(complete);
      if (index < 0) return;
      pending.resolvers.splice(index, 1);
      complete({ approved: false, remember: false });
      if (pending.resolvers.length === 0 && !pending.externallyOwned) {
        // Retire synchronously so a new caller cannot join this dying ask while
        // its durable cancellation is waiting for the broker's write queue.
        pending.retired = true;
        pending.promptController?.abort();
        void deps.cancel(id).catch((error: unknown) => logger.warn('Approval consumer retirement failed', {
          approvalId: id, error: error instanceof Error ? error.message : String(error),
        }));
      }
    };
    pending.resolvers.push(complete);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Metadata key naming the channel whose guest's turn raised an ask; the ask is the owner's and is delivered to him. */
export const APPROVAL_GUEST_CHANNEL_METADATA = 'guestChannel';

/** The channel whose guest's turn raised an ask, or undefined for any other ask. */
export function approvalGuestChannel(approval: { readonly metadata: Readonly<Record<string, unknown>> }): string | undefined {
  const value = approval.metadata[APPROVAL_GUEST_CHANNEL_METADATA];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * An ask raised inside a guest's turn (someone a channel admits who is not
 * its owner) records that channel, read from the turn's scope, never from the
 * request: its prompt goes to the owner's own conversation, not the guest's.
 */
function withGuestChannel(metadata: Record<string, unknown>): Record<string, unknown> {
  const channel = currentGuestChannel();
  return channel === undefined ? metadata : { ...metadata, [APPROVAL_GUEST_CHANNEL_METADATA]: channel };
}

function isWireRaise(input: RequestSharedApprovalInput): boolean {
  return input.metadata?.['raisedVia'] === 'approvals.raise';
}

/**
 * Who raised an ask, as the daemon recorded it: the authenticated principal
 * of an `approvals.raise` call (routes/approvals-raise.ts writes it and drops
 * any the caller sent), or `in-process` for an ask the daemon's own code
 * raised. Only one raiser's identical asks coalesce.
 */
export function approvalRaiser(metadata: Readonly<Record<string, unknown>> | undefined): string {
  if (metadata?.['raisedVia'] !== 'approvals.raise') {
    // A call `capabilities.run` put to the owner (daemon/capability-owner-gate.ts) is its caller's own: two callers
    // asking the same act get a question each, each run (or refused) as its own caller, never one answer for both.
    const caller = metadata?.['source'] === 'capabilities.run' ? metadata['requestedBy'] : undefined;
    return typeof caller === 'string' && caller.length > 0 ? `in-process:capability-caller:${caller}` : 'in-process';
  }
  const principal = metadata['raisedByPrincipal'];
  // By kind first: a sign-in user named `shared-token` is never the operator token's raiser (pairing/principal-ids.ts).
  const user = metadata['raisedByPrincipalKind'] === 'user' ? 'user:' : '';
  return typeof principal === 'string' && principal.length > 0 ? `principal:${user}${principal}` : 'wire:unidentified';
}

/** The coalescing key of a raise: its raiser, then the broker's (session, tool, args) key. */
function raiseKey(metadata: Readonly<Record<string, unknown>> | undefined, coalesceKey: string): string {
  return `${approvalRaiser(metadata)}\u0000${coalesceKey}`;
}

/** An open record this raise may join: same raiser and (session, tool, args), not owner-only, with a live waiter entry. */
function joinable(input: RequestSharedApprovalInput, key: string, deps: RaiseApprovalDeps): { record: SharedApprovalRecord; pending: PendingApprovalEntry } | null {
  if (input.requireOwnerDecision) return null;
  for (const existing of deps.approvals.values()) {
    if (existing.requiresOwnerDecision || !isOpenApprovalStatus(existing.status)) continue;
    if (raiseKey(existing.metadata, deps.coalesceKey(existing.sessionId, existing.request.tool, existing.request.args, existing.request.workingDirectory)) !== key) continue;
    const pending = deps.pendingResolvers.get(existing.id);
    if (pending && !pending.retired) return { record: existing, pending };
  }
  return null;
}

/**
 * Raise an ask through the shared broker.
 *
 * Order: the record is written first; only after the write landed does it
 * enter the map, get its waiters and timer, and is it published and any local
 * prompt drawn. A failed write leaves nothing behind: no record, no waiter,
 * no event, and the caller (and every identical raise that waited on it) gets
 * the error.
 */
export async function raiseSharedApproval(
  input: RequestSharedApprovalInput,
  deps: RaiseApprovalDeps,
): Promise<RaisedApproval> {
  const signal = input.signal;
  assertPermissionActive(signal);
  input.requireOwnerDecision?.assertCurrent();
  await deps.start();
  assertPermissionActive(signal);
  input.requireOwnerDecision?.assertCurrent();
  const wire = isWireRaise(input);
  // Keyed by raiser too: another caller's identical ask is its own, never joined to this one.
  const key = raiseKey(input.metadata, deps.coalesceKey(input.sessionId, input.request.tool, input.request.args, input.request.workingDirectory));

  // An identical raise being written: wait for it, then join what it made (its failure is this raise's too).
  for (;;) {
    const writing = input.requireOwnerDecision ? undefined : deps.raising.get(key);
    if (!writing) break;
    await writing;
    assertPermissionActive(signal);
  }

  // Duplicate in-flight asks coalesce on (raiser, session, tool, args): the second
  // identical ask attaches to the first's pending record, ONE prompt, and
  // one decision resolves both. No second record, no second local prompt.
  const existing = joinable(input, key, deps);
  if (existing) {
    let approval = existing.record;
    const holdId = wire ? randomUUID() : undefined;
    if (holdId !== undefined) {
      // A wire raiser's hold is part of the record, so a restart keeps it and its receipt can be read.
      const held = await deps.addHold(approval.id, { id: holdId, ...(input.holdProcess === undefined ? {} : { process: input.holdProcess }) });
      if (held) approval = held;
      else {
        // The ask settled while the hold waited for the write queue: hand back its decision, with no hold to release.
        const settled = deps.approvals.get(approval.id);
        if (settled && !isOpenApprovalStatus(settled.status) && settled.decision) {
          return { approval: settled, coalesced: true, decision: Promise.resolve(ordinaryApprovalDecision(settled.decision)) };
        }
        // Settled and already pruned from the map: its waiters are gone, so there is nothing to join.
        if (deps.pendingResolvers.get(approval.id) !== existing.pending) {
          return { approval, coalesced: true, decision: Promise.resolve({ approved: false, remember: false }) };
        }
      }
    }
    return {
      approval,
      coalesced: true,
      ...(holdId === undefined ? {} : { holdId }),
      decision: joinApproval(approval.id, existing.pending, deps, signal),
    };
  }

  const now = Date.now();
  const creatorHoldId = wire ? randomUUID() : undefined;
  const requester: ApprovalRequester = creatorHoldId !== undefined
    ? { kind: 'wire', holds: [{ id: creatorHoldId, ...(input.holdProcess === undefined ? {} : { process: input.holdProcess }) }] }
    : input.readsRecord === true ? { kind: 'record-reader' } : { kind: 'in-process' };
  const approval: SharedApprovalRecord = {
    id: `approval-${randomUUID().slice(0, 8)}`,
    callId: input.request.callId,
    sessionId: input.sessionId,
    routeId: input.routeId,
    status: 'pending',
    ...(input.requireOwnerDecision ? { requiresOwnerDecision: true as const } : {}),
    request: input.request,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    sequence: 1,
    homeNode: deps.homeNode(),
    requester,
    ...(input.timeoutMs && input.timeoutMs > 0 ? { expiresAt: now + input.timeoutMs } : {}),
    metadata: withGuestChannel(input.metadata ?? {}),
    audit: [deps.buildAudit('created', 'approval-broker', 'service')],
  };
  // An identical raise arriving now awaits this write: it joins the record, or gets this write's error.
  const writing = deps.create(approval);
  if (!input.requireOwnerDecision) deps.raising.set(key, writing);
  try {
    await writing;
  } finally {
    if (deps.raising.get(key) === writing) deps.raising.delete(key);
  }

  // Durable: now it gets its waiters, its timer and its event.
  const timer = input.timeoutMs && input.timeoutMs > 0
    ? setTimeout(() => {
      void deps.expire(approval.id, `timed out after ${input.timeoutMs}ms`).catch((error: unknown) => {
        logger.warn('Approval expiration failed', {
          approvalId: approval.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, input.timeoutMs)
    : undefined;
  timer?.unref?.();
  const pending: PendingApprovalEntry = { resolvers: [], timer, promptController: new AbortController(), ...(wire ? { externallyOwned: true } : {}) };
  deps.pendingResolvers.set(approval.id, pending);
  const pendingDecision = joinApproval(approval.id, pending, deps, signal);
  try {
    input.requireOwnerDecision?.assertCurrent();
  } catch (error) {
    await deps.cancel(approval.id);
    throw error;
  }
  // The creator's signal may have aborted during the write; that cancellation is already queued.
  if (!pending.retired && deps.approvals.get(approval.id) === approval) deps.publish(approval);

  return { approval: deps.approvals.get(approval.id) ?? approval, decision: pendingDecision, coalesced: false,
    ...(creatorHoldId === undefined ? {} : { holdId: creatorHoldId }) };
}
