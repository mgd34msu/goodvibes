import { captureNativeCiWatchOwner, nativeCiWatchOwner } from './native-owner.js';
import { ciRepairPrompt } from './repair-prompt.js';
/** Watch-owned repair decisions. CI output describes failure; it never authorizes work. */
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import { captureAutonomousSource, retainAutonomousSource } from '../permissions/autonomous.js';
import { admitExternalRequest, type ExternalOperationSource, type ExternalPermissionHost } from '../permissions/external-request.js';
import { withExternalOperationSource } from '../permissions/external-operation-scope.js';
import { hasActionsIdentity } from './report.js';
import type { CiWatchSubscription, FixSessionBrief, FixSessionStartOutcome, FixSessionStarter } from './types.js';

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

/**
 * The repair is admitted for exactly the jobs it will work on, each pinned to
 * its commit, run and job, so the decision binds to one failure. A failing
 * check from another app carries no such identity; it is left out of the
 * admitted brief and named in the start notice, and refused only when nothing
 * else failed. A refusal here is `refused`: it would come again for the same failure.
 */
export async function startAdmittedCiRepair(host: ExternalPermissionHost | undefined, input: CiRepairRequest, starter: FixSessionStarter): Promise<FixSessionStartOutcome> {
  if (!host || !input.operation) return { error: 'CI repair has no current original-source admission owner', refused: true };
  const operation = input.operation;
  const assertCurrent = () => { input.signal.throwIfAborted(); input.assertCurrent(); operation.assertCurrent(); };
  assertCurrent();
  if (!input.brief.jobs?.length) return { error: 'CI repair needs the failing jobs with exact commit, run, and job identities, and the brief names none', refused: true };
  const repairable = input.brief.jobs.filter(hasActionsIdentity);
  if (repairable.length === 0) {
    const names = input.brief.jobs.map(job => job.name);
    return { error: `CI repair works on GitHub Actions jobs, and ${names.join(', ')} ${names.length === 1 ? 'is a check' : 'are checks'} from another app with no Actions run or job. Fix ${names.length === 1 ? 'it' : 'them'} in ${names.length === 1 ? 'its' : 'their'} own system.`, refused: true };
  }
  const brief: FixSessionBrief = repairable.length === input.brief.jobs.length ? input.brief
    : Object.freeze({ ...input.brief, failingJobs: Object.freeze(repairable.map(job => job.name)), jobs: Object.freeze(repairable) });
  const invalidation = new AbortController();
  const unsubscribe = host.config.onDidInvalidate(() => invalidation.abort());
  const signal = AbortSignal.any([host.signal, input.signal, invalidation.signal, ...(operation.signal ? [operation.signal] : [])]);
  let admission: Awaited<ReturnType<typeof admitExternalRequest>> | undefined;
  try {
    admission = await admitExternalRequest(host, { connectionId: input.subscription.id,
    destination: `ci-watch:${input.subscription.repo}`, signal, assertCurrent }, operation, {
    tool: 'agent', args: { mode: 'spawn', task: ciRepairPrompt(brief),
      triggeringOperationEvidence: operation.inputFacts ?? [],
      ciWatch: { watchId: input.subscription.id, repo: input.subscription.repo, ref: input.subscription.ref,
        prNumber: input.subscription.prNumber, triggerFixSession: input.subscription.triggerFixSession, failure: brief } },
  });
    assertCurrent();
    // The gate's own words for why (who or what it was refused for), never its reason code alone.
    if (!admission.result.approved) return { error: `The CI repair was refused: ${admission.result.detail ?? admission.result.decision?.reason ?? admission.result.reasonCode}`, refused: true };
    await input.refreshCurrent();
    assertCurrent();
    // One claim immediately precedes the owned starter; neither the flag nor logs are authority.
    admission.claim(); assertCurrent(); input.claimRepair();
    const nativeOwner = nativeCiWatchOwner(operation);
    if (nativeOwner) return nativeOwner.startRepair(brief);
    const started = await withExternalOperationSource({ ...operation,
      assertCurrent: () => { signal.throwIfAborted(); operation.assertCurrent(); },
      signal }, () => starter(brief));
    if (started === undefined) return { error: 'the fix session failed to start' };
    return typeof started === 'string' ? { sessionId: started } : started;
  } finally { admission?.close(); unsubscribe(); }
}
