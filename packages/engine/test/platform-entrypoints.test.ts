import { describe, expect, test } from 'bun:test';
import {
  createBrowserGoodVibesPlatform,
  createExpoGoodVibesPlatform,
  createGoodVibesPlatform,
  createReactNativeGoodVibesPlatform,
  createWebGoodVibesPlatform,
} from '../platform/dist/index.js';

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Bun's `typeof fetch` includes a `preconnect` static method that plain mock
 * functions don't have. Attach a no-op stub so test doubles satisfy the type
 * without pretending to implement real preconnect behavior.
 */
function withPreconnect(
  impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(impl, {
    preconnect: (_url: string | URL, _options?: { dns?: boolean; tcp?: boolean; http?: boolean; https?: boolean }) => {},
  });
}

const fetchStub = withPreconnect(async () => createJsonResponse({ ok: true }));

describe('sdk platform integrations', () => {
  test('creates a generic composed sdk surface', () => {
    const platformClient = createGoodVibesPlatform({
      baseUrl: 'http://127.0.0.1:3210',
      authToken: 'token-123',
      fetch: fetchStub,
    });

    expect(platformClient.operator.transport.baseUrl).toBe('http://127.0.0.1:3210');
    expect(platformClient.peer.transport.baseUrl).toBe('http://127.0.0.1:3210');
  });

  test('browser entry defaults baseUrl from location.origin', () => {
    const previousLocation = globalThis.location;
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'https://goodvibes.example.com' },
    });
    try {
      const platformClient = createBrowserGoodVibesPlatform({
        fetch: fetchStub,
      });

      expect(platformClient.operator.transport.baseUrl).toBe('https://goodvibes.example.com');
    } finally {
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: previousLocation,
      });
    }
  });

  test('web entry aliases the browser integration layer', () => {
    const previousLocation = globalThis.location;
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'https://goodvibes.example.com' },
    });
    try {
      const platformClient = createWebGoodVibesPlatform({
        fetch: fetchStub,
      });

      expect(platformClient.operator.transport.baseUrl).toBe('https://goodvibes.example.com');
    } finally {
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: previousLocation,
      });
    }
  });

  test('react native entry exposes websocket-first realtime helpers', () => {
    class FakeWebSocket {}

    const platformClient = createReactNativeGoodVibesPlatform({
      baseUrl: 'https://goodvibes.example.com',
      authToken: 'token-123',
      fetch: fetchStub,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    expect(platformClient.realtime.runtime().domains).toContain('agents');
  });

  test('expo entry aliases the react native integration layer', () => {
    class FakeWebSocket {}

    const platformClient = createExpoGoodVibesPlatform({
      baseUrl: 'https://goodvibes.example.com',
      authToken: 'token-123',
      fetch: fetchStub,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    expect(platformClient.realtime.runtime().domains).toContain('agents');
  });
});
