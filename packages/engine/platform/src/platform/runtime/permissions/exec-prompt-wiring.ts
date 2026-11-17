import { currentExternalOperationSource } from '../../permissions/external-operation-scope.js';
import { answerExecPrompt, personExecPromptAnswer, type AutonomousToolPromptHost } from './autonomous-tool-prompts.js';
/**
 * One rule for a command stopped on its terminal. A fixed control prompt
 * ([y/N], yes/no) in a model's run is answered by the autonomous host through a
 * recorded, single-use admission. Any other prompt (a passphrase, a package
 * name), or one the host does not answer, is put to the person as the
 * `exec:prompt` ask when a person is attached to the surface, or when no model
 * run is in progress; an unattended run declines it and the run stops with the
 * prompt on its result.
 */
import { randomUUID } from 'node:crypto';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../../permissions/prompt.js';
import type { ExecPromptAsk, ExecPromptAnswer, ExecPromptExecution } from '../../tools/exec/interactive.js';

// The ask/answer shapes the handler mediates, re-exported so this entry point
// is self-sufficient for consumers wiring the seam.
export type { ExecPromptAsk, ExecPromptAnswer, ExecPromptExecution } from '../../tools/exec/interactive.js';

/** The prompt-answer handler the exec tool's interactive runner invokes. */
export type ExecPromptAnswerHandler = (ask: ExecPromptAsk, execution?: ExecPromptExecution) => Promise<ExecPromptAnswer>;

/** The broker seam this wiring routes through. */
export interface ExecPromptWiringDeps {
  readonly autonomousHost?: AutonomousToolPromptHost | undefined;
  /**
   * Whether a person can answer on this surface now (a terminal app, or a
   * connected client of a hosted session). Read when a prompt arrives.
   * Absent: no one is attached, so a model's run never waits on a person.
   */
  readonly attended?: (() => boolean) | undefined;
  readonly requestApproval: (input: {
    readonly request: PermissionPromptRequest;
    readonly metadata?: Record<string, unknown> | undefined;
  }) => Promise<PermissionPromptDecision>;
}

/**
 * Build the exec prompt-answer handler: the pending prompt rides the approval
 * broker as an `execute`-category ask. Approval with a string
 * `modifiedArgs.answer` feeds that text to the waiting child; approval
 * without one, or denial, declines the prompt (the runner then stops the run
 * with the prompt text on the honest result).
 */
export function buildExecPromptAnswerHandler(deps: ExecPromptWiringDeps): ExecPromptAnswerHandler {
  return async (ask, execution) => {
    if (currentExternalOperationSource()) {
      if (deps.autonomousHost) {
        const controlled = await answerExecPrompt(deps.autonomousHost, ask, execution);
        if (controlled.answered) return controlled;
      }
      if (deps.attended?.() !== true) return { answered: false, declined: 'unattended' };
    }
    const request: PermissionPromptRequest = {
      callId: `exec-prompt-${randomUUID().slice(0, 8)}`,
      tool: 'exec:prompt',
      args: {
        command: ask.command,
        prompt: ask.prompt,
        recentOutput: ask.recentOutput,
      },
      category: 'execute',
      analysis: {
        classification: 'exec-terminal-prompt',
        riskLevel: 'medium',
        summary: `A running command is waiting on its terminal: ${ask.prompt}`,
        reasons: [
          `The command \`${ask.command}\` stopped on a terminal prompt.`,
          'Approving sends your typed answer to the waiting command; declining stops the run.',
        ],
        surface: 'shell',
        blastRadius: 'project',
      },
      ...(ask.workingDirectory ? { workingDirectory: ask.workingDirectory } : {}),
      attribution: { kind: 'exec-prompt', command: ask.command, prompt: ask.prompt },
    };
    const decision = await deps.requestApproval({
      request,
      metadata: { source: 'exec-prompt', command: ask.command },
    });
    if (!decision.approved) return { answered: false, declined: 'refused' };
    const answer = decision.modifiedArgs?.['answer'];
    // Never fabricate a reply the human did not type: an approval that carries
    // no text is a decline in practice, reported honestly.
    if (typeof answer !== 'string') return { answered: false, declined: 'refused' };
    return personExecPromptAnswer(answer);
  };
}
