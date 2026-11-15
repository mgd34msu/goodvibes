/**
 * explicit-user-request-transport.test.ts
 *
 * "A person asked for this, right now" has to be a fact a transport asserts,
 * not a field nobody sets.
 *
 * `context.metadata.explicitUserRequest` was reachable but vestigial: nothing
 * in production populated it, so the handlers that consult it could never see
 * it. A vestigial security field is worse than none, because in review it
 * reads as protection.
 *
 * It is now set by the transports that can honestly claim it, and deliberately
 * NOT set by the ones that cannot, scheduled work, triggers and channel-driven
 * work are exactly the callers the distinction exists to separate from a live
 * human action. Nothing new is gated on it here; establishing the signal
 * honestly is the work.
 *
 * Both directions matter, so both are asserted: a claim arrives, and an absent
 * claim stays absent rather than defaulting to true.
 */

import { describe, expect, test } from 'bun:test';
import { createDaemonControlRouteHandlers, EXPLICIT_USER_REQUEST_HEADER } from '../daemon-api/src/control-routes.ts';
import { refuseNonUserRequest } from '../platform/src/platform/control-plane/routes/explicit-user-request.ts';
import { GatewayVerbError } from '../platform/src/platform/control-plane/routes/gateway-verb-error.ts';
import type { GatewayMethodInvocation } from '../platform/src/platform/control-plane/method-catalog-shared.ts';

function invocation(metadata?: Record<string, unknown>): GatewayMethodInvocation {
  return {
    body: {},
    query: {},
    context: {
      authToken: 'test-token',
      ...(metadata === undefined ? {} : { metadata }),
    },
  } as GatewayMethodInvocation;
}

type DispatchInput = Parameters<Parameters<typeof createDaemonControlRouteHandlers>[0]['invokeGatewayMethodCall']>[0];

function harness() {
  const received: DispatchInput[] = [];
  const handlers = createDaemonControlRouteHandlers({
    authToken: 'test-token',
    version: '0.0.0-test',
    sessionCookieName: 'goodvibes_session',
    controlPlaneGateway: {
      getSnapshot: () => ({}),
      renderWebUi: () => new Response('', { status: 200 }),
      listRecentEvents: () => [],
      listSurfaceMessages: () => [],
      listClients: () => [],
      createEventStream: () => new Response('', { status: 200 }),
    },
    extractAuthToken: () => 'test-token',
    resolveAuthenticatedPrincipal: () => ({ principalId: 'tester', principalKind: 'user', admin: true, scopes: [] }),
    gatewayMethods: { list: () => [], listEvents: () => [], get: () => ({ access: 'authenticated' }) },
    getOperatorContract: () => ({}),
    invokeGatewayMethodCall: async (input) => {
      received.push(input);
      return { status: 200, ok: true, body: {} };
    },
    parseOptionalJsonBody: async () => ({ body: {} }),
    requireAdmin: () => null,
    requireAuthenticatedSession: () => null,
  });
  return { handlers, received };
}

async function claimFor(header: string | null): Promise<boolean | undefined> {
  const { handlers, received } = harness();
  const headers = header === null ? {} : { [EXPLICIT_USER_REQUEST_HEADER]: header };
  await handlers.invokeGatewayMethod('email.send', new Request('http://localhost/invoke', { method: 'POST', headers }));
  expect(received).toHaveLength(1);
  return received[0]?.context?.explicitUserRequest;
}

describe('the header a transport uses to claim a live human action', () => {
  test('the header name is the one clients are told to send', () => {
    // Pinned because a rename here silently stops every claim arriving, and
    // the failure mode is invisible: everything keeps working, just less
    // safely than the code reads.
    expect(EXPLICIT_USER_REQUEST_HEADER).toBe('x-goodvibes-explicit-user-request');
  });

  test('only the literal "true" is a claim, read through the real handler', async () => {
    // The parse is deliberately strict. "1", "yes" and an empty header are all
    // callers that cannot honestly claim a human action, and a permissive
    // reading would hand the claim to exactly the automated paths the field
    // exists to distinguish.
    expect(await claimFor('true')).toBe(true);
    expect(await claimFor('TRUE')).toBe(true);
    expect(await claimFor('  true  ')).toBe(true);
    expect(await claimFor('1')).toBe(false);
    expect(await claimFor('yes')).toBe(false);
    expect(await claimFor('')).toBe(false);
    // Absent is not false, it is "did not claim", which is what a scheduled
    // run legitimately reports.
    expect(await claimFor(null)).toBeUndefined();
  });

  test('the claim reaches the dispatch on the REST verb path as well', async () => {
    const { handlers, received } = harness();
    await handlers.invokeGatewayRestVerb({
      methodId: 'email.send',
      params: {},
      req: new Request('http://localhost/api/email/send', { method: 'POST', headers: { [EXPLICIT_USER_REQUEST_HEADER]: 'yes' } }),
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.context?.explicitUserRequest).toBe(false);
  });
});

describe('what the handler does with the claim', () => {
  test('a supplied false is refused: a caller that says "not a user request" is believed', () => {
    expect(() => refuseNonUserRequest(invocation({ explicitUserRequest: false }), 'email.send'))
      .toThrow(GatewayVerbError);
  });

  test('a supplied true proceeds', () => {
    expect(() => refuseNonUserRequest(invocation({ explicitUserRequest: true }), 'email.send'))
      .not.toThrow();
  });

  test('an ABSENT claim proceeds, because scheduled work and triggers cannot make one', () => {
    // This is the ruling in code: requiring `=== true` would 403 every live
    // caller and permanently refuse the automated work these verbs are served
    // daemon-side for. `confirm: true` carries the guarantee for those.
    expect(() => refuseNonUserRequest(invocation(), 'email.send')).not.toThrow();
    expect(() => refuseNonUserRequest(invocation({}), 'email.send')).not.toThrow();
  });

  test('a non-boolean claim is ignored, not read as a claim either way', () => {
    // A string is neither the refusing `false` nor a believed `true`: it falls
    // through to the confirmation gate exactly like an absent claim. The
    // transport only ever sets booleans, so this guards a sloppy in-process caller.
    expect(() => refuseNonUserRequest(invocation({ explicitUserRequest: 'false' }), 'email.send'))
      .not.toThrow();
    expect(() => refuseNonUserRequest(invocation({ explicitUserRequest: false }), 'email.send'))
      .toThrow(GatewayVerbError);
  });
});
