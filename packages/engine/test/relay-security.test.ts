/**
 * A call that arrives over the relay needs the owner's WebAuthn step-up by what
 * it does, not by its HTTP verb: the daemon's own method catalog decides
 * whether the addressed method writes. A read invoked by POST runs without an
 * assertion; a write bound to GET is refused without one. The verifier is the
 * stand-in (WebAuthn needs the owner's authenticator); it records the request
 * facts it was asked to bind the assertion to, so an assertion for one call
 * cannot be judged against another's.
 */
import { describe, expect, test } from 'bun:test';
import { RELAY_VIA_HEADER } from '../daemon-api/src/relay-registration.js';
import { STEP_UP_ASSERTION_HEADER, type StepUpAssertionVerifier } from '../platform/src/platform/relay/step-up-policy.js';
import { relayRequestFactsFrom, wrapDispatchWithStepUp } from '../platform/src/platform/relay/daemon-wiring.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';

const relayed = (path: string, method: string, assertion?: string): Request =>
  new Request(`http://daemon.local${path}`, { method, headers: { [RELAY_VIA_HEADER]: '1', ...(assertion ? { [STEP_UP_ASSERTION_HEADER]: assertion } : {}) } });

/** The real catalog and the facts the daemon builds from it (daemon/facade.ts). */
const facts = relayRequestFactsFrom(new GatewayMethodCatalog(), () => ({ principal: { principalId: 'pairing:phone' } }));
const gate = { relayEnabled: () => true, requireStepUp: () => true, rendezvousId: () => 'rid-1' };

function dispatcher(verdict: Awaited<ReturnType<StepUpAssertionVerifier>>) {
  let ran = 0;
  const asked: unknown[] = [];
  const dispatch = wrapDispatchWithStepUp(async () => { ran++; return new Response('ran'); }, gate, async (assertion, context) => {
    asked.push({ assertion, ...context });
    return verdict;
  }, facts);
  return { dispatch, ran: () => ran, asked };
}

describe('relay step-up is decided by what the call does', () => {
  test('a write bound to GET, and a write by POST, are refused without a verified assertion and never run', async () => {
    const { dispatch, ran } = dispatcher({ ok: false, reason: 'assertion-missing' });
    for (const [path, method] of [['/api/devices/artifacts', 'GET'], ['/api/approvals/a1/approve', 'POST'], ['/api/control-plane/methods/approvals.approve/invoke', 'POST']] as const) {
      const response = (await dispatch(relayed(path, method)))!;
      expect(response.status, `${method} ${path}`).toBe(401);
      expect((await response.json() as { code?: string }).code).toBe('step-up-required');
    }
    expect(ran()).toBe(0);
  });

  test('a verified assertion lets the write run, and the verifier is asked about this exact call and principal', async () => {
    const { dispatch, ran, asked } = dispatcher({ ok: true });
    expect((await dispatch(relayed('/api/devices/artifacts', 'GET', 'signed')))!.status).toBe(200);
    expect(ran()).toBe(1);
    expect(asked).toEqual([{ assertion: 'signed', method: 'GET', path: '/api/devices/artifacts', rendezvousId: 'rid-1', principalId: 'pairing:phone' }]);
  });
});
