/**
 * owner-submission.ts, how what the owner typed or said becomes a turn or a
 * shell command.
 *
 * Only text typed into the composer has a grammar: `@model:` switches the
 * model, `!` runs a shell command, `!#` pins a memory and sends, `# ` saves a
 * note without sending. Text sent as given (skill bodies, retries, templates,
 * forms) and speech go straight to a turn, so words that arrived by voice are
 * never run as a shell command.
 *
 * Extracted from main() so the routing is one module taking the shell's parts
 * as ports; interactive.ts keeps the turn itself (sendOwnerTurn) and the model
 * switch.
 */
import type { ContentPart } from '@goodvibes-jev/engine/platform/platform/providers';
import type { NoticeLevel, OrchestratorUserInputOptions } from '@goodvibes-jev/engine/platform/platform/core';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { captureNativeConversationInput, type ProductInputContext } from '@goodvibes-jev/engine/terminal-shell/native';
import { readComposerMarker } from '@goodvibes-jev/engine/terminal-shell/submission-router';
import { SHELL_USAGE_HINT, type ShellPassthrough, type ShellRunResult } from '@goodvibes-jev/engine/terminal-shell/shell-passthrough';
import { applyComposerCapture, shouldSendAfterCapture, splitAtModelDirectives, type ComposerCaptureDeps } from '../input/composer-capture.ts';
import { createSpokenTurnInputOptions } from '../audio/spoken-turn-model-routing.ts';

export interface OwnerSubmissionPorts {
  /** Runs `!` commands; its buffered output goes in front of the next turn. */
  readonly shellPassthrough: Pick<ShellPassthrough, 'run' | 'consumeContext'>;
  readonly workingDir: string;
  readonly sessionMemoryStore: ComposerCaptureDeps['sessionMemoryStore'];
  /** Every submission starts here (readings cancelled, view back at the bottom, splash retired). */
  readonly begin: () => void;
  /** `@model:<id> prompt`: switch, then hand the rest back to `submitCaptured`, or hold it when the switch did not land. */
  readonly switchModels: (models: readonly string[], rest: string, content: ContentPart[] | undefined, options: ProductInputContext) => void;
  /** The contract question a typed message answers, unless it was dismissed. */
  readonly answerOptions: () => { readonly answersContractQuestion?: string };
  /** Starts the turn. */
  readonly sendTurn: (text: string, content: ContentPart[] | undefined, inputOptions: OrchestratorUserInputOptions | undefined) => void;
  readonly notify: (message: string, level?: NoticeLevel) => void;
  /** A `!` command's output, drawn in the transcript where it ran. */
  readonly showShellOutput: (result: ShellRunResult) => void;
  readonly render: () => void;
}

export interface OwnerSubmission {
  /** Text typed into the composer: its grammar applies. */
  readonly submitInput: (text: string, content?: ContentPart[], options?: ProductInputContext) => void;
  /** Composer text after its `@model:` directives were handled. */
  readonly submitCaptured: (text: string, content: ContentPart[] | undefined, options: ProductInputContext) => void;
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
        ports.render();
      });
    running.add(run);
  };

  // `!` runs a shell command (typed input only, never speech), `!#` pins and sends, `# ` saves a note without sending.
  const submitCaptured = (text: string, content: ContentPart[] | undefined, options: ProductInputContext): void => {
    const marker = readComposerMarker(text);
    if (marker.kind === 'shell' && !options.spokenOutput) {
      runShellCommand(marker.body);
      return;
    }
    const capture = applyComposerCapture(text, {
      sessionMemoryStore: ports.sessionMemoryStore,
      notify: (message) => ports.notify(message),
    });
    if (shouldSendAfterCapture(capture, Boolean(content))) {
      const answer: { readonly answersContractQuestion?: string } = options.spokenOutput ? {} : ports.answerOptions();
      const inputOptions = options.spokenOutput ? createSpokenTurnInputOptions() : answer.answersContractQuestion ? answer : undefined;
      // The output of `!` commands run since the last message goes with this one.
      ports.sendTurn(ports.shellPassthrough.consumeContext(capture.text), content, inputOptions);
    } else {
      ports.render();
    }
  };

  const submitInput = (text: string, content?: ContentPart[], options: ProductInputContext = {}): void => {
    ports.begin();
    const directives = splitAtModelDirectives(text);
    if (directives.models.length > 0) {
      ports.switchModels(directives.models, directives.text, content, options);
      return;
    }
    submitCaptured(text, content, options);
  };

  const submitTurn = (text: string, content?: ContentPart[], options: ProductInputContext = {}): void => {
    ports.begin();
    // The output of `!` commands run since the last message goes with this one.
    ports.sendTurn(ports.shellPassthrough.consumeContext(text), content, options.spokenOutput ? createSpokenTurnInputOptions() : undefined);
  };

  return {
    submitInput,
    submitCaptured,
    submitTurn,
    // Speech is sent as said; only typed composer text has a grammar.
    submitSpeech: (text) => submitTurn(text, undefined, { source: captureNativeConversationInput(text) }),
    shellCommandsSettled: async () => {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  };
}
