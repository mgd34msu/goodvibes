import type { NativeWorkSubmissionState } from './native-work-submission.js';
import type { NativeWorkExecutionAction, NativeWorkExecutionState } from './native-work-execution.js';
import type { NativeWorkLedgerState } from './bound-work-ledger.js';
export interface NativeWorkLedgerView {
  readonly intake?: import('./native-conversation-intake.js').NativeConversationIntakeActions;
  readonly state: NativeWorkLedgerState;
  submitFile?(path: string): Promise<NativeWorkSubmissionState | undefined>;
  submissionStatus?(): Promise<NativeWorkSubmissionState | undefined>;
  retrySubmission?(): Promise<NativeWorkSubmissionState | undefined>;
  /** Drop the saved submission the host has no record of, so a corrected one can be sent. */
  discardSubmission?(): Promise<NativeWorkSubmissionState | undefined>;
  selectProject(projectId: string): void;
  /** Show the selected project's ledger; discovers the project when none is selected. */
  open(): void;
  /** Notice a host, credential or workspace change now instead of at the next request. */
  sync(): void;
  /** Stop showing the ledger. The selection and running submissions or intakes are kept. */
  close(): void;
  /** End everything: actions in flight, the selection and the view. */
  dispose(): void;
  execute?(action: NativeWorkExecutionAction, workId: string): Promise<NativeWorkExecutionState | undefined>;
  observedExecutionAttempt?(workId: string): string | undefined;
}
