/**
 * A daemon that is reachable but failing must not be reported as "no phone" or
 * "no grants"; a capture too large for the model is refused rather than inlined;
 * the calling conversation's id reaches the daemon; a capped fleet says so.
 */
import { expect, test } from 'bun:test';
import { createDevicesClient } from '../platform/src/platform/runtime/client/devices-client.ts';
import { createClientPhoneTool } from '../platform/src/platform/runtime/client/phone-tool.ts';
import { createDaemonFleetRowsPoller, readDaemonFleetRows } from '../platform/src/platform/runtime/client/fleet-union.ts';
import type { DaemonVerbCaller } from '../platform/src/platform/runtime/client/daemon-verbs.ts';

function verbsWith(handler: (method: string, input: unknown) => unknown, available = true): DaemonVerbCaller & { calls: Array<{ method: string; input: unknown }> } {
  const calls: Array<{ method: string; input: unknown }> = [];
  return {
    calls,
    probe: () => (available ? { available: true as const } : { available: false as const, reason: 'no daemon is configured' }),
    async invoke<T,>(method: string, input?: unknown): Promise<T> {
      calls.push({ method, input });
      return await handler(method, input) as T;
    },
  } as DaemonVerbCaller & { calls: Array<{ method: string; input: unknown }> };
}

async function run(tool: ReturnType<typeof createClientPhoneTool>, args: Record<string, unknown>) {
  return tool.execute(args);
}

test('a reachable daemon that fails a read is reported as a failure, not as an empty list', async () => {
  const verbs = verbsWith(() => { throw new Error('401 Unauthorized'); });
  const tool = createClientPhoneTool(createDevicesClient(verbs));
  for (const action of ['nodes', 'grants', 'artifacts', 'photo']) {
    const result = await run(tool, { action, reason: 'check' });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('401 Unauthorized');
  }
});

test('a daemon that answers without the list is a failure, not an empty list', async () => {
  const devices = createDevicesClient(verbsWith(() => ({})));
  await expect(devices.listNodes()).rejects.toThrow('devices.nodes.list answered without nodes');
  await expect(devices.listGrants()).rejects.toThrow('devices.grants.list answered without grants');
  await expect(devices.listArtifacts()).rejects.toThrow('devices.artifacts.list answered without artifacts');
});

test('an unreachable daemon still reads as an honest empty list with its reason', async () => {
  const verbs = verbsWith(() => { throw new Error('no daemon'); }, false);
  const devices = createDevicesClient(verbs);
  expect(await devices.listNodes()).toEqual([]);
  expect(await devices.listGrants()).toEqual([]);
  const result = await run(createClientPhoneTool(devices), { action: 'nodes' });
  expect(result.success).toBe(false);
  expect(String(result.error)).toContain('no daemon is configured');
});

test('the calling conversation id rides the capability request', async () => {
  const verbs = verbsWith((method) => {
    if (method === 'devices.nodes.list') return { nodes: [{ nodeId: 'phone-1', supported: ['device.clipboard.read'] }] };
    return { ok: true, nodeId: 'phone-1', capabilityId: 'device.clipboard.read', authority: 'confirmed' };
  });
  const tool = createClientPhoneTool(createDevicesClient(verbs), { sessionId: () => 'session-7' });
  const result = await run(tool, { action: 'clipboard_read', reason: 'reading the link' });
  expect(result.success).toBe(true);
  expect(verbs.calls.find((call) => call.method === 'devices.capability.request')!.input).toMatchObject({ sessionId: 'session-7' });
});

test('a capture too large for the model is refused with the way to get a smaller one', async () => {
  const verbs = verbsWith(() => ({
    artifact: { artifactId: 'a1', mediaType: 'image/png', daemonPath: '/var/captures/a1.png' },
    dataBase64: 'A'.repeat(8 * 1024 * 1024),
  }));
  const result = await run(createClientPhoneTool(createDevicesClient(verbs)), { action: 'read', artifactId: 'a1' });
  expect(result.success).toBe(false);
  expect(String(result.output)).not.toContain('AAAAAAAAAA');
  expect(String(result.output)).toContain('maxWidth');
  expect(String(result.output)).toContain('/var/captures/a1.png');
});

test('a capped fleet snapshot says it is partial', async () => {
  const payload = { capturedAt: 1, truncated: true, totalCount: 2500, nodes: [{ id: 'd1' }, { notANode: true }] };
  expect(readDaemonFleetRows(payload)).toEqual({ capturedAt: 1, truncated: true, totalCount: 2500, nodes: [{ id: 'd1' }] } as never);
  const poller = createDaemonFleetRowsPoller({ verbs: verbsWith(() => payload), refreshIntervalMs: 60_000, log: { debug: () => {} } });
  // The poller starts its first read on construction; wait for it to land.
  if (poller.rows() === null) await new Promise<void>((resolve) => { const stop = poller.subscribe(() => { stop(); resolve(); }); });
  expect(poller.rows()).toMatchObject({ truncated: true, totalCount: 2500 });
  poller.stop();
});
