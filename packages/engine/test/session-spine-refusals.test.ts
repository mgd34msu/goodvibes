/**
 * A daemon that refuses a session op is not the same as a daemon that took it:
 * the legacy fold must not claim completion, a close queued while the daemon was
 * away must not undo a later reopen, a closed-session answer must surface, and
 * every session keeps its own heartbeat.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  foldLegacySpineStore,
  SessionSpineClient,
  type SpineResult,
  type SpineTransport,
} from '../platform/src/platform/runtime/session-spine/index.ts';
import { createSessionSpineRestTransport } from '../platform/src/platform/runtime/session-spine/rest-transport.ts';
import type { RegisterSharedSessionInput } from '../platform/src/platform/control-plane/index.ts';

const PARTICIPANT = { surfaceKind: 'tui', surfaceId: 'surface:test', displayName: 'Test' } as const;

function quietLog() {
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (message: string) => { warnings.push(message); },
  };
}

interface Wire {
  readonly calls: string[];
  readonly transport: SpineTransport;
  answer: (call: { type: 'register' | 'close'; sessionId: string; input?: RegisterSharedSessionInput }) => SpineResult;
}

function wire(): Wire {
  const calls: string[] = [];
  const w: Wire = {
    calls,
    answer: () => ({ outcome: 'ok' }),
    transport: {
      async register(input) {
        calls.push(`register:${input.sessionId}${input.reopen ? ':reopen' : ''}`);
        return w.answer({ type: 'register', sessionId: input.sessionId, input });
      },
      async close(sessionId) {
        calls.push(`close:${sessionId}`);
        return w.answer({ type: 'close', sessionId });
      },
    },
  };
  return w;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

describe('legacy fold against a refusing daemon', () => {
  function storeFixture() {
    const dir = join(tmpdir(), `gv-spine-refusal-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const storePath = join(dir, 'sessions.json');
    writeFileSync(storePath, JSON.stringify({ sessions: { a: { id: 'a', title: 'A', status: 'active' } } }), 'utf-8');
    return { storePath, markerPath: join(dir, '.spine-folded') };
  }

  test('a refused fold writes no marker and folds again on the next call', async () => {
    const fx = storeFixture();
    const w = wire();
    w.answer = () => ({ outcome: 'rejected', error: 'HTTP 503' });
    const log = quietLog();
    const client = new SessionSpineClient({ participant: PARTICIPANT, transport: w.transport, log, heartbeatMinIntervalMs: 0 });
    foldLegacySpineStore(client, { ...fx, project: '/p', log });
    await settle();
    expect(existsSync(fx.markerPath)).toBe(false);
    expect(log.warnings.some((m) => m.includes('will run again'))).toBe(true);

    w.answer = () => ({ outcome: 'ok' });
    foldLegacySpineStore(client, { ...fx, project: '/p', log });
    await settle();
    expect(w.calls.filter((c) => c === 'register:a')).toHaveLength(2);
    expect(existsSync(fx.markerPath)).toBe(true);
  });

  test('a daemon that holds the session as closed still completes the fold', async () => {
    const fx = storeFixture();
    const w = wire();
    w.answer = () => ({ outcome: 'rejected', conflict: 'closed' });
    const log = quietLog();
    const client = new SessionSpineClient({ participant: PARTICIPANT, transport: w.transport, log, heartbeatMinIntervalMs: 0 });
    foldLegacySpineStore(client, { ...fx, project: '/p', log });
    await settle();
    expect(existsSync(fx.markerPath)).toBe(true);
  });
});

describe('closed-session answer', () => {
  test('HTTP 200 with a closed conflict is a rejection with the conflict named', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ conflict: { status: 'closed' } }), { status: 200 })) as unknown as typeof fetch;
    try {
      const transport = createSessionSpineRestTransport({ resolveConnection: () => ({ baseUrl: 'http://127.0.0.1:1', token: 't' }) });
      const result = await transport.register({ sessionId: 'a', project: '/p', participant: { ...PARTICIPANT, lastSeenAt: 1 } });
      expect(result.outcome).toBe('rejected');
      expect(result.conflict).toBe('closed');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('the client warns once per session and treats the daemon as reachable', async () => {
    const w = wire();
    w.answer = () => ({ outcome: 'rejected', conflict: 'closed' });
    const log = quietLog();
    const client = new SessionSpineClient({ participant: PARTICIPANT, transport: w.transport, log, heartbeatMinIntervalMs: 0 });
    client.register({ sessionId: 'a', project: '/p' });
    await settle();
    client.heartbeat('a');
    await settle();
    expect(log.warnings.filter((m) => m.includes('closed'))).toHaveLength(1);
    expect(client.status()).toBe('online');
    client.dispose();
  });
});

describe('close queued while the daemon was away', () => {
  test('a reopen after the close reaches the daemon after it, so the session ends open', async () => {
    const w = wire();
    const client = new SessionSpineClient({ participant: PARTICIPANT, log: quietLog(), heartbeatMinIntervalMs: 0 });
    client.register({ sessionId: 'a', project: '/p' });
    client.close('a');
    client.reopen({ sessionId: 'a', project: '/p' });
    client.activate(w.transport);
    await settle();
    // Attached with the close queued behind a register; now a fresh reopen with the transport live.
    expect(w.calls.at(-1)).toBe('register:a:reopen');
    expect(w.calls.indexOf('close:a')).toBeLessThan(w.calls.lastIndexOf('register:a:reopen'));
    client.dispose();
  });

  test('a reopen on a live transport does not overtake a close that is still queued', async () => {
    const w = wire();
    const client = new SessionSpineClient({ participant: PARTICIPANT, transport: w.transport, log: quietLog(), heartbeatMinIntervalMs: 0 });
    let offline = true;
    w.answer = () => (offline ? { outcome: 'offline' } : { outcome: 'ok' });
    client.close('a'); // goes to the wire, daemon away: queued
    await settle();
    expect(client.pendingOps).toBe(1);
    offline = false;
    client.reopen({ sessionId: 'a', project: '/p' });
    await settle();
    expect(w.calls.filter((c) => c !== 'close:a').at(-1)).toBe('register:a:reopen');
    expect(w.calls.lastIndexOf('close:a')).toBeLessThan(w.calls.lastIndexOf('register:a:reopen'));
    client.dispose();
  });

  test('a reopen drops a fold close that is still waiting, so the replay does not shut the session again', async () => {
    const w = wire();
    const client = new SessionSpineClient({ participant: PARTICIPANT, log: quietLog(), heartbeatMinIntervalMs: 0 });
    const folded = client.foldLegacyRecords([{ sessionId: 'a', project: '/p' }], new Set(['a']));
    client.reopen({ sessionId: 'a', project: '/p' });
    client.activate(w.transport);
    await settle();
    expect(w.calls).not.toContain('close:a');
    expect(w.calls).toContain('register:a:reopen');
    expect(await folded).toBe(true);
    client.dispose();
  });

  test('a reopen drops a fold close that a running flush already took', async () => {
    const w = wire();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held: SpineTransport = {
      async register(input) {
        const result = await w.transport.register(input);
        if (!input.reopen) await gate;
        return result;
      },
      close: (sessionId) => w.transport.close(sessionId),
    };
    const client = new SessionSpineClient({ participant: PARTICIPANT, log: quietLog(), heartbeatMinIntervalMs: 0 });
    const folded = client.foldLegacyRecords([{ sessionId: 'a', project: '/p' }], new Set(['a']));
    client.activate(held);
    await settle();
    expect(w.calls).toEqual(['register:a']);
    client.reopen({ sessionId: 'a', project: '/p' });
    release();
    await settle();
    expect(w.calls).not.toContain('close:a');
    expect(w.calls).toContain('register:a:reopen');
    expect(await folded).toBe(true);
    client.dispose();
  });
});

describe('heartbeat per session', () => {
  test('two sessions each get their own heartbeats, and the keepalive covers both', async () => {
    let clock = 1_000;
    const w = wire();
    const client = new SessionSpineClient({ participant: PARTICIPANT, transport: w.transport, now: () => clock, log: quietLog(), heartbeatMinIntervalMs: 1_000 });
    client.register({ sessionId: 'a', project: '/p' });
    client.register({ sessionId: 'b', project: '/p' });
    await settle();
    w.calls.length = 0;
    clock += 5_000;
    client.heartbeat('a');
    client.heartbeat('b');
    await settle();
    expect(w.calls.sort()).toEqual(['register:a', 'register:b']);
    client.dispose();
  });
});
