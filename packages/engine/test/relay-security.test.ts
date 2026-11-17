// Proves: A write that arrives over the relay runs without the owner's step-up, or an assertion for one call is accepted for another.
// Red when: Step-up is decided by HTTP verb, so a write bound to GET or sent through generic invoke runs without an assertion, or the verifier is not given this call's method, path, rendezvous and principal.
// Proves: A step-up assertion is accepted twice, after it expired, from another principal, for another call or with a wrong signature.
// Red when: StepUpService stops marking a challenge consumed or stops binding it to principal, path and time.
/**
 * A call that arrives over the relay needs the owner's WebAuthn step-up by what
 * it does, not by its HTTP verb: the daemon's own method catalog decides
 * whether the addressed method writes. A read invoked by POST runs without an
 * assertion; a write bound to GET is refused without one. The gate cases use a
 * stand-in verifier that records the request facts it was asked to bind the
 * assertion to, so an assertion for one call cannot be judged against another's.
 *
 * The verifier itself is the real StepUpService over a real secret store, with
 * a P-256 key pair made in the test in place of the owner's passkey (it reports
 * a zero signature counter, as many passkeys do, so only the service's own
 * single-use rule stands between a replay and a second run).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toBase64Url } from '@goodvibes-jev/engine/transport-core/relay';
import { RELAY_VIA_HEADER } from '../daemon-api/src/relay-registration.js';
import { STEP_UP_ASSERTION_HEADER, type StepUpAssertionVerifier } from '../platform/src/platform/relay/step-up-policy.js';
import { relayRequestFactsFrom, wrapDispatchWithStepUp } from '../platform/src/platform/relay/daemon-wiring.js';
import { encodeAssertionHeader, StepUpService, type MintedStepUpChallenge } from '../platform/src/platform/relay/step-up-service.js';
import { SecretsManager } from '../platform/src/platform/config/secrets.ts';
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

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const RP_ID = 'owner.example';
const ORIGIN = 'https://owner.example';
const bytes = (data: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(data) as Uint8Array<ArrayBuffer>;

/** ASN.1 DER of a raw r||s ECDSA signature, as an authenticator hands it over. */
function derSignature(raw: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const integer = (part: Uint8Array): number[] => {
    let start = 0;
    while (start < part.length - 1 && part[start] === 0) start++;
    const body = [...part.subarray(start)];
    if (body[0]! & 0x80) body.unshift(0);
    return [0x02, body.length, ...body];
  };
  const sequence = [...integer(raw.subarray(0, 32)), ...integer(raw.subarray(32))];
  return bytes(Uint8Array.from([0x30, sequence.length, ...sequence]));
}

/** A passkey made in the test: its COSE public key, and a signer for one challenge. */
async function passkey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const point = bytes(await crypto.subtle.exportKey('raw', pair.publicKey));
  const cose = bytes(Uint8Array.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20, ...point.subarray(1, 33), 0x22, 0x58, 0x20, ...point.subarray(33)]));
  const sign = async (minted: MintedStepUpChallenge): Promise<string> => {
    const rpIdHash = bytes(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RP_ID)));
    const authenticatorData = bytes(Uint8Array.from([...rpIdHash, 0x05, 0, 0, 0, 0]));
    const clientDataJSON = bytes(new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: minted.challenge, origin: ORIGIN })));
    const clientDataHash = bytes(await crypto.subtle.digest('SHA-256', clientDataJSON));
    const raw = bytes(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, Uint8Array.from([...authenticatorData, ...clientDataHash])));
    return encodeAssertionHeader({
      credentialId: 'owner-passkey',
      authenticatorData: toBase64Url(authenticatorData),
      clientDataJSON: toBase64Url(clientDataJSON),
      signature: toBase64Url(derSignature(raw)),
    });
  };
  return { publicKeyCose: toBase64Url(cose), sign };
}

describe('the step-up verifier', () => {
  test('a signed assertion is accepted once, only for its call and principal, and only while its challenge is live', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gv-stepup-'));
    roots.push(home);
    let clock = 1_000_000;
    const service = new StepUpService({
      secrets: new SecretsManager({ surfaceRoot: 'goodvibes', globalHome: home, projectRoot: join(home, 'project') }),
      now: () => clock,
    });
    const owner = await passkey();
    const stranger = await passkey();
    await service.registerCredential({ rpId: RP_ID, origin: ORIGIN, credentialId: 'owner-passkey', publicKeyCose: owner.publicKeyCose });
    const call = { method: 'POST', path: '/api/approvals/a1/approve', principalId: 'pairing:phone' };
    const mint = () => service.mintChallenge({ method: call.method, path: call.path, principalId: call.principalId, ttlMs: 5_000 });

    const signed = await owner.sign(mint());
    const first = await service.verify(signed, call);
    const again = await service.verify(signed, call);
    const otherPrincipal = await service.verify(await owner.sign(mint()), { ...call, principalId: 'pairing:laptop' });
    const otherCall = await service.verify(await owner.sign(mint()), { ...call, path: '/api/devices/d1/revoke' });
    const wrongKey = await service.verify(await stranger.sign(mint()), call);
    const late = await owner.sign(mint());
    clock += 5_001;
    const expired = await service.verify(late, call);

    // A replay is refused; which of the two single-use checks says so is the service's business.
    expect({ first, again: again.ok, otherPrincipal, otherCall, wrongKey, expired }).toEqual({
      first: { ok: true },
      again: false,
      otherPrincipal: { ok: false, reason: 'challenge-unbound' },
      otherCall: { ok: false, reason: 'challenge-unbound' },
      wrongKey: { ok: false, reason: 'signature-invalid' },
      expired: { ok: false, reason: 'challenge-expired' },
    });
  });
});
