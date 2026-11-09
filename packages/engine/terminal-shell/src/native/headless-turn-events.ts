import type { RuntimeEventBus } from '@goodvibes-jev/engine/platform/platform/runtime/state';
import type { TurnEvent } from '@goodvibes-jev/engine/platform/events';
import type { NativeHeadlessTurnResult } from './native-headless.js';
/** One event observer shared by ordinary and permit-bound one-shot turns. */
export function observeHeadlessTurn(bus: Pick<RuntimeEventBus, 'on'>, format: string, initialStopReason: string) {
  const state = { response: '', error: '', stopReason: initialStopReason, exitCode: 3, events: 0 };
  const unsubs = [
    bus.on<Extract<TurnEvent, { type: 'STREAM_DELTA' }>>('STREAM_DELTA', ({ payload }) => {
      state.events++;
      if (format === 'stream-json')
        process.stdout.write(JSON.stringify({ type: payload.type, content: payload.content, accumulated: payload.accumulated }) + '\n');
    }),
    bus.on<Extract<TurnEvent, { type: 'TURN_COMPLETED' }>>('TURN_COMPLETED', ({ payload }) => {
      state.events++;
      state.response = payload.response;
      state.stopReason = payload.stopReason;
      state.exitCode = 0;
    }),
    bus.on<Extract<TurnEvent, { type: 'TURN_ERROR' }>>('TURN_ERROR', ({ payload }) => {
      state.events++;
      state.error = payload.error;
      state.stopReason = payload.stopReason;
      state.exitCode = 1;
    }),
    bus.on<Extract<TurnEvent, { type: 'TURN_CANCEL' }>>('TURN_CANCEL', ({ payload }) => {
      state.events++;
      state.error = payload.reason ?? 'cancelled';
      state.stopReason = payload.stopReason;
      state.exitCode = 130;
    }),
  ];
  return {
    state,
    dispose: () => {
      for (const unsubscribe of unsubs) unsubscribe();
    },
    result(
      signal: AbortSignal,
      runtime: { readonly sessionId: string; readonly model: string; readonly provider: string },
    ): NativeHeadlessTurnResult {
      if (signal.aborted) state.exitCode = 130;
      if (state.exitCode === 0 && !state.response.trim()) {
        state.exitCode = 1;
        state.stopReason = 'empty_response';
        state.error ||= 'The model returned no response.';
      }
      return { ...state, sessionId: runtime.sessionId, model: runtime.model, provider: runtime.provider };
    },
  };
}
