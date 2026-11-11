import { afterEach, expect, test } from 'bun:test';
import { hashState, SqliteDecisionLog } from '@goodvibes-jev/judgment';
import { noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ORIGINAL_OBLIGATION_COVERAGE, originalObligationSource } from '../../platform/src/platform/contract/batteries/original-obligation-coverage.js';
import { junitCompletion } from '../../platform/src/platform/contract/gate-receipts.js';
import { nativeSourcePlan } from '../../platform/src/platform/contract/native-source.js';
import { makeHarness, makeRepo, oneUnitPlan, runnerPort, startContract, waitFor, type Harness } from './runner-support.js';
import { contractOf, finishes, terminal } from './steps-support.js';

let harness: Harness | undefined;
afterEach(() => { harness?.dispose(); harness = undefined; });

test('the staged-delivery calibration fixture contains an applicable patch and its actual passing assertions', () => {
  const fixture = ORIGINAL_OBLIGATION_COVERAGE.high.fixtures.find(item => item.name === 'pending native delivery does not undo demonstrated staged work');
  const state = fixture?.state;
  if (!state || typeof state !== 'object' || Array.isArray(state) || !('evidence' in state)) throw new Error('Missing staged-delivery evidence');
  const evidence = state.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || !('stagedArtifact' in evidence)) throw new Error('Missing staged artifact');
  const artifact = evidence.stagedArtifact;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact) || !('content' in artifact) || typeof artifact.content !== 'string') throw new Error('Missing actual patch');
  const root = makeRepo();
  try {
    const apply = spawnSync('git', ['apply', '--check'], { cwd: root, input: artifact.content, encoding: 'utf8' });
    expect(apply.status).toBe(0);
    expect(spawnSync('git', ['apply'], { cwd: root, input: artifact.content, encoding: 'utf8' }).status).toBe(0);
    const result = spawnSync(process.execPath, ['test', 'search.test.ts', '--reporter=junit', '--reporter-outfile=result.xml'], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(junitCompletion(readFileSync(join(root, 'result.xml'), 'utf8'))).toEqual({ kind: 'assertions', runner: 'bun-junit',
      checks: { passed: 4, failed: 0, skipped: 0 } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('original obligation selection uses native source before display and derived plan wording', () => {
  const nativeSource = { sourceId: 'source', sourceRevision: '1', inputRevision: '1', criteriaId: 'criteria', criteriaRevision: '1',
    goal: 'Review every source file and deliver a report.', criteria: ['Review all source files.', 'Deliver review.md.'] };
  expect(originalObligationSource({ ask: 'Review the parser.', nativeSource,
    originalSource: { goal: 'Review some files.', criteria: ['Review parser.ts.'] } })).toEqual({
      origin: 'native-source', goal: nativeSource.goal, criteria: [...nativeSource.criteria],
    });
  expect(originalObligationSource({ ask: 'Display label', originalSource: { goal: 'Actual request', criteria: ['Original criterion'] } }))
    .toEqual({ origin: 'original-source', goal: 'Actual request', criteria: ['Original criterion'] });
  expect(originalObligationSource({ ask: 'Original request' })).toEqual({ origin: 'original-request', goal: 'Original request', criteria: [] });
});

test('an unrecorded original-obligation answer retains completed work and cannot publish', async () => {
  harness = makeHarness({ plan: oneUnitPlan(1), scripts: { u1: finishes('The parser is ready.') } });
  const previous = installJudgmentPort(runnerPort().port);
  try {
    const { contract, owner } = (await startContract(harness));
    await waitFor(() => terminal(harness!, contract.id), 'missing recorded coverage fails verification');
    const current = contractOf(harness, contract.id);
    expect(current.status).toBe('failed');
    expect(current.failureKind).toBe('judgment-unavailable');
    expect(current.decisions.some(decision => decision.reason.startsWith('verification pending:'))).toBe(false);
    expect(current.commit).toBeUndefined();
    expect(current.units[0]?.status).toBe('passed');
    expect(current.decisions.some(decision => decision.targetId === `${contract.id}.original-obligations`)).toBe(false);
    expect(harness.manager.getStatus(owner.id)?.status).not.toBe('completed');
    harness.runner.cancel(contract.id, 'Fixture captured missing provenance');
  } finally { installJudgmentPort(previous); }
});

test.each([0.98, 0.5])('a passed assigned goal and content cannot publish an unsupported original request (p=%s)', async probability => {
  using log = new SqliteDecisionLog(':memory:');
  const captured: Record<string, unknown>[] = [];
  harness = makeHarness({ plan: oneUnitPlan(1), decisionLog: log, scripts: { u1: finishes('The parser is ready.') },
    port: ({ name, state }) => {
      if (name === 'original_obligations_unmet') { captured.push(state); return noulAnswer(probability); }
      return undefined;
    } });
  const currentHarness = harness;
  // Stop after the observed hold: correction planning is a separate concern,
  // and this fixture deliberately supplies no repair plan for the missing work.
  currentHarness.runner.on(event => {
    if (event.type === 'CONTRACT_CHECKED' && event.scope === 'deliverable' && event.result === 'stall') {
      currentHarness.runner.cancel(event.contractId, 'Fixture captured the original-obligation hold');
    }
  });
  const { contract } = (await startContract(harness));
  await waitFor(() => (harness!.runner.get(contract.id)?.checks.length ?? 0) > 0, 'original-obligation hold');
  const current = contractOf(harness, contract.id);
  expect(captured).toHaveLength(1);
  expect(captured[0]).toMatchObject({ original: { goal: contract.ask, origin: 'original-request' }, assignedGoal: 'A CSV parser' });
  expect(current.status).not.toBe('passed');
  expect(current.commit).toBeUndefined();
  const check = current.checks.at(-1)!;
  expect(check.result).toBe('stall');
  expect(check.problems).toContain(probability === 0.5 ? 'unshown' : 'unmet');
  const coverage = current.decisions.find(decision => decision.targetId === `${contract.id}.original-obligations`)!;
  expect(JSON.parse(coverage.reason)).toMatchObject({ passed: false, reading: { probability,
    verdict: probability === 0.5 ? 'uncertain' : 'yes' } });
  expect(coverage.decisionIds).toHaveLength(1);
  expect(check.decisionIds).toContain(coverage.decisionIds[0]!);
  expect(log.get(coverage.decisionIds[0]!)).toMatchObject({ status: 'answered', context: { battery: 'contract.original-obligation-coverage' } });
});

test.each([false, true])('original coverage records the actual source, output and wire state binding (native: %s)', async native => {
  using log = new SqliteDecisionLog(':memory:');
  const captured: Record<string, unknown>[] = [];
  const plan = oneUnitPlan(1);
  const nativeSource = { sourceId: 'coverage-source', sourceRevision: '1', inputRevision: 'input-1', criteriaId: 'criteria', criteriaRevision: '1',
    goal: plan.goal, criteria: plan.criteria.map(criterion => criterion.text) };
  if (native) plan.criteria = [...nativeSourcePlan(nativeSource).criteria];
  harness = makeHarness({ plan, recordNative: native, decisionLog: log, scripts: { u1: finishes('The parser is ready.') },
    port: ({ name, state }) => { if (name === 'original_obligations_unmet') captured.push(state); return undefined; } });
  const { contract } = (await startContract(harness, { ask: 'Add a CSV parser module.', ...(native ? { nativeSource } : {}) }));
  await waitFor(() => terminal(harness!, contract.id), 'published checked source');
  const current = contractOf(harness, contract.id);
  expect(current.status).toBe('passed');
  expect(captured).toHaveLength(1);
  expect(captured[0]!.hostStages).toEqual(['native-acceptance', 'artifact-application', 'answer-delivery']);
  const coverage = current.decisions.find(decision => decision.targetId === `${contract.id}.original-obligations`)!;
  const receipt = JSON.parse(coverage.reason);
  expect(receipt).toMatchObject({ schemaVersion: 2, passed: true, sourceDigest: hashState(originalObligationSource(contract)),
    outputDigest: hashState(captured[0]!.output as string), decisionIds: coverage.decisionIds });
  expect(receipt).not.toHaveProperty('evidenceDigest');
  const recorded = log.get(coverage.decisionIds[0]!)!;
  expect(recorded).toMatchObject({ status: 'answered', context: { site: 'contract.check.original-obligation-coverage' } });
  expect(recorded.stateHash).toBe(receipt.stateHash);
  expect(Object.keys(recorded.questions as object)).toEqual(['original_obligations_unmet']);
  expect(current.checks.at(-1)!.decisionIds).toContain(coverage.decisionIds[0]!);
});
