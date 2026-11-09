/** Native metadata must prove its owner binding before using canonical protocol encoding. */
import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { SqliteDecisionLog, withDecisionLog, type EntryType } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { criteriaSetIdForWork, durablePayloadRevision, type DurableContractRequest } from '../../platform/src/platform/contract/durable-admission.js';
import * as admissionModule from '../../platform/src/platform/contract/durable-admission.js';
import { decideNativeContract } from '../../platform/src/platform/contract/native-decisions.js';
import { captureNativeContractSource, nativeSourceCriteria } from '../../platform/src/platform/contract/native-source.js';
import type { Contract, NativeContractSource } from '../../platform/src/platform/contract/types.js';
import { judgmentInputProblem } from '../../platform/src/platform/gate/judgment-input.js';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';

const workId = 'work-a73a83d8-d064-4be3-8217-012ebfe72275';
const criteriaId = 'criteria:d6b72d9f28026994604091a0bbac8dfa87467c68300f6960922429de420bbdfb';
const authority = { authorityId: 'owned-authority', authorityRevision: '1', scopeId: 'owned-scope', scopeRevision: '1' };
function contract(overrides: Partial<NativeContractSource> = {}, admittedWorkId: string | null = workId): Contract {
  const source = captureNativeContractSource({ sourceId: 'owned-source', sourceRevision: '1', inputRevision: 'owned-input',
    criteriaId, criteriaRevision: '1', goal: 'Preserve the original request.', criteria: ['Preserve all requirements.'], ...overrides });
  const request: DurableContractRequest = {
    key: { workId: admittedWorkId ?? workId, criteriaId: source.criteriaId, criteriaRevision: source.criteriaRevision, attemptId: 'owned-attempt' },
    binding: { sourceId: source.sourceId, inputRevision: source.inputRevision, actionId: 'owned-start', actionRevision: '1', ...authority },
    input: { ask: source.goal, nativeSource: source, sessionId: 'owned-session', origin: 'turn', projectRoot: '/owned-synthetic-project', isolation: 'shared' },
  };
  // This boundary fixture contains every field read by native decision/checkpoint validation.
  return { ...request.input, id: 'ctr-39723693', ownerAgentId: 'owned-owner', status: 'checking-plan',
    goal: source.goal, criteria: nativeSourceCriteria(source), judgmentUsage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    ...(admittedWorkId === null ? {} : { durableAdmission: { ...request, schemaVersion: 1, contractId: 'ctr-39723693',
      ownerAgentId: 'owned-owner', payloadRevision: durablePayloadRevision(request) } }),
  } as Contract;
}
async function decide(value: Contract, state: EntryType = { plan: 'Keep every original requirement.' }) {
  return decideNativeContract(value, { host: { authorityOf: () => authority }, changed() {} }, {
    stage: 'plan', targetId: value.id, action: 'Accept this exact checked plan', allowAct: true, state: () => state,
    continuations: [], signal: new AbortController().signal,
  });
}
async function recorded(run: (fake: ReturnType<typeof fakePort>, log: SqliteDecisionLog) => Promise<void>) {
  using log = new SqliteDecisionLog(':memory:');
  const fake = fakePort((_name, question) => choiceAnswer(question, 'act', 0.99));
  const prior = installJudgmentPort(withDecisionLog(fake.port, log));
  try { await run(fake, log); } finally { installJudgmentPort(prior); }
}

test('exact generated criteria ID reaches recorded native decisions through its durable owner binding', async () => {
  expect(criteriaSetIdForWork(workId)).toBe(criteriaId);
  expect(judgmentInputProblem(criteriaId)).toBe('card-material');
  await recorded(async (fake, log) => {
    const value = contract();
    const result = await decide(value);
    expect(result.decision.outcome).toBe('act'); expect(fake.requests).toHaveLength(1);
    expect(result.decision.evidence).toContainEqual({ id: criteriaId.slice('criteria:'.length), revision: '1' });
    expect(value.nativeSource!.criteriaId).toBe(criteriaId);
    expect(value.durableAdmission!.key.criteriaId).toBe(criteriaId);
    expect(log.query()).toHaveLength(1);
    expect(fake.requests[0]!.state).toMatchObject({ originalSource: { goal: value.goal, criteria: ['Preserve all requirements.'] } });
    result.assertCurrent();
  });
});

test('fresh stored opaque criteria references reach actual native decisions without deriving or forwarding a work-id checksum', async () => {
  const id = 'criteria-v2:' + opaqueUuid();
  await recorded(async (_fake, log) => {
    const value = contract({ criteriaId: id }), result = await decide(value);
    expect(result.decision.outcome).toBe('act'); expect(result.decision.evidence).toContainEqual({ id, revision: '1' });
    expect(value.durableAdmission!.key.criteriaId).toBe(id); expect(log.query()).toHaveLength(1);
  });
});

test('fresh native decisions retain distinct action incarnations while exact live evidence still governs claims', async () => {
  await recorded(async () => {
    const value = contract(), evidence = { plan: 'Keep every original requirement.' };
    const first = await decide(value, evidence);
    const second = await decide(value, evidence);
    expect(first.decision.binding.actionRevision).not.toBe(second.decision.binding.actionRevision);
    expect(first.decision.evidence.find(ref => ref.id === 'operation-evidence')?.revision).toBe(first.decision.binding.actionRevision);
    expect(second.decision.evidence.find(ref => ref.id === 'operation-evidence')?.revision).toBe(second.decision.binding.actionRevision);
    first.assertCurrent(); second.assertCurrent();
    evidence.plan = 'Replace the original requirements.';
    expect(() => first.recordClaim()).toThrow();
    expect(() => second.recordClaim()).toThrow();
  });
});

test.each(['unbound', 'different-work', 'suffix', 'raw-pan', 'prefixed-pan', 'credential'] as const)(
  '%s criteria metadata cannot acquire the generated-reference exception', async mode => {
    const id = mode === 'suffix' ? `${criteriaId}:suffix` : mode === 'raw-pan' ? '4111111111111111'
      : mode === 'prefixed-pan' ? 'criteria:4111111111111111' : mode === 'credential' ? 'password=owned-synthetic-secret' : criteriaId;
    const value = contract({ criteriaId: id }, mode === 'unbound' ? null : mode === 'different-work' ? 'different-owned-work' : workId);
    await recorded(async (fake, log) => {
      await expect(decide(value)).rejects.toMatchObject({ problem: mode === 'credential' ? 'credential-material' : 'card-material' });
      expect(fake.requests).toHaveLength(0); expect(log.query()).toHaveLength(0);
    });
  },
);

test.each(['goal', 'criterion', 'state', 'source-id', 'criteria-revision'] as const)(
  'a proven criteria identity never exempts raw sensitive %s', async field => {
    const pan = '4111111111111111';
    const value = contract(field === 'goal' ? { goal: pan } : field === 'criterion' ? { criteria: [pan] }
      : field === 'source-id' ? { sourceId: pan } : field === 'criteria-revision' ? { criteriaRevision: pan } : {});
    await recorded(async (fake, log) => {
      await expect(decide(value, field === 'state' ? { input: criteriaId } : {})).rejects.toMatchObject({ problem: 'card-material' });
      expect(fake.requests).toHaveLength(0); expect(log.query()).toHaveLength(0);
    });
  },
);

test('inconsistent durable criteria binding cannot normalize a matching source ID', async () => {
  const original = contract();
  const value: Contract = { ...original, durableAdmission: { ...original.durableAdmission!,
    key: { ...original.durableAdmission!.key, criteriaId: 'different-owned-criteria' } } };
  await recorded(async (fake, log) => {
    await expect(decide(value)).rejects.toMatchObject({ problem: 'card-material' });
    expect(fake.requests).toHaveLength(0); expect(log.query()).toHaveLength(0);
  });
});


// UNRUN: exercises the actual native decision and its repeated currentness
// guards; no helper-only count or synthetic replacement decision.
test('ordinary criteria references never invoke the earlier work-ID hash recipe', async () => {
  const value = contract({ criteriaId: 'owner-saved-requirements' });
  const hash = spyOn(admissionModule, 'criteriaSetIdForWork');
  try {
    await recorded(async () => {
      const result = await decide(value); result.assertCurrent(); result.assertCurrent();
      expect(result.decision.evidence).toContainEqual({ id: 'owner-saved-requirements', revision: '1' });
      expect(hash).not.toHaveBeenCalled();
    });
  } finally { hash.mockRestore(); }
});

test('an actual earlier criteria spelling is verified once per original admission while live guards still run', async () => {
  const value = contract(), hash = spyOn(admissionModule, 'criteriaSetIdForWork');
  try {
    await recorded(async () => {
      const first = await decide(value), second = await decide(value);
      first.assertCurrent(); second.assertCurrent();
      expect(first.decision.evidence).toContainEqual({ id: criteriaId.slice('criteria:'.length), revision: '1' });
      expect(hash).toHaveBeenCalledTimes(1);
    });
  } finally { hash.mockRestore(); }
});

// UNRUN: a prototype callback cannot manufacture the old privacy-reference
// cache for a criteria digest that does not belong to its actual saved work.
test('late WeakMap overrides cannot launder an unverified historical criteria reference', async () => {
  await recorded(async (fake) => {
    const value = contract({}, 'different-original-work'), admission = value.durableAdmission!;
    const get = WeakMap.prototype.get, apply = Reflect.apply;
    try {
      WeakMap.prototype.get = function(key) {
        if (key === admission) return { workId: admission.key.workId, criteriaId: value.nativeSource!.criteriaId };
        return apply(get, this, [key]);
      };
      await expect(decide(value)).rejects.toMatchObject({ problem: 'card-material' });
      expect(fake.requests).toHaveLength(0);
    } finally { WeakMap.prototype.get = get; }
  });
});

// Source regression: only the actual decision-log input commitment is needed
// for an ordinary native act. No second whole-operation hash has a consumer.
test('ordinary native decisions reuse their action incarnation without hashing a deferred-operation cache key', async () => {
  await recorded(async (_fake, log) => {
    const value = contract({ criteriaId: 'current-criteria' }, null), hash = spyOn(crypto, 'createHash');
    try {
      const result = await decide(value);
      expect(result.decision.outcome).toBe('act');
      const record = value.nativeDecisions!.history.at(-1)!;
      expect(record.operationRevision).toBe(record.decision.binding.actionRevision);
      expect(hash.mock.calls.filter(call => call[0] === 'sha256')).toHaveLength(log.query().length);
      result.recordClaim();
      result.assertCurrent();
    } finally { hash.mockRestore(); }
  });
});
