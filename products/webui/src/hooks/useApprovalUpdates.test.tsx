/**
 * useApprovalUpdates, the browser-side `control.approval_update` push consumer
 * (see the hook's own header comment for the wire-shape rationale). This test
 * proves the stream is opened at the right path/domain, that an
 * `approval-update` frame invalidates the approvals + permission-rules caches,
 * and that the connected/error state tracks onReady/onTerminate honestly.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ServerSentEventHandlers } from '@goodvibes-jev/engine/transport-http';

let capturedHandlers: ServerSentEventHandlers | null = null;
const openCalls: string[] = [];
const closers: Array<ReturnType<typeof mock>> = [];
const cleanups: Array<() => void> = [];

mock.module('../lib/goodvibes', () => ({
  DEFAULT_SSE_RECONNECT: { enabled: true, baseDelayMs: 1, maxDelayMs: 2, backoffFactor: 2, maxAttempts: 3 },
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  client: {
    streams: {
      open: (pathOrUrl: string, handlers: ServerSentEventHandlers) => {
        openCalls.push(pathOrUrl);
        capturedHandlers = handlers;
        const close = mock(() => {});
        closers.push(close);
        return Promise.resolve(close);
      },
    },
  },
}));

const { useApprovalUpdates } = await import('./useApprovalUpdates');

function renderHook(enabled = true): {
  invalidate: ReturnType<typeof mock>;
  state: () => { connected: boolean; error: string | null };
  rerender: (enabled: boolean) => void;
  unmount: () => void;
} {
  const client = new QueryClient();
  const invalidate = mock(() => Promise.resolve());
  (client as unknown as { invalidateQueries: unknown }).invalidateQueries = invalidate;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  let latest: { connected: boolean; error: string | null } = { connected: false, error: null };
  function Harness({ on }: { on: boolean }) {
    latest = useApprovalUpdates(on);
    return null;
  }

  const doRender = (on: boolean) => {
    flushSync(() => {
      root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Harness, { on })));
    });
  };
  doRender(enabled);

  // Registered for afterEach so a failed assertion cannot leave the root mounted.
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    flushSync(() => root.unmount());
    if (container.parentNode) container.parentNode.removeChild(container);
  };
  cleanups.push(unmount);

  return {
    invalidate,
    state: () => latest,
    rerender: doRender,
    unmount,
  };
}

/** The hook stores the closer from the open() promise one microtask later. */
async function settleOpen(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  closers.length = 0;
  capturedHandlers = null;
  openCalls.length = 0;
});

describe('useApprovalUpdates', () => {
  test('opens the control-plane events stream narrowed to the permissions domain', () => {
    renderHook();
    expect(openCalls.length).toBe(1);
    expect(openCalls[0]).toBe('/api/control-plane/events?domains=gate');
  });

  test('an approval-update frame invalidates approvals and permission rules', () => {
    const { invalidate } = renderHook();
    expect(capturedHandlers).not.toBeNull();

    capturedHandlers?.onEvent?.('approval-update', { approval: { id: 'appr-1', status: 'approved' }, createdAt: 1 });

    expect(invalidate.mock.calls.length).toBe(2);
    const keys = invalidate.mock.calls.map((call) => (call[0] as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(['approvals']);
    expect(keys).toContainEqual(['permissions', 'rules']);
  });

  test('a non-approval-update event name is ignored', () => {
    const { invalidate } = renderHook();
    capturedHandlers?.onEvent?.('heartbeat', {});
    capturedHandlers?.onEvent?.('gate', { type: 'PERMISSION_MODE_CHANGED' });
    expect(invalidate).not.toHaveBeenCalled();
  });

  test('onReady flips connected true; onTerminate flips it back false with an error note', () => {
    const { state } = renderHook();
    expect(state().connected).toBe(false);

    flushSync(() => capturedHandlers?.onReady?.(undefined));
    expect(state().connected).toBe(true);
    expect(state().error).toBeNull();

    flushSync(() => capturedHandlers?.onTerminate?.({ error: null, reconnectAttempts: 0 }));
    expect(state().connected).toBe(false);
    expect(state().error).not.toBeNull();
  });

  test('a transport error body (raw 401 JSON) never reaches the returned error', () => {
    const { state } = renderHook();
    flushSync(() => capturedHandlers?.onError?.(new Error('{"error":"Authentication required","code":"AUTH_REQUIRED","status":401}')));
    expect(state().error).not.toBeNull();
    expect(state().error).not.toContain('AUTH_REQUIRED');
    expect(state().error).not.toContain('{');
    expect(state().connected).toBe(false);
  });

  test('disabled: never opens a stream', () => {
    renderHook(false);
    expect(openCalls.length).toBe(0);
  });

  test('unmount closes the opened stream exactly once', async () => {
    const { unmount } = renderHook();
    await settleOpen();
    expect(closers.length).toBe(1);
    expect(closers[0]?.mock.calls.length).toBe(0);
    unmount();
    expect(closers[0]?.mock.calls.length).toBe(1);
  });

  test('unmounting before the open settles still closes the stream once it arrives', async () => {
    const { unmount } = renderHook();
    unmount();
    await settleOpen();
    expect(closers.length).toBe(1);
    expect(closers[0]?.mock.calls.length).toBe(1);
  });

  test('flipping enabled to false closes the stream and does not reopen it', async () => {
    const { rerender } = renderHook(true);
    await settleOpen();
    rerender(false);
    expect(closers.length).toBe(1);
    expect(closers[0]?.mock.calls.length).toBe(1);
    expect(openCalls.length).toBe(1);
  });
});
