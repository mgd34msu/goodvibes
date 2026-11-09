/** Actual runner regression source; UNRUN during the coding-first pass. */
import { expect, test } from 'bun:test';
import { JudgmentContextLimitError, SqliteDecisionLog, observeJudgmentModel, recordedJudgmentInputHash, reuseObservedJudgmentResult, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { captureJudgmentPort, installJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult } from '../../platform/src/platform/gate/judgment-result.js';
import { makeHarness, oneUnitPlan, startContract, waitFor } from './runner-support.js';
import { finishes, terminal } from './steps-support.js';

for (const copied of [false, true]) test(`final review consumes actual recorded input across split batches and refuses copied result identity (copy=${copied})`, async () => {
  using log = new SqliteDecisionLog(':memory:');
  const h = makeHarness({ decisionLog: log, plan: oneUnitPlan(1), scripts: { u1: finishes('The exact checked parser answer.') } });
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
    id = (await startContract(h)).contract.id;
    if (copied) {
      await waitFor(() => h.store.get(id!)?.decisions.some(decision => decision.reason.includes('requires its actual recorded input')) === true, 'unrecorded copied result hold');
      expect(h.store.get(id)?.status).not.toBe('passed');
      expect(h.store.get(id)?.commit).toBeUndefined();
      expect(h.store.get(id)?.checks).toHaveLength(0);
      h.runner.cancel(id, 'Fixture observed missing original recorded input');
    } else {
      await waitFor(() => terminal(h, id!), 'actual recorded split-batch acceptance');
      expect(h.store.get(id)?.status).toBe('passed');
      const saved = h.store.get(id)!.decisions.findLast(decision => decision.targetId === `${id}.final-answer-review`)!;
      const receipt = JSON.parse(saved.reason) as { stateHash: string; decisionIds: string[] };
      expect(receipt.decisionIds).toHaveLength(2);
      for (const decisionId of receipt.decisionIds) expect(log.get(decisionId)).toMatchObject({ stateHash: receipt.stateHash, status: 'answered', context: { site: 'contract.check.final-answer-review' } });
    }
    expect(splits).toBe(1);
    await h.runner.join(id);
  } finally {
    installJudgmentPort(original);
    h.dispose(); if (id) await h.runner.join(id);
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
    const request = { state: 'Actual custom recorded input', questions: { flag: { type: 'noul', instructions: 'Does the fixture statement hold?' } }, context: { site: 'test.strict-recorded-custom' } } as const;
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
