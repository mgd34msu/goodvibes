import {
  nativeConversationIntakeLines,
  type NativeConversationIntakeActions,
  type NativeConversationIntakeState,
} from './native-conversation-intake.js';
import { nativeWorkSubmissionLines, type NativeWorkSubmissionActions } from './native-work-submission.js';
import { commandRefusal } from '../command-confirmation.js';
/** Recovery verbs share dispatch; the product declares whether a hosted turn may be resumed here. */
export async function handleNativeIntakeCommand(
  args: readonly string[],
  context: {
    print(text: string): void;
    readonly nativeConversationIntake?: NativeConversationIntakeActions | undefined;
    readonly dispatchNativeIntakeTurn?: ((state: NativeConversationIntakeState) => void | Promise<void>) | undefined;
  },
  allowHostedDispatch: boolean,
): Promise<boolean> {
  const action = args[0];
  if (action !== 'intake-status' && action !== 'intake-retry' && action !== 'intake-resume' && action !== 'intake-cancel') return false;
  if (args.length !== 1) throw commandRefusal('Usage: /work intake-status | intake-retry | intake-resume | intake-cancel');
  const intake = context.nativeConversationIntake;
  if (!intake) throw commandRefusal('Native conversation intake is unavailable in this shell.');
  const result = await (action === 'intake-status'
    ? intake.status()
    : action === 'intake-retry'
      ? intake.retry()
      : action === 'intake-resume'
        ? intake.resume()
        : intake.cancel());
  context.print(nativeConversationIntakeLines(result).join('\n'));
  if (result?.turnReady || (allowHostedDispatch && result?.hostedTurn)) {
    await context.dispatchNativeIntakeTurn?.(result);
    // A local turn dispatched here has ended: its intake record has nothing left to fence.
    if (result.turnReady && context.dispatchNativeIntakeTurn) await result.finishTurn?.();
  }
  return true;
}
export async function handleNativeSubmissionCommand(
  args: readonly string[],
  print: (text: string) => void,
  submission: Pick<NativeWorkSubmissionActions, 'submitFile' | 'status' | 'retry' | 'discard'> | undefined,
): Promise<boolean> {
  const action = args[0];
  if (action !== 'submit-file' && action !== 'submission-status' && action !== 'submission-retry' && action !== 'submission-discard') return false;
  const path = args[1];
  if (args.length !== (action === 'submit-file' ? 2 : 1) || (action === 'submit-file' && path === undefined)) {
    throw commandRefusal('Usage: /work submit-file <JSON-path> | submission-status | submission-retry | submission-discard');
  }
  if (!submission) throw commandRefusal('Native source submission is unavailable in this shell.');
  const result =
    action === 'submit-file' && path !== undefined
      ? await submission.submitFile(path)
      : action === 'submission-status'
        ? await submission.status()
        : action === 'submission-discard'
          ? await submission.discard()
          : await submission.retry();
  print(
    nativeWorkSubmissionLines(result)
      .map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' '))
      .join('\n'),
  );
  return true;
}
