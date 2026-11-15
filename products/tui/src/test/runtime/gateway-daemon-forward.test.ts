/**
 * The TUI's local gateway catalog has no handlers of its own; the mail,
 * calendar and review surfaces call it, so every invokable built-in verb must
 * reach the daemon instead of failing with "no internal handler".
 */
import { expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { DaemonVerbCaller } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { CONNECTION_PROBE_METHOD } from '../../input/commands/connection-status.ts';
import { forwardGatewayMethodsToDaemon } from '../../runtime/gateway-daemon-forward.ts';

function recordingVerbs(reply: unknown = { ok: true }) {
  const calls: Array<{ id: string; input: unknown }> = [];
  const verbs = {
    probe: () => ({ available: true }),
    invoke: async (id: string, input?: unknown) => { calls.push({ id, input }); return reply; },
  } as unknown as DaemonVerbCaller;
  return { verbs, calls };
}

test('every method the mail, calendar and review surfaces call has a handler', () => {
  const catalog = new GatewayMethodCatalog();
  forwardGatewayMethodsToDaemon(catalog, recordingVerbs().verbs);
  for (const id of [...Object.values(CONNECTION_PROBE_METHOD), 'email.inbox.read', 'email.draft.create', 'email.send', 'calendar.events.get', 'calendar.events.create', 'checkpoints.revertHunkPreview', 'checkpoints.revertHunk']) {
    expect({ id, handled: catalog.hasHandler(id) }).toEqual({ id, handled: true });
  }
});

test('a call is sent to the daemon with its body and query as one input, and the daemon reply comes back', async () => {
  const catalog = new GatewayMethodCatalog();
  const { verbs, calls } = recordingVerbs({ messages: [] });
  forwardGatewayMethodsToDaemon(catalog, verbs);
  const reply = await catalog.invoke('email.inbox.list', { context: { clientKind: 'tui' }, query: { folder: 'INBOX' }, body: { limit: 5 } });
  expect(reply).toEqual({ messages: [] });
  expect(calls).toEqual([{ id: 'email.inbox.list', input: { folder: 'INBOX', limit: 5 } }]);
});

test('a daemon refusal reaches the caller instead of being replaced by a wiring error', async () => {
  const catalog = new GatewayMethodCatalog();
  const verbs = { probe: () => ({ available: false }), invoke: async () => { throw new Error("cannot invoke 'email.inbox.list': no daemon is configured"); } } as unknown as DaemonVerbCaller;
  forwardGatewayMethodsToDaemon(catalog, verbs);
  await expect(catalog.invoke('email.inbox.list', { context: {} })).rejects.toThrow('no daemon is configured');
});

test('a method marked not invokable keeps its honest refusal', async () => {
  const catalog = new GatewayMethodCatalog();
  const { verbs, calls } = recordingVerbs();
  const notInvokable = catalog.list().find((d) => d.invokable === false);
  forwardGatewayMethodsToDaemon(catalog, verbs);
  expect(notInvokable).toBeDefined();
  await expect(catalog.invoke(notInvokable?.id ?? '', { context: {} })).rejects.toThrow('not invokable');
  expect(calls).toEqual([]);
});
