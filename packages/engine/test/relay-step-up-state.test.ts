/**
 * The step-up service's state under concurrency and its binding rules, with
 * real WebAuthn assertions (no mock crypto) and an in-memory secret store.
 */
import { describe, expect, test } from 'bun:test';
import {
  MAX_LIVE_STEP_UP_CHALLENGES,
  MAX_LIVE_STEP_UP_CHALLENGES_PER_PRINCIPAL,
  StepUpChallengeLimitError,
  StepUpService,
  encodeAssertionHeader,
} from '../platform/src/platform/relay/step-up-service.ts';
import { ORIGIN, RP_ID, makeCredential, signAssertion, u8, type SyntheticCredential } from './_helpers/step-up-assertions.ts';
import { toBase64Url } from '@goodvibes-jev/engine/transport-core/relay';

/** The call every challenge in these tests is minted for and presented on. */
const CALL = { method: 'POST', path: '/api/approvals/claim' } as const;

function makeService(): { service: StepUpService; store: Map<string, string>; writes: () => number } {
  const store = new Map<string, string>();
  let writes = 0;
  const service = new StepUpService({
    secrets: {
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => { writes += 1; store.set(key, value); },
    },
    now: () => 1_000,
  });
  return { service, store, writes: () => writes };
}

async function registerCredential(service: StepUpService, credential: SyntheticCredential, extra: { rpId?: string; origin?: string } = {}): Promise<void> {
  await service.registerCredential({
    rpId: extra.rpId ?? RP_ID,
    origin: extra.origin ?? ORIGIN,
    credentialId: credential.credentialId,
    publicKeyCose: credential.publicKeyCose,
    signCount: 0,
  });
}

/** A second credential id over its own keypair. */
async function otherCredential(idByte: number): Promise<SyntheticCredential> {
  return { ...(await makeCredential()), credentialId: toBase64Url(u8(idByte, 2, 3, 4, 5, 6, 7, 8)) };
}

describe('one assertion is good once', () => {
  test('the same assertion verified twice at the same moment passes exactly once', async () => {
    const { service } = makeService();
    const credential = await makeCredential();
    await registerCredential(service, credential);
    const minted = service.mintChallenge(CALL);
    const header = encodeAssertionHeader(await signAssertion({ credential, challenge: minted.challenge, signCount: 3 }));
    const results = await Promise.all([service.verify(header, CALL), service.verify(header, CALL), service.verify(header, CALL)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});

describe('registration and verification do not overwrite each other', () => {
  test('a credential registered while an assertion is being verified is still registered afterwards', async () => {
    const { service } = makeService();
    const first = await makeCredential();
    await registerCredential(service, first);
    const second = await otherCredential(9);
    const minted = service.mintChallenge(CALL);
    const header = encodeAssertionHeader(await signAssertion({ credential: first, challenge: minted.challenge, signCount: 4 }));
    const [verified] = await Promise.all([service.verify(header, CALL), registerCredential(service, second)]);
    expect(verified.ok).toBe(true);
    const listed = await service.listCredentials();
    expect(listed.map((c) => c.credentialId).sort()).toEqual([first.credentialId, second.credentialId].sort());
    expect(listed.find((c) => c.credentialId === first.credentialId)?.signCount).toBe(4);
  });

  test('registering a second relying party is refused while credentials exist for the first', async () => {
    const { service } = makeService();
    const first = await makeCredential();
    await registerCredential(service, first);
    const second = await otherCredential(9);
    await expect(registerCredential(service, second, { rpId: 'other.example', origin: 'https://other.example' })).rejects.toThrow(/relying party "daemon.example"/);
    // The first credential still verifies.
    const minted = service.mintChallenge(CALL);
    const header = encodeAssertionHeader(await signAssertion({ credential: first, challenge: minted.challenge }));
    expect((await service.verify(header, CALL)).ok).toBe(true);
  });

  test('a second origin for the same relying party is added, not substituted', async () => {
    const { service } = makeService();
    const first = await makeCredential();
    await registerCredential(service, first);
    const second = await otherCredential(9);
    await registerCredential(service, second, { origin: 'https://alt.daemon.example' });
    const minted = service.mintChallenge(CALL);
    const header = encodeAssertionHeader(await signAssertion({ credential: first, challenge: minted.challenge, origin: ORIGIN }));
    expect((await service.verify(header, CALL)).ok).toBe(true);
  });

  test('a removed credential can no longer verify', async () => {
    const { service } = makeService();
    const first = await makeCredential();
    const second = await otherCredential(9);
    await registerCredential(service, first);
    await registerCredential(service, second);
    expect(await service.removeCredential(second.credentialId)).toBe(true);
    expect(await service.removeCredential(second.credentialId)).toBe(false);
    const minted = service.mintChallenge(CALL);
    const header = encodeAssertionHeader(await signAssertion({ credential: second, challenge: minted.challenge }));
    expect(await service.verify(header, CALL)).toEqual({ ok: false, reason: 'no-credential' });
    expect((await service.listCredentials()).map((c) => c.credentialId)).toEqual([first.credentialId]);
  });
});

describe('a challenge is good for the request it was minted for', () => {
  async function presented(binding: Parameters<StepUpService['mintChallenge']>[0]): Promise<{ service: StepUpService; header: string }> {
    const { service } = makeService();
    const credential = await makeCredential();
    await registerCredential(service, credential);
    const minted = service.mintChallenge(binding);
    return { service, header: encodeAssertionHeader(await signAssertion({ credential, challenge: minted.challenge })) };
  }

  test('a challenge minted for session a is refused for session b and accepted for a', async () => {
    const { service, header } = await presented({ method: 'POST', path: '/api/sessions/a/close', sessionId: 'a' });
    expect(await service.verify(header, { method: 'POST', path: '/api/sessions/b/close', sessionId: 'b' })).toEqual({ ok: false, reason: 'challenge-unbound' });
    // A refusal on binding does not burn the challenge.
    expect((await service.verify(header, { method: 'POST', path: '/api/sessions/a/close', sessionId: 'a' })).ok).toBe(true);
  });

  test('a challenge minted for one path is refused for another', async () => {
    const { service, header } = await presented({ method: 'post', path: '/api/approvals/claim' });
    expect(await service.verify(header, { method: 'POST', path: '/api/sessions/register' })).toEqual({ ok: false, reason: 'challenge-unbound' });
    expect((await service.verify(header, { method: 'POST', path: '/api/approvals/claim' })).ok).toBe(true);
  });

  test('a bound challenge is refused when no request context is given', async () => {
    const { service, header } = await presented({ ...CALL, rendezvousId: 'rid-1' });
    expect(await service.verify(header)).toEqual({ ok: false, reason: 'challenge-unbound' });
  });

  test('a challenge minted without a method and path authorises no call', async () => {
    const { service, header } = await presented({});
    expect(await service.verify(header, { method: 'DELETE', path: '/api/anything' })).toEqual({ ok: false, reason: 'challenge-unbound' });
  });

  test('a challenge minted by one principal is refused for another and accepted for its own', async () => {
    const { service, header } = await presented({ ...CALL, principalId: 'pairing:a' });
    expect(await service.verify(header, { ...CALL, principalId: 'pairing:b' })).toEqual({ ok: false, reason: 'challenge-unbound' });
    expect((await service.verify(header, { ...CALL, principalId: 'pairing:a' })).ok).toBe(true);
  });
});

describe('a call without an assertion is told what would get it through', () => {
  test('with no passkey registered the refusal is no-credential, with one it is assertion-missing', async () => {
    const { service } = makeService();
    expect(await service.verify(null, CALL)).toEqual({ ok: false, reason: 'no-credential' });
    await registerCredential(service, await makeCredential());
    expect(await service.verify(null, CALL)).toEqual({ ok: false, reason: 'assertion-missing' });
  });
});

describe('an accepted assertion writes the counter only when it advanced', () => {
  test('secret-store writes per accepted call: 0 for a passkey that reports 0, 1 when the counter advances', async () => {
    const { service, writes } = makeService();
    const credential = await makeCredential();
    await registerCredential(service, credential);
    const before = writes();
    const still = service.mintChallenge(CALL);
    expect((await service.verify(encodeAssertionHeader(await signAssertion({ credential, challenge: still.challenge, signCount: 0 })), CALL)).ok).toBe(true);
    expect(writes() - before).toBe(0);
    const advanced = service.mintChallenge(CALL);
    expect((await service.verify(encodeAssertionHeader(await signAssertion({ credential, challenge: advanced.challenge, signCount: 2 })), CALL)).ok).toBe(true);
    expect(writes() - before).toBe(1);
  });
});

describe('the challenge store is bounded', () => {
  test('minting past the limit is refused until challenges are used or expire', () => {
    const { service } = makeService();
    for (let i = 0; i < MAX_LIVE_STEP_UP_CHALLENGES; i++) service.mintChallenge({ principalId: `p${i}` });
    expect(() => service.mintChallenge({ principalId: 'late' })).toThrow(StepUpChallengeLimitError);
  });

  test('one caller filling its own cap does not lock out another caller', () => {
    const { service } = makeService();
    for (let i = 0; i < MAX_LIVE_STEP_UP_CHALLENGES_PER_PRINCIPAL; i++) service.mintChallenge({ principalId: 'looping-reader', ttlMs: 300_000 });
    expect(() => service.mintChallenge({ principalId: 'looping-reader' })).toThrow(StepUpChallengeLimitError);
    expect(service.mintChallenge({ principalId: 'admin' }).challengeId).toBeString();
  });
});
