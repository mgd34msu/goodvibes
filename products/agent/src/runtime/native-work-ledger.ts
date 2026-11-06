import type { NativeWorkSubmissionState } from './native-work-submission.ts';
import type { NativeWorkExecutionAction, NativeWorkExecutionState } from './native-work-execution.ts';
import type { NativeWorkLedgerState } from '@goodvibes-jev/engine/terminal-shell/native/bound-work-ledger';
export {
  BoundWorkLedgerModel as NativeWorkLedgerModel,
  type NativeWorkLedgerState,
} from '@goodvibes-jev/engine/terminal-shell/native/bound-work-ledger';
export type { NativeWorkLedgerBinding } from '@goodvibes-jev/engine/terminal-shell/native/work-ledger-projection';

export interface NativeWorkLedgerView {
  readonly intake?: import('./native-conversation-intake.ts').NativeConversationIntakeActions;
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
