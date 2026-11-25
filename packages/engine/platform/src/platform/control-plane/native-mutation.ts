/**
 * A call made with the Agent's credential is admitted natively: only the
 * host's recorded decision permits the mutation. Who called is the transport's
 * fact, never a body field, so every call of that kind is judged alike.
 */
import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { types as nodeTypes } from 'node:util';
import { admitExternalRequest, type ExternalPermissionHost } from '../permissions/external-request.js';
import { captureOwnedJson, snapshotJudgmentInput } from '../gate/judgment-input.js';
import type { HandlerContextEnvelope } from './host-handlers.js';
import { requireConfirmation } from './confirmation-gate.js';
import { GatewayVerbError } from './routes/gateway-verb-error.js';
import type { MutationPublication } from '../utils/file-mutation.js';
import type { ToolExecutionEffect } from '../tools/registry.js';
import type { RetainedAutomationJobTarget } from '../automation/job-mutations.js';
import { projectAutomationTargetRequest } from '../automation/job-mutations.js';
import { missingScopes } from '@goodvibes/engine/daemon-api/route-helpers';
import { NATIVELY_ADMITTED_METHOD_IDS } from './native-admission-methods.js';
import { logger } from '../utils/logger.js';

export type NativeMutationHost = ExternalPermissionHost;
export interface NativeMutationAdmission { readonly kind: 'native-recorded-mutation'; }
const nativeAdmissions = new WeakMap<NativeMutationAdmission, {
  readonly invocation: object | undefined;
  readonly method: string;
  readonly source: { readonly goal: string; readonly criteria: readonly string[] };
  readonly assertCurrent: () => void;
  readonly withPublication: MutationPublication;
}>();

/** In-process only. A copied object, JSON body, or arbitrary callback never grants this evidence. */
export function readNativeMutationAdmission(token: NativeMutationAdmission, invocation: object) {
  const admission = nativeAdmissions.get(token);
  if (!admission || admission.invocation !== invocation) throw new Error('Unknown native mutation admission');
  admission.assertCurrent(); return admission;
}

/**
 * Whether the caller is the GoodVibes Agent acting on the owner's behalf: the
 * transport authenticated it with the Agent's credential (`agent`). Such a
 * call takes recorded native admission; any other caller takes its method's
 * own confirmation rule.
 */
export function isDelegatedCaller(context: { readonly credentialKind?: string | undefined }): boolean {
  return context.credentialKind === 'agent';
}

/** Native path identity stays local, including replacement with equal database bytes. */
export function retainMutationStorage(path: string, workspace: string): () => void {
  const root = realpathSync(workspace);
  const rootStat = lstatSync(root, { bigint: true });
  const identity = () => {
    try {
      const file = lstatSync(path, { bigint: true });
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('Invalid native mutation storage');
      return [realpathSync(path), file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 'absent';
      throw error;
    }
  };
  let ancestor = dirname(path);
  for (;;) {
    try { realpathSync(ancestor); break; } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      const parent = dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent;
    }
  }
  const parent = realpathSync(ancestor), parentStat = lstatSync(parent, { bigint: true });
  const before = identity();
  return () => {
    const currentRoot = lstatSync(realpathSync(workspace), { bigint: true });
    const currentParent = lstatSync(realpathSync(ancestor), { bigint: true });
    if (realpathSync(workspace) !== root || currentRoot.dev !== rootStat.dev || currentRoot.ino !== rootStat.ino
      || realpathSync(ancestor) !== parent || currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino
      || identity() !== before) throw new GatewayVerbError('Native mutation target changed', 'NATIVE_MUTATION_STALE', 409);
  };
}

export async function runNativeMutation<T>(input: {
  readonly host?: NativeMutationHost | undefined;
  readonly method: string;
  readonly body: unknown;
  readonly context: HandlerContextEnvelope;
  readonly invocation?: object | undefined;
  readonly target: unknown;
  readonly automationTarget?: RetainedAutomationJobTarget | undefined;
  readonly assertTargetCurrent: () => void;
  readonly scopes?: readonly string[] | undefined;
  readonly confirmation?: 'required' | 'none' | undefined;
  /** Native registrar selection, never inferred from the remote body. */
  readonly effect?: ToolExecutionEffect | undefined;
  readonly mutate: (assertCurrent: () => void, admission?: NativeMutationAdmission, withPublication?: MutationPublication) => Promise<T>;
}): Promise<T> {
  const { body, context } = input;
  // The list the sending program reads to leave this decision to the daemon (native-admission-methods.ts).
  if (!NATIVELY_ADMITTED_METHOD_IDS.has(input.method)) {
    logger.error('[native-mutation] a natively admitted method is missing from NATIVELY_ADMITTED_METHOD_IDS; a model call to it is decided twice', { method: input.method });
  }
  if (!isDelegatedCaller(context)) {
    if (input.confirmation !== 'none') requireConfirmation('owner-request', input.method, body, context);
    const current = () => { context.signal?.throwIfAborted(); };
    current(); return input.mutate(current);
  }
  const host = input.host, authority = context.nativeExecutionAuthority, expected = authority?.current();
  const scopes = input.scopes ?? ['write:channels'];
  const effect = input.effect ?? 'write';
  if (!host || host.workspaceTrust === undefined || !authority || !expected || !context.admin || context.principalKind !== 'token'
    || context.principalId !== expected.principalId || expected.kind !== 'pairing-token'
    || missingScopes(context.scopes, scopes).length > 0
    || missingScopes(expected.scopes, scopes).length > 0
    || context.isAuthorized?.(scopes) !== true) {
    throw new GatewayVerbError('Native mutation requires current paired owner access and native write scopes', 'NATIVE_MUTATION_FORBIDDEN', 403);
  }
  // The body is read once, here; the judged request is this copy.
  const original = captureOwnedJson(body, nodeTypes.isProxy);
  const automationTarget = input.automationTarget;
  const request = automationTarget === undefined ? original
    : projectAutomationTargetRequest(automationTarget, input.method, original);
  const args = { method: input.method, request: snapshotJudgmentInput(request), selectedTarget: snapshotJudgmentInput(input.target) };
  const invalidation = new AbortController();
  const unsubscribe = host.config.onDidInvalidate(() => invalidation.abort());
  // One signal says the authority ended: the request, the host or the config went away.
  const signal = AbortSignal.any([host.signal, invalidation.signal, ...(context.signal ? [context.signal] : [])]);
  const source = Object.freeze({ goal: `Perform the authenticated native request ${input.method}.`, criteria: Object.freeze([
    'Apply exactly the complete authenticated request to the retained selected target.',
    'Honor current paired owner, admin, write scope, workspace, privacy and permission constraints.',
    effect === 'send' ? 'Deliver only the complete retained message to the exact retained destination; do not purchase or select additional targets.'
      : 'This request does not authorize message delivery, purchases or additional targets.',
  ]) });
  // The pairing owner states revocation and narrowing: a revoked or re-issued
  // token yields no snapshot, and a narrowed one loses the scope.
  const assertPaired = () => {
    const fresh = authority.current();
    if (!fresh || fresh.tokenId !== expected.tokenId || fresh.authorityRevision !== expected.authorityRevision
      || missingScopes(fresh.scopes, scopes).length > 0) {
      throw new GatewayVerbError('Native mutation paired owner changed', 'NATIVE_MUTATION_STALE', 409);
    }
  };
  const assertCurrent = () => {
    signal.throwIfAborted(); assertPaired();
    automationTarget?.assertCurrent();
  };
  try {
    assertCurrent();
    const admission = await admitExternalRequest(host, { connectionId: randomUUID(), destination: input.method, signal, assertCurrent: () => signal.throwIfAborted() },
      { sourceOf: () => source, assertCurrent, signal }, { tool: effect === 'send' ? 'send_message' : 'write', args, effect,
        serverPolicy: { principalKind: 'paired-token', admin: true, scopes, effect, method: input.method } }).catch(error => {
          // Before claim, the original native source can identify retirement
          // hidden by a failed reading. No effect has been attempted here.
          assertCurrent(); throw error;
        });
    try {
      if (!admission.result.approved) {
        throw new GatewayVerbError('Native mutation was not admitted', 'NATIVE_MUTATION_HELD', 422);
      }
      admission.claim();
      let active = true;
      const current = () => { if (!active) throw new Error('Native mutation admission retired'); admission.assertCurrent(); };
      // Staging and hosted admission remain outside the pairing owner's lock.
      // Only the actual native writer calls this private publication keeper,
      // and the selected target is checked there, once, at commit.
      const withPublication: MutationPublication = async operation => {
        current();
        return authority.withCurrent(expected, async assertPublication => {
          const publicationCurrent = () => { assertPublication(); current(); };
          publicationCurrent(); input.assertTargetCurrent();
          const result = await operation(publicationCurrent);
          // The exact writer owns its selected-target transition. Rechecking
          // the old target after publication would reject the intended effect.
          assertPublication(); signal.throwIfAborted(); return result;
        });
      };
      const token: NativeMutationAdmission = Object.freeze({ kind: 'native-recorded-mutation' });
      nativeAdmissions.set(token, Object.freeze({ invocation: input.invocation, method: input.method, source,
        assertCurrent: current, withPublication }));
      try { input.assertTargetCurrent(); return await input.mutate(current, token, withPublication); }
      finally { active = false; nativeAdmissions.delete(token); }
    } finally { admission.close(); }
  } finally { unsubscribe(); }
}
