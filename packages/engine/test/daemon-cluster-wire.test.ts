import { expect, test } from 'bun:test';
import { callDaemonMethod, callDaemonRoute } from '../terminal-shell/src/raw-reply-route.ts';

test('daemon CLI calls carry the operator token, the gateway envelope and raw HTTP payloads over a real loopback wire', async () => {
  const invoked: { path: string; body: unknown }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      if (request.headers.get('authorization') !== 'Bearer fixture-token') return new Response('unauthorized', { status: 401 });
      const path = new URL(request.url).pathname;
      if (path.startsWith('/api/control-plane/methods/')) {
        const body = await request.json() as { body?: unknown };
        invoked.push({ path, body: body.body });
        return Response.json({ sessions: [] });
      }
      return Response.json({ status: 'running', source: 'loopback fixture' });
    },
  });
  try {
    const target = { baseUrl: `http://127.0.0.1:${server.port}`, token: 'fixture-token', isLocal: true };
    expect(await callDaemonMethod(target, 'sessions.hosted.list', { input: { includeTerminated: true }, readOnly: true }))
      .toEqual({ ok: true, data: { sessions: [] } });
    expect(invoked).toEqual([{ path: '/api/control-plane/methods/sessions.hosted.list/invoke', body: { includeTerminated: true } }]);
    expect(await callDaemonRoute(target, '/status', { method: 'GET', envelope: 'raw' })).toEqual({ ok: true, data: { status: 'running', source: 'loopback fixture' } });
    const refused = await callDaemonMethod({ ...target, token: 'wrong' }, 'sessions.hosted.list', { readOnly: true });
    expect(refused.ok === false && refused.code).toBe('auth-refused');
  } finally { server.stop(true); }
});
