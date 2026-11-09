/** Actual daemon composition and ConfigManager publisher; no runtime execution
 * has been performed while the coding worklist is still active. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createNativeDataWriteOwner, NATIVE_READER_REQUIREMENT_FILE } from '@goodvibes-jev/engine/sdk/platform/runtime/native-reader-compatibility';
import { createDevicePostureServices } from '../../runtime/device-posture-composition.js';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test('the actual native device composition forwards its admitted configuration writer before fresh observation publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'daemon-device-reader-floor-')); roots.push(root);
  const nativeDataWriter = createNativeDataWriteOwner({ execPath: join(root, 'goodvibes-daemon'), version: '3.1.2', assertCurrent() {} });
  const configManager = new ConfigManager({ surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT, workingDir: root, configDir: join(root, 'config'), nativeDataWriter });
  const { devicePosture } = createDevicePostureServices({ configManager, stateDirectory: join(root, 'devices'),
    distributedRuntime: { listPeers: () => [], async invokePeer() { throw new Error('No device dispatch in storage fixture'); } },
    approvals: { async requestApproval() { throw new Error('No approval prompt in storage fixture'); } },
  });
  try {
    const capture = await devicePosture.artifacts.retain({ nodeId: 'paired-fixture', capabilityId: 'device.screen.capture', kind: 'image', mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) });
    expect(capture.sha256).toBeUndefined();
    const floor = JSON.parse(readFileSync(join(root, NATIVE_READER_REQUIREMENT_FILE), 'utf8')) as { formats: string[] };
    expect(floor.formats).toContain('device-capture-observations-v2');
    expect((await devicePosture.artifacts.read(capture.id)).ok).toBe(true);
  } finally { devicePosture.stopHousekeeping(); }
});
