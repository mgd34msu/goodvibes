/**
 * A phone action from a hosted turn: a live grant runs it with no question, no
 * grant asks the owner once, and neither path asks a decision model about the
 * device action itself.
 */
import { expect, spyOn, test } from 'bun:test';
import { withDecisionLog, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createHostedSessionRuntime } from '@goodvibes-jev/engine/platform/platform/hosted-sessions';
import { DEVICE_CAPABILITY_IDS, DEVICE_NODE_ANNOUNCEMENT_KEY } from '@goodvibes-jev/engine/platform/platform/devices';
import { executeToolCalls, type ToolExecutionDeps } from '@goodvibes-jev/engine/platform/platform/core';
import { gateReadingsPort } from '../helpers/synthetic-gate-readings.js';
import { createHostedSessionOptions } from '../../runtime/hosted-session-composition.js';
import { useGatewayFixture } from '../helpers/gateway-fixture.js';

const fixture = useGatewayFixture({ hostSessions: false });
async function until(check: () => boolean) { const deadline = Date.now() + 5000; while (!check()) { if (Date.now() > deadline) throw new Error('Device work was not queued'); await new Promise(done => setTimeout(done, 5)); } }

async function hosted() {
  const daemon = fixture(); const services = daemon.services;
  const floor = await createHostedSessionOptions(services).floorFactory!({ workspaceRoot: daemon.workingDirectory });
  expect(floor.devicePosture).toBe(services.devicePosture);
  const runtime = createHostedSessionRuntime({ floor, sessionId: 'device-canonical', workspaceRoot: daemon.workingDirectory, systemPrompt: 'Synthetic paired-device proof' });
  const readings: JudgmentRequest<Questions>[] = [];
  let hook: ((request: JudgmentRequest<Questions>) => void | Promise<void>) | undefined;
  const gate = gateReadingsPort([['', { outward: true, capability: 'write_fs', names_path: false, names_host: false }]]);
  const semantic = fakePort((_name, question) => question.type === 'noul' ? noulAnswer(0.99) : choiceAnswer(question, 'act', 0.99));
  const record = (log: typeof services.judgment.decisionLog) => withDecisionLog({ model: 'jev-1.13.0', async ask(request) {
    readings.push(request as JudgmentRequest<Questions>); request.beforeAttempt?.(); await hook?.(request as JudgmentRequest<Questions>);
    request.signal?.throwIfAborted(); request.beforeAttempt?.();
    return 'disposition' in request.questions || 'refuse' in request.questions ? semantic.port.ask(request) : gate.port.ask(request);
  } }, log);
  const rootPort = record(services.judgment.decisionLog); const floorPort = record(floor.services.judgment.decisionLog);
  const rootSpy = spyOn(services.judgment.port, 'ask').mockImplementation(request => rootPort.ask(request));
  const floorSpy = spyOn(floor.services.judgment.port, 'ask').mockImplementation(request => floorPort.ask(request));
  const human = spyOn(services.approvalBroker, 'requestApproval').mockImplementation(async () => ({ approved: true }));
  const manager = services.distributedRuntime;
  const pair = await manager.requestPairing({ peerKind: 'device', label: 'Canonical synthetic phone', capabilities: DEVICE_CAPABILITY_IDS,
    metadata: { [DEVICE_NODE_ANNOUNCEMENT_KEY]: { nodeKind: 'web-pwa', contractVersion: 1, capabilities: DEVICE_CAPABILITY_IDS, secureContext: true } } });
  await manager.approvePairRequest(pair.request.id); const verified = await manager.verifyPairRequest(pair.request.id, pair.challenge);
  expect(verified).not.toBeNull(); const auth = { peer: verified!.peer, token: verified!.token };
  const turn = new AbortController();
  const deps: ToolExecutionDeps = { autonomousSource: () => ({ goal: 'Take the requested synthetic phone screenshot', criteria: ['Only this paired phone, retain exact returned bytes'] }),
    turnSignal: turn.signal, permissionManager: floor.services.permissionManager, toolRegistry: runtime.toolRegistry,
    hookDispatcher: null, runtimeBus: services.runtimeBus, sessionId: runtime.sessionId,
    emitterContext: () => ({ sessionId: runtime.sessionId, traceId: 'device-fixture', source: 'orchestrator' }),
  };
  return { manager, auth, runtime, readings, human, turn, services, onReading(next: typeof hook) { hook = next; },
    run() { return executeToolCalls(deps, crypto.randomUUID(), [{ id: crypto.randomUUID(), name: 'phone', arguments: { action: 'screenshot', nodeId: auth.peer.id, reason: 'Original screenshot request' } }]); },
    async close() { turn.abort(); rootSpy.mockRestore(); floorSpy.mockRestore(); human.mockRestore(); runtime.dispose(); await floor.dispose(); await manager.writes.drain(); },
  };
}

const deviceReadings = (readings: readonly JudgmentRequest<Questions>[]) => readings.filter(request => String(request.context?.site ?? '').startsWith('engine.device'));

async function answerOnce(h: Awaited<ReturnType<typeof hosted>>) {
  const pending = h.run(); await until(() => h.manager.listWork().some(work => work.peerId === h.auth.peer.id && work.status === 'queued'));
  const [work] = await h.manager.claimWork(h.auth); expect(work?.command).toBe('device.screen.capture');
  await h.manager.completeWork(h.auth, work!.id, { result: { contractVersion: 1, capabilityId: 'device.screen.capture', ok: true, mediaBase64: Buffer.from('owned synthetic pixels').toString('base64'), mediaType: 'image/png' } });
  return pending;
}

test('with no grant a hosted phone action asks the owner once and no decision model', async () => {
  const h = await hosted();
  try {
    expect(h.runtime.toolRegistry.has('phone')).toBe(true);
    const result = await answerOnce(h); expect(result[0]?.success).toBe(true);
    expect(h.human).toHaveBeenCalledTimes(1);
    expect(deviceReadings(h.readings)).toEqual([]);
    expect(await fixture().services.devicePosture.artifacts.list(h.auth.peer.id)).toHaveLength(1);
  } finally { await h.close(); }
});

test('a live grant runs a hosted phone action with no question at all', async () => {
  const h = await hosted();
  try {
    await h.services.devicePosture.grants.record({ nodeId: h.auth.peer.id, nodeKind: 'web-pwa', capabilityId: 'device.screen.capture', scope: 'always', grantedBy: 'operator' });
    const result = await answerOnce(h); expect(result[0]?.success).toBe(true);
    expect(h.human).not.toHaveBeenCalled();
    expect(deviceReadings(h.readings)).toEqual([]);
  } finally { await h.close(); }
});
