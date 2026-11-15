/**
 * Gate: this daemon's device posture composition serves the WHOLE devices.*
 * family over the gateway, including the three verbs that ask a paired phone
 * for something and read back what it sent.
 *
 * The paired-phone feature is platform-owned, but the seams are this daemon's:
 * the peer transport devices pair onto, the shared approval broker the owner's
 * question rides, the config manager the posture is read from, and the state
 * directory the grants and captures live in
 * (runtime/device-posture-composition.ts). This test drives the wire path end
 * to end over this composition: a live grant authorises a request with no
 * question, with no grant the owner is asked once, the bytes the device
 * returned are retained by the real capture store, and the caller reads them
 * back by id.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/platform/platform/control-plane';
import {
  DEVICE_CAPABILITY_CONTRACT_VERSION,
  DEVICE_NODE_ANNOUNCEMENT_KEY,
  DEVICE_CAPABILITY_IDS,
} from '@goodvibes-jev/engine/platform/platform/devices';
import type {
  DeviceApprovalBridge,
  DevicePeerTransport,
  DevicePeerView,
} from '@goodvibes-jev/engine/platform/platform/devices';
import { createDevicePostureServices, DAEMON_DEVICE_ACTOR } from '../../runtime/device-posture-composition.ts';
import { makeOwnedTempDir as makeProjectTempDir } from '../helpers/owned-temp.js';

const DEVICE_METHOD_IDS = [
  'devices.nodes.list',
  'devices.capability.request',
  'devices.artifacts.list',
  'devices.artifacts.read',
  'devices.grants.list',
  'devices.grants.revoke',
  'devices.housekeeping.run',
] as const;

/** PNG-ish bytes; the store only cares that what comes back is what went in. */
const CAPTURE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7, 7, 7, 7]);

const runtimes: Array<{ stopHousekeeping: () => void }> = [];
afterAll(() => {
  for (const runtime of runtimes.splice(0)) runtime.stopHousekeeping();
});

interface Harness {
  readonly catalog: GatewayMethodCatalog;
  /** The owner's questions, in order: what each one showed. */
  readonly asks: Array<{ capability: unknown; nodeId: unknown; reason: unknown }>;
  readonly service: ReturnType<typeof createDevicePostureServices>['devicePosture'];
  readonly config: ConfigManager;
  readonly transport: DevicePeerTransport;
  readonly lifetime: AbortController;
  invoke: GatewayMethodCatalog['invoke'];
  readonly dispatched: string[];
  approve(decision: 'once' | 'always' | 'deny'): void;
  /** Runs while the owner is being asked, before the answer is returned. */
  whileAsked(hook: () => void | Promise<void>): void;
  sendBytes(send: boolean): void;
}

function pairedPhone(): DevicePeerView {
  return {
    id: 'phone-1',
    label: 'Pixel on the desk',
    kind: 'device',
    platform: 'android',
    version: '1.0.0',
    status: 'connected',
    capabilities: [...DEVICE_CAPABILITY_IDS],
    metadata: {
      [DEVICE_NODE_ANNOUNCEMENT_KEY]: {
        nodeKind: 'web-pwa',
        contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION,
        capabilities: [...DEVICE_CAPABILITY_IDS],
        secureContext: true,
      },
    },
  };
}

function harness(): Harness {
  const root = makeProjectTempDir('gv-daemon-device-verbs-');
  const lifetime = new AbortController();
  const dispatched: string[] = [];
  const asks: Harness['asks'] = [];
  let answer: 'once' | 'always' | 'deny' = 'once';
  let duringAsk: () => void | Promise<void> = () => {};
  let sendBytes = false;

  const transport: DevicePeerTransport = {
    listPeers: (kind) => (kind === undefined || kind === 'device' ? [pairedPhone()] : []),
    invokePeer: async (input) => {
      input.admission?.assertCurrent(); input.admission?.claim();
      dispatched.push(input.command);
      return {
        completed: true,
        work: {
          id: 'work-1',
          status: 'completed',
          result: {
            contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION,
            capabilityId: input.command,
            ok: true,
            data: { echoed: input.command },
            ...(sendBytes
              ? {
                mediaBase64: Buffer.from(CAPTURE_BYTES).toString('base64'),
                mediaType: 'image/png',
              }
              : {}),
          },
        },
      };
    },
  };

  const approvals: DeviceApprovalBridge = { requestApproval: async (input) => {
    const args = input.request.args as Record<string, unknown>;
    asks.push({ capability: args.capability, nodeId: args.nodeId, reason: args.reason });
    await duringAsk();
    if (answer === 'deny') return { approved: false, reason: 'Not now.' };
    return answer === 'always' ? { approved: true, rememberTier: 'tool' } : { approved: true };
  } };

  const catalog = new GatewayMethodCatalog();
  const config = new ConfigManager({ workingDir: join(root, 'work'), homeDir: root, surfaceRoot: 'tui' });
  const { devicePosture } = createDevicePostureServices({
    configManager: config,
    signal: lifetime.signal,
    distributedRuntime: transport,
    approvals,
    stateDirectory: join(root, 'devices'),
    gatewayMethods: catalog,
  });
  // Nothing here starts housekeeping; the disposer is registered so a future
  // change that does cannot leave a timer running past this file.
  runtimes.push(devicePosture);

  return {
    catalog,
    asks,
    service: devicePosture, config, transport, lifetime,
    invoke: (id, request) => catalog.invoke(id, request),
    dispatched,
    approve(next) { answer = next; },
    whileAsked(hook) { duringAsk = hook; },
    sendBytes(next) { sendBytes = next; },
  };
}

const CONTEXT = { context: { admin: true } } as const;

describe('the composed daemon serves the whole devices.* family', () => {
  test('every device verb is cataloged and handled, not a 501 facade', () => {
    const h = harness();
    for (const id of DEVICE_METHOD_IDS) {
      expect(h.catalog.get(id), `${id} is not cataloged`).toBeTruthy();
      expect(h.catalog.hasHandler(id), `${id} has no handler`).toBe(true);
    }
  });

  test('the paired phone this daemon\'s transport reports is the one the verbs see', async () => {
    const h = harness();
    const listed = await h.invoke('devices.nodes.list', { ...CONTEXT, body: {} }) as {
      nodes: readonly { nodeId: string; label: string }[];
    };
    expect(listed.nodes.map((node) => node.nodeId)).toEqual(['phone-1']);
    expect(listed.nodes[0]?.label).toBe('Pixel on the desk');
  });

  test('a request with no grant asks the owner once and goes out over this daemon\'s transport', async () => {
    const h = harness();
    const result = await h.invoke('devices.capability.request', {
      ...CONTEXT,
      body: {
        nodeId: 'phone-1',
        capabilityId: 'device.command.vibrate',
        reason: 'confirming which phone is on the desk',
      },
    }) as { ok: boolean; authority: string; data?: unknown };

    expect(result).toMatchObject({ ok: true });
    expect(result.authority).toBe('confirmed-once');
    expect(h.asks).toEqual([{ nodeId: 'phone-1', capability: 'device.command.vibrate', reason: 'confirming which phone is on the desk' }]);
    expect(h.dispatched).toEqual(['device.command.vibrate']);
  });

  test('a refusal is an answer with the reason, and nothing reaches the phone', async () => {
    const h = harness();
    h.approve('deny');
    const result = await h.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.camera.rear.capture', reason: 'no thanks' },
    }) as { ok: boolean; refusal: string; detail: string };

    expect(result.ok).toBe(false);
    expect(result.refusal).toBe('denied-by-person');
    expect(result.detail).toBe('Not now.');
    expect(h.dispatched).toEqual([]);
  });

  test('a capture is retained by this daemon\'s store and read back byte for byte', async () => {
    const h = harness();
    h.sendBytes(true);
    const requested = await h.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.screen.capture', reason: 'read the error on my screen' },
    }) as { ok: boolean; artifact: { artifactId: string; byteLength: number; mediaType: string } | null };

    expect(requested.ok).toBe(true);
    expect(requested.artifact?.mediaType).toBe('image/png');
    const artifactId = requested.artifact?.artifactId ?? '';

    const listed = await h.invoke('devices.artifacts.list', { ...CONTEXT, body: {} }) as {
      artifacts: readonly { artifactId: string }[];
      retained: number;
      retentionHours: number;
    };
    expect(listed.retained).toBe(1);
    expect(listed.retentionHours).toBe(24);
    expect(listed.artifacts[0]?.artifactId).toBe(artifactId);

    const read = await h.invoke('devices.artifacts.read', {
      ...CONTEXT,
      body: { artifactId },
    }) as { dataBase64: string; artifact: { byteLength: number } };
    expect(read.artifact.byteLength).toBe(CAPTURE_BYTES.byteLength);
    // A surface that is not on this host's disk gets the same bytes the phone
    // sent, which is the whole reason this verb exists.
    expect([...Buffer.from(read.dataBase64, 'base64')]).toEqual([...CAPTURE_BYTES]);
  });

  test('a durable grant given through the verb is visible and revocable in the grants surface', async () => {
    const h = harness();
    h.approve('always');
    await h.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.location.coarse', reason: 'roughly where am I' },
    });

    const grants = await h.invoke('devices.grants.list', { ...CONTEXT, body: {} }) as {
      grants: readonly { capabilityId: string; nodeId: string; grantId: string }[];
    };
    expect(grants.grants.map((grant) => grant.capabilityId)).toEqual(['device.location.coarse']);

    // The live grant is the authority: the second request asks nobody.
    const second = await h.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.location.coarse', reason: 'again' },
    }) as { authority: string };
    expect(second.authority).toBe('existing-grant');
    expect(h.asks).toHaveLength(1);

    await h.invoke('devices.grants.revoke', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.location.coarse' },
    });
    const third = await h.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.location.coarse', reason: 'after revoking' },
    }) as { authority: string };
    expect(third.authority).toBe('confirmed-always');
    expect(h.asks).toHaveLength(2);
  });

  test('this daemon records itself as the actor, so the ledger says where the decision was made', async () => {
    const h = harness();
    h.approve('always');
    await h.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.clipboard.read', reason: 'paste what I copied' },
    });
    const grants = await h.invoke('devices.grants.list', { ...CONTEXT, body: {} }) as {
      grants: readonly { grantedBy: string }[];
      audit: readonly { action: string }[];
    };
    expect(grants.grants[0]?.grantedBy).toBe('operator');
    expect(grants.audit.some((entry) => entry.action === 'granted')).toBe(true);
    expect(DAEMON_DEVICE_ACTOR).toBe('daemon:phone-tool');
  });

  test('a request the contract cannot satisfy is refused before anyone is asked', async () => {
    const h = harness();
    const missingInput = await h.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.clipboard.write', reason: 'put this on the phone' },
    }) as { ok: boolean; refusal: string };
    const unknownNode = await h.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'not-paired', capabilityId: 'device.command.vibrate', reason: 'x' },
    }) as { ok: boolean; refusal: string };

    expect(missingInput.refusal).toBe('invalid-input');
    expect(unknownNode.refusal).toBe('node-unknown');
    expect(h.asks).toHaveLength(0);
    expect(h.dispatched).toEqual([]);
  });
});

const requestBody = { nodeId: 'phone-1', capabilityId: 'device.camera.rear.capture', reason: 'Read the exact synthetic test capture' };
const requestDevice = (h: Harness) => h.invoke('devices.capability.request', { ...CONTEXT, body: requestBody }) as Promise<{ ok: boolean; refusal: string; detail: string }>;

describe('only device settings end a request in flight', () => {
  test('turning the capability off while the owner is asked refuses before the phone is reached', async () => {
    const h = harness();
    h.whileAsked(() => { h.config.set('device.capabilities.mode', 'off'); });
    expect(await requestDevice(h)).toMatchObject({ ok: false, refusal: 'disabled-by-config' });
    expect(h.dispatched).toEqual([]);
  });

  test('an unrelated setting saved while the owner is asked leaves the request alone', async () => {
    const h = harness(); h.sendBytes(true);
    h.whileAsked(() => { h.config.set('behavior.autoCompactThreshold', 70); });
    expect(await requestDevice(h)).toMatchObject({ ok: true });
    expect(await h.service.artifacts.list()).toHaveLength(1);
  });
});
