import { describe, expect, test } from 'bun:test';
import { createRemoteDomainEvents } from '../transport-realtime/src/domain-events.ts';
import { createWebSocketConnector } from '../transport-realtime/src/runtime-events.ts';
import type { ConnectionState } from '../transport-realtime/src/connector-options.ts';

const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 20)); };

describe('domain events: one connection per feed', () => {
  test('a connector that resolves without a cleanup function is not connected a second time', async () => {
    let connects = 0;
    const events = createRemoteDomainEvents(['agents'] as const, (async () => { connects++; }) as never);
    events.agents.on('AGENT_SPAWNING' as never, () => {});
    await settle();
    events.agents.on('AGENT_COMPLETED' as never, () => {});
    await settle();
    expect(connects).toBe(1);
  });

  test('a connector that returns a cleanup still reconnects after the last listener leaves', async () => {
    let connects = 0;
    let cleanups = 0;
    const events = createRemoteDomainEvents(['agents'] as const, async () => { connects++; return () => { cleanups++; }; });
    const off = events.agents.on('AGENT_SPAWNING' as never, () => {});
    await settle();
    off();
    expect(cleanups).toBe(1);
    events.agents.on('AGENT_SPAWNING' as never, () => {});
    await settle();
    expect(connects).toBe(2);
  });
});

class MockSocket {
  static instances: MockSocket[] = [];
  static get OPEN(): number { return 1; }
  readyState = 0;
  private listeners = new Map<string, Set<(e: Event) => void>>();
  constructor(readonly url: string) { MockSocket.instances.push(this); }
  addEventListener(type: string, fn: (e: Event) => void): void { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn); }
  removeEventListener(type: string, fn: (e: Event) => void): void { this.listeners.get(type)?.delete(fn); }
  send(): void {}
  close(): void { this.readyState = 3; }
  fire(type: string, event: Event): void { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event); }
}

describe('websocket connector: failed is final', () => {
  test('disposing after reconnect attempts are exhausted keeps the state failed', async () => {
    MockSocket.instances = [];
    const states: ConnectionState[] = [];
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockSocket as unknown as typeof WebSocket, {
      reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 1 },
      onConnectionStateChange: (s) => states.push(s),
    });
    const stop = await connector('agents', () => {});
    for (let i = 0; i < 2; i++) {
      const socket = MockSocket.instances[MockSocket.instances.length - 1]!;
      socket.fire('open', new Event('open'));
      await settle();
      socket.fire('close', new CloseEvent('close', { code: 1006, wasClean: false }));
      await settle();
    }
    expect(states).toContain('failed');
    (stop as () => void)();
    expect(states[states.length - 1]).toBe('failed');
  });
});
