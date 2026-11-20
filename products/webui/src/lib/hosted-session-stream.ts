/**
 * hosted-session-stream.ts, reading the `turn` and `tools` raw event-domain
 * frames that carry a hosted session's LIVE output.
 *
 * There is no token-stream verb for a hosted session and no separate wire
 * shape either (method-catalog-hosted-sessions.ts's header comment): the
 * hosted loop is the ordinary Orchestrator, so it emits the exact same
 * STREAM_DELTA / TURN_COMPLETED / TOOL_EXECUTING / ... envelopes a local
 * session does, on the control-plane's `turn` and `tools` domains, stamped
 * with the hosted session's id as `sessionId`. A client attached to a hosted
 * session watches exactly what it watches locally and filters on the id
 * `sessions.hosted.attach` handed it (gateway.ts's serializeEnvelope:
 * `{ type, ts, traceId, sessionId, source, payload }`).
 *
 * This module reads that envelope shape defensively, the same "never trust
 * the wire to be exactly what was asked for" stance sessions-union.ts and
 * approvals.ts document, so an event this client has never seen degrades to
 * being ignored rather than crashing the attached view.
 */
import { isTurnSettlingEvent, readTurnSettlement, settlesRunningTurn } from '@goodvibes-jev/engine/transport-core/turn-settlement';
import { asRecord, firstString } from './object';

/** One decoded `turn`/`tools` domain frame, narrowed to what a hosted-session
 * viewer reads. `type` is the runtime event's own discriminant (STREAM_DELTA,
 * TURN_COMPLETED, TOOL_EXECUTING, ...), read from the envelope's top-level
 * `type` field, matching gateway-utils.ts's serializeEnvelope exactly. */
export interface HostedStreamFrame {
  readonly type: string;
  readonly sessionId: string;
  readonly payload: Record<string, unknown>;
}

/** Decode a raw envelope payload (the SSE frame's `data:` JSON) into a
 * HostedStreamFrame, or null when it does not carry a sessionId at all, a
 * frame this client cannot attribute to any session is never rendered. */
export function readHostedStreamFrame(raw: unknown): HostedStreamFrame | null {
  const record = asRecord(raw);
  const sessionId = firstString(record, ['sessionId']);
  if (!sessionId) return null;
  return {
    type: firstString(record, ['type']),
    sessionId,
    payload: asRecord(record.payload),
  };
}

/** One completed message this view renders after `history`, either the
 * final text of a completed turn, or a system-rendered note about how the
 * turn ended (error/cancelled), matching HostedSessionHistoryMessage's shape
 * so it can be appended to the same rendered list. */
export interface HostedLiveMessage {
  readonly role: 'assistant' | 'system';
  readonly content: string;
  readonly at: number;
}

/** One tool call currently in flight for the attached hosted session's turn. */
export interface HostedActiveToolCall {
  readonly callId: string;
  readonly turnId: string;
  readonly tool: string;
  readonly state: 'executing' | 'succeeded' | 'failed';
  readonly error?: string;
}

/** STREAM_DELTA's running text so far this turn (`payload.accumulated`), '' after
 * DRAFT_WITHDRAWN (the completion check sent the streamed draft back and the
 * replacement streams from empty), or null for any other frame. */
export function streamDeltaAccumulated(frame: HostedStreamFrame): string | null {
  if (frame.type === 'DRAFT_WITHDRAWN') return '';
  if (frame.type !== 'STREAM_DELTA') return null;
  const value = frame.payload.accumulated;
  return typeof value === 'string' ? value : '';
}

/** A settled turn rendered as one appended message (the model's answer, or a
 * system line saying how the turn ended), or null when the frame does not end a
 * turn. Read through the one settlement reader every surface uses, so an empty
 * answer is a system line, never a blank assistant bubble. */
export function hostedLiveMessageFromTurnFrame(frame: HostedStreamFrame, now: () => number = Date.now): HostedLiveMessage | null {
  const settlement = readTurnSettlement(frame);
  if (!settlement) return null;
  switch (settlement.kind) {
    case 'answered':
      return { role: 'assistant', content: settlement.response, at: now() };
    case 'empty':
      return { role: 'system', content: 'The model returned no answer. Send the message again or choose another model.', at: now() };
    case 'failed':
      return { role: 'system', content: `Turn failed: ${settlement.error}`, at: now() };
    case 'cancelled':
      return { role: 'system', content: 'Turn cancelled.', at: now() };
    case 'refused':
      // A duplicate submission refused while a turn runs (`preflight_failed`) is not this view's
      // turn ending: the running turn's text and tool calls stay.
      if (!settlesRunningTurn(settlement)) return null;
      return {
        role: 'system',
        content: `Turn could not start: ${settlement.reason.replace(/\.+\s*$/u, '')}. Compact the conversation or start a new session.`,
        at: now(),
      };
  }
}

/** The id of the turn a frame shows running (any turn or tool frame stamped with a
 * turnId, except the settling ones, which include a PREFLIGHT_FAIL that can name a
 * rejected duplicate under a fresh id), or null. What a Stop sends as its expected turn. */
export function liveTurnIdFromFrame(frame: HostedStreamFrame): string | null {
  if (isTurnSettlingEvent(frame.type)) return null;
  const turnId = firstString(frame.payload, ['turnId']);
  return turnId || null;
}

/** The turn a terminal frame ended ('' when the frame names none), or null for any other frame. */
export function endedTurnIdFromFrame(frame: HostedStreamFrame): string | null {
  return isTerminalTurnFrame(frame) ? firstString(frame.payload, ['turnId']) : null;
}

/** True for a frame that means the running turn is no longer in flight, the local
 * "streaming" indicator drops and any live-text buffer clears. A duplicate submission
 * refused while a turn runs (`preflight_failed` under a fresh id) is not one. */
export function isTerminalTurnFrame(frame: HostedStreamFrame): boolean {
  const settlement = readTurnSettlement(frame);
  return settlement !== null && settlesRunningTurn(settlement);
}

/** Read a `tools` domain frame into an active-call transition, or null for a
 * tool lifecycle stage this view does not render (TOOL_RECEIVED/VALIDATED/...). */
export function hostedToolCallFromFrame(frame: HostedStreamFrame): HostedActiveToolCall | null {
  const callId = firstString(frame.payload, ['callId']);
  const turnId = firstString(frame.payload, ['turnId']);
  const tool = firstString(frame.payload, ['tool']);
  if (!callId || !tool) return null;
  switch (frame.type) {
    case 'TOOL_EXECUTING':
      return { callId, turnId, tool, state: 'executing' };
    case 'TOOL_SUCCEEDED':
      return { callId, turnId, tool, state: 'succeeded' };
    case 'TOOL_FAILED': {
      const error = frame.payload.error;
      return { callId, turnId, tool, state: 'failed', error: typeof error === 'string' ? error : undefined };
    }
    default:
      return null;
  }
}
