import type { NativeWorkExecutionIdentity } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-execution-client';

export interface NativeIntakeExecutionIntent {
  readonly sourceRevision: string;
  readonly target: NativeWorkExecutionIdentity;
}
