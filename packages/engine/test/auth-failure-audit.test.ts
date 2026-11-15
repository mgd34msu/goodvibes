import { describe, expect, test } from 'bun:test';
import { createAuthFailureAudit } from '../platform/src/platform/daemon/auth-failure-audit.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.js';
import { DaemonHttpRouter } from '../platform/src/platform/daemon/http/router.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';

function watchedBus() {
  const bus = new RuntimeEventBus();
  const seen: Array<{ type: string; payload: Record<string, unknown> }> = [];
  bus.onDomain('security', (envelope) => { seen.push({ type: envelope.type, payload: envelope.payload as unknown as Record<string, unknown> }); });
  return { bus, seen };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('refused credentials on the daemon API reach the security domain', () => {
  test('a wrong token on the main API answers 401 and emits AUTH_FAILED without the credential', async () => {
    const { bus, seen } = watchedBus();
    const router = new DaemonHttpRouter({
      authenticateRequest: () => null,
      authToken: () => 'operator-secret-token',
      runtimeBus: bus,
      configManager: { get: () => undefined },
    } as never);
    const dispatch = (router as unknown as { dispatchAuthedRequest(req: Request): Promise<Response> }).dispatchAuthedRequest.bind(router);
    const res = await dispatch(new Request('http://127.0.0.1/api/sessions', { headers: { authorization: 'Bearer guessed-token' } }));
    expect(res.status).toBe(401);
    const failed = seen.filter((e) => e.type === 'AUTH_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload.reason).toBe('invalid_credentials');
    expect(JSON.stringify(failed[0]!.payload)).not.toContain('guessed-token');
  });

  test('a refused admin call and a refused remote peer each emit AUTH_FAILED', async () => {
    const { bus, seen } = watchedBus();
    const helper = new DaemonControlPlaneHelper({
      authToken: () => 'operator-secret-token',
      userAuth: { validateSession: () => null } as never,
      distributedRuntime: { authenticatePeerToken: async () => null } as never,
      trustProxyEnabled: () => false,
      runtimeBus: bus,
    } as unknown as DaemonControlPlaneContext);
    expect(helper.requireAdmin(new Request('http://127.0.0.1/x', { headers: { authorization: 'Bearer nope' } }))?.status).toBe(401);
    expect(((await helper.requireRemotePeer(new Request('http://127.0.0.1/x', { headers: { authorization: 'Bearer nope' } }))) as Response).status).toBe(401);
    expect(seen.filter((e) => e.type === 'AUTH_FAILED')).toHaveLength(2);
  });

  test('one address is reported up to the cap, then once as rate_limited, then silently until the window ends', async () => {
    const { bus, seen } = watchedBus();
    let clock = 0;
    const audit = createAuthFailureAudit(bus, () => clock);
    for (let i = 0; i < 60; i += 1) audit.record('10.0.0.1', 'test');
    await drain();
    const reasons = seen.map((e) => e.payload.reason);
    expect(reasons).toHaveLength(21);
    expect(reasons.filter((r) => r === 'rate_limited')).toHaveLength(1);
    audit.record('10.0.0.2', 'test');
    await drain();
    expect(seen).toHaveLength(22);
    clock += 60_000;
    audit.record('10.0.0.1', 'test');
    await drain();
    expect(seen).toHaveLength(23);
    expect(seen.at(-1)!.payload.reason).toBe('invalid_credentials');
  });
});
