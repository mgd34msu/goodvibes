/**
 * What a paired-device request reports once the phone has already acted, what
 * the approval prompt shows, and how the stores behave under a second writer.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEVICE_CAPABILITY_CONTRACT_VERSION,
  DEVICE_CAPABILITY_IDS,
  resolveDeviceNodeProfile,
  type DeviceNodeProfile,
} from '../platform/src/platform/devices/device-capability-contract.ts';
import { DEFAULT_DEVICE_CAPABILITY_POLICY, DeviceCapabilityService } from '../platform/src/platform/devices/device-capability-service.ts';
import type { DeviceCapabilityGrant, DeviceGrantStore } from '../platform/src/platform/devices/device-grants.ts';
import { DeviceGrantStore as GrantStore } from '../platform/src/platform/devices/device-grants.ts';
import { DeviceCaptureArtifactStore } from '../platform/src/platform/devices/device-capture-artifacts.ts';
import { DeviceHousekeeper } from '../platform/src/platform/devices/device-housekeeping.ts';
import { validateDeviceCapabilityInput } from '../platform/src/platform/devices/device-peer-work.ts';
import { PersistentStore } from '../platform/src/platform/state/persistent-store.ts';
import { tryAcquireCrossProcessLock } from '../platform/src/platform/workspace/checkpoint/cross-process-lock.ts';
import {
  DEVICE_NODE_ANNOUNCEMENT_KEY,
  createDevicePostureRuntime,
  type DevicePeerView,
  type DeviceWorkView,
} from '../platform/src/platform/devices/device-posture-runtime.ts';
import { createDevicePhoneTool } from '../platform/src/platform/devices/device-phone-tool.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { beginDeviceRequest } from '../platform/src/platform/devices/device-autonomous.ts';
import { withExternalOperationSource } from '../platform/src/platform/permissions/external-operation-scope.ts';
import { logger } from '../platform/src/platform/utils/logger.ts';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';

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
    expect(outcome.refusal).not.toBe('denied-by-jev');
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

  test('a capture sweep that fails still discloses the grant removals and leaves a failure marker', async () => {
    const grants = { sweep: async () => sweptGrants } as unknown as DeviceGrantStore;
    let artifactsOk = false;
    const artifacts = { sweep: async () => {
      if (!artifactsOk) throw new Error('Another device capture writer is active');
      return { sweptAt: 2, removed: [], retained: 0, bytesReclaimed: 0 };
    } } as unknown as DeviceCaptureArtifactStore;
    const housekeeper = new DeviceHousekeeper({ grants, artifacts, disclosurePath: join(root, 'hk.json') });

    await expect(housekeeper.sweep('periodic')).rejects.toThrow('writer is active');
    expect(housekeeper.getLastFailure()?.error).toContain('writer is active');
    const disclosed = await housekeeper.listDisclosures();
    expect(disclosed).toHaveLength(1);
    expect(disclosed[0]?.grants.removed.map((entry) => entry.grantId)).toEqual(['g1']);
    expect(disclosed[0]?.summary).toContain('capture sweep did not run');

    artifactsOk = true;
    await housekeeper.sweep('manual');
    expect(housekeeper.getLastFailure()).toBeNull();
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
    // The slow writer has read the ledger and not yet published: it must be holding the lock.
    expect(existsSync(`${file}.lock`)).toBe(true);
    const revoking = writer.revoke({ grantId: grant.id, actor: 'operator' });
    release();
    await Promise.all([staleWrite, revoking]);
    expect((await writer.list()).map((entry) => entry.id)).toEqual([]);
  });

  test('a capture write waits out a short holder of the index lock instead of failing', async () => {
    const directory = join(root, 'captures');
    const artifacts = new DeviceCaptureArtifactStore(directory);
    await artifacts.list();
    const lockPath = join(directory, 'capture-index.json.lock');
    const held = tryAcquireCrossProcessLock(lockPath);
    expect(held).not.toBeNull();
    const sweeping = artifacts.sweep();
    for (let turn = 0; turn < 5; turn += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
    held?.();
    const report = await sweeping;
    expect(report.removed).toEqual([]);
  });

  test('a ledger that differs right after its own durable write does not fail the write', async () => {
    const file = join(root, 'ledger.json');
    let interfere = false;
    class InterferingStore extends PersistentStore<Record<string, unknown>> {
      override async persist(data: Record<string, unknown>, options: Parameters<PersistentStore<Record<string, unknown>>['persist']>[1] = {}): Promise<void> {
        const after = options.afterPublish;
        await super.persist(data, { ...options, afterPublish: () => {
          if (interfere) writeFileSync(file, JSON.stringify({ version: 1, grants: [], audit: [], other: 'writer' }));
          after?.();
        } });
      }
    }
    const store = new GrantStore(new InterferingStore(file) as never);
    const grant = await store.record({ nodeId: 'n', nodeKind: 'web-pwa', capabilityId: 'device.command.vibrate', scope: 'always', grantedBy: 'operator' });
    interfere = true;
    const removed = await store.revoke({ grantId: grant.id, actor: 'operator' });
    expect(removed.map((entry) => entry.grantId)).toEqual([grant.id]);
    // The other writer really did replace the file inside the publish window.
    expect(readFileSync(file, 'utf8')).toContain('"other":"writer"');
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

describe('a request that outlives its deadline while the phone answers', () => {
  const beginOwned = (invalidate: { listener: (() => void) | null }) => {
    const node = profile();
    const policy = DEFAULT_DEVICE_CAPABILITY_POLICY;
    const grants = {
      getRevocationGeneration: () => 0, getObservationRevision: () => 0, hasPendingRevocations: () => false,
    } as unknown as DeviceGrantStore;
    return withExternalOperationSource({ sourceOf: () => ({ goal: 'Check the door', criteria: [] }), assertCurrent() {} }, () =>
      beginDeviceRequest(
        { port: { recorder: {} } as never, onDidInvalidate: (listener) => { invalidate.listener = listener; return () => {}; } },
        grants, node.nodeId, () => policy, () => [node], policy, node, 1000));
  };

  test('the deadline ends a request that has not acted, but not the result of one that has', () => {
    const realSetTimeout = globalThis.setTimeout;
    let fireDeadline: () => void = () => {};
    globalThis.setTimeout = ((handler: () => void) => { fireDeadline = handler; return { unref() {} } as unknown as ReturnType<typeof setTimeout>; }) as unknown as typeof globalThis.setTimeout;
    const realNow = Date.now();
    const now = spyOn(Date, 'now').mockReturnValue(realNow);
    try {
      const invalidate: { listener: (() => void) | null } = { listener: null };
      const owner = beginOwned(invalidate);
      now.mockReturnValue(realNow + 5000);
      fireDeadline();
      expect(() => owner.assertCurrent()).toThrow();
      expect(() => owner.assertCurrent(false, true)).not.toThrow();

      // A revocation or config change still ends it after the effect.
      invalidate.listener?.();
      expect(() => owner.assertCurrent(false, true)).toThrow();
      owner.close();
    } finally {
      now.mockRestore();
      globalThis.setTimeout = realSetTimeout;
    }
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

describe('an autonomous request whose phone answers after the request deadline', () => {
  test('the answer and its captured bytes are kept, not discarded as denied-by-jev', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const fake = fakePort((_name, question) => choiceAnswer(question, 'act', 0.99));
    const realNow = Date.now();
    const now = spyOn(Date, 'now').mockReturnValue(realNow);
    try {
      const service = new DeviceCapabilityService({
        grants: new GrantStore(join(root, 'grants.json')),
        artifacts: new DeviceCaptureArtifactStore(join(root, 'captures')),
        dispatcher: {
          async dispatch(input) {
            input.admission?.claim();
            // The phone answers ok, but only after the request's own deadline.
            now.mockReturnValue(realNow + 60 * 60 * 1000);
            return { ok: true, data: { seen: true }, bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' };
          },
        },
        confirm: async () => { throw new Error('autonomous requests never prompt a person'); },
        listNodes: () => [profile()],
        autonomous: { port: withDecisionLog(fake.port, log) },
      });
      const outcome = await withExternalOperationSource({ sourceOf: () => ({ goal: 'Check the door', criteria: [] }), assertCurrent() {} }, () =>
        service.request({ nodeId: 'node-a', capabilityId: 'device.camera.rear.capture', reason: 'check the door' }));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.artifact).toBeDefined();
    } finally {
      now.mockRestore();
    }
  });
});
