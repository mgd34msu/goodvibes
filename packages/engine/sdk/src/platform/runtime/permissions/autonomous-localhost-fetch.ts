/** One recorded, exact-hop localhost admission. Never a persistent trust grant. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual, types as nodeTypes } from 'node:util';
import { captureOwnedJson, snapshotJudgmentInput } from '../../gate/judgment-input.js';
import { captureCurrentAutonomousSourceFrame } from '../../permissions/autonomous.js';
import { currentExternalOperationSource } from '../../permissions/external-operation-scope.js';
import { extractHostname } from '../../tools/fetch/trust-tiers.js';
import { admitExternalRequest } from '../../permissions/external-request.js';
import type { AutonomousToolPromptHost } from './autonomous-tool-prompts.js';
import type { LocalhostFetchApprovalInput, LocalhostFetchExecutionContext, LocalhostFetchPermit } from './localhost-fetch-approval.js';

export async function admitLocalhostFetch(host: AutonomousToolPromptHost, input: LocalhostFetchApprovalInput,
  execution?: LocalhostFetchExecutionContext): Promise<LocalhostFetchPermit | false> {
  const operation = currentExternalOperationSource();
  if (!operation || !execution?.assertCurrent || !input.request || !input.originalRequest
    || host.workspaceTrust === undefined) return false;
  const workspaceTrust = host.workspaceTrust;
  const prepareTrust = workspaceTrust?.prepareAutonomousConstraint;
  if (workspaceTrust !== null && typeof prepareTrust !== 'function') return false;
  const invalidation = new AbortController();
  const unsubscribe = host.config.onDidInvalidate(() => invalidation.abort());
  const signal = AbortSignal.any([host.signal, invalidation.signal, ...(execution.signal ? [execution.signal] : []),
    ...(operation.signal ? [operation.signal] : [])]);
  let admission: Awaited<ReturnType<typeof admitExternalRequest>> | undefined;
  let transferred = false;
  try {
    // Exact private snapshots retain the request and credential-bearing headers
    // only for this hop. They never become public revision labels.
    const originalInput = captureOwnedJson(input, nodeTypes.isProxy);
    if (input.request.url !== input.url || extractHostname(input.url) !== input.host) return false;
    // These schema-declared inline fields are credentials even when their names
    // (token/key) also have innocent meanings in other tools.
    const auth = input.originalRequest.auth;
    if (auth && [auth.token, auth.password, auth.key].some(value => typeof value === 'string' && value.length > 0)) return false;
    // The original model input must pass the normal protected-material boundary.
    const originalRequest = snapshotJudgmentInput(input.originalRequest, 'fetch');
    const preparedNames = new Set(Object.keys(input.request.headers ?? {}).map(name => name.toLowerCase()));
    const credentialNames = new Set((input.credentialHeaders ?? []).map(name => name.toLowerCase()).filter(name => preparedNames.has(name)));
    const headers = Object.fromEntries(Object.entries(input.request.headers ?? {}).filter(([name]) => !credentialNames.has(name.toLowerCase())));
    const request = snapshotJudgmentInput({ ...input.request, headers }, 'fetch');
    const source = captureCurrentAutonomousSourceFrame(operation.sourceOf()).source;
    const assertTrust = await prepareTrust?.call(workspaceTrust, 'read', signal);
    let closed = false;
    const assertCurrent = () => {
      if (closed) throw new Error('Localhost fetch admission closed');
      signal.throwIfAborted(); execution.assertCurrent!(); operation.assertCurrent(); assertTrust?.();
      if (host.workspaceTrust !== workspaceTrust || workspaceTrust?.prepareAutonomousConstraint !== prepareTrust) throw new Error('Workspace trust capability changed');
      if (!isDeepStrictEqual(captureOwnedJson(input, nodeTypes.isProxy), originalInput)
        || !isDeepStrictEqual(captureCurrentAutonomousSourceFrame(operation.sourceOf()).source, source)) throw new Error('Localhost fetch source or request changed');
    };
    assertCurrent();
    admission = await admitExternalRequest(host, { connectionId: randomUUID(), destination: input.url, signal, assertCurrent }, operation, {
      tool: 'fetch', args: { urls: [request], originalRequest, credentialHeaderNames: [...credentialNames],
        localhostAdmission: 'This exact prepared hop only; does not allow future requests or alter project trust.' },
    });
    assertCurrent();
    if (!admission.result.approved) return false;
    const owned = admission;
    const permit: LocalhostFetchPermit = Object.freeze({ signal, assertCurrent,
      claim() { assertCurrent(); owned.claim(); assertCurrent(); },
      close() { if (!closed) { closed = true; owned.close(); unsubscribe(); } },
    });
    transferred = true;
    return permit;
  } catch { return false; }
  finally { if (!transferred) { admission?.close(); unsubscribe(); } }
}
