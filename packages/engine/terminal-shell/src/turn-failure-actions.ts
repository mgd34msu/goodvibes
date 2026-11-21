/**
 * The failure row of a turn in both terminal programs: its drawing is
 * registered with the transcript (transcript-row-renderers.ts) for TURN_ERROR
 * lines, and its keys act on the newest failure that no prompt followed:
 *
 *   alt+r  try again (the program's own retry of the failed turn)
 *   alt+o  use another model / choose a model: opens the model picker; the
 *          model chosen there answers the same prompt
 *   alt+i  details: the reading's details under the cause, and back
 *   alt+s  sign in again: the provider sign-ins (/auth)
 *
 * The reading itself is platform core/turn-failure.ts; this file keeps only
 * which row is live and what its keys do. No request, write or model call: a
 * key reads the conversation in memory.
 */
import {
  readTurnFailure,
  storedTurnFailure,
  TURN_FAILURE_EVENT,
  type ConversationMessageSnapshot,
  type TurnFailureAction,
  type TurnFailureReading,
} from '@goodvibes/engine/platform/platform/core';
import { registerTranscriptRowRenderer } from './transcript-row-renderers.js';
import { renderTurnFailureRow } from './renderer/turn-failure-row.js';

/** What the row reads of the conversation it is drawn in. */
export interface TurnFailureConversation {
  getMessageCount(): number;
  getMessageAt(index: number): Readonly<ConversationMessageSnapshot> | undefined;
  /** Drop the drawn rows so the next frame draws the row's new state. */
  clearLineCache(): void;
}

/** The keys a failure row answers. */
export type FailedTurnKeyAction = 'retry' | 'other-model' | 'details' | 'sign-in';

/** The row's state for the process: details opened, the retry the program offers. */
const rows = {
  details: new Set<string>(),
  retry: null as (() => void) | null,
  conversation: null as TurnFailureConversation | null,
};

function failureLineAt(conversation: TurnFailureConversation, index: number): Readonly<Extract<ConversationMessageSnapshot, { role: 'system' }>> | undefined {
  const message = conversation.getMessageAt(index);
  return message?.role === 'system' && message.runtimeEvent?.type === TURN_FAILURE_EVENT ? message : undefined;
}

/** The index of the newest failure line no prompt followed, or -1. */
function liveFailureIndex(conversation: TurnFailureConversation): number {
  for (let index = conversation.getMessageCount() - 1; index >= 0; index--) {
    const message = conversation.getMessageAt(index);
    if (message?.role === 'user') return -1;
    if (failureLineAt(conversation, index)) return index;
  }
  return -1;
}

/** A line's reading: the stored one, or, for a line written as text only, one read from its text. */
function readingOf(line: Readonly<Extract<ConversationMessageSnapshot, { role: 'system' }>>): TurnFailureReading {
  return storedTurnFailure(line.turnFailure) ?? readTurnFailure({ turnId: '', error: line.content, stopReason: 'unexpected_error' });
}

function detailsKey(reading: TurnFailureReading, index: number): string {
  return reading.turnId || `line:${index}`;
}

/**
 * Draw TURN_ERROR lines of `conversation` as failure rows. One conversation
 * per program (its main transcript); a line of another conversation drawn
 * with the same renderer is not found here and stays a plain notice.
 */
export function installTurnFailureRows(conversation: TurnFailureConversation, options: { readonly changesCommand: boolean }): () => void {
  rows.conversation = conversation;
  return registerTranscriptRowRenderer(TURN_FAILURE_EVENT, (input) => {
    const line = failureLineAt(conversation, input.messageIndex);
    if (!line || line.content !== input.content) return null;
    const reading = readingOf(line);
    return renderTurnFailureRow(reading, input.width, {
      keys: liveFailureIndex(conversation) === input.messageIndex,
      details: rows.details.has(detailsKey(reading, input.messageIndex)),
      changesCommand: options.changesCommand,
    });
  });
}

/** The live failure's reading, when there is one. */
function liveReading(): { readonly reading: TurnFailureReading; readonly index: number } | undefined {
  const conversation = rows.conversation;
  if (!conversation) return undefined;
  const index = liveFailureIndex(conversation);
  const line = index >= 0 ? failureLineAt(conversation, index) : undefined;
  return line ? { reading: readingOf(line), index } : undefined;
}

function offers(reading: TurnFailureReading, ...actions: TurnFailureAction[]): boolean {
  return reading.next.some((step) => actions.includes(step.action));
}

/**
 * The retry the program offers for its failed turn (the terminal app's Alt+R
 * path), so a model chosen with alt+o sends the prompt the same way. Called
 * with each key the program reads; cheap.
 */
export function offerFailedTurnRetry(retry: () => void): void {
  rows.retry = retry;
}

/** A prompt was sent: the older row's keys go (its rows are drawn again). */
export function noteTurnFailurePromptSent(): void {
  const conversation = rows.conversation;
  if (!conversation) return;
  // The prompt just added is last: a failure before it had live keys.
  for (let index = conversation.getMessageCount() - 2; index >= 0; index--) {
    const message = conversation.getMessageAt(index);
    if (message?.role === 'user') return;
    if (failureLineAt(conversation, index)) { conversation.clearLineCache(); return; }
  }
}

export interface FailedTurnActionDeps {
  /** Open the model picker; `onClosed` hears once whether that picker session applied a main-model selection. */
  readonly openModelPicker: (onClosed: (chosen: boolean) => void) => void;
  /** Where a provider is signed in again. */
  readonly openSignIn: () => void;
  /** The program's retry of the failed turn; absent: the one offered with offerFailedTurnRetry. */
  readonly retry?: (() => boolean) | undefined;
  readonly render: () => void;
}

/**
 * What the row's keys do (commandContext.failedTurnAction). False when no
 * live failure offers the action: the key then does nothing.
 */
export function createFailedTurnAction(deps: FailedTurnActionDeps): (action: FailedTurnKeyAction) => boolean {
  const sendAgain = (): boolean => {
    if (deps.retry) return deps.retry();
    if (!rows.retry) return false;
    rows.retry();
    return true;
  };
  return (action) => {
    const live = liveReading();
    if (!live) return false;
    const { reading, index } = live;
    switch (action) {
      case 'details': {
        if (!offers(reading, 'details')) return false;
        const key = detailsKey(reading, index);
        if (!rows.details.delete(key)) rows.details.add(key);
        rows.conversation?.clearLineCache();
        deps.render();
        return true;
      }
      case 'other-model': {
        if (!offers(reading, 'other-model', 'choose-model')) return false;
        // Only the model chosen in the picker this key opened sends the failed
        // prompt again, and only while that failure is still the live one.
        deps.openModelPicker((chosen) => {
          if (!chosen) return;
          const still = liveReading();
          if (still && still.index === index && offers(still.reading, 'other-model', 'choose-model')) sendAgain();
        });
        deps.render();
        return true;
      }
      case 'sign-in': {
        if (!offers(reading, 'sign-in')) return false;
        deps.openSignIn();
        deps.render();
        return true;
      }
      case 'retry': {
        if (!offers(reading, 'retry')) return false;
        return sendAgain();
      }
    }
  };
}

/** What a retry of a turn that already ran tools sends: it continues from their results instead of repeating them. */
export const CONTINUE_AFTER_TOOLS = 'The previous attempt stopped with an error after running tools. Their results are above; continue from them without repeating what they already did.';

/** The failed turn as the orchestrator holds it (Orchestrator.failedTurnInput). */
export interface FailedTurnInputView {
  readonly turnId: string;
  readonly text: string;
  readonly content?: unknown;
  readonly options?: unknown;
  readonly rollbackCount: number;
  readonly superseded: boolean;
}

/**
 * Send the failed turn again (the Agent's alt+r): the transcript goes back to
 * before it and the prompt is sent as it was; a turn that already ran tools
 * keeps their results and continues from them. False when nothing failed.
 */
export function retryFailedTurn<F extends FailedTurnInputView>(
  orchestrator: { failedTurnInput(): F | null; clearFailedTurnInput(turnId: string): void },
  conversation: TurnFailureConversation & { removeMessagesAfter(count: number, options?: { readonly preserveCompletedTools?: boolean }): void },
  send: (text: string, content: F['content'] | undefined, options: F['options']) => Promise<void>,
  onError: (error: unknown) => void,
): boolean {
  const failed = orchestrator.failedTurnInput();
  if (!failed || failed.superseded) return false;
  let ranTools = false;
  for (let index = failed.rollbackCount; index < conversation.getMessageCount(); index++) {
    const message = conversation.getMessageAt(index);
    if (message?.role === 'tool' || (message?.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0)) { ranTools = true; break; }
  }
  orchestrator.clearFailedTurnInput(failed.turnId);
  if (ranTools) {
    conversation.removeMessagesAfter(failed.rollbackCount, { preserveCompletedTools: true });
    void send(CONTINUE_AFTER_TOOLS, undefined, failed.options).catch(onError);
  } else {
    conversation.removeMessagesAfter(failed.rollbackCount);
    void send(failed.text, failed.content, failed.options).catch(onError);
  }
  return true;
}

/** What a program hands over to put the row's keys on its command context. */
export interface WireFailedTurnActionsOptions {
  readonly commandContext: {
    failedTurnAction?: ((action: FailedTurnKeyAction) => boolean) | undefined;
    openModelPicker?: ((onClosed?: (chosen: boolean) => void) => void) | undefined;
    executeCommand?: ((name: string, args: string[]) => Promise<boolean>) | undefined;
  };
  /** The program's retry of the failed turn; absent: the one offered with offerFailedTurnRetry. */
  readonly retry?: (() => boolean) | undefined;
  readonly render: () => void;
}

/** Put the failure row's keys on the program's command context (alt+r, alt+o, alt+i, alt+s). */
export function wireFailedTurnActions(options: WireFailedTurnActionsOptions): void {
  const { commandContext } = options;
  commandContext.failedTurnAction = createFailedTurnAction({
    openModelPicker: (onClosed) => commandContext.openModelPicker?.(onClosed),
    // The provider sign-ins: each provider, whether it is signed in, and how to fix it.
    openSignIn: () => { void commandContext.executeCommand?.('auth', []).finally(options.render); },
    ...(options.retry ? { retry: options.retry } : {}),
    render: options.render,
  });
}
