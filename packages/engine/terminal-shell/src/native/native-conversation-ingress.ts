import type { Orchestrator, OrchestratorUserInputOptions } from '@goodvibes/engine/platform/platform/core';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import type { NativeConversationInput } from './native-conversation-input.js';
import {
  nativeConversationIntakeAccepted,
  nativeConversationIntakeLines,
  nativeIntakeFailureCause,
  type NativeConversationIntakeActions,
  type NativeConversationIntakeState,
} from './native-conversation-intake.js';

/** Thrown only when the turn is known never to have started, so its dispatch claim may be given back. */
export class NativeTurnNotStartedError extends Error {
  constructor(options?: ErrorOptions) {
    super('The native turn did not start.', options);
    this.name = 'NativeTurnNotStartedError';
  }
}

const CLAIM_RELEASED_MESSAGE = 'The native turn did not start and its dispatch claim was released. Use /work intake-retry to run it, or submit a new input.';

/**
 * For a dispatch that failed: when the turn is known never to have started, gives its
 * claim back and returns what to tell the user. Undefined means the claim stays.
 */
export async function releaseUnstartedNativeTurn(state: NativeConversationIntakeState, error: unknown): Promise<string | undefined> {
  if (!(error instanceof NativeTurnNotStartedError)) return undefined;
  return (await state.releaseTurnClaim?.()) === true ? CLAIM_RELEASED_MESSAGE : undefined;
}

/**
 * What a product tells the user after its native dispatch failed: the released-claim
 * message when the turn never started, otherwise the product's own recovery text.
 */
export async function describeFailedNativeDispatch(state: NativeConversationIntakeState, error: unknown, keptClaimMessage: string): Promise<string> {
  return (await releaseUnstartedNativeTurn(state, error)) ?? keptClaimMessage;
}

/**
 * True when the host could not take the input and nothing was saved or sent for it: no host is
 * selected or reachable, or this terminal is not paired with it. A product that runs turns itself
 * may run this one in its own process. A local journal failure is not this: it is reported as is.
 */
export function nativeIntakeUnreachable(state: NativeConversationIntakeState | undefined): boolean {
  return state?.status === 'unavailable' && state.request === undefined && state.notSent === undefined
    && state.cause !== 'journal' && state.cause !== 'journal_conflict';
}

/** Only a fresh durable dispatch claim can enter the ordinary turn loop. */
export async function routeNativeConversationInput(deps: {
  readonly intake: NativeConversationIntakeActions | undefined;
  readonly source: NativeConversationInput;
  /** Lines the person must see (a refusal, a step to take). */
  readonly notify: (message: string) => void;
  /**
   * Bookkeeping of an accepted turn (identifiers, the recorded decision): the activity feed.
   * Without it those lines go to `notify` too.
   */
  readonly record?: ((message: string) => void) | undefined;
  readonly dispatch: (state: NativeConversationIntakeState) => Promise<void>;
  /**
   * Run the turn in this process when the intake cannot be reached and nothing was sent for it.
   * `reason` is the one line that says why; the caller shows it (once while it stays the same).
   * Without it such an input is refused and the text handed back.
   */
  readonly runLocal?: ((reason: string) => Promise<void>) | undefined;
  readonly preparationFailureMessage?: string | undefined;
}): Promise<NativeConversationIntakeState | undefined> {
  if (!deps.intake) {
    const state = { status: 'unavailable' as const, message: 'Native conversation intake is unavailable. No ordinary turn was started.' };
    if (deps.runLocal) {
      await deps.runLocal('No connected host is set up for this terminal, so messages run in this process.');
      return { status: 'recorded', message: 'Ran in this process.' };
    }
    deps.notify(state.message);
    return state;
  }
  let state: NativeConversationIntakeState | undefined;
  try {
    state = await deps.intake.submit(deps.source);
  } catch (error) {
    logger.warn('native intake: submit failed', { error: summarizeError(error) });
    const failed = {
      status: 'unknown' as const,
      cause: nativeIntakeFailureCause(error),
      message: deps.preparationFailureMessage ?? 'Prompt preparation failed. Use /work intake-status to inspect the original input.',
    };
    deps.notify(failed.message);
    return failed;
  }
  if (deps.runLocal && nativeIntakeUnreachable(state)) {
    await deps.runLocal(`${state!.message} Until the host can take them, messages run in this process.`);
    return { status: 'recorded', message: 'Ran in this process.' };
  }
  const quiet = deps.record !== undefined && nativeConversationIntakeAccepted(state);
  for (const line of nativeConversationIntakeLines(state)) (quiet ? deps.record! : deps.notify)(line);
  if (isNativeConversationTurnReady(state)) {
    try {
      await deps.dispatch(state);
      // The turn ran to its end: its intake record has nothing left to fence.
      await state.finishTurn?.();
    } catch (error) {
      logger.warn('native intake: turn dispatch failed', { error: summarizeError(error) });
      const cause = nativeIntakeFailureCause(error);
      const message = await releaseUnstartedNativeTurn(state, error);
      if (message !== undefined) {
        deps.notify(message);
        return { ...state, status: 'unknown', cause, turnReady: false, message };
      }
      const kept = 'Native turn dispatch requires recovery. Its durable claim was preserved; the turn may not have started and will not be replayed automatically.';
      deps.notify(kept);
      return { ...state, status: 'unknown', cause, turnReady: false, message: kept };
    }
  }
  return state;
}

/** A permit carries host provenance; derived text and attachments never replace its source. */
export async function dispatchNativeConversationTurn(
  state: NativeConversationIntakeState,
  orchestrator: Pick<Orchestrator, 'bindNativeConversationProject' | 'handleUserInput'>,
  options?: OrchestratorUserInputOptions,
): Promise<void> {
  if (!isNativeConversationTurnReady(state)) return;
  try {
    orchestrator.bindNativeConversationProject(state.result.projectId);
  } catch (error) {
    throw new NativeTurnNotStartedError({ cause: error });
  }
  await orchestrator.handleUserInput(state.result.text, undefined, nativeConversationTurnInputOptions(state, options));
}

export type ReadyNativeConversationTurn = NativeConversationIntakeState & {
  readonly turnReady: true;
  readonly turnPermit: NonNullable<NativeConversationIntakeState['turnPermit']>;
  readonly result: Extract<NonNullable<NativeConversationIntakeState['result']>, { readonly kind: 'turn' }>;
};
/** A renderer or input route cannot turn an unclaimed or non-turn receipt into dispatchable input. */
export function isNativeConversationTurnReady(state: NativeConversationIntakeState | undefined): state is ReadyNativeConversationTurn {
  return state?.turnReady === true && Boolean(state.turnPermit) && state.result?.kind === 'turn';
}
export function nativeConversationTurnInputOptions(
  state: ReadyNativeConversationTurn,
  options?: OrchestratorUserInputOptions,
): OrchestratorUserInputOptions {
  return { ...options, nativeConversationTurnPermit: state.turnPermit };
}
