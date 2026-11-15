import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import { trackDisposables } from './_helpers/disposables.ts';
import { stopListenerTimers } from './_helpers/listener-teardown.ts';
import { HttpListener } from '../platform/src/platform/daemon/http-listener.js';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.js';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { ApiTokenAuditor } from '../platform/src/platform/security/token-audit.js';
import { auditPairingTokens } from '../platform/src/platform/runtime/pairing-token-audit.js';
import { createTokenAuditBusEmitter } from '../platform/src/platform/runtime/token-audit-events.js';

const roots: string[] = [];
const disposables = trackDisposables();
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function listenerFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'security-audit-'));
  roots.push(dir);
  const userAuth = new UserAuthManager({ bootstrapFilePath: join(dir, 'users.json'), bootstrapCredentialPath: join(dir, 'bootstrap.txt') });
  userAuth.addUser('test-admin', 'correct-password', ['admin']);
  const bus = new RuntimeEventBus();
  const seen: Array<{ type: string; payload: Record<string, unknown> }> = [];
  bus.onDomain('security', (envelope) => { seen.push({ type: envelope.type, payload: envelope.payload as unknown as Record<string, unknown> }); });
  const listener = disposables.add(
    new HttpListener({ port: 0, userAuth, configManager: new ConfigManager({ configDir: dir }), runtimeBus: bus }),
    stopListenerTimers,
  ) as unknown as { handleRequest: (req: Request) => Promise<Response> };
  const login = (password: string) => listener.handleRequest(new Request('http://127.0.0.1/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'test-admin', password }),
  }));
  return { seen, login };
}

describe('authentication outcomes reach the security domain', () => {
  test('a failed login emits AUTH_FAILED without the attempted username or password', async () => {
    const { seen, login } = listenerFixture();
    expect((await login('wrong-password')).status).toBe(401);
    const failed = seen.filter((e) => e.type === 'AUTH_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload.reason).toBe('invalid_credentials');
    expect(JSON.stringify(failed[0]!.payload)).not.toContain('wrong-password');
    expect(JSON.stringify(failed[0]!.payload)).not.toContain('test-admin');
  });

  test('a successful login emits AUTH_SUCCEEDED and no AUTH_FAILED', async () => {
    const { seen, login } = listenerFixture();
    expect((await login('correct-password')).status).toBe(200);
    expect(seen.map((e) => e.type)).toEqual(['AUTH_SUCCEEDED']);
    expect(seen[0]!.payload.username).toBe('test-admin');
    expect(seen[0]!.payload.method).toBe('password');
  });
});

describe('paired device tokens are audited for rotation', () => {
  const DAY = 24 * 60 * 60 * 1000;
  function auditorFixture() {
    const bus = new RuntimeEventBus();
    const types: string[] = [];
    bus.onDomain('security', (envelope) => { types.push(envelope.type); });
    const auditor = new ApiTokenAuditor({ managed: false, defaultRotationCadenceMs: 90 * DAY, defaultRotationWarningThresholdMs: 14 * DAY }, { emitter: createTokenAuditBusEmitter(bus) });
    return { auditor, types };
  }

  test('an overdue paired token is reported once, and a revoked one stops being audited', async () => {
    const { auditor, types } = auditorFixture();
    const now = 1_000 * DAY;
    let devices = [{ id: 'd1', name: 'phone', createdAt: now - 100 * DAY }];
    const tokens = { list: () => devices };
    auditPairingTokens(tokens, auditor, now);
    auditPairingTokens(tokens, auditor, now + 1);
    await Promise.resolve(); await Promise.resolve();
    expect(types.filter((t) => t === 'TOKEN_ROTATION_EXPIRED')).toHaveLength(1);

    devices = [];
    auditPairingTokens(tokens, auditor, now + 2);
    expect(auditor.getTokenMetadata('pairing:d1')).toBeUndefined();
  });

  test('a fresh paired token raises no finding', async () => {
    const { auditor, types } = auditorFixture();
    const now = 1_000 * DAY;
    auditPairingTokens({ list: () => [{ id: 'd1', name: 'phone', createdAt: now - DAY }] }, auditor, now);
    await Promise.resolve(); await Promise.resolve();
    expect(types).toEqual([]);
  });
});

describe('revoking a paired device token', () => {
  test('is announced as COMPANION_TOKEN_REVOKED only when a token was really revoked', async () => {
    const { GatewayMethodCatalog } = await import('../platform/src/platform/control-plane/method-catalog.js');
    const { registerPairingGatewayMethods } = await import('../platform/src/platform/control-plane/routes/pairing.js');
    const { PairingTokenManager } = await import('../platform/src/platform/pairing/pairing-token-store.js');
    const dir = mkdtempSync(join(tmpdir(), 'pairing-revoke-'));
    roots.push(dir);
    const pairing = new PairingTokenManager(join(dir, 'pairing.json'));
    const minted = pairing.mint({ name: 'phone' });
    const catalog = new GatewayMethodCatalog();
    const revoked: string[] = [];
    registerPairingGatewayMethods(catalog, pairing, (event) => { revoked.push(event.id); });
    const context = { principalId: 'owner' };
    await expect(catalog.invoke('pairing.tokens.delete', { body: { id: 'missing' }, context })).rejects.toThrow();
    expect(revoked).toEqual([]);
    const id = minted.id;
    await catalog.invoke('pairing.tokens.delete', { body: { id }, context });
    expect(revoked).toEqual([id]);
    expect(minted).toBeDefined();
  });
});
