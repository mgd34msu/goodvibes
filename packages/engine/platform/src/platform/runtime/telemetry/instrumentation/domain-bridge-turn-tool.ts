import type { ToolEvent } from '../../../../events/tools.js';
import type { TurnEvent } from '../../../../events/turn.js';
import { endToolSpan, recordToolPhase, startToolSpan, type ToolPhase } from '../spans/tool.js';
import { endTurnSpan, startTurnSpan } from '../spans/turn.js';
import { endLlmSpan, startLlmSpan } from '../spans/llm.js';
import { trackSpan, type DomainBridgeAttachmentInput, type Env, type SpanMap } from './domain-bridge-shared.js';

/** Turn spans are the roots: TURN_SUBMITTED opens one, the turn's terminal event closes it. */
export function attachTurnDomain(
  { bus, helpers }: DomainBridgeAttachmentInput,
  turnSpans: SpanMap,
): () => void {
  const unsubs: Array<() => void> = [];

  unsubs.push(
    bus.on('TURN_SUBMITTED', (env: Env<Extract<TurnEvent, { type: 'TURN_SUBMITTED' }>>) => {
      helpers.safe(() => {
        const span = startTurnSpan(helpers.tracer, {
          turnId: env.payload.turnId,
          traceId: env.traceId ?? '',
          sessionId: env.sessionId ?? '',
          prompt: env.payload.prompt,
        });
        trackSpan(turnSpans, env.payload.turnId, span);
      });
    }),
  );

  unsubs.push(
    bus.on('TURN_COMPLETED', (env: Env<Extract<TurnEvent, { type: 'TURN_COMPLETED' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(turnSpans, env.payload.turnId, (span) => endTurnSpan(span, { outcome: 'completed' }));
      });
    }),
  );

  unsubs.push(
    bus.on('TURN_ERROR', (env: Env<Extract<TurnEvent, { type: 'TURN_ERROR' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(turnSpans, env.payload.turnId, (span) => endTurnSpan(span, { outcome: 'error', error: env.payload.error }));
      });
    }),
  );

  unsubs.push(
    bus.on('TURN_CANCEL', (env: Env<Extract<TurnEvent, { type: 'TURN_CANCEL' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(turnSpans, env.payload.turnId, (span) => endTurnSpan(span, { outcome: 'cancelled', cancelReason: env.payload.reason }));
      });
    }),
  );

  return () => unsubs.forEach((unsub) => unsub());
}

/**
 * A turn's model requests are children of its span: LLM_REQUEST_STARTED opens
 * one (a turn has at most one request in flight), LLM_RESPONSE_RECEIVED closes
 * it with the token counts, and a turn that ends first closes it as failed.
 */
export function attachModelRequestDomain(
  { bus, helpers }: DomainBridgeAttachmentInput,
  requestSpans: SpanMap,
  turnSpans: SpanMap,
): () => void {
  const unsubs: Array<() => void> = [];

  unsubs.push(
    bus.on('LLM_REQUEST_STARTED', (env: Env<Extract<TurnEvent, { type: 'LLM_REQUEST_STARTED' }>>) => {
      helpers.safe(() => {
        const parent = turnSpans.get(env.payload.turnId);
        const span = startLlmSpan(helpers.tracer, {
          turnId: env.payload.turnId,
          provider: env.payload.provider,
          model: env.payload.model,
          traceId: parent?.spanContext.traceId ?? env.traceId ?? '',
          parentSpanId: parent?.spanContext.spanId,
          streaming: true,
        });
        trackSpan(requestSpans, env.payload.turnId, span);
      });
    }),
  );

  unsubs.push(
    bus.on('LLM_RESPONSE_RECEIVED', (env: Env<Extract<TurnEvent, { type: 'LLM_RESPONSE_RECEIVED' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(requestSpans, env.payload.turnId, (span) => endLlmSpan(span, {
          success: true,
          tokens: {
            inputTokens: env.payload.inputTokens,
            outputTokens: env.payload.outputTokens,
            cacheReadTokens: env.payload.cacheReadTokens,
            cacheWriteTokens: env.payload.cacheWriteTokens,
          },
        }));
      });
    }),
  );

  const unfinished = (turnId: string, error: string) => helpers.safe(() => {
    helpers.closeSpan(requestSpans, turnId, (span) => endLlmSpan(span, { success: false, error }));
  });
  unsubs.push(bus.on('TURN_ERROR', (env: Env<Extract<TurnEvent, { type: 'TURN_ERROR' }>>) => unfinished(env.payload.turnId, env.payload.error)));
  unsubs.push(bus.on('TURN_CANCEL', (env: Env<Extract<TurnEvent, { type: 'TURN_CANCEL' }>>) => unfinished(env.payload.turnId, 'cancelled')));
  unsubs.push(bus.on('TURN_COMPLETED', (env: Env<Extract<TurnEvent, { type: 'TURN_COMPLETED' }>>) => unfinished(env.payload.turnId, 'the turn ended before a response was recorded')));

  return () => unsubs.forEach((unsub) => unsub());
}

/**
 * Tool spans are children of their turn's span when it is open, so a trace
 * shows each call under the turn that made it.
 */
export function attachToolDomain(
  { bus, helpers }: DomainBridgeAttachmentInput,
  toolSpans: SpanMap,
  turnSpans: SpanMap,
): () => void {
  const unsubs: Array<() => void> = [];

  unsubs.push(
    bus.on('TOOL_RECEIVED', (env: Env<Extract<ToolEvent, { type: 'TOOL_RECEIVED' }>>) => {
      helpers.safe(() => {
        const parent = turnSpans.get(env.payload.turnId);
        const span = startToolSpan(helpers.tracer, {
          callId: env.payload.callId,
          turnId: env.payload.turnId,
          tool: env.payload.tool,
          traceId: parent?.spanContext.traceId ?? env.traceId ?? '',
          parentSpanId: parent?.spanContext.spanId,
        });
        trackSpan(toolSpans, env.payload.callId, span);
      });
    }),
  );

  const phase = (type: 'TOOL_VALIDATED' | 'TOOL_PREHOOKED' | 'TOOL_EXECUTING' | 'TOOL_MAPPED' | 'TOOL_POSTHOOKED', name: ToolPhase) => {
    unsubs.push(
      bus.on(type, (env: Env<Extract<ToolEvent, { type: typeof type }>>) => {
        helpers.safe(() => {
          helpers.withSpan(toolSpans, env.payload.callId, (span) => recordToolPhase(span, name));
        });
      }),
    );
  };
  phase('TOOL_VALIDATED', 'validated');
  phase('TOOL_PREHOOKED', 'prehooked');
  phase('TOOL_EXECUTING', 'executing');
  phase('TOOL_MAPPED', 'mapped');
  phase('TOOL_POSTHOOKED', 'posthooked');

  unsubs.push(
    bus.on('TOOL_PERMISSIONED', (env: Env<Extract<ToolEvent, { type: 'TOOL_PERMISSIONED' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(toolSpans, env.payload.callId, (span) => recordToolPhase(span, 'permissioned', { 'tool.approved': env.payload.approved }));
      });
    }),
  );

  unsubs.push(
    bus.on('TOOL_SUCCEEDED', (env: Env<Extract<ToolEvent, { type: 'TOOL_SUCCEEDED' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(toolSpans, env.payload.callId, (span) => endToolSpan(span, { outcome: 'succeeded', durationMs: env.payload.durationMs }));
      });
    }),
  );

  unsubs.push(
    bus.on('TOOL_FAILED', (env: Env<Extract<ToolEvent, { type: 'TOOL_FAILED' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(toolSpans, env.payload.callId, (span) => endToolSpan(span, { outcome: 'failed', durationMs: env.payload.durationMs, error: env.payload.error }));
      });
    }),
  );

  unsubs.push(
    bus.on('TOOL_CANCELLED', (env: Env<Extract<ToolEvent, { type: 'TOOL_CANCELLED' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(toolSpans, env.payload.callId, (span) => endToolSpan(span, { outcome: 'cancelled', durationMs: 0, cancelReason: env.payload.reason }));
      });
    }),
  );

  return () => unsubs.forEach((unsub) => unsub());
}
