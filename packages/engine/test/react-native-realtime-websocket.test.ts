import { expect, test } from 'bun:test';
import { createReactNativeGoodVibesPlatform } from '../platform/src/react-native.ts';
import { createMemoryTokenStore } from '../platform/src/auth.js';

class RecordingSocket {
  static readonly OPEN = 1;
  static readonly sockets: RecordingSocket[] = [];
  static readonly sent: string[] = [];
  static onSend: (() => void) | undefined;
  readyState = 1;
  private readonly handlers = new Map<string, Array<(event: unknown) => void>>();
  constructor(readonly url: string, readonly protocols?: unknown, readonly options?: { headers?: Record<string, string> }) {
    RecordingSocket.sockets.push(this);
    queueMicrotask(() => this.fire('open', { currentTarget: this }));
  }
  fire(type: string, event: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }
  removeEventListener(): void {}
  send(frame: string): void { RecordingSocket.sent.push(frame); RecordingSocket.onSend?.(); }
  close(): void {}
}

function nextSend(): Promise<void> {
  return new Promise<void>((resolve) => { RecordingSocket.onSend = resolve; });
}

test('every socket carries the bearer token it was built with, and a reconnect carries the new one', async () => {
  RecordingSocket.sockets.length = 0;
  RecordingSocket.sent.length = 0;
  const platform = createReactNativeGoodVibesPlatform({
    baseUrl: 'https://daemon.example',
    tokenStore: createMemoryTokenStore('first'),
    realtime: { webSocketReconnect: { enabled: true, baseDelayMs: 1, maxDelayMs: 1 } },
    WebSocketImpl: RecordingSocket as unknown as typeof WebSocket,
  });
  let sent = nextSend();
  const stop = platform.realtime.runtime().turn.onEnvelope('TURN_COMPLETED', () => {});
  await sent;
  expect(RecordingSocket.sockets[0]?.options?.headers?.['Authorization']).toBe('Bearer first');
  await platform.auth.setToken('second');
  sent = nextSend();
  RecordingSocket.sockets[0]!.fire('close', { wasClean: false, code: 1006, reason: '' });
  await sent;
  stop();
  RecordingSocket.onSend = undefined;
  expect(RecordingSocket.sockets[1]?.options?.headers?.['Authorization']).toBe('Bearer second');
  expect(JSON.parse(RecordingSocket.sent[1]!).token).toBe('second');
});

test('realtime refreshes a token inside the refresh window before it is sent', async () => {
  RecordingSocket.sockets.length = 0;
  RecordingSocket.sent.length = 0;
  const now = 1_000_000;
  const platform = createReactNativeGoodVibesPlatform({
    baseUrl: 'https://daemon.example',
    tokenStore: createMemoryTokenStore('stale', now + 1_000),
    autoRefresh: { now: () => now, refreshLeewayMs: 60_000, refresh: async () => ({ token: 'fresh', expiresAt: now + 3_600_000 }) },
    WebSocketImpl: RecordingSocket as unknown as typeof WebSocket,
  });
  const authFrameSent = nextSend();
  const stop = platform.realtime.runtime().turn.onEnvelope('TURN_COMPLETED', () => {});
  await authFrameSent;
  stop();
  RecordingSocket.onSend = undefined;
  expect(RecordingSocket.sockets[0]?.options?.headers?.['Authorization']).toBe('Bearer fresh');
  expect(JSON.parse(RecordingSocket.sent[0]!).token).toBe('fresh');
});
