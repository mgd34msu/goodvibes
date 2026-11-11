/** Actual runner regressions for recorded review inputs and durable refusals. */
import { expect, test } from 'bun:test';
import { JudgmentContextLimitError, JudgmentError, SqliteDecisionLog, observeJudgmentModel, recordedJudgmentInputHash, reuseObservedJudgmentResult, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureJudgmentPort, installJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult } from '../../platform/src/platform/gate/judgment-result.js';
import { makeHarness, makeRepo, oneUnitPlan, startContract, waitFor, type Harness, type HarnessOptions } from './runner-support.js';
import { finishes, terminal } from './steps-support.js';

for (const native of [false, true]) for (const copied of [false, true]) test(`split content review binds only native saved proofs (native=${native}, copy=${copied})`, async () => {
  using log = new SqliteDecisionLog(':memory:');
  const plan = oneUnitPlan(1);
  const source = { sourceId: 'actual-native-work', sourceRevision: '1', inputRevision: 'input-1', criteriaId: 'actual-native-criteria', criteriaRevision: '1',
    goal: plan.goal, criteria: plan.criteria.map(criterion => criterion.text) };
  const h = makeHarness({ decisionLog: log, recordNative: native,
    plan: native ? { ...plan, criteria: source.criteria.map((text, index) => ({ id: `c${index + 1}`, text, quote: text })) } : plan,
    scripts: { u1: finishes('The exact checked parser answer.') } });
  const original = judgmentPort('test.completion-recorded-input');
  let splits = 0;
  const replacement: JudgmentPort = { ...original, async ask(request) {
    if (request.context?.site === 'contract.check.final-answer-review' && Object.keys(request.questions).length > 1) {
      splits++; throw new JudgmentContextLimitError();
    }
    const result = await original.ask(request);
    return copied && request.context?.site === 'contract.check.final-answer-review' ? { ...result } : result;
  } };
  installJudgmentPort(replacement);
  let id: string | undefined;
  try {
    id = (await startContract(h, native ? { nativeSource: source } : {})).contract.id;
    if (native && copied) {
      await waitFor(() => h.store.get(id!)?.decisions.some(decision => decision.reason.includes('requires its actual recorded input')) === true, 'unrecorded copied result hold');
      expect(h.store.get(id)?.status).not.toBe('passed');
      expect(h.store.get(id)?.commit).toBeUndefined();
      expect(h.store.get(id)?.checks).toHaveLength(0);
      h.runner.cancel(id, 'Fixture observed missing original recorded input');
    } else {
      await waitFor(() => terminal(h, id!), 'actual recorded split-batch acceptance');
      expect(h.store.get(id)?.status).toBe('passed');
      const saved = h.store.get(id)!.decisions.findLast(decision => decision.targetId === `${id}.final-answer-review`)!;
      const receipt = JSON.parse(saved.reason) as { stateHash?: string; decisionIds: string[] };
      expect(receipt.decisionIds).toHaveLength(2);
      expect(receipt).not.toHaveProperty('evidenceDigest');
      if (native) {
        expect(receipt.stateHash).toMatch(/^[a-f0-9]{64}$/);
        for (const decisionId of receipt.decisionIds) expect(log.get(decisionId)).toMatchObject({ stateHash: receipt.stateHash, status: 'answered', context: { site: 'contract.check.final-answer-review' } });
      } else {
        expect(receipt).not.toHaveProperty('stateHash');
        for (const entry of log.query().filter(entry => entry.context.site?.startsWith('contract.check.'))) expect(entry).not.toHaveProperty('stateHash');
        const coverage = JSON.parse(h.store.get(id)!.decisions.findLast(decision => decision.targetId === `${id}.original-obligations`)!.reason);
        expect(coverage).not.toHaveProperty('stateHash');
        expect(coverage.passed).toBe(true);
      }
    }
    expect(splits).toBe(1);
    await h.runner.join(id);
  } finally {
    installJudgmentPort(original);
    h.dispose(); if (id) await h.runner.join(id);
  }
});

for (const interruption of [false, true]) for (const changed of [false, true]) test(`native content refusal survives localization ${interruption ? 'shutdown and explicit resume' : 'provider rejection'} (changed=${changed})`, async () => {
  using log = new SqliteDecisionLog(':memory:');
  const plan = oneUnitPlan(1);
  const source = { sourceId: 'original-native-work', sourceRevision: '1', inputRevision: 'input-1', criteriaId: 'original-native-criteria', criteriaRevision: '1',
    goal: plan.goal, criteria: plan.criteria.map(criterion => criterion.text) };
  let contentCalls = 0, fulfillmentCalls = 0, localizationCalls = 0;
  const root = makeRepo();
  const options: HarnessOptions = { root, decisionLog: log, recordNative: true,
    plan: { ...plan, criteria: source.criteria.map((text, index) => ({ id: `c${index + 1}`, text, quote: text })) },
    scripts: { u1: finishes('The retained parser answer.') }, port: context => {
      if (context.name === 'unfinished') { contentCalls++; return noulAnswer(contentCalls === 1 ? .98 : .03); }
      if (context.name === 'goal' && context.state['goal'] === source.goal) fulfillmentCalls++;
      const action = (context.state['binding'] as { actionId?: string } | undefined)?.actionId;
      if (context.name === 'disposition' && action?.includes(':stall:')) return choiceAnswer(context.question, 'reject', .99);
      return undefined;
    } };
  const h = makeHarness(options);
  let resumed: Harness | undefined;
  const original = judgmentPort('test.native-negative-then-localization-failure');
  const replacement: JudgmentPort = { ...original, async ask(request) {
    if (request.context?.site === 'contract.check.final-answer-finding') {
      localizationCalls++;
      const current = h.runner.list({ includeTerminal: true })[0]!;
      const saved = h.store.load(current.id)!;
      expect(saved.checks.at(-1)?.result).toBe('stall');
      expect(saved.checks.at(-1)?.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
      if (changed) writeFileSync(join(h.root, 'src/csv.ts'), 'export const parse = "new independent source evidence";\n');
      if (interruption) {
        // Stop at the durable refusal checkpoint, without a provider failure.
        // Only a later explicit resume may inspect the independently changed tree.
        h.runner.dispose();
        throw new JudgmentError('aborted', 'Fixture host stopped during localization');
      }
      throw new JudgmentError('rejected', 'Fixture later localization failed', { status: 400 });
    }
    return original.ask(request);
  } };
  installJudgmentPort(replacement);
  let id: string | undefined;
  try {
    id = (await startContract(h, { nativeSource: source })).contract.id;
    await waitFor(() => interruption ? localizationCalls === 1 : terminal(h, id!), 'durable refusal and localization stop', 15_000);
    await h.runner.join(id);
    expect(contentCalls).toBe(1);
    expect(localizationCalls).toBe(1);
    expect(h.store.get(id)?.commit).toBeUndefined();
    if (interruption) {
      expect(h.store.get(id)?.status).toBe('judging');
      h.dispose();
      resumed = makeHarness({ ...options, scripts: { u1: () => { throw new Error('Accepted worker must not rerun on resume'); } } });
      await resumed.runner.resumeAll();
      await waitFor(() => terminal(resumed!, id!), 'explicit retained-refusal or changed-evidence review', 15_000);
      await resumed.runner.join(id);
    } else {
      expect(h.store.get(id)?.status).toBe('failed');
      expect(h.store.get(id)?.failureKind).toBe('judgment-unavailable');
      expect(h.store.get(id)?.error).toContain('Fixture later localization failed');
      // Even changed files do not revive a terminal provider failure.
      await h.runner.resumeAll();
      expect(contentCalls).toBe(1);
    }
    const current = (resumed ?? h).store.get(id)!;
    const reassessed = interruption && changed;
    expect(localizationCalls).toBe(1);
    expect(contentCalls).toBe(reassessed ? 2 : 1);
    // These are actual withDecisionLog rows: fresh fulfillment calls would
    // get new IDs and must not make an unchanged negative content review vanish.
    const fulfilled = log.query({ site: 'contract.check.deliverable-judge', status: 'answered' });
    expect(fulfilled).toHaveLength(reassessed ? 2 : 1);
    expect(new Set(fulfilled.map(entry => entry.id)).size).toBe(fulfilled.length);
    expect(fulfillmentCalls).toBeGreaterThanOrEqual(fulfilled.length);
    const refused = current.checks.find(check => check.result !== 'pass')!;
    expect(refused.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    const negative = current.decisions.filter(decision => decision.targetId === `${id}.final-answer-review`)
      .map(decision => JSON.parse(decision.reason)).find(receipt => receipt.passed === false);
    expect(negative.negativeHold).toBe('native-refusal-check-v1');
    expect(negative).not.toHaveProperty('evidenceDigest');
    expect(log.get(negative.decisionIds[0])?.stateHash).toBe(negative.stateHash);
    expect(current.status === 'passed').toBe(reassessed);
    if (!reassessed) expect(current.commit).toBeUndefined();
  } finally {
    resumed?.dispose();
    if (resumed && id) await resumed.runner.join(id);
    installJudgmentPort(original); h.dispose(); if (id) await h.runner.join(id);
    rmSync(root, { recursive: true, force: true });
  }
});


test('strict complete admission preserves actual logged custom input observation without minting native model provenance', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const custom: JudgmentPort = { model: 'jev-custom-fixture', async ask(request) {
    return { answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul', noul: 0.1 }])) as never,
      requestedModel: request.model ?? 'jev-custom-fixture', model: 'jev-custom-fixture', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, requestId: undefined };
  } };
  const logged = withDecisionLog(custom, log), previous = installJudgmentPort(logged);
  try {
    const request = { state: 'Actual custom recorded input', questions: { flag: { type: 'noul', instructions: 'Does the fixture statement hold?' } }, context: { site: 'test.strict-recorded-custom' }, inputBinding: 'state' } as const;
    const owner = captureJudgmentPort('test.strict-recorded-custom', { prepareResultCapture: prepareJudgmentResult });
    const result = await owner.port.ask(request);
    expect(recordedJudgmentInputHash(result, request)).toBe(log.get(result.decisionId!)?.stateHash);
    expect(recordedJudgmentInputHash(result, request)).toBeDefined();
    expect(observeJudgmentModel(result)).toBeUndefined();
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.answers.flag)).toBe(true);
    const copied = structuredClone(result), admittedCopy = prepareJudgmentResult(request.questions).capture(copied);
    expect(recordedJudgmentInputHash(admittedCopy, request)).toBeUndefined();
    expect(observeJudgmentModel(admittedCopy)).toBeUndefined();
    const projection = { ...result, model: 'different-model' };
    expect(reuseObservedJudgmentResult(result, projection)).toBe(projection);
    expect(recordedJudgmentInputHash(projection, request)).toBeUndefined();
    expect(observeJudgmentModel(projection)).toBeUndefined();
  } finally { installJudgmentPort(previous); }
});
