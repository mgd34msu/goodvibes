/** Authenticated explicit-source submission. Host authority never comes from the body. */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodInvocation } from '../method-catalog-shared.js';
import { WORK_LEDGER_WRITE_SCOPE } from '../method-catalog-native-work-submission.js';
import { WORK_LEDGER_READ_SCOPE } from '../method-catalog-work-ledger.js';
import { NativeWorkSubmissionError, type NativeWorkSubmissionHost } from '../../workflow/work-ledger/native-submission.js';
import {
  nativeWorkSubmissionRequestSchema, nativeWorkSubmissionLookupRequestSchema,
  nativeWorkSubmissionResultSchema, nativeWorkSubmissionLookupResultSchema,
} from '../../workflow/work-ledger/native-submission-wire.js';
import { GatewayVerbError, withholdCommittedResult } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { requireNativeOwner } from './native-owner.js';
import type { WorkCause } from '../../workflow/work-ledger/work-plans.js';

const SCOPES = [WORK_LEDGER_READ_SCOPE, WORK_LEDGER_WRITE_SCOPE] as const;
function authorize(invocation: GatewayMethodInvocation) {
  // A project act (effect-authority.ts `work.write`): a paired device below an admin submits in a project given to it.
  return requireNativeOwner(invocation, SCOPES, 'Native submission', { projectAct: true });
}

/**
 * Who caused work a caller that is not the owner submitted: that caller (by its principal), so it starts, resumes and
 * stops the work it asked for, and nobody else's. Work the owner submits keeps no cause until the owner's own act records it.
 */
function submittedBy(invocation: GatewayMethodInvocation): WorkCause | undefined {
  const actor = invocation.context.actor;
  const principalId = invocation.context.principalId ?? undefined;
  const whose = actor?.agentFor ?? actor;
  if (!actor || !principalId || whose?.class === 'owner' || whose?.class === 'system') return undefined;
  return { party: 'other', who: 'a paired device, member or program that asked for it', madeFor: principalId };
}

/** Trusted daemon ledger owner. Neither handler acquires an execution graph. */
export function registerNativeWorkSubmissionGatewayMethods(catalog: GatewayMethodCatalog, host: Pick<NativeWorkSubmissionHost, 'submit' | 'get'>,
  /** Records who caused a submitted piece of work (work-plans.ts `noteCause`, as work it just made). */
  noteCause?: ((workId: string, cause: WorkCause) => void) | undefined): void {
  for (const operation of ['submit', 'get'] as const) {
    const method = operation === 'submit' ? 'workLedger.submit' : 'workLedger.submission.get';
    const descriptor = catalog.get(method);
    if (!descriptor) throw new Error(`Missing native submission descriptor: ${method}`);
    catalog.register(descriptor, async invocation => {
      try {
        const authority = authorize(invocation);
        const input = readInvocationParams(invocation);
        invocation.signal?.throwIfAborted();
        const options = { ...(invocation.signal ? { signal: invocation.signal } : {}), isAuthorized: () => invocation.isAuthorized?.(SCOPES) === true };
        if (operation === 'submit') {
          const parsed = nativeWorkSubmissionRequestSchema.safeParse(input);
          if (!parsed.success) throw new GatewayVerbError(`Invalid explicit native source: ${parsed.error.issues[0]?.message ?? 'the request does not match the submission shape'}`, 'INVALID_ARGUMENT', 400);
          const result = await host.submit(parsed.data, authority, options);
          try { authorize(invocation); } catch (revoked) { withholdCommittedResult(revoked, 'The submission was recorded.'); }
          const answered = nativeWorkSubmissionResultSchema.parse(result);
          // A caller that is not the owner asked for this work: it is that caller's, recorded now, so it starts it itself
          // (and the owner's old work stays the owner's: work-plans.ts `noteCause`).
          const cause = noteCause ? submittedBy(invocation) : undefined;
          const receipt = (answered as { readonly receipt?: { readonly workId?: unknown } }).receipt;
          if (cause && typeof receipt?.workId === 'string' && receipt.workId) {
            try { noteCause!(receipt.workId, cause); } catch { /* recorded already (a repeat of the same request): nothing to change */ }
          }
          return answered;
        }
        const parsed = nativeWorkSubmissionLookupRequestSchema.safeParse(input);
        if (!parsed.success) throw new GatewayVerbError('Invalid native submission lookup', 'INVALID_ARGUMENT', 400);
        const result = await host.get(parsed.data, authority, options);
        authorize(invocation); return nativeWorkSubmissionLookupResultSchema.parse(result);
      } catch (error) {
        if (error instanceof GatewayVerbError) throw error;
        if (error instanceof NativeWorkSubmissionError && error.code === 'workspace-refused' && error.workspace) {
          // A definite refusal found before anything was written: the caller keeps no pending request for it.
          const refusal = error.workspace.refusal;
          throw new GatewayVerbError(error.message, 'NATIVE_SUBMISSION_WORKSPACE_REFUSED', refusal.status ?? 403, undefined,
            { state: `Nothing was submitted: ${refusal.state}.`, next: refusal.next });
        }
        if (error instanceof NativeWorkSubmissionError) {
          const status = ['unsupported-authority', 'forbidden'].includes(error.code) ? 403 : error.code === 'invalid' ? 400
            : ['stale', 'conflict', 'request-conflict'].includes(error.code) ? 409 : 503;
          throw new GatewayVerbError(error.code === 'indeterminate'
            ? 'Native submission outcome is unknown. Look up the original request before retrying.'
            : error.message, `NATIVE_SUBMISSION_${error.code.replaceAll('-', '_').toUpperCase()}`, status);
        }
        throw new GatewayVerbError('Native work submission is unavailable; retain the original request identity', 'NATIVE_SUBMISSION_UNAVAILABLE', 503);
      }
    }, { replace: true });
  }
}
