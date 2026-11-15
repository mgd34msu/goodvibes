import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import {
  DEVICE_CAPABILITY_CONTRACT_VERSION,
  DEVICE_CAPABILITY_IDS,
  DEVICE_NODE_ANNOUNCEMENT_KEY,
  type DevicePeerView,
} from '@goodvibes-jev/engine/platform/platform/devices';
import { createDevicePostureServices } from '../../runtime/device-posture-composition.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function devicePeer(nodeId: string): DevicePeerView {
  return {
    id: nodeId, kind: 'device', label: nodeId, platform: 'android', version: '1.0.0', status: 'connected',
    capabilities: [...DEVICE_CAPABILITY_IDS],
    metadata: { [DEVICE_NODE_ANNOUNCEMENT_KEY]: {
      nodeKind: 'web-pwa', contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION,
      capabilities: [...DEVICE_CAPABILITY_IDS], secureContext: true } },
  };
}

test('a device past the 200th paired peer is still a known node, so its grants are not reaped', () => {
  const root = makeOwnedTempDir('device-peer-listing');
  const peers = Array.from({ length: 250 }, (_, index) => devicePeer(`phone-${index}`));
  const { devicePosture } = createDevicePostureServices({
    configManager: new ConfigManager({ homeDir: root, workingDir: root, surfaceRoot: 'daemon' }),
    stateDirectory: join(root, 'devices'),
    distributedRuntime: {
      // Mirrors the real manager: a listing is capped at 200 unless a limit is passed.
      listPeers: (kind?: string, limit = 200) => peers.filter((peer) => kind === undefined || peer.kind === kind).slice(0, limit),
      invokePeer: async () => { throw new Error('No dispatch in a listing test'); },
    } as never,
    approvals: { requestApproval: async () => { throw new Error('No approval in a listing test'); } },
  });
  expect(devicePosture.listNodes()).toHaveLength(250);
});
