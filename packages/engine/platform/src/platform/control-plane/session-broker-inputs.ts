import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { SubmitSharedSessionMessageInput } from './session-types.js';
import type { SharedSessionInputIntent, SharedSessionInputRecord, SharedSessionInputState, SharedSessionSurfaceReplyBinding } from './session-intents.js';
import { isDelegatedSessionInput, sharedSessionInputLifecycle } from './session-intents.js';
import type { SharedSessionRecord } from './session-types.js';
import { BOOT_RECONCILE_CANCEL_REASON, countPendingSessionInputs, sortInputs } from './session-broker-state.js';
import { bindSharedSessionAgent, hasFreshSurfaceParticipant, isSurfaceManagedSession, SURFACE_ROUTE_FRESHNESS_MS } from './session-broker-sessions.js';

export interface SharedSessionInputStore {
  readonly sessions: Map<string, SharedSessionRecord>;
  readonly inputs: Map<string, SharedSessionInputRecord[]>;
}

export function touchSharedSession(store: SharedSessionInputStore, sessionId: string): void {
  const session = store.sessions.get(sessionId);
  if (!session) return;
  const now = Date.now();
  store.sessions.set(sessionId, { ...session, lastActivityAt: now, updatedAt: now });
}

export function refreshPendingInputCount(store: SharedSessionInputStore, sessionId: string): void {
  const session = store.sessions.get(sessionId);
  if (!session) return;
  const pendingInputCount = countPendingSessionInputs(store.inputs.get(sessionId) ?? []);
  store.sessions.set(sessionId, {
    ...session,
    pendingInputCount,
    updatedAt: Date.now(),
  });
}

export function recordSharedSessionInput(
  store: SharedSessionInputStore,
  input: {
    readonly sessionId: string;
    readonly intent: SharedSessionInputIntent;
    readonly message: SubmitSharedSessionMessageInput;
    readonly routeId?: string | undefined;
    readonly causationId?: string | undefined;
    readonly maxPersistedInputs: number;
  },
): SharedSessionInputRecord {
  touchSharedSession(store, input.sessionId);
  const id = `sin-${randomUUID().slice(0, 8)}`;
  const entry: SharedSessionInputRecord = {
    id,
    sessionId: input.sessionId,
    intent: input.intent,
    state: 'queued',
    correlationId: typeof input.message.metadata?.correlationId === 'string'
      ? input.message.metadata.correlationId
      : `session-input:${id}`,
    ...(input.causationId ? { causationId: input.causationId } : {}),
    body: input.message.body,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    routeId: input.routeId,
    surfaceKind: input.message.surfaceKind,
    surfaceId: input.message.surfaceId,
    externalId: input.message.externalId,
    threadId: input.message.threadId,
    userId: input.message.userId,
    displayName: input.message.displayName,
    metadata: input.message.metadata ?? {},
    routing: input.message.routing,
  };
  const bucket = store.inputs.get(input.sessionId) ?? [];
  bucket.push(entry);
  let sorted = sortInputs(bucket);
  let excess = sorted.length - input.maxPersistedInputs;
  if (excess > 0) {
    // Only finished rows are history to drop; a queued, delivered or spawned row is a message still owed an answer.
    sorted = sorted.filter((candidate) => {
      if (excess > 0 && countPendingSessionInputs([candidate]) === 0) {
        excess -= 1;
        return false;
      }
      return true;
    });
  }
  store.inputs.set(input.sessionId, sorted);
  refreshPendingInputCount(store, input.sessionId);
  return entry;
}

export function updateSharedSessionInput(
  store: SharedSessionInputStore,
  sessionId: string,
  inputId: string,
  transform: (input: SharedSessionInputRecord) => SharedSessionInputRecord,
): SharedSessionInputRecord | null {
  const bucket = store.inputs.get(sessionId);
  if (!bucket) return null;
  const index = bucket.findIndex((entry) => entry.id === inputId);
  if (index < 0) return null;
  const updated = transform(bucket[index]!);
  bucket[index] = updated;
  store.inputs.set(sessionId, bucket);
  refreshPendingInputCount(store, sessionId);
  touchSharedSession(store, sessionId);
  return updated;
}

/** The outcome of one checked move: the moved row, or the unchanged row and why it did not move. */
export type SessionInputMove =
  | { readonly ok: true; readonly input: SharedSessionInputRecord; readonly from: SharedSessionInputState }
  | { readonly ok: false; readonly input: SharedSessionInputRecord; readonly reason: string; readonly allowed: readonly SharedSessionInputState[] };

/**
 * Move one input to `to` only when its lifecycle allows it; a refused move
 * leaves the row exactly as it was and says why. Null when the input is unknown.
 */
export function moveSharedSessionInput(
  store: SharedSessionInputStore,
  sessionId: string,
  inputId: string,
  to: SharedSessionInputState,
  patch: Partial<Pick<SharedSessionInputRecord, 'activeAgentId' | 'error'>> = {},
): SessionInputMove | null {
  const current = store.inputs.get(sessionId)?.find((entry) => entry.id === inputId);
  if (!current) return null;
  const check = sharedSessionInputLifecycle.check(current.state, to);
  if (!check.ok) return { ok: false, input: current, reason: check.reason, allowed: check.allowed };
  const moved = updateSharedSessionInput(store, sessionId, inputId, (entry) => ({ ...entry, ...patch, state: to, updatedAt: Date.now() }))!;
  return { ok: true, input: moved, from: current.state };
}

/**
 * The hot-path form of a checked move: a refused move is logged and the row is
 * returned exactly as it was, so a writer that raced another outcome never
 * throws and never rewrites a final state.
 */
export function moveSharedSessionInputOrKeep(
  store: SharedSessionInputStore,
  sessionId: string,
  inputId: string,
  to: SharedSessionInputState,
  patch: Partial<Pick<SharedSessionInputRecord, 'activeAgentId' | 'error'>> = {},
): SharedSessionInputRecord | null {
  const moved = moveSharedSessionInput(store, sessionId, inputId, to, patch);
  if (!moved) return null;
  if (!moved.ok) logger.warn('A session input kept its state', { sessionId, inputId, reason: moved.reason });
  return moved.input;
}

/**
 * Cancel every queued input a deliberate session close leaves behind, so a
 * closed session does not count as busy and nothing later starts work for it.
 * Delegated rows are left to the host flow that owns their source.
 */
export function cancelQueuedSessionInputs(
  store: SharedSessionInputStore,
  sessionId: string,
  reason: string,
): SharedSessionInputRecord[] {
  const queued = (store.inputs.get(sessionId) ?? []).filter((entry) => entry.state === 'queued' && !isDelegatedSessionInput(entry));
  const cancelled: SharedSessionInputRecord[] = [];
  for (const entry of queued) {
    const moved = moveSharedSessionInput(store, sessionId, entry.id, 'cancelled', { error: reason });
    if (moved?.ok) cancelled.push(moved.input);
  }
  return cancelled;
}

/**
 * Fail the queued inputs no surface is left to collect. A steer or follow-up
 * is queued for a surface only while one other than its sender is heartbeating;
 * once none has been seen within the same freshness window that routed it, the
 * row would stay queued and keep the daemon busy. A row younger than the
 * window is still within the time its surface was promised, so it stays
 * (a surface that deliberately detaches passes `minAgeMs: 0`).
 * Sessions an agent is answering, closed sessions, daemon-run sessions, hosted
 * sessions and delegated rows belong to other owners and are left alone.
 */
export function retireAbandonedSurfaceInputs(
  store: SharedSessionInputStore,
  now: number,
  options: { readonly freshnessMs?: number | undefined; readonly minAgeMs?: number | undefined; readonly sessionId?: string | undefined } = {},
): SharedSessionInputRecord[] {
  const freshnessMs = options.freshnessMs ?? SURFACE_ROUTE_FRESHNESS_MS;
  const minAgeMs = options.minAgeMs ?? freshnessMs;
  const retired: SharedSessionInputRecord[] = [];
  for (const [sessionId, bucket] of store.inputs.entries()) {
    if (options.sessionId !== undefined && options.sessionId !== sessionId) continue;
    const session = store.sessions.get(sessionId);
    // A hosted session's inputs belong to the hosted engine, which fails its own when a session ends.
    if (!session || session.status !== 'active' || session.activeAgentId || !isSurfaceManagedSession(session) || session.kind === 'hosted') continue;
    for (const entry of bucket.filter((candidate) => candidate.state === 'queued' && !isDelegatedSessionInput(candidate))) {
      if (entry.intent !== 'steer' && entry.intent !== 'follow-up') continue;
      if (now - entry.createdAt < minAgeMs) continue;
      if (hasFreshSurfaceParticipant(session, now, freshnessMs, { surfaceId: entry.surfaceId })) continue;
      const moved = moveSharedSessionInput(store, sessionId, entry.id, 'failed', {
        error: 'No surface collected this input: every surface that was attached to the session has stopped heartbeating. Send it again once a surface is connected.',
      });
      if (moved?.ok) retired.push(moved.input);
    }
  }
  return retired;
}

/**
 * Claim the input an agent was started for. With `inputId` exactly that row is
 * claimed, and only while it is still queued, so a leftover older row is never
 * answered (or its reply routed) in place of the one this agent is for. Without
 * an id the oldest queued row is claimed, the behaviour callers that do not
 * know their input still rely on.
 */
export function claimNextQueuedSessionInput(
  store: SharedSessionInputStore,
  sessionId: string,
  agentId: string,
  inputId?: string,
): SharedSessionInputRecord | null {
  const bucket = store.inputs.get(sessionId) ?? [];
  const next = inputId === undefined
    ? bucket.find((entry) => entry.state === 'queued' && !isDelegatedSessionInput(entry))
    : bucket.find((entry) => entry.id === inputId && entry.state === 'queued' && !isDelegatedSessionInput(entry));
  if (!next) return null;
  const result = moveSharedSessionInputOrKeep(store, sessionId, next.id, 'spawned', { activeAgentId: agentId });
  touchSharedSession(store, sessionId);
  return result;
}

/**
 * Collection read for a live surface: filter a session's inputs by state and/or a
 * `since` cursor (createdAt, exclusive), oldest-first, capped to `limit`. With
 * `state: 'queued'` + the last-seen cursor this yields exactly the PENDING inputs
 * a surface has not collected yet (see SharedSessionBroker.getInputsSince).
 */
export function filterSessionInputsSince(
  bucket: readonly SharedSessionInputRecord[],
  options: { readonly state?: SharedSessionInputRecord['state'] | undefined; readonly since?: number | undefined; readonly limit?: number | undefined },
): SharedSessionInputRecord[] {
  const filtered = bucket.filter((entry) => {
    // Polling a persisted marker must never recover process-local authority.
    if (isDelegatedSessionInput(entry)) return false;
    if (options.state !== undefined && entry.state !== options.state) return false;
    if (options.since !== undefined && entry.createdAt <= options.since) return false;
    return true;
  });
  return filtered.slice(-Math.max(1, options.limit ?? 100));
}

/**
 * How long an input a surface claimed stays that surface's before another may
 * take it: the time a surface has to start the work and name its agent. Past
 * it the claimant is presumed gone, and the message must not wait forever.
 */
export const SURFACE_CLAIM_LEASE_MS = 2 * 60_000;

/** Thrown by a claim on an input another surface holds or that has ended; nothing was changed. */
export class InputNotClaimableError extends Error {
  readonly code = 'INPUT_NOT_CLAIMABLE';
  constructor(readonly state: string) {
    super(`Cannot claim input: it is ${state}, so another surface already holds it or it has ended. Leave it to that surface; nothing was changed.`);
  }
}

/**
 * A claim is granted to one caller: a queued input, or a delivered one no
 * agent was named for within the lease. Checked where the row moves, with no
 * await between, so two surfaces racing for one input cannot both pass.
 */
export function assertSurfaceInputClaimable(store: SharedSessionInputStore, sessionId: string, inputId: string, now: number): void {
  const current = store.inputs.get(sessionId)?.find((entry) => entry.id === inputId);
  if (!current) return;
  const unbound = !current.activeAgentId;
  if (current.state === 'queued' || (current.state === 'delivered' && unbound && now - current.updatedAt >= SURFACE_CLAIM_LEASE_MS)) return;
  throw new InputNotClaimableError(current.state);
}

/** A surface's delivery report, and whether it was applied to the row. */
export interface SurfaceInputDeliveryOutcome {
  readonly input: SharedSessionInputRecord;
  /** True when the row was queued/delivered and the report advanced or re-confirmed it. */
  readonly applied: boolean;
}

/**
 * Surface delivery marking: advance a queued/delivered input as a live surface
 * collects it (`consumed:false` → 'delivered') or finishes acting on it
 * (`consumed:true` → 'completed'). A repeat report on a delivered row is
 * applied again (re-announcing is idempotent). Any other row is returned
 * unchanged and not applied. Returns null when the input is unknown.
 *
 * One recovery is allowed past a final state: a daemon restart cancels
 * `delivered` rows because it cannot know whether their answerer survived. A
 * surface in another process may have, and its `consumed:true` report is the
 * proof, so that row completes instead of reading "cancelled" after it was answered.
 */
export function markSurfaceInputDelivered(
  store: SharedSessionInputStore,
  sessionId: string,
  inputId: string,
  consumed: boolean,
): SurfaceInputDeliveryOutcome | null {
  const current = store.inputs.get(sessionId)?.find((entry) => entry.id === inputId);
  if (!current || isDelegatedSessionInput(current)) return null;
  if (consumed && current.state === 'cancelled' && current.error === BOOT_RECONCILE_CANCEL_REASON) {
    const revived = updateSharedSessionInput(store, sessionId, inputId, (entry) => {
      const { error: _restartReason, ...rest } = entry;
      return { ...rest, state: 'completed', updatedAt: Date.now() };
    })!;
    return { input: revived, applied: true };
  }
  if (!consumed && current.state === 'delivered') return { input: current, applied: true };
  const moved = moveSharedSessionInput(store, sessionId, inputId, consumed ? 'completed' : 'delivered');
  if (!moved) return null;
  return { input: moved.input, applied: moved.ok };
}

/**
 * Apply a live surface's report about a queued input: it collected the input
 * (`consumed:false`), or finished acting on it (`consumed:true`), and, when it
 * names one, the agent that is answering it.
 *
 * The agent pairing is the half that routes an answer home. The daemon's own
 * spawn takes `bindAgent`, which claims whatever input is NEXT in the queue for
 * the agent it just started; a surface has already named the exact input, so
 * this stamps that one, makes the agent the session's active agent, and
 * announces the reply binding. The announcement is the whole point: without it
 * a message that arrived over a channel and was dispatched to a surface was
 * answered into nothing. Idempotent, a repeated report re-announces, and the
 * binder is required to be idempotent for exactly that reason.
 */
export function applySurfaceInputDelivery(
  store: SharedSessionInputStore,
  sessionId: string,
  inputId: string,
  options: { readonly consumed?: boolean | undefined; readonly agentId?: string | undefined; readonly claim?: boolean | undefined },
  hooks: {
    readonly publish: (event: string, payload: unknown) => void;
    readonly publishInput: (event: string, input: SharedSessionInputRecord, extra: Record<string, unknown>) => void;
    readonly announce: (binding: SharedSessionSurfaceReplyBinding) => void;
  },
): SharedSessionInputRecord | null {
  const consumed = options.consumed === true;
  const outcome = markSurfaceInputDelivered(store, sessionId, inputId, consumed);
  if (!outcome) return null;
  // A report on a row that already ended (cancelled, answered by a daemon
  // agent, failed) changes nothing: no agent binding, no reply announcement,
  // no lifecycle event, so nothing is routed or shown for a move that did not happen.
  if (!outcome.applied) return outcome.input;
  // A claim restarts the clock of an input that was already delivered with no
  // agent, so the next claimant waits out the lease again instead of taking it too.
  const updated = options.claim && !consumed
    ? updateSharedSessionInput(store, sessionId, inputId, (entry) => ({ ...entry, updatedAt: Date.now() })) ?? outcome.input
    : outcome.input;
  const agentId = options.agentId?.trim();
  let record = updated;
  if (agentId) {
    const session = store.sessions.get(sessionId);
    if (session) {
      const rebound = bindSharedSessionAgent(session, agentId);
      store.sessions.set(sessionId, rebound);
      hooks.publish('session-agent-bound', rebound);
    }
    record = updateSharedSessionInput(store, sessionId, inputId, (entry) => ({
      ...entry, activeAgentId: agentId, updatedAt: Date.now(),
    })) ?? updated;
    hooks.announce({
      sessionId,
      agentId,
      ...(record.routeId ? { routeId: record.routeId } : {}),
      ...(record.surfaceKind ? { surfaceKind: record.surfaceKind } : {}),
      task: record.body,
      reason: 'continuation-runner',
    });
  }
  refreshPendingInputCount(store, sessionId);
  hooks.publishInput(consumed ? 'session-input-completed' : 'session-input-delivered', record, agentId ? { agentId } : {});
  return record;
}

export function finalizeAgentSessionInputs(
  store: SharedSessionInputStore,
  sessionId: string,
  agentId: string,
  nextState: Extract<SharedSessionInputRecord['state'], 'completed' | 'failed' | 'cancelled'>,
  error?: string,
): SharedSessionInputRecord[] {
  const bucket = store.inputs.get(sessionId);
  if (!bucket) return [];
  touchSharedSession(store, sessionId);
  const updatedInputs: SharedSessionInputRecord[] = [];
  const owned = bucket.filter((entry) => !isDelegatedSessionInput(entry)
    && entry.activeAgentId === agentId && (entry.state === 'delivered' || entry.state === 'spawned'));
  for (const entry of owned) {
    const moved = moveSharedSessionInput(store, sessionId, entry.id, nextState, error ? { error } : {});
    if (moved?.ok) updatedInputs.push(moved.input);
    else if (moved) logger.warn('A session input kept its state', { sessionId, inputId: entry.id, reason: moved.reason });
  }
  return updatedInputs;
}
