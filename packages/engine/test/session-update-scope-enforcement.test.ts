/**
 * session-update-scope-enforcement.test.ts
 *
 * The `control.session_update` channel declares `scopes: ['read:sessions']`.
 * The gateway must ENFORCE that on the per-client SSE fan-out: a principal-scoped
 * web client without read:sessions does not receive session-update frames, while
 * one that has it (or an admin token, single-admin-token collapse) does. Internal
 * streams that carry no scopes stay trusted so nothing existing regresses.
 */

import { describe, expect, test } from 'bun:test';
import { createFeatureFlagManager } from '../platform/src/platform/runtime/feature-flags/manager.js';
import { ControlPlaneGateway } from '../platform/src/platform/control-plane/gateway.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';

function makeGateway(): ControlPlaneGateway {
  return new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus(), featureFlags: createFeatureFlagManager() });
}

const SENTINEL_EVENT = 'scope-test-sentinel';

/**
 * Read from an SSE stream until the sentinel frame arrives, then report whether a
 * `session-update` frame came before it. The sentinel is an untagged event every client
 * receives and the caller publishes it AFTER the event under test, so frames arrive in
 * publish order and a session-update that was going to be delivered is already in the
 * buffer. No wall-clock budget decides the verdict; the timer only bounds a hang.
 */
async function sawSessionUpdate(res: Response): Promise<boolean> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ceiling: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    ceiling = setTimeout(() => reject(new Error('sentinel frame never arrived on the stream')), 10_000);
  });
  try {
    while (!buffer.includes(`event: ${SENTINEL_EVENT}`)) {
      const chunk = await Promise.race([reader.read(), hung]);
      if (chunk.done) throw new Error('stream ended before the sentinel frame');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    clearTimeout(ceiling);
    await reader.cancel().catch(() => {});
  }
  return buffer.includes('event: session-update');
}

function openWebStream(gateway: ControlPlaneGateway, opts: { scopes?: readonly string[]; admin?: boolean }): Response {
  return gateway.createEventStream(new Request('http://localhost/api/control-plane/events'), {
    clientKind: 'web',
    transport: 'sse',
    principalId: 'p',
    principalKind: 'token',
    ...(opts.scopes !== undefined ? { scopes: opts.scopes } : {}),
    ...(opts.admin !== undefined ? { admin: opts.admin } : {}),
  });
}

describe('session-update honors the declared read:sessions scope', () => {
  test('SSE replay uses the same authorization as live delivery', async () => {
    const gateway = makeGateway();
    gateway.publishEvent('session-update', { event: 'session-created' });
    gateway.publishEvent(SENTINEL_EVENT, {});
    expect(await sawSessionUpdate(openWebStream(gateway, { scopes: ['read:events'] }))).toBe(false);
    expect(await sawSessionUpdate(openWebStream(gateway, { scopes: ['read:sessions'] }))).toBe(true);
  });

  test('WebSocket replay protects both session channels', () => {
    const gateway = makeGateway();
    gateway.publishEvent('session-update', { secret: 'session' });
    gateway.publishEvent('hosted-session-update', { secret: 'hosted' });
    for (const allowed of [false, true]) {
      const events: string[] = [];
      const { clientId } = gateway.openWebSocketClient({ clientKind: 'web', scopes: allowed ? ['read:sessions'] : ['read:events'] }, event => events.push(event));
      expect(events.includes('session-update')).toBe(allowed);
      expect(events.includes('hosted-session-update')).toBe(allowed);
      gateway.closeWebSocketClient(clientId);
    }
  });
  test('a web client WITHOUT read:sessions does not receive session-update', async () => {
    const gateway = makeGateway();
    const res = openWebStream(gateway, { scopes: ['read:events'] });
    gateway.publishEvent('session-update', { event: 'session-created', payload: {}, createdAt: Date.now() });
    gateway.publishEvent(SENTINEL_EVENT, {});
    expect(await sawSessionUpdate(res)).toBe(false);
  });

  test('a web client WITH read:sessions receives session-update', async () => {
    const gateway = makeGateway();
    const res = openWebStream(gateway, { scopes: ['read:sessions'] });
    gateway.publishEvent('session-update', { event: 'session-created', payload: {}, createdAt: Date.now() });
    gateway.publishEvent(SENTINEL_EVENT, {});
    expect(await sawSessionUpdate(res)).toBe(true);
  });

  test('an admin token receives session-update even with only read:events (single-token collapse)', async () => {
    const gateway = makeGateway();
    const res = openWebStream(gateway, { scopes: ['read:events'], admin: true });
    gateway.publishEvent('session-update', { event: 'session-created', payload: {}, createdAt: Date.now() });
    gateway.publishEvent(SENTINEL_EVENT, {});
    expect(await sawSessionUpdate(res)).toBe(true);
  });

  test('an internal stream with NO scopes stays trusted (no regression for session-scoped streams)', async () => {
    const gateway = makeGateway();
    const res = gateway.createEventStream(new Request('http://localhost/stream'), { clientKind: 'web' });
    gateway.publishEvent('session-update', { event: 'session-created', payload: {}, createdAt: Date.now() });
    gateway.publishEvent(SENTINEL_EVENT, {});
    expect(await sawSessionUpdate(res)).toBe(true);
  });
});
