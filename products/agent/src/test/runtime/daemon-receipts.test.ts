/**
 * Connected-host receipt delivery: a current daemon delivers its undelivered
 * honesty receipts ("updated from X to Y", "restarted after a crash") once, and
 * ONLY to a /status read that opts in with ?receipts=, a plain /status read is
 * receipt-neutral. The agent's receipt reader runs once per attach, through the
 * same factory services.ts uses; the build read stays plain. Every taken receipt
 * must render exactly once.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { AgentDaemonReceiptFeed, createDaemonReceiptConsumption, type DaemonReceipt } from '../../runtime/daemon-receipts.ts';
import { createSessionSpineReceiptConsumer as createSpineReceiptConsumer } from '@goodvibes-jev/engine/platform/platform/runtime/session-spine';
import { readDaemonStatusPayload } from '../../runtime/daemon-build-compatibility.ts';

describe('AgentDaemonReceiptFeed', () => {
  test('buffers receipts captured before the renderer attaches, then flushes in order', () => {
    const feed = new AgentDaemonReceiptFeed();
    feed.push([{ id: 'a', text: 'first', at: 1 }, { id: 'b', text: 'second', at: 2 }]);
    const delivered: DaemonReceipt[] = [];
    feed.attach((receipt) => delivered.push(receipt));
    expect(delivered.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  test('delivers immediately once attached and dedupes by id', () => {
    const feed = new AgentDaemonReceiptFeed();
    const delivered: DaemonReceipt[] = [];
    feed.attach((receipt) => delivered.push(receipt));
    feed.push([{ id: 'a', text: 'first', at: 1 }]);
    feed.push([{ id: 'a', text: 'first again', at: 1 }, { id: 'b', text: 'second', at: 2 }]);
    expect(delivered.map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});

describe('receipt consumption once per attach', () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  /**
   * A daemon that honours the receipt contract: a plain read carries no receipts,
   * `receipts=peek` shows the undelivered ones without delivering, and
   * `receipts=ack&ids=` marks exactly those delivered.
   */
  function startDaemon(): { requests: string[] } {
    const requests: string[] = [];
    const undelivered = new Map([['update-1', 'updated from 1.9.0 to 1.9.1']]);
    server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        requests.push(`${url.pathname}${url.search}`);
        const mode = url.searchParams.get('receipts');
        if (mode === 'ack') {
          for (const id of (url.searchParams.get('ids') ?? '').split(',')) undelivered.delete(id);
          return Response.json({ status: 'running', version: '3.2.0', receipts: [] });
        }
        if (mode === 'peek' || mode === 'consume') {
          const receipts = [...undelivered].map(([id, text]) => ({ id, text, at: 9 }));
          if (mode === 'consume') undelivered.clear();
          return Response.json({ status: 'running', version: '3.2.0', receipts });
        }
        return Response.json({ status: 'running', version: '3.2.0' });
      },
    });
    return { requests };
  }

  test('a plain status read takes no receipts; the attach read takes them, acknowledges them, and renders them once', async () => {
    const { requests } = startDaemon();
    const connection = () => ({ baseUrl: `http://127.0.0.1:${server!.port}`, token: 'test-token' });
    const feed = new AgentDaemonReceiptFeed();
    const rendered: string[] = [];
    feed.attach((receipt) => rendered.push(receipt.text));

    // A plain read, what the liveness probe and the build read do.
    const plain = await readDaemonStatusPayload(connection());
    expect(plain).toEqual({ status: 'running', version: '3.2.0' });
    expect(rendered).toEqual([]);

    const attach = createDaemonReceiptConsumption({
      consumeReceipts: createSpineReceiptConsumer({ resolveConnection: connection }),
      feed,
      afterAttach: async () => {},
    });
    requests.length = 0;
    await attach();

    expect(requests).toEqual(['/status?receipts=peek', '/status?receipts=ack&ids=update-1']);
    expect(rendered).toEqual(['updated from 1.9.0 to 1.9.1']);

    // The daemon delivered it, so a second attach finds nothing to render.
    await attach();
    expect(rendered).toEqual(['updated from 1.9.0 to 1.9.1']);
  });

  test('receipts taken before the sink attaches are buffered, and the post-attach hook runs after the read', async () => {
    startDaemon();
    const connection = () => ({ baseUrl: `http://127.0.0.1:${server!.port}`, token: null });
    const feed = new AgentDaemonReceiptFeed();
    const order: string[] = [];
    await createDaemonReceiptConsumption({
      consumeReceipts: async () => {
        order.push('consume');
        return [{ id: 'r-1', text: 'restarted after a crash', at: 1 }];
      },
      feed,
      afterAttach: async () => { order.push('afterAttach'); },
    })();
    expect(order).toEqual(['consume', 'afterAttach']);

    const rendered: string[] = [];
    feed.attach((receipt) => rendered.push(receipt.text));
    expect(rendered).toEqual(['restarted after a crash']);
  });
});
