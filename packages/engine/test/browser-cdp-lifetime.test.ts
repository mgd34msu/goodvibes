import { expect, spyOn, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import { cdpWebSocketHandshakeWorks } from '../platform/src/platform/browser/browser-cdp.js';

function sockets(construct?: () => void) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const opened: Socket[] = [];
  class Socket {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    closes = 0;
    constructor() { opened.push(this); construct?.(); }
    close(): void { this.closes++; }
  }
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: Socket });
  return { opened, restore: () => {
    if (descriptor) Object.defineProperty(globalThis, 'WebSocket', descriptor);
    else Reflect.deleteProperty(globalThis, 'WebSocket');
  } };
}

for (const outcome of ['open', 'error', 'close', 'abort'] as const)
  test(`debugger diagnostic ${outcome} closes its own socket and removes its timer and abort listener`, async () => {
    const controller = new AbortController(), owned = sockets();
    const schedule = spyOn(globalThis, 'setTimeout'), clear = spyOn(globalThis, 'clearTimeout');
    const reason = new Error('owning browser service retired');
    const pending = cdpWebSocketHandshakeWorks('ws://127.0.0.1:9222/devtools/browser/original', controller.signal);
    const result = pending.catch((error: unknown) => error);
    try {
      const socket = owned.opened[0]; if (!socket) throw new Error('No diagnostic socket was constructed');
      expect(owned.opened).toHaveLength(1);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
      const timerIndex = schedule.mock.calls.findIndex(call => call[1] === 3_000);
      expect(timerIndex).toBeGreaterThanOrEqual(0);
      const timer: unknown = schedule.mock.results[timerIndex]?.value;
      if (outcome === 'abort') controller.abort(reason);
      else if (outcome === 'open') socket.onopen?.();
      else if (outcome === 'error') socket.onerror?.();
      else socket.onclose?.();
      expect(await result).toBe(outcome === 'abort' ? reason : outcome === 'open');
      expect(socket.closes).toBe(1);
      expect(socket.onopen).toBeNull(); expect(socket.onerror).toBeNull(); expect(socket.onclose).toBeNull();
      expect(clear.mock.calls.some(call => call[0] === timer)).toBe(true);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally { controller.abort(reason); await result; schedule.mockRestore(); clear.mockRestore(); owned.restore(); }
  });

test('a diagnostic retired during socket construction still closes the newly returned socket', async () => {
  const controller = new AbortController(), reason = new Error('constructor retired original owner');
  const owned = sockets(() => controller.abort(reason));
  try {
    expect(await cdpWebSocketHandshakeWorks('ws://127.0.0.1:9222/original', controller.signal).catch((error: unknown) => error)).toBe(reason);
    expect(owned.opened).toHaveLength(1); expect(owned.opened[0]?.closes).toBe(1);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  } finally { owned.restore(); }
});

test('an already retired diagnostic creates no socket', async () => {
  const controller = new AbortController(), reason = new Error('owner already retired'), owned = sockets();
  controller.abort(reason);
  try {
    expect(await cdpWebSocketHandshakeWorks('ws://127.0.0.1:9222/original', controller.signal).catch((error: unknown) => error)).toBe(reason);
    expect(owned.opened).toHaveLength(0);
  } finally { owned.restore(); }
});
