/**
 * owner-turn-sender.ts, where one message from the owner goes once the
 * composer (or the phone, or an activated plan) has handed it over.
 *
 * Typed, spoken, companion and plan input all end in `sendTurn`: native
 * intake, the routing decision (the connected host's loop or this process)
 * and the turn-finished signal. A message the route refuses (another message
 * is still being taken, or the intake said no) is never reported as taken:
 * held `!` output goes back to the buffer and `notSent` decides where the text
 * goes. Companion and plan messages come in through `receiveOwnerInput`; one
 * that is refused is held, in order, and sent on its own once the way clears.
 *
 * It lives beside interactive.ts rather than inside it so this path can be
 * run as the shell runs it.
 */
import type { NativeConversationInput, ProductInputContext } from '@goodvibes/engine/terminal-shell/native';
import type { NoticeLevel, OrchestratorUserInputOptions } from '@goodvibes/engine/platform/platform/core';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { createHeldInputs } from '@goodvibes/engine/terminal-shell/held-input';
import type { OwnerInputAnswered } from '@goodvibes/engine/terminal-shell/companion-input';
import { withShellContext, type ShellContextHold } from '../input/shell-passthrough.ts';
import { routeNativeConversationInput } from '../runtime/native-conversation-ingress.ts';
import type { NativeConversationIntakeActions, NativeConversationIntakeState } from '../runtime/native-conversation-intake.ts';
import type { NativeRemoteConversationWiring } from './remote-conversation-wiring.ts';

export interface OwnerTurnSenderDeps {
  /** The connected host's route, see remote-conversation-wiring.ts. */
  readonly remoteConversation: Pick<NativeRemoteConversationWiring, 'routeNativeOrExplain'>;
  /** The native intake in effect now; read for every message, since /work commands may replace it. */
  readonly intake: () => NativeConversationIntakeActions | undefined;
  /** `!` output taken for a message that has not been admitted yet. */
  readonly shellContextHold: Pick<ShellContextHold, 'take'>;
  /** Typed text refused before admission goes back here. */
  readonly restoreDraft: (text: string) => void;
  /** Runs the turn in this process. */
  readonly runTurn: (text: string, spokenOutput: boolean, turnOptions: OrchestratorUserInputOptions | undefined) => Promise<void>;
  /** Runs a turn the native intake admitted for this process. */
  readonly dispatchNativeTurn: (state: NativeConversationIntakeState, spokenOutput: boolean, turnOptions: OrchestratorUserInputOptions | undefined) => Promise<void>;
  /** True while a turn runs here; a held message waits for it. */
  readonly isBusy: () => boolean;
  /**
   * The machine's announce-once record: `record` is true only for the first
   * call with an id on this machine; `forget` makes the ids it selects new again.
   */
  readonly announcements: {
    readonly record: (id: string) => boolean;
    readonly forget: (selects: (id: string) => boolean) => void;
  };
  readonly messages: {
    readonly high: (message: string, level?: NoticeLevel) => void;
    readonly userAction: (message: string) => void;
    readonly activity: (message: string) => void;
    /** Why a message was not sent, or what it needs: shown in the conversation at once. */
    readonly aboutInput: (message: string, level?: NoticeLevel) => void;
  };
  readonly render: () => void;
}

export interface OwnerTurnSendOptions {
  /** Gets the text back when it was refused before admission. Default: the composer's draft. */
  readonly notSent?: ((text: string) => void) | undefined;
  /** The output of `!` commands run since the last message goes in front of this one; a refusal gives it back. */
  readonly attachShellOutput?: boolean | undefined;
  /** The intake's lines go to the activity feed (a held message sent again). */
  readonly quiet?: boolean | undefined;
  /**
   * Gets the text when it may have been sent: the intake was handed it and its
   * answer never came (`unknown`). Default: kept in {@link OwnerTurnSender.uncertain}
   * and the composer draft, never sent again on its own.
   */
  readonly uncertain?: ((text: string) => void) | undefined;
  /**
   * Told how the message ended when this process sees no turn events for it:
   * the connected host ran it (its completion's answer), or it never became a
   * turn (failed, or may have been sent). A turn run here answers from its own
   * events. Refused and held, it is told when the held message is sent.
   */
  readonly answered?: OwnerInputAnswered | undefined;
}

export interface OwnerTurnSender {
  /** Resolves true once the message was taken (its turn ran or the host has it), false when it was refused and handed to `notSent`. */
  sendTurn(text: string, options: ProductInputContext, turnOptions?: OrchestratorUserInputOptions, how?: OwnerTurnSendOptions): Promise<boolean>;
  /** The companion/plan route (bindOwnerInput): sent as given, or held when refused. */
  receiveOwnerInput(text: string, turnOptions: OrchestratorUserInputOptions | undefined, answered?: OwnerInputAnswered): void;
  /** Messages held from the phone or a plan, oldest first. */
  held(): readonly string[];
  /** Messages that may have been sent (their intake answer never came), oldest first: never sent again on their own. */
  uncertain(): readonly string[];
  /**
   * Resolves once nothing this sender started on its own is still running: a
   * phone or plan message sent through `receiveOwnerInput`, and the sending of
   * held messages that a taken message cleared the way for. The held retry
   * timer is not counted; a send it starts is.
   */
  settled(): Promise<void>;
  dispose(): void;
}

const HELD_OWNER_INPUT_LIMIT = 16;
const HELD_OWNER_RETRY_MS = 5_000;
/** Announce-once ids of "messages run in this process because <reason>": one per reason. */
const LOCAL_TURN_ANNOUNCEMENT = 'local-turns:';

export function createOwnerTurnSender(deps: OwnerTurnSenderDeps): OwnerTurnSender {
  const { messages } = deps;
  /** The reason last given for running turns in this process; cleared once the host takes a message. */
  let localTurnReason: string | undefined;
  /** The host took a message: a later reason to run here is said again, on this machine too. */
  const hostTookMessage = (): void => {
    if (localTurnReason === undefined) return;
    localTurnReason = undefined;
    deps.announcements.forget((id) => id.startsWith(LOCAL_TURN_ANNOUNCEMENT));
  };
  /** Inputs whose intake answer never came: kept, shown as "may have been sent", not sent again by this sender. */
  const uncertainInputs = createHeldInputs();
  const UNCERTAIN_SESSION = 'agent-owner';
  /** Sends this sender started on its own, which no caller holds the promise of; `settled()` waits on them. */
  const running = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>): void => {
    running.add(work);
    void work.finally(() => running.delete(work)).catch(() => {});
  };
  const keepUncertain = (text: string, reason: string): void => {
    const held = uncertainInputs.hold({ sessionId: UNCERTAIN_SESSION, text, attachments: [], flags: {} });
    uncertainInputs.unknown(held.clientMessageId, reason);
  };

  function sendTurn(
    text: string,
    options: ProductInputContext,
    turnOptions?: OrchestratorUserInputOptions,
    how: OwnerTurnSendOptions = {},
  ): Promise<boolean> {
    if (!text) {
      deps.render();
      return Promise.resolve(false);
    }
    const notSent = how.notSent ?? deps.restoreDraft;
    // The intake may have taken it: it is kept and shown as such, and never counted as taken or as refused.
    const uncertain = how.uncertain ?? ((kept: string): void => {
      keepUncertain(kept, 'the intake did not answer');
      deps.restoreDraft(kept);
    });
    const spokenOutput = options.spokenOutput === true;
    const shell = how.attachShellOutput ? deps.shellContextHold.take() : null;
    // The images a message carries (uploaded to the host first, owner-submission.ts) go with it as its attachments.
    const attachments = options.source?.attachments;
    const source: NativeConversationInput = { text: shell ? withShellContext(shell.blocks, text) : text, unsupportedSources: [],
      ...(attachments && attachments.length > 0 ? { attachments } : {}) };
    const refused = (): false => {
      shell?.restore();
      notSent(text);
      return false;
    };
    // The host cannot take this message and nothing was sent for it: the turn runs here (the
    // documented behaviour of hostedSessions.routeConversationTurns), and it works. Why is a
    // standing fact of this machine (no host set up, no host token), so it is said once on this
    // machine and goes to the activity feed after that; it is said again once a host took a
    // message and then could not.
    const runLocal = (reason: string): Promise<void> => {
      if (reason !== localTurnReason) {
        localTurnReason = reason;
        if (deps.announcements.record(`${LOCAL_TURN_ANNOUNCEMENT}${reason}`)) messages.userAction(reason);
        else messages.activity(reason);
        deps.render();
      }
      // The held output now goes with this turn; a later failure does not bring it back.
      shell?.release();
      return deps.runTurn(source.text, spokenOutput, turnOptions);
    };
    const mayHaveBeenSent = (): false => {
      shell?.release();
      // Not sent again on its own, so its sender is told now rather than never.
      how.answered?.({ answer: 'This message may not have been taken: its intake did not confirm it. Send it again if no answer follows.', status: 'failed' });
      uncertain(text);
      const line = 'Your message may have been sent: its intake did not confirm it. It is kept; check /work intake before sending it again.';
      if (how.quiet) messages.activity(line);
      else messages.aboutInput(line, 'warning');
      deps.render();
      return false;
    };
    const taken = (async (): Promise<boolean> => {
      try {
        // The hosted route refused it and nothing was sent: the shell output goes back and
        // `notSent` decides where the text goes (the composer, or the held queue for a phone
        // or plan message), and the caller is told it was not taken.
        let hostRefused = false;
        let hostUncertain = false;
        const routed = await deps.remoteConversation.routeNativeOrExplain(source, deps.intake(), () => { hostRefused = true; }, () => { hostUncertain = true; });
        if (hostRefused) return refused();
        if (hostUncertain) return mayHaveBeenSent();
        if (routed && 'local' in routed) {
          await runLocal(routed.reason);
          return true;
        }
        if (routed) {
          shell?.release();
          hostTookMessage();
          // The connected host runs the turn: its completion carries the answer this process never sees as turn events.
          const answered = how.answered;
          if (answered) {
            void routed.completion.then(
              (done) => answered({
                answer: done.response || done.error || '',
                status: done.status === 'completed' ? 'completed' : done.status === 'cancelled' ? 'cancelled' : 'failed',
              }),
              (error: unknown) => answered({ answer: `The connected host did not report how this message ended: ${summarizeError(error)}`, status: 'failed' }),
            );
          }
          return true;
        }
        const state = await routeNativeConversationInput({
          intake: deps.intake(),
          source,
          notify: (message) => {
            if (how.quiet) messages.activity(message);
            else messages.aboutInput(message);
            deps.render();
          },
          record: (message) => messages.activity(message),
          dispatch: (state) => deps.dispatchNativeTurn(state, spokenOutput, turnOptions),
          runLocal,
        });
        // The host answered for this message: a later fallback states its reason again.
        if (state?.result) hostTookMessage();
        // Refused (another input still being admitted or unresolved, input not acceptable): nothing was sent.
        if (state?.notSent || state?.status === 'pending' || state?.status === 'unavailable' || state?.status === 'invalid') return refused();
        // Handed to the intake with no answer: it may have been recorded. Not taken (it is kept) and not
        // refused (it is not sent again on its own); /work intake says which before a resend.
        if (state?.status === 'unknown') return mayHaveBeenSent();
        shell?.release();
        return true;
      } catch (error) {
        // Routing failed before the input was admitted: give back the draft.
        // A held message keeps its duty to answer and is answered when it is sent.
        refused();
        const line = `Your message was not sent: ${summarizeError(error)}`;
        if (how.quiet) messages.activity(line);
        else messages.aboutInput(line, 'error');
        deps.render();
        return false;
      }
    })();
    // A message taken and settled has cleared the way for one held from the phone or a plan.
    void taken.then((ok) => { if (ok && !how.quiet) sendHeldOwnerInput(); });
    return taken;
  }

  // Companion messages and an activated plan take the composer's path as sent (no
  // composer grammar), carrying their origin. One the intake refuses (another
  // message is still being taken) is held, in order, and sent on its own once
  // the way clears: when a message here settles, and every few seconds while
  // something is held. Nothing from the phone or a plan's first turn is dropped,
  // and the draft is never touched.
  const heldOwnerInput: Array<{ readonly text: string; readonly turnOptions: OrchestratorUserInputOptions | undefined; readonly answered?: OwnerInputAnswered | undefined }> = [];
  let heldOwnerTimer: ReturnType<typeof setTimeout> | null = null;
  let heldOwnerSending = false;
  let disposed = false;
  const describeOwnerInput = (text: string, turnOptions: OrchestratorUserInputOptions | undefined): string => {
    const quoted = `"${text.length > 120 ? `${text.slice(0, 117)}...` : text}"`;
    const from = turnOptions?.origin?.source;
    return from ? `the ${from} message ${quoted}` : quoted;
  };
  function scheduleHeldOwnerInput(): void {
    if (disposed || heldOwnerTimer || heldOwnerInput.length === 0) return;
    heldOwnerTimer = setTimeout(() => {
      heldOwnerTimer = null;
      sendHeldOwnerInput();
    }, HELD_OWNER_RETRY_MS);
    (heldOwnerTimer as { unref?: () => void }).unref?.();
  }
  function sendHeldOwnerInput(): void {
    if (disposed || heldOwnerSending || heldOwnerInput.length === 0) return;
    heldOwnerSending = true;
    track((async () => {
      try {
        while (heldOwnerInput.length > 0 && !deps.isBusy()) {
          const next = heldOwnerInput[0]!;
          let mayHaveBeenSent = false;
          const taken = await sendTurn(next.text, {}, next.turnOptions, {
            notSent: () => {}, quiet: true, answered: next.answered,
            uncertain: () => { mayHaveBeenSent = true; keepUncertain(next.text, 'the intake did not answer'); },
          });
          // A message that may have been sent leaves the queue: sending it again on a timer could send it twice.
          if (mayHaveBeenSent) {
            heldOwnerInput.shift();
            messages.high(`${describeOwnerInput(next.text, next.turnOptions)} may have been sent: its intake did not confirm it. It is not sent again on its own; check /work intake.`, 'warning');
            break;
          }
          if (!taken) break;
          heldOwnerInput.shift();
          messages.activity(`Sent ${describeOwnerInput(next.text, next.turnOptions)}, held until the previous message was taken.`);
        }
      } finally {
        heldOwnerSending = false;
        scheduleHeldOwnerInput();
      }
    })());
  }
  const receiveOwnerInput = (text: string, turnOptions: OrchestratorUserInputOptions | undefined, answered?: OwnerInputAnswered): void => {
    const hold = (): void => {
      if (heldOwnerInput.length >= HELD_OWNER_INPUT_LIMIT) {
        messages.high(`Not sent: ${describeOwnerInput(text, turnOptions)}. ${HELD_OWNER_INPUT_LIMIT} messages are already waiting; send it again once they are taken.`, 'warning');
        answered?.({ answer: `This message was not taken: ${HELD_OWNER_INPUT_LIMIT} messages were already waiting. Send it again once they are answered.`, status: 'failed' });
      } else {
        heldOwnerInput.push({ text, turnOptions, ...(answered ? { answered } : {}) });
        messages.high(`Held ${describeOwnerInput(text, turnOptions)}: the current message is still being taken. It is sent on its own once that clears.`, 'warning');
        scheduleHeldOwnerInput();
      }
      deps.render();
    };
    // Behind a held message, a new one waits its turn so the order is kept.
    if (heldOwnerInput.length > 0) hold();
    else track(sendTurn(text, {}, turnOptions, { notSent: hold, uncertain: () => keepUncertain(text, 'the intake did not answer'), answered }));
  };

  return {
    sendTurn,
    receiveOwnerInput,
    held: () => heldOwnerInput.map((entry) => entry.text),
    uncertain: () => uncertainInputs.list(UNCERTAIN_SESSION).map((entry) => entry.text),
    settled: async () => {
      // A send that settles may start the held queue's; wait until a pass finds nothing running.
      while (running.size > 0) await Promise.allSettled([...running]);
    },
    dispose: () => {
      disposed = true;
      if (heldOwnerTimer) clearTimeout(heldOwnerTimer);
      heldOwnerTimer = null;
      // A held message that will now never be sent still owes its sender an answer.
      for (const held of heldOwnerInput.splice(0)) {
        held.answered?.({ answer: 'This message was not answered: GoodVibes Agent closed before it could be sent. Send it again.', status: 'failed' });
      }
    },
  };
}
