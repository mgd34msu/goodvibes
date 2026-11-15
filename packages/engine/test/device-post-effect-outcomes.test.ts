/**
 * What a paired-device request reports once the phone has already acted, what
 * the approval prompt shows, and how the stores behave under a second writer.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEVICE_CAPABILITY_CONTRACT_VERSION,
  DEVICE_CAPABILITY_IDS,
  resolveDeviceNodeProfile,
  type DeviceNodeProfile,
} from '../platform/src/platform/devices/device-capability-contract.ts';
import { DEFAULT_DEVICE_CAPABILITY_POLICY, DeviceCapabilityService, type DeviceCapabilityPolicy } from '../platform/src/platform/devices/device-capability-service.ts';
import type { DeviceCapabilityGrant, DeviceGrantStore } from '../platform/src/platform/devices/device-grants.ts';
import { DeviceGrantStore as GrantStore } from '../platform/src/platform/devices/device-grants.ts';
import { DeviceCaptureArtifactStore } from '../platform/src/platform/devices/device-capture-artifacts.ts';
import { DeviceHousekeeper } from '../platform/src/platform/devices/device-housekeeping.ts';
import { validateDeviceCapabilityInput } from '../platform/src/platform/devices/device-peer-work.ts';
import { PersistentStore } from '../platform/src/platform/state/persistent-store.ts';
import { acquireProcessLock } from '../platform/src/platform/utils/process-lock.ts';
import {
  DEVICE_NODE_ANNOUNCEMENT_KEY,
  createDevicePostureRuntime,
  type DevicePeerView,
  type DeviceWorkView,
} from '../platform/src/platform/devices/device-posture-runtime.ts';
import { createDevicePhoneTool } from '../platform/src/platform/devices/device-phone-tool.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { logger } from '../platform/src/platform/utils/logger.ts';

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gv-device-effect-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function profile(): DeviceNodeProfile {
  const resolved = resolveDeviceNodeProfile({
    nodeId: 'node-a', nodeKind: 'web-pwa', label: 'Pixel', contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION,
    capabilities: [...DEVICE_CAPABILITY_IDS],
  });
  if (!resolved.ok) throw new Error('fixture node failed to resolve');
  return resolved.profile;
}

const grantRecord = (): DeviceCapabilityGrant => ({
  id: 'grant-1', nodeId: 'node-a', nodeKind: 'web-pwa', capabilityId: 'device.command.vibrate', scope: 'always',
  grantedAt: 1, expiresAt: Number.MAX_SAFE_INTEGER, useCount: 0, grantedBy: 'operator',
});

describe('a request the device already carried out is never reported as refused', () => {
  test('a capture that could not be retained says the device acted and is not a denial', async () => {
    const service = new DeviceCapabilityService({
      grants: { find: async () => null } as unknown as DeviceGrantStore,
      artifacts: { retain: async () => { throw new Error('Another device capture writer is active'); } } as unknown as DeviceCaptureArtifactStore,
      dispatcher: { dispatch: async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png', workId: 'w1' }) },
      confirm: async () => ({ decision: 'once', actor: 'operator' }),
      listNodes: () => [profile()],
    });
    const outcome = await service.request({ nodeId: 'node-a', capabilityId: 'device.camera.rear.capture', reason: 'check the door' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('dispatch-failed');
    expect(outcome.detail).toContain('carried out');
    expect(outcome.detail).toContain('writer is active');
  });

  test('a grant whose use could not be recorded still returns what the phone answered', async () => {
    const service = new DeviceCapabilityService({
      grants: { find: async () => grantRecord(), markUsed: async () => { throw new Error('ledger busy'); } } as unknown as DeviceGrantStore,
      artifacts: {} as unknown as DeviceCaptureArtifactStore,
      dispatcher: { dispatch: async () => ({ ok: true, data: { buzzed: true } }) },
      confirm: async () => { throw new Error('a live grant must not prompt'); },
      listNodes: () => [profile()],
    });
    const outcome = await service.request({ nodeId: 'node-a', capabilityId: 'device.command.vibrate', reason: 'nudge' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.authority).toBe('existing-grant');
    expect(outcome.data).toEqual({ buzzed: true });
  });
});

describe('open_url accepts only http and https', () => {
  test.each(['file:///etc/passwd', 'javascript:alert(1)', 'intent://scan/#Intent;end', 'tel:911', 'mailto:a@b.test'])(
    '%s is reported as a problem by the shared validator', (url) => {
      const problems = validateDeviceCapabilityInput('device.command.open_url', { url, reason: 'r' });
      expect(problems.map((problem) => problem.field)).toEqual(['url']);
      expect(problems[0]?.problem).toBe('unsupported-value');
    });

  test('http and https pass', () => {
    expect(validateDeviceCapabilityInput('device.command.open_url', { url: 'https://example.test/a', reason: 'r' })).toEqual([]);
    expect(validateDeviceCapabilityInput('device.command.open_url', { url: 'HTTP://example.test', reason: 'r' })).toEqual([]);
  });

  test('the run path refuses before the person is asked', async () => {
    const prompts: unknown[] = [];
    const service = new DeviceCapabilityService({
      grants: { find: async () => null } as unknown as DeviceGrantStore,
      artifacts: {} as unknown as DeviceCaptureArtifactStore,
      dispatcher: { dispatch: async () => { throw new Error('must not dispatch'); } },
      confirm: async (request) => { prompts.push(request); return { decision: 'once', actor: 'operator' }; },
      listNodes: () => [profile()],
    });
    const outcome = await service.request({ nodeId: 'node-a', capabilityId: 'device.command.open_url', reason: 'r', input: { url: 'file:///etc/passwd' } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal).toBe('invalid-input');
    expect(prompts).toHaveLength(0);
  });
});

describe('device posture runtime', () => {
  function peer(): DevicePeerView {
    return {
      id: 'phone-1', kind: 'device', label: 'Test phone', platform: 'android', version: '1.0.0', status: 'connected',
      capabilities: [...DEVICE_CAPABILITY_IDS],
      metadata: { [DEVICE_NODE_ANNOUNCEMENT_KEY]: {
        nodeKind: 'web-pwa', contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION, capabilities: [...DEVICE_CAPABILITY_IDS], secureContext: true } },
    };
  }
  function runtimeWith(invoke: (input: { peerId: string; command: string }) => { work: DeviceWorkView; completed: boolean },
    cancelled: string[] | null) {
    const asks: Array<{ callId: string; args: Record<string, unknown> }> = [];
    const runtime = createDevicePostureRuntime({
      transport: {
        listPeers: (kind) => [peer()].filter((entry) => kind === undefined || entry.kind === kind),
        invokePeer: async (input) => invoke(input),
        ...(cancelled ? { cancelWork: async (workId: string) => { cancelled.push(workId); } } : {}),
      },
      approvals: { requestApproval: async (input) => {
        asks.push({ callId: input.request.callId, args: input.request.args as Record<string, unknown> });
        return { approved: true };
      } },
      config: new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'tui' }),
      stateDirectory: join(root, 'state'),
    });
    return { runtime, asks };
  }
  const completedWork = (capabilityId: string): { work: DeviceWorkView; completed: boolean } => ({
    completed: true,
    work: { id: 'w1', status: 'completed', result: { contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION, capabilityId, ok: true, data: {} } },
  });

  test('the prompt shows the real node, capability and reason even when the input names others', async () => {
    const { runtime, asks } = runtimeWith((input) => completedWork(input.command), null);
    const first = await runtime.capabilities.request({ nodeId: 'phone-1', capabilityId: 'device.command.vibrate', reason: 'the real reason',
      input: { capability: 'location.get', node: 'Kitchen display', reason: 'checking battery', nodeId: 'someone-else' } });
    const second = await runtime.capabilities.request({ nodeId: 'phone-1', capabilityId: 'device.command.vibrate', reason: 'again' });
    expect(first.ok).toBe(true); expect(second.ok).toBe(true);
    expect(asks[0]?.args.capability).toBe('device.command.vibrate');
    expect(asks[0]?.args.node).toBe('Test phone');
    expect(asks[0]?.args.nodeId).toBe('phone-1');
    expect(asks[0]?.args.reason).toBe('the real reason');
    expect(new Set(asks.map((ask) => ask.callId)).size).toBe(2);
  });

  test('a request that stopped waiting is withdrawn so a returning phone cannot act on it', async () => {
    const cancelled: string[] = [];
    const { runtime } = runtimeWith(() => ({ completed: false, work: { id: 'stale-1', status: 'queued' } }), cancelled);
    const outcome = await runtime.capabilities.request({ nodeId: 'phone-1', capabilityId: 'device.command.vibrate', reason: 'r' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal).toBe('dispatch-failed');
    expect(cancelled).toEqual(['stale-1']);
  });

  test('work that is already cancelled is not cancelled twice', async () => {
    const cancelled: string[] = [];
    const { runtime } = runtimeWith(() => ({ completed: false, work: { id: 'gone-1', status: 'cancelled' } }), cancelled);
    await runtime.capabilities.request({ nodeId: 'phone-1', capabilityId: 'device.command.vibrate', reason: 'r' });
    expect(cancelled).toEqual([]);
  });

  test('an answer for a different capability than the one requested is a failure', async () => {
    const { runtime } = runtimeWith(() => completedWork('device.camera.rear.capture'), null);
    const outcome = await runtime.capabilities.request({ nodeId: 'phone-1', capabilityId: 'device.command.vibrate', reason: 'r' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toContain('not the device.command.vibrate');
  });
});

describe('housekeeping', () => {
  const sweptGrants = { sweptAt: 1, removed: [{ grantId: 'g1', nodeId: 'n', capabilityId: 'c', scope: 'always', reason: 'node-gone' as const, removedAt: 1 }], retained: 0, auditTrimmed: 0 };

  test('a capture sweep that fails still discloses the grant removals', async () => {
    const grants = { sweep: async () => sweptGrants } as unknown as DeviceGrantStore;
    let artifactsOk = false;
    const artifacts = { sweep: async () => {
      if (!artifactsOk) throw new Error('Another device capture writer is active');
      return { sweptAt: 2, removed: [], retained: 0, bytesReclaimed: 0 };
    } } as unknown as DeviceCaptureArtifactStore;
    const housekeeper = new DeviceHousekeeper({ grants, artifacts, disclosurePath: join(root, 'hk.json') });

    await expect(housekeeper.sweep('periodic')).rejects.toThrow('writer is active');
    const disclosed = await housekeeper.listDisclosures();
    expect(disclosed).toHaveLength(1);
    expect(disclosed[0]?.grants.removed.map((entry) => entry.grantId)).toEqual(['g1']);
    expect(disclosed[0]?.summary).toContain('capture sweep did not run');

    artifactsOk = true;
    await expect(housekeeper.sweep('manual')).resolves.toBeDefined();
  });

  test('a sweep started while another is running joins it', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const grants = { sweep: async () => { calls += 1; await gate; return { sweptAt: 1, removed: [], retained: 0, auditTrimmed: 0 }; } } as unknown as DeviceGrantStore;
    const artifacts = { sweep: async () => ({ sweptAt: 1, removed: [], retained: 0, bytesReclaimed: 0 }) } as unknown as DeviceCaptureArtifactStore;
    const housekeeper = new DeviceHousekeeper({ grants, artifacts, disclosurePath: join(root, 'hk2.json') });
    const first = housekeeper.sweep('periodic');
    const second = housekeeper.sweep('manual');
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(await housekeeper.listDisclosures()).toHaveLength(1);
  });
});

describe('a second writer', () => {
  test('the grant ledger is locked from the read to the publish, so a revocation is not overwritten', async () => {
    const file = join(root, 'grants.json');
    let reachedRead!: () => void;
    const atRead = new Promise<void>((resolve) => { reachedRead = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let gated = false;
    class GatedStore extends PersistentStore<Record<string, unknown>> {
      override async load(): Promise<Record<string, unknown> | null> {
        const data = await super.load();
        if (!gated && data !== null) { gated = true; reachedRead(); await gate; }
        return data;
      }
    }
    const writer = new GrantStore(file);
    const grant = await writer.record({ nodeId: 'n', nodeKind: 'web-pwa', capabilityId: 'device.command.vibrate', scope: 'always', grantedBy: 'operator' });
    const slow = new GrantStore(new GatedStore(file) as never);
    const staleWrite = slow.markUsed(grant.id);
    await atRead;
    // The slow writer has read the ledger and not yet published; the revocation waits for it.
    const revoking = writer.revoke({ grantId: grant.id, actor: 'operator' });
    release();
    await Promise.all([staleWrite, revoking]);
    expect((await writer.list()).map((entry) => entry.id)).toEqual([]);
  });

  test('a capture write waits out a short holder of the index lock instead of failing', async () => {
    const directory = join(root, 'captures');
    const artifacts = new DeviceCaptureArtifactStore(directory);
    await artifacts.list();
    const held = await acquireProcessLock(`${directory}.writer.sqlite`);
    const sweeping = artifacts.sweep();
    for (let turn = 0; turn < 5; turn += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
    held.release();
    const report = await sweeping;
    expect(report.removed).toEqual([]);
  });
});

describe('the phone tool run action', () => {
  test('refuses a non-http open_url before any request is made, naming the field', async () => {
    let requested = 0;
    const runtime = createDevicePostureRuntime({
      transport: {
        listPeers: () => [{ id: 'phone-1', kind: 'device', label: 'Test phone', status: 'connected', capabilities: [...DEVICE_CAPABILITY_IDS],
          metadata: { [DEVICE_NODE_ANNOUNCEMENT_KEY]: { nodeKind: 'web-pwa', contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION,
            capabilities: [...DEVICE_CAPABILITY_IDS], secureContext: true } } }],
        invokePeer: async () => { requested += 1; throw new Error('must not dispatch'); },
      },
      approvals: { requestApproval: async () => { requested += 1; return { approved: true }; } },
      config: new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'tui' }),
      stateDirectory: join(root, 'tool-state'),
    });
    const tool = createDevicePhoneTool(runtime);
    const result = await tool.execute({ action: 'run', capabilityId: 'device.command.open_url', reason: 'r', input: { url: 'intent://x' } }) as
      { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('url');
    expect(requested).toBe(0);
  });
});

describe('periodic housekeeping failures are reported, not swallowed', () => {
  test('a failing periodic sweep logs a warning and a non-positive cadence is refused with one', async () => {
    const realSetInterval = globalThis.setInterval;
    const ticks: Array<() => void> = [];
    globalThis.setInterval = ((handler: () => void) => { ticks.push(handler); return { unref() {} } as unknown as ReturnType<typeof setInterval>; }) as unknown as typeof globalThis.setInterval;
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const grants = { sweep: async () => { throw new Error('ledger unreadable'); } } as unknown as DeviceGrantStore;
      const artifacts = { sweep: async () => ({ sweptAt: 1, removed: [], retained: 0, bytesReclaimed: 0 }) } as unknown as DeviceCaptureArtifactStore;
      const housekeeper = new DeviceHousekeeper({ grants, artifacts, disclosurePath: join(root, 'hk-periodic.json') });

      housekeeper.start(0);
      expect(ticks).toHaveLength(0);
      expect(warn.mock.calls.some(([message]) => String(message).includes('not scheduled'))).toBe(true);

      warn.mockClear();
      housekeeper.start(60_000);
      expect(ticks).toHaveLength(1);
      ticks[0]!();
      for (let i = 0; i < 20 && warn.mock.calls.length === 0; i++) await Promise.resolve();
      const failure = warn.mock.calls.find(([message]) => String(message).includes('Periodic device housekeeping failed'));
      expect(failure?.[1]).toEqual({ error: 'ledger unreadable' });
      housekeeper.stop();
    } finally {
      warn.mockRestore();
      globalThis.setInterval = realSetInterval;
    }
  });
});

describe('who authorises a phone request', () => {
  function serviceWith(options: {
    readonly grant?: DeviceCapabilityGrant | null;
    readonly noGrant?: 'ask-owner' | 'allow';
    readonly dispatch?: (admission: { signal: AbortSignal; claim(): void } | undefined) => Promise<{ ok: boolean }>;
    readonly policy?: () => DeviceCapabilityPolicy;
  }) {
    const counts = { confirm: 0, dispatch: 0 };
    const listeners: Array<() => void> = [];
    const service = new DeviceCapabilityService({
      grants: { find: async () => options.grant ?? null, markUsed: async () => {} } as unknown as DeviceGrantStore,
      artifacts: {} as unknown as DeviceCaptureArtifactStore,
      dispatcher: { dispatch: async (input) => { counts.dispatch += 1; return options.dispatch ? options.dispatch(input.admission) : { ok: true }; } },
      confirm: async () => { counts.confirm += 1; return { decision: 'once', actor: 'operator' }; },
      listNodes: () => [profile()],
      noGrantAuthority: () => options.noGrant ?? 'ask-owner',
      onPolicyChange: (listener) => { listeners.push(listener); return () => {}; },
      ...(options.policy ? { policy: options.policy } : {}),
    });
    return { service, counts, settingsChanged: () => { for (const listener of listeners) listener(); } };
  }
  const vibrate = { nodeId: 'node-a', capabilityId: 'device.command.vibrate', reason: 'nudge' } as const;

  test('a live grant runs the request with no question', async () => {
    const { service, counts } = serviceWith({ grant: grantRecord() });
    const outcome = await service.request(vibrate);
    expect(outcome.ok && outcome.authority).toBe('existing-grant');
    expect(counts).toEqual({ confirm: 0, dispatch: 1 });
  });

  test('with no grant the owner is asked once, and under yolo nobody is', async () => {
    const asked = serviceWith({});
    expect((await asked.service.request(vibrate)).ok).toBe(true);
    expect(asked.counts.confirm).toBe(1);
    const yolo = serviceWith({ noGrant: 'allow' });
    const outcome = await yolo.service.request(vibrate);
    expect(outcome.ok && outcome.authority).toBe('permissions-mode');
    expect(yolo.counts.confirm).toBe(0);
  });

  test('turning the capability off withdraws a request the phone has not picked up, and only then', async () => {
    let policy: DeviceCapabilityPolicy = DEFAULT_DEVICE_CAPABILITY_POLICY;
    let settingsChanged = () => {};
    const waiting = serviceWith({
      grant: grantRecord(),
      policy: () => policy,
      dispatch: async (admission) => {
        policy = { ...policy, mode: 'off' }; settingsChanged();
        return { ok: !admission?.signal.aborted };
      },
    });
    settingsChanged = waiting.settingsChanged;
    const withdrawn = await waiting.service.request(vibrate);
    expect(withdrawn.ok).toBe(false);
    if (!withdrawn.ok) expect(withdrawn.refusal).toBe('disabled-by-config');

    policy = DEFAULT_DEVICE_CAPABILITY_POLICY;
    const picked = serviceWith({
      grant: grantRecord(),
      policy: () => policy,
      dispatch: async (admission) => {
        admission?.claim();
        policy = { ...policy, mode: 'off' }; settingsChanged();
        return { ok: !admission?.signal.aborted };
      },
    });
    settingsChanged = picked.settingsChanged;
    expect((await picked.service.request(vibrate)).ok).toBe(true);
  });
});
