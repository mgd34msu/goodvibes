import type { NativeWorkSubmissionState } from './native-work-submission.js';
import type { NativeWorkExecutionAction, NativeWorkExecutionState } from './native-work-execution.js';
import type { NativeWorkLedgerState } from './bound-work-ledger.js';
export interface NativeWorkLedgerView {
  readonly intake?: import('./native-conversation-intake.js').NativeConversationIntakeActions;
  readonly state: NativeWorkLedgerState;
  submitFile?(path: string): Promise<NativeWorkSubmissionState | undefined>;
  submissionStatus?(): Promise<NativeWorkSubmissionState | undefined>;
  retrySubmission?(): Promise<NativeWorkSubmissionState | undefined>;
  selectProject(projectId: string): void;
  open(): void;
  sync(): void;
  close(): void;
  execute?(action: NativeWorkExecutionAction, workId: string): Promise<NativeWorkExecutionState | undefined>;
}
