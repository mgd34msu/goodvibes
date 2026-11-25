import type { NativeWorkSubmissionState } from './native-work-submission.js';

/**
 * This program's link to the daemon for work you ask for and messages you type (bound-work-ledger-host.ts): what
 * the Unanswered list in the Work place reads and acts on. The work itself is read from the daemon (`work.list`).
 */
export interface NativeWorkLedgerView {
  readonly intake?: import('./native-conversation-intake.js').NativeConversationIntakeActions;
  submitFile?(path: string): Promise<NativeWorkSubmissionState | undefined>;
  submissionStatus?(): Promise<NativeWorkSubmissionState | undefined>;
  retrySubmission?(): Promise<NativeWorkSubmissionState | undefined>;
  /** Drop the saved submission the host has no record of, so a corrected one can be sent. */
  discardSubmission?(): Promise<NativeWorkSubmissionState | undefined>;
  /** Notice a host, credential or workspace change now instead of at the next request. */
  sync(): void;
  /** End everything: actions in flight and the selection. */
  dispose(): void;
}
