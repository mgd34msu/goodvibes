import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RemoteRunnerRegistry } from '../platform/src/platform/runtime/remote/runner-registry.js';
import { ReconnectEngine, type ConnectOutcome, type TransportAdapter } from '../platform/src/platform/runtime/remote/reconnect.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

describe('importing remote artifacts', () => {
  test('a file that is not an artifact is refused by name and leaves the registry unchanged', async () => {
    const dir = makeProjectTempDir('remote-import');
    const path = join(dir, 'not-an-artifact.json');
    writeFileSync(path, JSON.stringify({ id: 'x', runnerId: 'r' }));
    const registry = new RemoteRunnerRegistry({ getStatus: () => null, list: () => [] });
    await expect(registry.importArtifact(path)).rejects.toThrow('createdAt');
    expect(registry.listArtifacts()).toEqual([]);
    expect(registry.listContracts()).toEqual([]);
  });

  test('an artifact that would widen a known runner\'s capability ceiling is refused on every import path', async () => {
    const dir = makeProjectTempDir('remote-import');
    const now = Date.now();
    const contract = {
      id: 'runner:r1', runnerId: 'r1', label: 'r1', sourceTransport: 'acp', trustClass: 'self-hosted-acp', template: 'general',
      capabilityCeiling: { allowedTools: ['read'], capabilityCeilingTools: ['read'], executionProtocol: 'gather-plan-apply', reviewMode: 'none',
        communicationLane: 'direct', orchestrationDepth: 0, successCriteria: [], requiredEvidence: [], writeScope: [] },
      createdAt: now, lastUpdatedAt: now, transport: { state: 'initializing', messageCount: 0, errorCount: 0 },
    } as unknown as Parameters<RemoteRunnerRegistry['registerContract']>[0];
    const source = new RemoteRunnerRegistry({ getStatus: () => null, list: () => [] });
    source.registerContract(contract);
    const artifact = source.captureArtifactForRunner('r1')!;
    const wide = { ...artifact, runnerContract: { ...artifact.runnerContract, capabilityCeiling: { ...artifact.runnerContract.capabilityCeiling, allowedTools: ['read', 'exec', 'write'] } } };
    const artifactPath = join(dir, 'wide-artifact.json');
    writeFileSync(artifactPath, JSON.stringify(wide));
    const bundlePath = join(dir, 'wide-bundle.json');
    writeFileSync(bundlePath, JSON.stringify({ version: 1, exportedAt: now, sessionId: 's', activeConnectionIds: [], pools: [], contracts: [wide.runnerContract], artifacts: [] }));

    const target = new RemoteRunnerRegistry({ getStatus: () => null, list: () => [] });
    target.registerContract(contract);
    await expect(target.importArtifact(artifactPath)).rejects.toThrow('different capability ceiling');
    await expect(target.importSessionBundle(bundlePath)).rejects.toThrow('different capability ceiling');
    expect(target.listArtifacts()).toEqual([]);
    expect(target.getContract('r1')?.capabilityCeiling.allowedTools).toEqual(['read']);
  });

  test('a session bundle with one bad artifact imports nothing', async () => {
    const dir = makeProjectTempDir('remote-import');
    const path = join(dir, 'bundle.json');
    writeFileSync(path, JSON.stringify({ version: 1, pools: [{ id: 'p', label: 'P', runnerIds: [] }], contracts: [], artifacts: [{}] }));
    const registry = new RemoteRunnerRegistry({ getStatus: () => null, list: () => [] });
    await expect(registry.importSessionBundle(path)).rejects.toThrow('artifacts[0]');
    expect(registry.listPools()).toEqual([]);
  });
});

const FAST = { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, jitter: 0 };
const IDENTITY = { sessionId: 's1', clientId: 'c1' } as never;
const retryable = { success: false, category: 'network', error: 'connection reset', retryable: true } as ConnectOutcome;

function engine(connect: TransportAdapter['connect'], policy = FAST, onConnected: () => void = () => {}) {
  const adapter: TransportAdapter = { connect, disconnect: async () => {}, requestReplay: async () => {} };
  return new ReconnectEngine(adapter, IDENTITY, undefined, { onConnected, onTerminalFailure: () => {} }, policy);
}

describe('the reconnect loop', () => {
  test('dispose during the back-off sleep ends the loop instead of leaving it pending', async () => {
    const loop = engine(async () => retryable, { ...FAST, initialDelayMs: 60_000, maxDelayMs: 60_000 });
    const running = loop.reconnect(async () => 'token');
    await Bun.sleep(5);
    loop.dispose();
    expect(await Promise.race([running, Bun.sleep(500).then(() => 'hung')])).toBe(false);
  });

  test('a loop that ran out of attempts can be started again', async () => {
    let calls = 0;
    const loop = engine(async () => { calls++; return retryable; });
    expect(await loop.reconnect(async () => 'token')).toBe(false);
    const before = calls;
    expect(await loop.reconnect(async () => 'token')).toBe(false);
    expect(calls - before).toBe(FAST.maxAttempts);
  });

  test('a token provider that throws counts as a failed attempt', async () => {
    const loop = engine(async () => retryable);
    expect(await loop.reconnect(async () => { throw new Error('token store locked'); })).toBe(false);
  });

  test('no connection is reported once the engine is disposed mid-connect', async () => {
    let connected = 0;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const loop = engine(async () => {
      await gate;
      return { success: true, token: 't', epoch: 1, replayFromOffset: 0, negotiatedProtocol: undefined } as unknown as ConnectOutcome;
    }, FAST, () => { connected++; });
    const pending = loop.connect('token');
    loop.dispose();
    finish();
    expect(await pending).toBe(false);
    expect(connected).toBe(0);
  });
});
