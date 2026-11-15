/**
 * agent-harness-remote.test.ts
 *
 * Focused tests for the distributed remote execution surface exposed via
 * agent_harness remote_* modes.
 *
 * Guarantees:
 *   1. Read surfaces (remote_snapshot, remote_peers, remote_work, remote_pair_requests)
 *      return success:true with the expected methodId, route, and effect fields.
 *   2. Mutation surfaces require current recorded admission; caller flags do not grant it.
 *   3. Genuinely admitted mutation surfaces preserve their operator handoff and native
 *      pairing requirements without performing remote effects in these fixtures.
 *   4. The remote catalog modes are registered in AGENT_HARNESS_MODES and described in
 *      HARNESS_MODE_DESCRIPTORS with the correct kinds and safety annotations.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { AGENT_HARNESS_MODES } from '../../tools/agent-harness-tool-schema.ts';
import { HARNESS_MODE_DESCRIPTORS } from '../../tools/agent-harness-mode-catalog.ts';
import { makeHandoffFixture } from './agent-harness-handoff-fixture.ts';

const REMOTE_READ_MODES = ['remote_snapshot', 'remote_peers', 'remote_work', 'remote_pair_requests'] as const;
const REMOTE_MUTATION_MODES = ['remote_pair_approve', 'remote_pair_reject', 'remote_peers_invoke', 'remote_work_cancel'] as const;
const ALL_REMOTE_MODES = [...REMOTE_READ_MODES, ...REMOTE_MUTATION_MODES] as const;

let previousPort: ReturnType<typeof installJudgmentPort>;
let decisionLog: SqliteDecisionLog;
let readings: ReturnType<typeof fakePort>;
const NO_QUESTIONS = new Set(['mutates', 'outward', 'secrets', 'irreversible', 'beyondProject',
  'weakensSecurity', 'obfuscated', 'flagsRisk', 'catastrophic', 'cardDetails']);
const ADMISSION_BATTERIES = new Set(['engine.gate.boundary', 'engine.gate.side-effect',
  'engine.gate.risk-family', 'engine.gate.autonomous-disposition', 'engine.gate.autonomous-refusal']);

beforeEach(() => {
  // Authored local handoff readings intentionally classify the body as read.
  // The authentic engine proof and deterministic effect floors still apply.
  readings = fakePort((wireName, question) => {
    const name = wireName.replace(/^(effect|risk|edge)__/, '');
    const label = name === 'disposition' ? 'act' : name === 'kind' ? 'read'
      : name === 'family' || name === 'capability' ? 'generic' : undefined;
    if (question.type === 'choice' && label) return choiceAnswer(question, label, 0.999);
    if (question.type === 'noul' && NO_QUESTIONS.has(name)) return noulAnswer(0.001);
    throw new Error(`Unscripted remote admission question ${name}`);
  });
  const port: JudgmentPort = { model: readings.port.model, ask(request) {
    if (!request.context?.battery?.split('+').every(name => ADMISSION_BATTERIES.has(name))) throw new Error('Unscripted remote admission battery');
    return readings.port.ask(request);
  } };
  decisionLog = new SqliteDecisionLog(':memory:');
  previousPort = installJudgmentPort(withDecisionLog(port, decisionLog));
});
afterEach(() => { installJudgmentPort(previousPort); decisionLog[Symbol.dispose](); });

function makeRemoteFixture() {
  const base = makeHandoffFixture({ label: 'gv-remote' });
  const source = { goal: 'Inspect an operator handoff in an isolated local fixture',
    criteria: ['Preserve the exact remote route and input', 'Perform no remote effects'] };
  const admit = (args: Record<string, unknown>, signal?: AbortSignal) => base.admit(source, args, signal);

  return {
    tool: base.tool,
    toolRegistry: base.toolRegistry, configManager: base.configManager, source, admit,
    async run(args: Record<string, unknown>, signal?: AbortSignal) {
      const { call, admission } = await admit(args, signal);
      return base.toolRegistry.executePrepared(call, admission);
    },
    cleanup: () => rmSync(base.root, { recursive: true, force: true }),
  };
}

describe('agent_harness remote surface', () => {
  test('all remote modes are registered in AGENT_HARNESS_MODES', () => {
    const modeSet = new Set(AGENT_HARNESS_MODES);
    for (const mode of ALL_REMOTE_MODES) {
      expect(modeSet.has(mode)).toBe(true);
    }
  });

  test('remote mode descriptors separate read routes from admitted effect handoffs', () => {
    const descriptorMap = new Map(HARNESS_MODE_DESCRIPTORS.map((d) => [d.id, d]));

    for (const mode of REMOTE_READ_MODES) {
      const descriptor = descriptorMap.get(mode);
      expect(descriptor).toBeDefined();
      expect(descriptor?.kind).toBe('inspect');
      expect(descriptor?.family).toBe('remote');
      expect(Object.hasOwn(descriptor ?? {}, 'requiresConfirmation')).toBe(false);
    }

    for (const mode of REMOTE_MUTATION_MODES) {
      const descriptor = descriptorMap.get(mode);
      expect(descriptor).toBeDefined();
      expect(descriptor?.kind).toBe('effect');
      expect(descriptor?.family).toBe('remote');
      expect(descriptor?.summary).toContain('Admitted handoff');
      expect(descriptor?.next).toContain('agent_operator_method');
      expect(Object.hasOwn(descriptor ?? {}, 'requiresConfirmation')).toBe(false);
      expect(descriptor?.parameters).not.toContain('confirm');
      expect(descriptor?.parameters).not.toContain('explicitUserRequest');
    }
  });

  test('read surfaces return success:true with correct methodId, route, and effect', async () => {
    const fixture = makeRemoteFixture();
    try {
      const expectations: Record<string, { methodId: string; effect: string }> = {
        remote_snapshot: { methodId: 'remote.snapshot', effect: 'read-only-network' },
        remote_peers: { methodId: 'remote.peers.list', effect: 'read-only-network' },
        remote_work: { methodId: 'remote.work.list', effect: 'read-only-network' },
        remote_pair_requests: { methodId: 'remote.pair.requests.list', effect: 'read-only-network' },
      };

      for (const [mode, expected] of Object.entries(expectations)) {
        const result = await fixture.tool.execute({ mode });
        expect(result.success).toBe(true);
        const parsed = JSON.parse(result.output ?? '{}') as Record<string, unknown>;
        expect(parsed.methodId).toBe(expected.methodId);
        expect(parsed.effect).toBe(expected.effect);
        expect(typeof parsed.modelRoute).toBe('string');
        expect(parsed.modelRoute).toBe(`agent_operator_method methodId:"${expected.methodId}" input:{}`);
        expect(parsed.recordedAdmissionRequired).toBe(false);
        expect(Object.hasOwn(parsed, 'confirmationRequired')).toBe(false);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test('raw mutation surfaces reject caller flags as well as absent flags', async () => {
    const fixture = makeRemoteFixture();
    try {
      for (const mode of REMOTE_MUTATION_MODES) {
        for (const extra of [{}, { confirm: true, explicitUserRequest: 'Caller-authored remote request' }]) {
          // Ids are supplied so the refusal under test is the missing admission, not the missing input.
          const result = await fixture.tool.execute({ mode, target: 'remote-id-1', command: 'status', ...extra });
          expect(result.success).toBe(false);
          expect(result.error).toContain('recorded effect admission');
          expect(result.output).toBeUndefined();
        }
      }
      expect(readings.requests).toHaveLength(0);
      expect(decisionLog.query()).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test('recorded act admission returns operator handoffs without caller grants', async () => {
    const fixture = makeRemoteFixture();
    try {
      const methodIdMap: Record<string, string> = {
        remote_pair_approve: 'remote.pair.requests.approve',
        remote_pair_reject: 'remote.pair.requests.reject',
        remote_peers_invoke: 'remote.peers.invoke',
        remote_work_cancel: 'remote.work.cancel',
      };

      for (const [mode, expectedMethodId] of Object.entries(methodIdMap)) {
        const result = await fixture.run({ mode, requestId: 'req-1', peerId: 'peer-1', command: 'inspect', workId: 'work-1' });
        expect(result.success).toBe(true);
        const parsed = JSON.parse(result.output ?? '{}') as Record<string, unknown>;
        expect(parsed.methodId).toBe(expectedMethodId);
        expect(parsed.effect).toBe('connected-host-state');
        expect(parsed.recordedAdmissionRequired).toBe(true);
        expect(Object.hasOwn(parsed, 'confirmationRequired')).toBe(false);
        expect(typeof parsed.modelRoute).toBe('string');
        expect(String(parsed.modelRoute)).toBe(`agent_operator_method methodId:"${expectedMethodId}" input:${JSON.stringify(parsed.input)}`);
        expect(parsed.modelRoute).not.toContain('confirm:');
        expect(parsed.modelRoute).not.toContain('explicitUserRequest:');
        expect(parsed.policy).toContain('fresh admission');
        if (mode !== 'remote_work_cancel') expect(parsed.policy).toContain('native pairing protocol');
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test('remote_pair_approve handoff includes requestId in input when provided', async () => {
    const fixture = makeRemoteFixture();
    try {
      const result = await fixture.run({
        mode: 'remote_pair_approve',
        requestId: 'req-abc-123',
        note: 'approved by user',
      });
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output ?? '{}') as Record<string, unknown>;
      expect(parsed.methodId).toBe('remote.pair.requests.approve');
      const inputField = parsed.input as Record<string, unknown>;
      expect(inputField.requestId).toBe('req-abc-123');
      expect(inputField.note).toBe('approved by user');
    } finally {
      await fixture.cleanup();
    }
  });

  test('remote_peers_invoke handoff includes peerId and command in input when provided', async () => {
    const fixture = makeRemoteFixture();
    const payload = { task: 'Inspect the owned fixture', detail: { revision: 'original' } };
    try {
      const result = await fixture.run({
        mode: 'remote_peers_invoke',
        peerId: 'peer-xyz',
        command: 'run-task',
        payload,
      });
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output ?? '{}') as Record<string, unknown>;
      expect(parsed.methodId).toBe('remote.peers.invoke');
      const inputField = parsed.input as Record<string, unknown>;
      expect(inputField.peerId).toBe('peer-xyz');
      expect(inputField.command).toBe('run-task');
      expect(inputField.payload).toEqual(payload);
    } finally {
      await fixture.cleanup();
    }
  });

  test('remote_work_cancel handoff includes workId and reason when provided', async () => {
    const fixture = makeRemoteFixture();
    try {
      const result = await fixture.run({
        mode: 'remote_work_cancel',
        workId: 'work-001',
        reason: 'user requested cancellation',
      });
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output ?? '{}') as Record<string, unknown>;
      expect(parsed.methodId).toBe('remote.work.cancel');
      const inputField = parsed.input as Record<string, unknown>;
      expect(inputField.workId).toBe('work-001');
      expect(inputField.reason).toBe('user requested cancellation');
    } finally {
      await fixture.cleanup();
    }
  });

  test.each(['source', 'config', 'cancel'] as const)('a prepared handoff is held when its original %s retires', async change => {
    const fixture = makeRemoteFixture();
    const controller = new AbortController();
    try {
      const { call, admission } = await fixture.admit({ mode: 'remote_peers_invoke', peerId: 'peer-owned',
        command: 'inspect-fixture', payload: { task: 'Keep the complete original handoff' } }, controller.signal);
      const count = readings.requests.length;
      if (change === 'source') fixture.source.goal = 'A different operator task';
      if (change === 'config') fixture.configManager.set('permissions.mode', 'plan');
      if (change === 'cancel') controller.abort();
      await expect(fixture.toolRegistry.executePrepared(call, admission)).rejects.toThrow();
      expect(readings.requests).toHaveLength(count);
      expect(decisionLog.query({ site: 'engine.gate.autonomous-tool' }).flatMap(entry => entry.status === 'answered'
        ? entry.notes.filter(note => note.kind === 'action' && note.action.startsWith('autonomous:claim:')) : [])).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test.each(['private', 'card', 'accessor'] as const)('complete %s handoff input is refused before hosted readings', async kind => {
    const fixture = makeRemoteFixture();
    let getterCalls = 0;
    const payload: Record<string, unknown> = { task: 'Inspect only the owned fixture' };
    if (kind === 'private') payload.apiKey = 'synthetic-remote-private';
    if (kind === 'card') payload.unknown = '4111111111111111';
    if (kind === 'accessor') Object.defineProperty(payload, 'undisplayed', { enumerable: true,
      get() { getterCalls++; return 'synthetic-remote-private'; } });
    try {
      await expect(fixture.run({ mode: 'remote_peers_invoke', peerId: 'peer-owned', command: 'inspect-fixture', payload })).rejects.toThrow();
      expect(readings.requests).toHaveLength(0);
      expect(decisionLog.query()).toHaveLength(0);
      expect(getterCalls).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test('the remote family in the mode catalog is exactly the eight remote modes', () => {
    const remoteDescriptors = HARNESS_MODE_DESCRIPTORS.filter((d) => d.family === 'remote');
    expect(remoteDescriptors).toHaveLength(8);
    const ids = remoteDescriptors.map((d) => d.id).sort();
    expect(ids).toEqual(
      ['remote_pair_approve', 'remote_pair_reject', 'remote_pair_requests', 'remote_peers', 'remote_peers_invoke', 'remote_snapshot', 'remote_work', 'remote_work_cancel'],
    );
  });
});
