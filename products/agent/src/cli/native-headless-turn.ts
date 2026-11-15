import { executeHeadlessTurn, type HeadlessTurnLimits } from '@goodvibes-jev/engine/terminal-shell/headless-command';
import type { BootstrapContext } from '../runtime/bootstrap.ts';
import type { NativeConversationIntakeState } from '../runtime/native-conversation-intake.ts';
import type { NativeHeadlessTurnResult } from './native-headless.ts';

export { headlessSessionSnapshot, settleHeadlessTurn } from '@goodvibes-jev/engine/terminal-shell/headless-command';

/** Every Agent headless prompt is admitted through native intake first; its exact permit enters the ordinary executor. */
export function executeAdmittedHeadlessTurn(
  ctx: BootstrapContext,
  state: NativeConversationIntakeState,
  signal: AbortSignal,
  format: string,
  limits: Omit<HeadlessTurnLimits, 'unsettledReason'> = {},
): Promise<NativeHeadlessTurnResult> {
  return executeHeadlessTurn(ctx, state, signal, format, { ...limits, unsettledReason: 'native-turn-unsettled' });
}
