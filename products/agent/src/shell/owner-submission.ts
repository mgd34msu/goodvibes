/**
 * owner-submission.ts, how what the owner typed or said becomes a turn or a
 * shell command.
 *
 * The composer's own grammar applies only to what was typed into it: `@model:`
 * at either end switches the model, `!#` pins a memory, `# ` saves a note
 * without sending, `!` runs a shell command. Text sent as given (forms, the
 * commands that submit a prompt) and speech go straight to a turn, so words
 * that arrived by voice are never run as a shell command.
 *
 * Extracted from main() so the routing is one module taking the shell's parts
 * as ports; the turn itself is owner-turn-sender.ts (sendTurn), and
 * interactive.ts keeps the model switch and the refusal of what a turn cannot carry.
 */
import type { ContentPart } from '@goodvibes-jev/engine/platform/platform/providers';
import type { NoticeLevel, OrchestratorUserInputOptions } from '@goodvibes-jev/engine/platform/platform/core';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { captureNativeConversationInput, type NativeConversationInput, type ProductInputContext } from '@goodvibes-jev/engine/terminal-shell/native';
import { applyComposerCapture, readComposerMarker, shouldSendAfterCapture, type ComposerCaptureDeps } from '@goodvibes-jev/engine/terminal-shell/submission-router';
import { SHELL_USAGE_HINT, type ShellPassthrough, type ShellRunResult } from '../input/shell-passthrough.ts';

/** How a message is sent: given back to the composer when refused, with the held `!` output in front. */
export interface OwnerTurnHow {
  readonly notSent?: ((text: string) => void) | undefined;
  readonly attachShellOutput?: boolean | undefined;
}

export interface OwnerSubmissionPorts {
  /** Runs `!` commands; their output is held for the next message. */
  readonly shellPassthrough: Pick<ShellPassthrough, 'run'>;
  readonly workingDir: string;
  readonly sessionMemoryStore: ComposerCaptureDeps['sessionMemoryStore'];
  /** Every submission starts here (a setup takeover let go, the view back at the bottom). */
  readonly prepare: () => void;
  /** Applies `@model:` directives and returns the text that remains. */
  readonly applyModelSwitches: (text: string) => string;
  /** True when the message carries what a turn cannot (an image): it was refused and the draft given back. */
  readonly refuseUnsendable: (draft: string, source: NativeConversationInput | undefined, content: readonly ContentPart[] | undefined) => boolean;
  /** The contract question a typed message answers, unless it was dismissed. */
  readonly answerOptions: () => { readonly answersContractQuestion?: string };
  /** Starts the turn (or routes it to the connected host). */
  readonly sendTurn: (text: string, options: ProductInputContext, turnOptions: OrchestratorUserInputOptions | undefined, how: OwnerTurnHow) => Promise<boolean>;
  /** A refused, unsent prompt goes back into an empty composer. */
  readonly restoreDraft: (text: string) => void;
  /** How many `!` commands are running, after each start and finish. */
  readonly onShellCommandsRunning: (running: number) => void;
  readonly notify: (message: string, level?: NoticeLevel) => void;
  /** A `!` command's output, drawn in the transcript where it ran. */
  readonly showShellOutput: (result: ShellRunResult) => void;
  readonly render: () => void;
}

export interface OwnerSubmission {
  /** Text typed into the composer: its grammar applies. */
  readonly submitComposerText: (text: string, content?: ContentPart[], options?: ProductInputContext) => void;
  /** Text sent as a turn exactly as given. */
  readonly submitTurn: (text: string, content?: ContentPart[], options?: ProductInputContext) => void;
  /** A transcript from the microphone: sent as said. */
  readonly submitSpeech: (text: string) => void;
  /** Resolves once every `!` command started here has finished. */
  readonly shellCommandsSettled: () => Promise<void>;
}

export function createOwnerSubmission(ports: OwnerSubmissionPorts): OwnerSubmission {
  const running = new Set<Promise<void>>();

  const runShellCommand = (command: string): void => {
    if (!command) {
      ports.notify(SHELL_USAGE_HINT);
      ports.render();
      return;
    }
    ports.notify(`[Shell] $ ${command}`);
    ports.render();
    const run = ports.shellPassthrough
      .run(command, ports.workingDir)
      .then((result) => ports.showShellOutput(result))
      .catch((error: unknown) => ports.notify(`[Shell] Failed to run: ${summarizeError(error)}`, 'error'))
      .finally(() => {
        running.delete(run);
        ports.onShellCommandsRunning(running.size);
        ports.render();
      });
    running.add(run);
    ports.onShellCommandsRunning(running.size);
  };

  const submitComposerText = (text: string, content?: ContentPart[], options: ProductInputContext = {}): void => {
    ports.prepare();
    const draft = options.source?.text ?? text;
    let processedText = ports.applyModelSwitches(text);
    // The one reading of the composer's markers, the same one that labels the composer.
    const marker = readComposerMarker(processedText);
    // `!` runs a shell command for typed input only, never for speech.
    if (marker.kind === 'shell' && !options.spokenOutput) {
      runShellCommand(marker.body);
      return;
    }
    if (ports.refuseUnsendable(draft, options.source, content)) return;
    if (marker.kind === 'memory-pin' || marker.kind === 'note') {
      // `!#` pins and sends; `# ` saves a note and sends nothing.
      const capture = applyComposerCapture(processedText, {
        sessionMemoryStore: ports.sessionMemoryStore,
        notify: (message) => ports.notify(message),
      });
      if (!shouldSendAfterCapture(capture, false)) {
        ports.render();
        return;
      }
      processedText = capture.text;
    }
    // Model directives and the memory markers are the composer's own grammar; what remains is what the user sent.
    // A typed message answers the contract question on offer, unless it was dismissed.
    const answer: { readonly answersContractQuestion?: string } = options.spokenOutput ? {} : ports.answerOptions();
    // A refused message goes back to the composer as typed, not with its references expanded
    // into file text; a `!#` pin already saved is not repeated on the resend.
    const expandedReferences = options.source?.unsupportedSources.some((part) => part.kind === 'file' || part.kind === 'context') === true;
    const resendable = (unsent: string): string => !expandedReferences ? unsent
      : marker.kind === 'memory-pin' ? draft.replace(/^\s*!#\s*/, '') : draft;
    void ports.sendTurn(processedText, options, answer.answersContractQuestion ? answer : undefined, {
      notSent: (unsent) => ports.restoreDraft(resendable(unsent)),
      attachShellOutput: true,
    });
  };

  const submitTurn = (text: string, content?: ContentPart[], options: ProductInputContext = {}): void => {
    ports.prepare();
    if (ports.refuseUnsendable(text, options.source, content)) return;
    void ports.sendTurn(text, options, undefined, { attachShellOutput: true });
  };

  return {
    submitComposerText,
    submitTurn,
    // Speech is sent as said; only typed composer text has a grammar.
    submitSpeech: (text) => submitTurn(text, undefined, { source: captureNativeConversationInput(text) }),
    shellCommandsSettled: async () => {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  };
}
