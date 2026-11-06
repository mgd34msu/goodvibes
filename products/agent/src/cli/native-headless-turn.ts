import { observeHeadlessTurn } from '@goodvibes-jev/engine/terminal-shell/headless-turn-events';
import type { BootstrapContext } from '../runtime/bootstrap.ts';
import { dispatchNativeConversationTurn } from '../runtime/native-conversation-ingress.ts';
import type { NativeConversationIntakeState } from '../runtime/native-conversation-intake.ts';
import type { NativeHeadlessTurnResult } from './native-headless.ts';

/** Fresh native turn only. Its exact permit/source enters the existing ordinary executor. */
export async function executeAdmittedHeadlessTurn(
  ctx: BootstrapContext,
  state: NativeConversationIntakeState,
  signal: AbortSignal,
  format: string,
): Promise<NativeHeadlessTurnResult> {
  const observer = observeHeadlessTurn(ctx.runtimeBus, format, 'native-turn-unsettled');
  // This freshly bootstrapped executor belongs only to this invocation.
  const abort = () => ctx.orchestrator.abort();
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) return { exitCode: 130, response: '', stopReason: 'cancelled' };
    await dispatchNativeConversationTurn(state, ctx.orchestrator);
    return observer.result(signal, ctx.runtime);
  } finally {
    signal.removeEventListener('abort', abort);
    observer.dispose();
  }
}
