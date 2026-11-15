import { describe, expect, test } from 'bun:test';
import { postNativeMirrorAttach } from '../../shell/remote-conversation-wiring.ts';

const connection = { baseUrl: 'http://127.0.0.1:1', token: 'synthetic-token' };
const body = { sessionId: 'hosted-1', clientId: 'agent-test' };

describe('native mirror attach', () => {
  test('gives up on a daemon that never answers once its deadline passes', async () => {
    const deadline = new AbortController();
    // A host that accepts the connection and then says nothing, until the caller's signal fires.
    const hanging = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
    })) as unknown as typeof fetch;

    const pending = postNativeMirrorAttach(connection, body, deadline.signal, hanging);
    deadline.abort(new Error('mirror deadline'));

    await expect(pending).rejects.toThrow('mirror deadline');
  });

  test('a refused attach is not a reply', async () => {
    const refused = (async () => new Response('no', { status: 403 })) as unknown as typeof fetch;
    expect(await postNativeMirrorAttach(connection, body, new AbortController().signal, refused)).toEqual({ ok: false });
  });

  test('an accepted attach returns the reply body', async () => {
    const accepted = (async () => Response.json({ session: { id: 'hosted-1' } })) as unknown as typeof fetch;
    expect(await postNativeMirrorAttach(connection, body, new AbortController().signal, accepted)).toEqual({ ok: true, reply: { session: { id: 'hosted-1' } } });
  });
});
