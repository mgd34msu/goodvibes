import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ServerSentEventHandlers } from '@goodvibes-jev/engine/transport-http';

let handlers: ServerSentEventHandlers | null = null;

mock.module('../lib/goodvibes', () => ({
  DEFAULT_SSE_RECONNECT: { enabled: true },
  client: {
    streams: {
      open: (_path: string, next: ServerSentEventHandlers) => {
        handlers = next;
        return Promise.resolve(() => {});
      },
    },
  },
}));

const { useCompactionReceipts } = await import('./useCompactionReceipts');

let latest: ReturnType<typeof useCompactionReceipts> | null = null;
afterEach(() => { handlers = null; latest = null; });

function mount() {
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  function Harness({ id }: { id: string }) {
    latest = useCompactionReceipts(id, true);
    return null;
  }
  const show = (id: string) => flushSync(() => root.render(React.createElement(Harness, { id })));
  return { show, unmount: () => { flushSync(() => root.unmount()); container.remove(); } };
}

test('a receipt frame as the daemon sends it (event inside the envelope payload) is captured with its outcome', async () => {
  const view = mount();
  view.show('s-1');
  // The shared stream opens on the next microtask.
  for (let index = 0; index < 4; index++) await Promise.resolve();
  flushSync(() => handlers?.onEvent?.('compaction', {
    type: 'COMPACTION_RECEIPT', ts: 1, traceId: 't', sessionId: 's-1', source: 'runtime',
    payload: { type: 'COMPACTION_RECEIPT', outcome: 'applied', tokensBefore: 100, tokensAfter: 20, trigger: 'auto', strategy: 'x' },
  }));
  expect(latest?.receipts[0]?.outcome).toBe('applied');
  expect(latest?.receipts[0]?.tokensBefore).toBe(100);
  view.unmount();
});
