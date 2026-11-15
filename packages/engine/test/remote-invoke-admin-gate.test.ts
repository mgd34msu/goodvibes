/**
 * The remote peer invoke route is an administrator action: a denied admin
 * check answers before the distributed runtime is asked to invoke anything.
 */
import { describe, expect, it } from 'bun:test';
import { createDaemonRemoteRouteHandlers } from '../daemon-api/src/remote-routes.ts';

type RouteContext = Parameters<typeof createDaemonRemoteRouteHandlers>[0];

function handlersWith(requireAdmin: () => Response | null, invokePeer: (input: { command?: string }) => Promise<unknown>) {
  return createDaemonRemoteRouteHandlers({
    requireAdmin,
    parseJsonBody: async () => ({ command: 'uptime' }),
    requireRemotePeer: async () => new Response(null, { status: 401 }),
    requireAuthenticatedSession: () => null,
    authToken: null,
    distributedRuntime: { invokePeer },
  } as unknown as RouteContext);
}

const invokeRequest = () => new Request('http://daemon/api/remote/peers/peer-1/invoke', { method: 'POST', body: JSON.stringify({ command: 'uptime' }) });

describe('remote peer invoke admin gate', () => {
  it('answers a denied admin check without reaching invokePeer', async () => {
    let invokeCalls = 0;
    const handlers = handlersWith(() => new Response('forbidden', { status: 403 }), async () => { invokeCalls += 1; return { ok: true }; });
    const response = await handlers.invokeRemotePeer('peer-1', invokeRequest());
    expect(response.status).toBe(403);
    expect(invokeCalls).toBe(0);
  });

  it('passes an admitted request through to invokePeer and answers 202', async () => {
    let seenCommand: string | undefined;
    const handlers = handlersWith(() => null, async (input) => { seenCommand = input.command; return { workId: 'w-1' }; });
    const response = await handlers.invokeRemotePeer('peer-1', invokeRequest());
    expect(response.status).toBe(202);
    expect(seenCommand).toBe('uptime');
  });
});
