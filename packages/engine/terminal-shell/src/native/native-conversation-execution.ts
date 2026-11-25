import { nativeWorkExecutionSnapshotSchema, type NativeWorkExecutionIdentity, type NativeWorkExecutionSnapshot, type OperatorNativeWorkExecutionClient } from '@goodvibes/engine/platform/platform/workflow/work-ledger/native-execution-client';
import type { NativeConversationIntakeWorkReceipt } from '@goodvibes/engine/platform/platform/workflow/work-ledger/native-intake-client';
import type { NativeIntakeExecutionIntent } from './types.js';
import type { NativeWorkExecutionState } from './native-work-execution.js';

export const nativeConversationExecutionIntent = (receipt: NativeConversationIntakeWorkReceipt): NativeIntakeExecutionIntent => ({
  sourceRevision: receipt.source.sourceRevision,
  target: { workId: receipt.workId, attemptId: receipt.attemptId, expectedRevision: { ...receipt.expectedRevision } },
});
export const sameNativeExecutionIntent = (left: NativeIntakeExecutionIntent, right: NativeIntakeExecutionIntent): boolean => JSON.stringify(left) === JSON.stringify(right);
const notFound = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'NATIVE_EXECUTION_NOT_FOUND';

const sameRevisions = (left: NativeWorkExecutionIdentity['expectedRevision'], right: NativeWorkExecutionIdentity['expectedRevision']): boolean => left.work === right.work && left.criteria === right.criteria && left.attempt === right.attempt;

function validate(snapshot: NativeWorkExecutionSnapshot, projectId: string, target: NativeWorkExecutionIdentity, action: 'status' | 'start'): NativeWorkExecutionSnapshot {
  const result = nativeWorkExecutionSnapshotSchema.parse(snapshot);
  if (result.projectId !== projectId || result.workId !== target.workId || result.attemptId !== target.attemptId
    || (action === 'start' && !sameRevisions(result.expectedRevision, target.expectedRevision))) throw new Error('Native execution target changed');
  return result;
}
function observed(snapshot: NativeWorkExecutionSnapshot, action: 'status' | 'start', target: NativeWorkExecutionIdentity): NativeWorkExecutionState {
  return { workId: snapshot.workId, action, busy: false, snapshot,
    message: !sameRevisions(snapshot.expectedRevision, target.expectedRevision)
      ? 'The work changed since your message made it, so nothing was started or resumed from here. Look at it in Work.'
      : snapshot.recovery === 'required' ? 'The work stopped halfway. Look at it in Work, where you can go on with it.'
      : snapshot.kind === 'pending-intent' ? 'The work is starting.'
      : 'The work runs; its results are checked when it ends. Follow it in Work.' };
}

/** Read-only reconciliation cannot create, resume or rewrite an execution. */
export async function inspectNativeConversationExecution(client: OperatorNativeWorkExecutionClient, projectId: string, intent: NativeIntakeExecutionIntent, signal: AbortSignal): Promise<NativeWorkExecutionState> {
  try { return observed(validate(await client.status(intent.target, { signal }), projectId, intent.target, 'status'), 'status', intent.target); }
  catch (error) { return { workId: intent.target.workId, action: 'status', busy: false,
    message: notFound(error) ? 'Your message became work that has not started. Try it again in Work, under Unanswered, to start it.'
      : 'Whether the work runs could not be read; nothing was started again. Look at it in Work.' };
  }
}

/** Call only after the exact intent is durably confirmed. Never resume here. */
export async function dispatchNativeConversationExecution(client: OperatorNativeWorkExecutionClient, projectId: string, intent: NativeIntakeExecutionIntent, signal: AbortSignal): Promise<NativeWorkExecutionState> {
  try { return observed(validate(await client.status(intent.target, { signal }), projectId, intent.target, 'status'), 'status', intent.target); }
  catch (error) {
    if (!notFound(error) || signal.aborted) return { workId: intent.target.workId, action: 'status', busy: false, message: 'Whether the work runs could not be read, so it was not started. Look at it in Work.' };
  }
  try { return observed(validate(await client.start(intent.target, { signal }), projectId, intent.target, 'start'), 'start', intent.target); }
  catch {
    if (signal.aborted) return { workId: intent.target.workId, action: 'start', busy: false, message: 'The work\'s start was interrupted. Look at it in Work before starting it again.' };
    // A lost acknowledgement may already have committed the same host intent.
    // Reconcile once by reading; never send an automatic second start.
    const status = await inspectNativeConversationExecution(client, projectId, intent, signal);
    return { ...status, message: status.snapshot ? status.message : 'Whether the work started is not known. Look at it in Work before starting it again.' };
  }
}
