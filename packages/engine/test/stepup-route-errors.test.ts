/**
 * The step-up verbs tell a caller's mistake (400) and a full challenge store
 * (429) apart from an internal failure, which is never reported as a 400.
 */
import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { GatewayVerbError } from '../platform/src/platform/control-plane/routes/gateway-verb-error.ts';
import { registerStepUpGatewayMethods } from '../platform/src/platform/control-plane/routes/stepup.ts';
import { MAX_LIVE_STEP_UP_CHALLENGES, StepUpService } from '../platform/src/platform/relay/step-up-service.ts';

function catalogFor(service: Parameters<typeof registerStepUpGatewayMethods>[1]): GatewayMethodCatalog {
  const catalog = new GatewayMethodCatalog();
  registerStepUpGatewayMethods(catalog, service);
  return catalog;
}

function memoryService(): StepUpService {
  const store = new Map<string, string>();
  return new StepUpService({
    secrets: { get: async (key) => store.get(key) ?? null, set: async (key, value) => { store.set(key, value); } },
    now: () => 1_000,
  });
}

const register = (catalog: GatewayMethodCatalog, body: Record<string, unknown>) =>
  catalog.invoke('stepup.credentials.register', { query: {}, body, context: {} } as never);

describe('stepup.credentials.register', () => {
  test('a malformed public key is a 400 naming the problem', async () => {
    const catalog = catalogFor(memoryService());
    const error = await register(catalog, { rpId: 'daemon.example', origin: 'https://daemon.example', credentialId: 'abc', publicKeyCose: 'AAAA' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayVerbError);
    expect((error as GatewayVerbError).status).toBe(400);
    expect((error as GatewayVerbError).message).toContain('P-256');
  });

  test('an internal failure is not reported as a 400', async () => {
    const failing = {
      registerCredential: async () => { throw new Error('secret store is read-only'); },
      mintChallenge: () => { throw new Error('unused'); },
      listCredentials: async () => [],
      removeCredential: async () => false,
    };
    const error = await register(catalogFor(failing), { rpId: 'daemon.example', origin: 'https://daemon.example', credentialId: 'abc', publicKeyCose: 'AAAA' }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(GatewayVerbError);
    expect((error as Error).message).toBe('secret store is read-only');
  });
});

describe('stepup.challenge.mint', () => {
  test('a full challenge store is a 429 that says how to proceed', async () => {
    const catalog = catalogFor(memoryService());
    for (let i = 0; i < MAX_LIVE_STEP_UP_CHALLENGES; i++) await catalog.invoke('stepup.challenge.mint', { query: {}, body: {}, context: { principalId: `p${i}` } } as never);
    const error = await catalog.invoke('stepup.challenge.mint', { query: {}, body: {}, context: { principalId: 'late' } } as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayVerbError);
    expect((error as GatewayVerbError).status).toBe(429);
    expect((error as GatewayVerbError).message).toContain('wait for one to expire');
  });
});

describe('stepup.challenge.mint per caller', () => {
  test('a caller that keeps minting is refused while another caller still gets a challenge', async () => {
    const catalog = catalogFor(memoryService());
    const mint = (principalId: string) => catalog.invoke('stepup.challenge.mint', { query: {}, body: { ttlMs: 300000 }, context: { principalId } } as never);
    let refused: unknown;
    for (let i = 0; i < MAX_LIVE_STEP_UP_CHALLENGES && !refused; i++) refused = await mint('reader').then(() => undefined, (e: unknown) => e);
    expect((refused as GatewayVerbError).status).toBe(429);
    expect(await mint('admin')).toMatchObject({ challengeId: expect.any(String) });
  });
});
