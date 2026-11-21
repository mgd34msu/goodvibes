/**
 * Session emitters, typed emission wrappers for SessionEvent domain.
 *
 * Import and call these instead of emitting raw strings.
 */
import { createEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { SessionEvent } from '../../../events/session.js';
import type { EmitterContext } from './index.js';
import type { DomainDispatch } from '../store/index.js';
import { sessionRecoveryPatch } from '../store/domains/session.js';

/**
 * Creates a typed session event envelope, reducing boilerplate across the
 * 7 public wrapper functions below.
 */
function sessionEvent<T extends SessionEvent['type']>(
  type: T,
  data: Omit<Extract<SessionEvent, { type: T }>, 'type'>,
  ctx: EmitterContext,
): RuntimeEventEnvelope<T, Extract<SessionEvent, { type: T }>> {
  return createEventEnvelope(type, { type, ...data } as Extract<SessionEvent, { type: T }>, ctx);
}

// ---------------------------------------------------------------------------
// Public typed emitter wrappers
// ---------------------------------------------------------------------------

/** Emit SESSION_STARTED when a new session is created and initialising. */
export function emitSessionStarted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; profileId: string; workingDir: string }
): void {
  bus.emit('session', sessionEvent('SESSION_STARTED', data, ctx));
}

/** Emit QUEUED_MESSAGES_CHANGED when the pending mid-turn queue mutates. */
export function emitQueuedMessagesChanged(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; action: 'enqueued' | 'edited' | 'deleted' | 'delivered'; messageId: string; pendingCount: number }
): void {
  bus.emit('session', sessionEvent('QUEUED_MESSAGES_CHANGED', data, ctx));
}

/** Emit SESSION_RESUMED when a previously saved session is being resumed. */
export function emitSessionResumed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; turnCount: number }
): void {
  bus.emit('session', sessionEvent('SESSION_RESUMED', data, ctx));
}

/** Emit SESSION_READY when session is fully loaded and ready for input. */
export function emitSessionReady(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string }
): void {
  bus.emit('session', sessionEvent('SESSION_READY', data, ctx));
}

/** Emit SESSION_RECOVERY_FAILED when session recovery has failed unrecoverably. */
export function emitSessionRecoveryFailed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; error: string }
): void {
  bus.emit('session', sessionEvent('SESSION_RECOVERY_FAILED', data, ctx));
}

/**
 * Keep the store's session recovery machine (`recoveryState`, `recoveryError`,
 * `wasRepaired`, `isResumed`) in step with the session events on `bus`: the
 * events are the one owner, the store a view of them. Returns the unsubscribe.
 */
export function attachSessionRecoveryState(
  bus: Pick<RuntimeEventBus, 'onDomain'>,
  dispatch: Pick<DomainDispatch, 'syncSessionState'>,
): () => void {
  return bus.onDomain('session', ({ payload }) => {
    const patch = sessionRecoveryPatch(payload);
    if (patch) dispatch.syncSessionState(patch, `session.${payload.type.toLowerCase()}`);
  });
}
