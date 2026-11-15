import { expect, test } from 'bun:test';
import { createReactNativeGoodVibesPlatform } from '../platform/src/react-native.ts';

function withWarnings<T>(run: (warnings: string[]) => T): T {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
  try {
    return run(warnings);
  } finally {
    console.warn = original;
  }
}

class FakeSocket {}

test('realtime without a wrapper warns once that the upgrade will be refused', () => {
  withWarnings((warnings) => {
    const platform = createReactNativeGoodVibesPlatform({ baseUrl: 'https://daemon.example' });
    platform.realtime.runtime();
    platform.realtime.runtime();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Authorization');
  });
});

test('realtime with a supplied WebSocket implementation does not warn', () => {
  withWarnings((warnings) => {
    const platform = createReactNativeGoodVibesPlatform({
      baseUrl: 'https://daemon.example',
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    platform.realtime.runtime();
    platform.realtime.viaWebSocket(FakeSocket as unknown as typeof WebSocket);
    expect(warnings).toEqual([]);
  });
});

class RecordingSocket {
  static readonly OPEN = 1;
  static readonly sent: string[] = [];
  static onSend: (() => void) | undefined;
  readyState = 1;
  private readonly handlers = new Map<string, Array<(event: unknown) => void>>();
  constructor(readonly url: string) {
    queueMicrotask(() => { for (const handler of this.handlers.get('open') ?? []) handler({}); });
  }
  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }
  removeEventListener(): void {}
  send(frame: string): void { RecordingSocket.sent.push(frame); RecordingSocket.onSend?.(); }
  close(): void {}
}

test('realtime refreshes a token inside the refresh window before it is sent', async () => {
  RecordingSocket.sent.length = 0;
  const { createMemoryTokenStore } = await import('../platform/src/auth.js');
  const now = 1_000_000;
  const platform = createReactNativeGoodVibesPlatform({
    baseUrl: 'https://daemon.example',
    tokenStore: createMemoryTokenStore('stale', now + 1_000),
    autoRefresh: { now: () => now, refreshLeewayMs: 60_000, refresh: async () => ({ token: 'fresh', expiresAt: now + 3_600_000 }) },
    WebSocketImpl: RecordingSocket as unknown as typeof WebSocket,
  });
  const authFrameSent = new Promise<void>((resolve) => { RecordingSocket.onSend = resolve; });
  const stop = platform.realtime.runtime().turn.onEnvelope('TURN_COMPLETED', () => {});
  await authFrameSent;
  stop();
  RecordingSocket.onSend = undefined;
  expect(JSON.parse(RecordingSocket.sent[0]!).token).toBe('fresh');
});
