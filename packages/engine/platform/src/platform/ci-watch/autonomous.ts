import { captureNativeCiWatchOwner, nativeCiWatchOwner } from './native-owner.js';
import { ciRepairPrompt } from './repair-prompt.js';
/** Watch-owned repair decisions. CI output describes failure; it never authorizes work. */
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import { captureAutonomousSource, retainAutonomousSource } from '../permissions/autonomous.js';
import { admitExternalRequest, type ExternalOperationSource, type ExternalPermissionHost } from '../permissions/external-request.js';
import { withExternalOperationSource } from '../permissions/external-operation-scope.js';
import type { CiWatchSubscription, FixSessionBrief, FixSessionStarter } from './types.js';

/** Capture while the triggering operation still owns its source, before any detached await. */
export function captureCiWatchOwner(operation: ExternalOperationSource | undefined): ExternalOperationSource | undefined {
  if (!operation) return undefined;
  const native = captureNativeCiWatchOwner(operation);
  if (native) return native;
  operation.assertCurrent(); operation.signal?.throwIfAborted();
  const source = captureAutonomousSource(operation.sourceOf());
  const sourceIsCurrent = retainAutonomousSource(source);
  const assertCurrent = () => {
    operation.assertCurrent(); operation.signal?.throwIfAborted();
    if (!sourceIsCurrent(operation.sourceOf())) throw new Error('CI watch original source changed');
  };
  const inputFacts = operation.inputFacts ? snapshotJudgmentInput(operation.inputFacts) as readonly Readonly<Record<string, unknown>>[] : undefined;
  return Object.freeze({ ...(inputFacts ? { inputFacts } : {}), sourceOf() { assertCurrent(); return source; }, assertCurrent,
    ...(operation.signal ? { signal: operation.signal } : {}) });
}

export interface CiRepairRequest {
  readonly subscription: CiWatchSubscription;
  readonly brief: FixSessionBrief;
  readonly operation?: ExternalOperationSource | undefined;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly claimRepair: () => void;
  readonly refreshCurrent: () => Promise<void>;
}

export async function startAdmittedCiRepair(host: ExternalPermissionHost | undefined, input: CiRepairRequest, starter: FixSessionStarter) {
  if (!host || !input.operation) return { error: 'CI repair has no current original-source admission owner' };
  const operation = input.operation;
  const assertCurrent = () => { input.signal.throwIfAborted(); input.assertCurrent(); operation.assertCurrent(); };
  assertCurrent();
  if (!input.brief.jobs?.length) return { error: 'CI repair needs the failing jobs with exact commit, run, and job identities, and the brief names none' };
  const unidentified = input.brief.jobs.filter(job => !job.headSha || !job.runId || !job.jobId).map(job => job.name);
  if (unidentified.length > 0) {
    // Only GitHub Actions jobs carry a run and job identity; a failing check from another app cannot be repaired from its logs.
    return { error: `CI repair needs exact commit, run, and job identities for every failing job, and ${unidentified.join(', ')} ${unidentified.length === 1 ? 'has' : 'have'} none (not a GitHub Actions job). Fix ${unidentified.length === 1 ? 'that check' : 'those checks'} in its own system, then the repair can be offered for the remaining failures.` };
  }
  const invalidation = new AbortController();
  const unsubscribe = host.config.onDidInvalidate(() => invalidation.abort());
  const signal = AbortSignal.any([host.signal, input.signal, invalidation.signal, ...(operation.signal ? [operation.signal] : [])]);
  let admission: Awaited<ReturnType<typeof admitExternalRequest>> | undefined;
  try {
    admission = await admitExternalRequest(host, { connectionId: input.subscription.id,
    destination: `ci-watch:${input.subscription.repo}`, signal, assertCurrent }, operation, {
    tool: 'agent', args: { mode: 'spawn', task: ciRepairPrompt(input.brief),
      triggeringOperationEvidence: operation.inputFacts ?? [],
      ciWatch: { watchId: input.subscription.id, repo: input.subscription.repo, ref: input.subscription.ref,
        prNumber: input.subscription.prNumber, triggerFixSession: input.subscription.triggerFixSession, failure: input.brief } },
  });
    assertCurrent();
    if (!admission.result.approved) return { error: `CI repair denied by owner policy (${admission.result.reasonCode})` };
    await input.refreshCurrent();
    assertCurrent();
    // One claim immediately precedes the owned starter; neither the flag nor logs are authority.
    admission.claim(); assertCurrent(); input.claimRepair();
    const nativeOwner = nativeCiWatchOwner(operation);
    if (nativeOwner) return nativeOwner.startRepair(input.brief);
    return await withExternalOperationSource({ ...operation,
      assertCurrent: () => { signal.throwIfAborted(); operation.assertCurrent(); },
      signal }, () => starter(input.brief));
  } finally { admission?.close(); unsubscribe(); }
}
