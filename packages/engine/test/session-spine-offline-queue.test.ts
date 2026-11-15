import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RegisterSharedSessionInput } from '../platform/src/platform/control-plane/index.ts';
import {
  TUI_SPINE_PARTICIPANT,
  SessionSpineClient,
  foldLegacySpineStore,
  type SpineResult,
  type SpineTransport,
} from '../platform/src/platform/runtime/session-spine/index.ts';

const silent = { debug: () => {}, info: () => {}, warn: () => {} };
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

function recordingTransport(outcome: () => SpineResult['outcome'] = () => 'ok') {
  const calls: Array<{ readonly op: 'register' | 'close'; readonly sessionId: string; readonly input?: RegisterSharedSessionInput }> = [];
  const transport: SpineTransport = {
    register: async (input) => { calls.push({ op: 'register', sessionId: input.sessionId, input }); return { outcome: outcome() }; },
    close: async (sessionId) => { calls.push({ op: 'close', sessionId }); return { outcome: outcome() }; },
  };
  return { calls, transport };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('session spine offline queue', () => {
  test('offline heartbeats coalesce and never evict the titled registration', async () => {
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, heartbeatMinIntervalMs: 0, queueLimit: 8, log: silent });
    client.register({ sessionId: 's1', project: '/p', title: 'Planning' });
    for (let i = 0; i < 300; i += 1) client.heartbeat('s1');
    expect(client.pendingOps).toBe(1);
    const wire = recordingTransport();
    client.activate(wire.transport);
    await settle();
    expect(wire.calls).toHaveLength(1);
    expect(wire.calls[0]?.input?.title).toBe('Planning');
    client.dispose();
  });

  test('a flush stops at the first offline op and keeps the rest in order', async () => {
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, heartbeatMinIntervalMs: 60_000, log: silent });
    client.register({ sessionId: 'a', project: '/p' });
    client.register({ sessionId: 'b', project: '/p' });
    client.close('a');
    const offline = recordingTransport(() => 'offline');
    client.activate(offline.transport);
    await settle();
    expect(offline.calls).toHaveLength(1);
    expect(client.pendingOps).toBe(3);
    client.deactivate('test');
    const online = recordingTransport();
    client.activate(online.transport);
    await settle();
    expect(online.calls.map((call) => `${call.op}:${call.sessionId}`)).toEqual(['register:a', 'register:b', 'close:a']);
    client.dispose();
  });

  test('a completion that lands after deactivate does not set reachability', async () => {
    let release: (result: SpineResult) => void = () => {};
    const transport: SpineTransport = {
      register: () => new Promise<SpineResult>((resolve) => { release = resolve; }),
      close: async () => ({ outcome: 'ok' }),
    };
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, heartbeatMinIntervalMs: 60_000, log: silent });
    client.activate(transport);
    client.register({ sessionId: 's1', project: '/p', title: 'T' });
    client.deactivate('mode lost');
    release({ outcome: 'ok' });
    await settle();
    expect(client.status()).toBe('unknown');
    client.dispose();
  });

  test('a large legacy fold is not evicted, and the marker waits for the daemon', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-spine-fold-'));
    dirs.push(dir);
    const storePath = join(dir, 'sessions.json');
    const markerPath = `${storePath}.spine-migrated`;
    const sessions: Record<string, unknown> = {};
    for (let i = 0; i < 200; i += 1) sessions[`s${i}`] = { id: `s${i}`, title: `t${i}`, status: 'closed' };
    writeFileSync(storePath, JSON.stringify({ sessions }));
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, heartbeatMinIntervalMs: 60_000, log: silent });
    foldLegacySpineStore(client, { storePath, markerPath, project: '/p', log: silent });
    await settle();
    expect(existsSync(markerPath)).toBe(false);
    const wire = recordingTransport();
    client.activate(wire.transport);
    for (let i = 0; i < 50 && !existsSync(markerPath); i += 1) await settle();
    expect(wire.calls.filter((call) => call.op === 'close')).toHaveLength(200);
    expect(existsSync(markerPath)).toBe(true);
    client.dispose();
  });
});
