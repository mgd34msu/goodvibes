/**
 * A write to the device grant ledger while a phone is answering (another
 * request using its own grant, say) is not a change to this request's
 * authority. The capture the phone already took must be kept and reported, not
 * dropped behind a refusal that invites a second photo.
 */
import { afterAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/platform/platform/control-plane';
import {
  DEVICE_CAPABILITY_CONTRACT_VERSION,
  DEVICE_CAPABILITY_IDS,
  DEVICE_NODE_ANNOUNCEMENT_KEY,
} from '@goodvibes-jev/engine/platform/platform/devices';
import type { DeviceApprovalBridge, DevicePeerTransport, DevicePeerView } from '@goodvibes-jev/engine/platform/platform/devices';
import { createDevicePostureServices } from '../../runtime/device-posture-composition.ts';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const phone: DevicePeerView = {
  id: 'phone-1', label: 'Pixel on the desk', kind: 'device', platform: 'android', version: '1.0.0', status: 'connected',
  capabilities: [...DEVICE_CAPABILITY_IDS],
  metadata: { [DEVICE_NODE_ANNOUNCEMENT_KEY]: { nodeKind: 'web-pwa', contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION,
    capabilities: [...DEVICE_CAPABILITY_IDS], secureContext: true } },
};

const runtimes: Array<{ stopHousekeeping: () => void }> = [];
afterAll(() => { for (const runtime of runtimes.splice(0)) runtime.stopHousekeeping(); });

test('a ledger write by another request while the phone answers keeps the capture and reports success', async () => {
  const root = makeOwnedTempDir('gv-daemon-device-ledger-drift-');
  const lifetime = new AbortController();
  let writeLedger: () => Promise<unknown> = async () => undefined;
  const transport: DevicePeerTransport = {
    listPeers: (kind) => (kind === undefined || kind === 'device' ? [phone] : []),
    invokePeer: async (input) => {
      input.admission?.assertCurrent(); input.admission?.claim();
      await writeLedger();
      return { completed: true, work: { id: 'work-1', status: 'completed', result: {
        contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION, capabilityId: input.command, ok: true,
        mediaBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'), mediaType: 'image/png' } } };
    },
  };
  const approvals: DeviceApprovalBridge = { requestApproval: async () => ({ approved: true }) };
  const catalog = new GatewayMethodCatalog();
  const { devicePosture } = createDevicePostureServices({
    configManager: new ConfigManager({ workingDir: join(root, 'work'), homeDir: root, surfaceRoot: 'tui' }),
    signal: lifetime.signal, distributedRuntime: transport, approvals,
    stateDirectory: join(root, 'devices'), gatewayMethods: catalog,
  });
  runtimes.push(devicePosture);
  writeLedger = () => devicePosture.grants.record({ nodeId: 'phone-1', nodeKind: 'web-pwa', capabilityId: 'device.command.vibrate',
    scope: 'always', grantedBy: 'another-request' });

  const result = await catalog.invoke('devices.capability.request', { context: { admin: true },
    body: { nodeId: 'phone-1', capabilityId: 'device.camera.rear.capture', reason: 'check the door' } }) as
    { ok: boolean; refusal: string; artifact: { artifactId: string } | null };

  expect(result.ok).toBe(true);
  expect(result.artifact).not.toBeNull();
  expect(await devicePosture.artifacts.list('phone-1')).toHaveLength(1);
  expect(await devicePosture.grants.list()).toHaveLength(1);
});
