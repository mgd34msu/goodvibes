import { describe, expect, test } from 'bun:test';
import { createHttpTransport } from '../platform/src/platform/runtime/transports/daemon-http-client.ts';
import { readArrayResponse, readControlPlaneSnapshot } from '../platform/src/platform/runtime/transports/http-helpers.ts';
import { createTransportPaths } from '../platform/src/platform/runtime/transports/transport-paths.ts';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function transportOver(routes: (url: URL) => unknown) {
  const fetchImpl = (async (input: RequestInfo | URL) => json(routes(new URL(String(input))))) as unknown as typeof fetch;
  return createHttpTransport({ baseUrl: 'http://127.0.0.1:3210', fetchImpl });
}

describe('by-id lookups over a list that is capped by limit', () => {
  const approvals = Array.from({ length: 250 }, (_, index) => ({
    id: `approval-${index + 1}`, callId: `call-${index + 1}`, status: 'pending', createdAt: 1, updatedAt: 1, metadata: {}, audit: [],
    request: { callId: `call-${index + 1}`, tool: 'write', args: {}, category: 'write', analysis: { classification: 'generic', riskLevel: 'low', summary: 's', reasons: [] } },
  }));
  const peers = Array.from({ length: 700 }, (_, index) => ({
    id: `peer-${index + 1}`, kind: 'node', label: `Peer ${index + 1}`, requestedId: `peer-${index + 1}`, capabilities: [], commands: [],
    status: 'paired', pairedAt: 1, tokens: [], metadata: {},
  }));
  const transport = transportOver((url) => {
    const limit = Number(url.searchParams.get('limit') ?? '100');
    if (url.pathname === '/api/approvals') {
      // The daemon lists the newest 50 and takes no page size; an id reads that one record wherever it ranks.
      const approvalId = url.searchParams.get('approvalId');
      const listed = approvalId === null ? approvals.slice(0, 50) : approvals.filter((entry) => entry.id === approvalId);
      return { awaitingDecision: false, mode: 'default', approvalCount: 0, denialCount: 0, cachedChecks: 0, totalChecks: 0, approvals: listed };
    }
    if (url.pathname === '/api/remote/peers') return { peers: peers.slice(0, limit) };
    throw new Error(`unexpected request ${url.pathname}`);
  });

  test('an approval beyond the first page is found, and a missing one is null', async () => {
    expect((await transport.operator.approvals.get('approval-250'))?.id).toBe('approval-250');
    expect(await transport.operator.approvals.get('approval-251')).toBeNull();
  });

  test('a peer beyond the first page is found, and a missing one is null', async () => {
    expect((await transport.peer.peers.get('peer-700'))?.id).toBe('peer-700');
    expect(await transport.peer.peers.get('peer-701')).toBeNull();
  });
});

describe('the current-session read', () => {
  test('asks the daemon root for /api/session, not a path under the control-plane route', async () => {
    const requested: string[] = [];
    const transport = transportOver((url) => {
      requested.push(url.pathname);
      return { sessionId: 'current' };
    });
    await transport.operator.sessions.current();
    expect(requested).toEqual(['/api/session']);
  });
});

describe('a daemon response that changed shape is an error, not an empty list', () => {
  test('readArrayResponse names the missing key and what arrived', () => {
    expect(readArrayResponse<{ id: string }>({ sessions: [{ id: 'a' }] }, 'sessions')).toEqual([{ id: 'a' }]);
    expect(readArrayResponse<{ id: string }>([{ id: 'a' }], 'sessions')).toEqual([{ id: 'a' }]);
    expect(() => readArrayResponse({ sess: [] }, 'sessions')).toThrow('"sessions"');
    expect(() => readArrayResponse({ sess: [] }, 'sessions')).toThrow('sess');
  });

  test('the control-plane snapshot refuses a gateway body without its server, totals or clients', async () => {
    const paths = createTransportPaths('http://127.0.0.1:3210');
    const snapshotWith = (gateway: unknown) => readControlPlaneSnapshot(
      (async (input: RequestInfo | URL) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === new URL(paths.controlPlaneUrl).pathname) return json(gateway);
        if (pathname === new URL(paths.approvalsUrl).pathname) return json({ approvals: [] });
        return json({ sessions: [] });
      }) as unknown as typeof fetch,
      paths,
      null,
    );
    const good = { server: { connectionState: 'connected', host: 'h', port: 1 }, totals: { requests: 3, errors: 1 }, clients: [], recentEvents: [] };
    expect(await snapshotWith(good)).toMatchObject({ connectionState: 'connected', requestCount: 3, errorCount: 1 });
    await expect(snapshotWith({ ...good, totals: undefined })).rejects.toThrow('"totals"');
    await expect(snapshotWith({ ...good, server: undefined })).rejects.toThrow('"server"');
    await expect(snapshotWith({ ...good, clients: undefined })).rejects.toThrow('"clients"');
  });
});

describe('retry observers of the daemon HTTP client', () => {
  const retryPolicy = { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 };

  function flakyOnce(reply: unknown): { fetchImpl: typeof fetch; urls: string[] } {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return urls.length === 1 ? new Response('{}', { status: 503 }) : json(reply);
    }) as unknown as typeof fetch;
    return { fetchImpl, urls };
  }

  test('a retried operator call reaches the scheduled and executed observers', async () => {
    const { fetchImpl, urls } = flakyOnce({ awaitingDecision: false, mode: 'default', approvalCount: 0, denialCount: 0, cachedChecks: 0, totalChecks: 0, approvals: [] });
    const scheduled: string[] = [];
    let executed = 0;
    const transport = createHttpTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetchImpl,
      retry: retryPolicy,
      onRetryScheduled: (info) => { scheduled.push(info.reason); },
      onRetryExecuted: () => { executed += 1; },
    });
    await transport.operator.approvals.list();
    expect(urls.length).toBe(2);
    expect(scheduled).toEqual(['http-503']);
    expect(executed).toBe(1);
  });

  test('a retried call made with a peer token reaches the same observers', async () => {
    const { fetchImpl, urls } = flakyOnce({ work: [] });
    const scheduled: string[] = [];
    const transport = createHttpTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetchImpl,
      // A POST is retried only when its route is idempotent or the policy names it.
      retry: { ...retryPolicy, retryOnMethods: ['GET', 'POST'], perMethodPolicy: { 'work.pull': retryPolicy } },
      onRetryScheduled: (info) => { scheduled.push(info.reason); },
    });
    await transport.peer.work.claim('peer-token', {});
    expect(urls.length).toBe(2);
    expect(scheduled).toEqual(['http-503']);
  });
});

describe('the task list over the operator client', () => {
  const task = (index: number) => ({
    id: `task-${index}`, kind: 'agent', title: `Task ${index}`, status: 'running', owner: 'agent', cancellable: true, childTaskIds: [], queuedAt: 1,
  });
  const snapshot = (tasks: readonly unknown[]) => ({ queued: 0, running: tasks.length, blocked: 0, totals: { created: tasks.length, completed: 0, failed: 0, cancelled: 0 }, tasks });

  test('sends no page size to a method that takes no input and applies the limit itself', async () => {
    const seenQueries: string[] = [];
    const transport = transportOver((url) => {
      seenQueries.push(url.search);
      return snapshot(Array.from({ length: 5 }, (_, index) => task(index)));
    });
    const listed = await transport.operator.tasks.list(2);
    expect(listed.map((entry) => entry.id)).toEqual(['task-0', 'task-1']);
    expect(seenQueries).toEqual(['']);
  });

  test('a row that lacks the fields a consumer reads is refused, not cast', async () => {
    const transport = transportOver(() => snapshot([{ id: 'task-1' }]));
    await expect(transport.operator.tasks.list()).rejects.toThrow('$.tasks[0].kind');
  });
});
