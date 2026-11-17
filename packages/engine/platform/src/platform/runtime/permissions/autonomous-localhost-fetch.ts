/** One recorded, exact-hop localhost admission. Never a persistent trust grant. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { snapshotJudgmentInput } from '../../gate/judgment-input.js';
import { currentExternalOperationSource } from '../../permissions/external-operation-scope.js';
import { extractHostname } from '../../tools/fetch/trust-tiers.js';
import { admitExternalRequest } from '../../permissions/external-request.js';
import type { FetchUrlInput } from '../../tools/fetch/schema.js';
import { logAdmissionFailure } from './admission-failure.js';
import { openAutonomousAdmission, type AutonomousAdmissionScope } from './autonomous-admission.js';
import type { AutonomousToolPromptHost } from './autonomous-tool-prompts.js';
import type { LocalhostFetchApprovalInput, LocalhostFetchExecutionContext, LocalhostFetchPermit } from './localhost-fetch-approval.js';

/**
 * The request as the decision reads it: everything but the body, which is
 * named by its size and digest. A body is data for the dev server, not
 * something to judge, and sending it would grow the decision input with it.
 */
function describedRequest(request: FetchUrlInput): Record<string, unknown> {
  const { body, body_base64: base64, body_data: data, ...rest } = request;
  const bytes = typeof body === 'string' ? Buffer.from(body)
    : typeof base64 === 'string' ? Buffer.from(base64, 'base64')
      : data !== undefined ? Buffer.from(JSON.stringify(data)) : undefined;
  return bytes === undefined ? rest
    : { ...rest, bodyBytes: bytes.byteLength, bodySha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function admitLocalhostFetch(host: AutonomousToolPromptHost, input: LocalhostFetchApprovalInput,
  execution?: LocalhostFetchExecutionContext): Promise<LocalhostFetchPermit | false> {
  const operation = currentExternalOperationSource();
  const executionAssert = execution?.assertCurrent;
  if (!operation || !executionAssert || !input.request || !input.originalRequest) return false;
  if (input.request.url !== input.url || extractHostname(input.url) !== input.host) return false;
  // These schema-declared inline fields are credentials even when their names
  // (token/key) also have innocent meanings in other tools.
  const auth = input.originalRequest.auth;
  if (auth && [auth.token, auth.password, auth.key].some(value => typeof value === 'string' && value.length > 0)) return false;
  let scope: AutonomousAdmissionScope | undefined;
  let admission: Awaited<ReturnType<typeof admitExternalRequest>> | undefined;
  let transferred = false;
  try {
    scope = await openAutonomousAdmission(host, operation, { signal: execution.signal, assertCurrent: executionAssert }, 'read', 'Localhost fetch');
    if (!scope) return false;
    const opened = scope;
    // The original model input must pass the normal protected-material boundary.
    const originalRequest = snapshotJudgmentInput(input.originalRequest, 'fetch');
    const preparedNames = new Set(Object.keys(input.request.headers ?? {}).map(name => name.toLowerCase()));
    const credentialNames = new Set((input.credentialHeaders ?? []).map(name => name.toLowerCase()).filter(name => preparedNames.has(name)));
    const headers = Object.fromEntries(Object.entries(input.request.headers ?? {}).filter(([name]) => !credentialNames.has(name.toLowerCase())));
    // The prepared hop is built by the fetch runtime from values only it holds and
    // fetches with those same values, so it is captured here once.
    const request = snapshotJudgmentInput({ ...input.request, headers }, 'fetch') as FetchUrlInput;
    opened.assertCurrent();
    admission = await admitExternalRequest(host, { connectionId: randomUUID(), destination: input.url, signal: opened.signal, assertCurrent: opened.assertCurrent }, operation, {
      tool: 'fetch', args: {
        urls: [describedRequest(request)],
        // The model's own request only when the prepared hop differs from it (a redirect or a resolved header).
        ...(isDeepStrictEqual(originalRequest, request) ? {} : { originalRequest: describedRequest(originalRequest as FetchUrlInput) }),
        credentialHeaderNames: [...credentialNames],
        localhostAdmission: 'This exact prepared hop only; does not allow future requests or alter project trust.',
      },
    }, opened);
    opened.assertCurrent();
    if (!admission.result.approved) return false;
    const owned = admission;
    const permit: LocalhostFetchPermit = Object.freeze({ signal: opened.signal, assertCurrent: opened.assertCurrent,
      claim() { opened.assertCurrent(); owned.claim(); },
      close() { owned.close(); opened.close(); },
    });
    transferred = true;
    return permit;
  } catch (error) { logAdmissionFailure('localhost fetch', error); return false; }
  finally { if (!transferred) { admission?.close(); scope?.close(); } }
}
