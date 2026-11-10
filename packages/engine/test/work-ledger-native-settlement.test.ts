import { JudgmentContextLimitError } from '../../judgment/src/port/errors.ts';
import { checkSettings } from '../platform/src/platform/contract/check.js';
import { goalObligationSource } from '../platform/src/platform/contract/goal-obligation-proof.js';
import { originalObligationSource } from '../platform/src/platform/contract/batteries/original-obligation-coverage.js';
import { CONTRACT_CONFIG_DEFAULTS } from '../platform/src/platform/contract/config.js';
import { verifyNativeWorkExecution } from '../platform/src/platform/workflow/work-ledger/native-execution-verifier.js';
import { nativeExecutionProvider } from './helpers/native-execution-provider.js';
import * as atomicStore from '../platform/src/platform/utils/atomic-json-store.js';
/** Real paired authority, workspace scope and KnowledgeStore bridge into the real durable runner. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, SqliteDecisionLog, withDecisionLog, createSystemOnePort, DEFAULT_MODEL, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { createWorkLedger } from '../platform/src/platform/workflow/work-ledger/service.js';
import { createNativeWorkExecutionHost } from '../platform/src/platform/workflow/work-ledger/native-execution.js';
import { parseNativeWorkExecutionRecord, nativeExecutionTargetRevision } from '../platform/src/platform/workflow/work-ledger/native-execution-types.js';
import { criteriaSetIdForWork, DurableContractAdmissions, durableKeyHash } from '../platform/src/platform/contract/durable-admission.js';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.js';
import { WorkspaceRegistrationStore } from '../platform/src/platform/workspace/registration/store.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { makeRepo, makeHarness, oneUnitPlan, runnerPort, waitFor, type Harness, type HarnessOptions } from './contract/runner-support.js';
import { finishes } from './contract/steps-support.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(options: { harness?: Partial<HarnessOptions>; decoratePort?: (port: JudgmentPort) => JudgmentPort; register?: boolean; automatic?: boolean; source?: { goal: string; criteria: string[] }; settlementAnswers?: Parameters<typeof runnerPort>[0] } = {}) {
  const root = makeRepo(); mkdirSync(join(root, '.goodvibes'), { recursive: true });
  const tokens = new PairingTokenManager(join(root, '.goodvibes', 'pairing.json'));
  const paired = tokens.mint({ name: 'Owned synthetic test device' });
  const catalog = new GatewayMethodCatalog();
  const helper = new DaemonControlPlaneHelper({ pairingTokens: tokens, authToken: () => 'synthetic-shared', gatewayMethods: catalog, controlPlaneGateway: { touchWebSocketClient() {} },
    userAuth: { validateSession: (value: string) => value === 'synthetic-user-session' ? { username: 'owner' } : null, getUser: () => ({ username: 'owner', roles: ['admin'] }) } } as unknown as DaemonControlPlaneContext);
  const authority = helper.createNativeExecutionAuthority(paired.token)!;
  const scopes = new WorkspaceRegistrationStore({ path: join(root, '.goodvibes', 'registrations.json'), homeDir: join(root, 'home'), daemonStateDir: join(root, '.goodvibes', 'daemon') });
  if (options.register !== false) await scopes.add(root);
  const store = new KnowledgeStore({ dbPath: join(root, '.goodvibes', 'knowledge.sqlite') });
  const ledgerStorage = await store.openWorkLedgerStorage('project');
  let id = 0;
  const ledger = createWorkLedger({ projectId: 'project', storage: ledgerStorage, clock: { now: () => 100, newId: kind => `${kind}-${++id}` } });
  const actor = ledger.authority.issueActor({ projectId: 'project', actorId: authority.current()!.principalId, role: 'coordinator' });
  const created = await ledger.service.execute({ type: 'create', requestId: 'create', expectedRevision: 0, title: 'Small display label', goal: options.source?.goal ?? 'Preserve the complete goal.\nKeep all original requirements ☃.', criteria: options.source?.criteria ?? ['Keep the exact parser behavior.', 'Keep the ordered second requirement.'] }, actor);
  if (created.kind !== 'accepted' || created.event.type === 'import_legacy') throw new Error('fixture create failed');
  const claimed = await ledger.service.execute({ type: 'claim', requestId: 'claim', expectedRevision: 1, workId: created.event.workId }, actor);
  if (claimed.kind !== 'accepted' || claimed.event.type === 'import_legacy') throw new Error('fixture claim failed');
  const work = claimed.event.work; const attempt = claimed.event.attempts[0]!;
  const target = { workId: work.id, workRevision: work.revision, criteriaRevision: work.criteriaRevision, attemptId: attempt.id, attemptRevision: attempt.revision };
  const key = { workId: work.id, criteriaId: criteriaSetIdForWork(work.id), criteriaRevision: String(work.criteriaRevision), attemptId: attempt.id };
  const log = new SqliteDecisionLog(join(root, '.goodvibes', 'decisions.sqlite'));
  const fake = runnerPort(options.settlementAnswers);
  const port = options.decoratePort?.(withDecisionLog(fake.port, log)) ?? withDecisionLog(fake.port, log);
  const storage = await store.openNativeWorkExecutionStorage('project');
  const hostOptions = { projectId: 'project', projectRoot: root, sessionId: 'native-fixture', storage, scopes, port, decisionLog: log, verification: { settings: () => checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: options.harness?.readAccessFilter ?? (async () => true), automatic: options.automatic ?? false } };
  const host = createNativeWorkExecutionHost(hostOptions);
  const plan = oneUnitPlan(2); plan.goal = work.goal; plan.criteria = work.criteria.map((text, index) => ({ id: `c${index + 1}`, text, quote: text }));
  plan.groups[0]!.units[0]!.criteria = work.criteria.map((_text, index) => ({ id: `u1.c${index + 1}`, text: `Original requirement ${index + 1} holds`, serves: [`c${index + 1}`] }));
  const harness = makeHarness({ root, plan, scripts: { u1: finishes('complete native result') }, decisionLog: log,
    nativeDecisions: host.nativeOwner.decisions, durableAdmission: host.nativeOwner.admission, ...options.harness });
  host.attachRunner(harness.runner);
  cleanups.push(async () => { await host.close(); harness.dispose(); await Promise.all(harness.runner.list({ includeTerminal: true }).map(item => harness.runner.join(item.id))); await ledger.service.close(); await store.close(); log[Symbol.dispose](); rmSync(root, { recursive: true, force: true }); });
  return { root, tokens, paired, catalog, helper, authority, scopes, store, ledger, actor, work, target, get key() { const current = storage.currentByAttempt(target.attemptId); return current.record?.request.key ?? current.intent?.request.key ?? key; }, log, storage, host, hostOptions, harness, plan };
}
async function completed(harness: Harness, id: string) {
  await waitFor(() => ['passed', 'failed', 'cancelled'].includes(harness.runner.get(id)?.status ?? ''), 'native bridge completion', 15000);
  await harness.runner.join(id); return harness.runner.get(id)!;
}


test('terminal settlement checks every original criterion and atomically publishes adjacent report and evidence', async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority);
  await completed(f.harness, started.admission.contractId);
  const before = f.storage.current(f.key); expect(before.ledger.revision).toBe(2);
  const observed: { revision: number; verification: string }[] = [];
  const stop = f.ledger.service.subscribe(f.actor, snapshot => observed.push({ revision: snapshot.revision, verification: snapshot.works[0]?.verification.state ?? 'missing' }));
  cleanups.push(async () => { stop(); });
  const receipt = await f.host.settle(f.key, f.authority);
  expect(receipt.version).toBe(2);
  expect(receipt).not.toHaveProperty('receiptDigest'); expect(receipt).not.toHaveProperty('contractDigest'); expect(receipt).not.toHaveProperty('keyHash');
  expect(receipt.attestation.outcome).toBe('verified'); expect(receipt.attestation.criteriaResults.map(item => item.criterionIndex)).toEqual([0, 1]);
  const after = f.storage.current(f.key); expect(after.ledger.revision).toBe(4);
  expect(after.ledger.history.slice(-2).map(event => event.type)).toEqual(['report', 'record_evidence']);
  expect(after.ledger.evidence[0]?.target).toEqual(receipt.targetAfterReport); expect(after.settlement).toEqual(receipt);
  await waitFor(() => observed.some(item => item.revision === 4), 'ordinary ledger subscription receives settlement');
  expect(observed.some(item => item.revision === 3)).toBe(false); expect(observed.at(-1)?.verification).toBe('verified');
  expect(receipt.evidenceSequence).toBe(receipt.reportSequence + 1);
  expect(f.host.status(f.key, f.authority).settlement).toMatchObject({ state: 'published', evidenceId: receipt.evidenceId });
  const checks = receipt.attestation.references.filter(item => item.kind === 'decision'); expect(checks).toHaveLength(2);
  for (const reference of checks) { const actual = f.log.get(reference.ref.slice('decision:'.length)); expect(actual?.status).toBe('answered'); expect(reference.digest).toBe(actual?.stateHash); }
  expect(receipt.attestation.references.filter(reference => reference.kind !== 'decision').every(reference => reference.digest === undefined)).toBe(true);
  expect(receipt.attestation.criteriaResults.every(result => result.references.every(ref => checks.some(check => check.ref === ref)))).toBe(true);
  const controller = new AbortController(); controller.abort();
  expect(await f.host.settle(f.key, f.authority, { signal: controller.signal })).toEqual(receipt);
  expect(f.harness.agentsOf('u1')).toHaveLength(1);
});

test('native settlement accepts a genuine content review followed by original-requirements reassessment', async () => {
  let assessments = 0;
  const f = await fixture({ harness: { port: context => {
    const evidence = context.state['evidence'] as { orchestration?: { currentValidation?: { scope: string } }; finalAnswerReview?: { passed: boolean } } | undefined;
    if (evidence?.orchestration?.currentValidation?.scope === 'deliverable'
      && (context.name === 'goal' || context.name.startsWith('criterion_'))) {
      if (context.name === 'goal') assessments++;
      return noulAnswer(evidence.finalAnswerReview?.passed ? 0.03 : 0.97);
    }
    return undefined;
  } } });
  const started = await f.host.start(f.target, f.authority);
  const contract = await completed(f.harness, started.admission.contractId);
  expect(contract.status).toBe('passed');
  expect(assessments).toBe(2);
  expect(contract.checks.at(-1)!.decisionIds).toHaveLength(4);
  const receipt = await f.host.settle(f.key, f.authority);
  expect(receipt.attestation.outcome).toBe('verified');
  expect(f.harness.agentsOf('u1')).toHaveLength(1);
});

test('native settlement requires real scope-bound decisions covering the whole answer when a broad objection was uncertain', async () => {
  const f = await fixture({ harness: { port: context => {
    if (context.name === 'unsupported') return noulAnswer(context.state['claimScope'] ? 0.03 : 0.61);
    return undefined;
  } } });
  const started = await f.host.start(f.target, f.authority);
  const contract = await completed(f.harness, started.admission.contractId);
  expect(contract.status).toBe('passed');
  const content = JSON.parse(contract.decisions.findLast(decision => decision.targetId === `${contract.id}.final-answer-review`)!.reason);
  const claimId = content.claimReviews[0].decisionId;
  for (const mutation of ['missing', 'wrong-range', 'uncertain', 'wrong-state'] as const) {
    await expect(verifyNativeWorkExecution({ execution: f.storage.current(f.key).record!, runner: f.harness.runner,
      port: f.hostOptions.port, decisionLog: { get(id) {
        const entry = f.log.get(id);
        if (id !== claimId || entry?.status !== 'answered') return entry;
        if (mutation === 'missing') return undefined;
        if (mutation === 'uncertain') return { ...entry, answers: { unsupported: noulAnswer(0.4) } };
        if (mutation === 'wrong-state') return { ...entry, stateHash: 'another-passage' as typeof entry.stateHash };
        return { ...entry, questions: { unsupported: { type: 'noul', instructions: 'Check a different passage.' } } };
      } }, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true,
      signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow('genuine final-answer content review');
  }
  expect(f.storage.current(f.key).settlement).toBeNull();
  const receipt = await f.host.settle(f.key, f.authority);
  expect(receipt.attestation.outcome).toBe('verified');
  expect(f.harness.agentsOf('u1')).toHaveLength(1);
});

test('native settlement verifies the logical goal proof and all actual premises without rewriting the uncertain source reading', async () => {
  const f = await fixture({ harness: { port: context => context.name === 'goal'
    && (context.state['evidence'] as { orchestration?: { currentValidation?: { scope: string } } } | undefined)?.orchestration?.currentValidation?.scope === 'deliverable' ? noulAnswer(0.61) : undefined } });
  const started = await f.host.start(f.target, f.authority);
  const contract = await completed(f.harness, started.admission.contractId);
  expect(contract.status).toBe('passed');
  const proof = JSON.parse(contract.decisions.findLast(decision => decision.targetId === `${contract.id}.goal-obligations`)!.reason);
  expect(proof.sourceGoal.probability).toBe(0.61);
  const proofId = proof.decisionIds[0], literalSource = canonicalJson(goalObligationSource(contract));
  for (const mutation of ['missing', 'wrong-source', 'uncertain', 'wrong-state'] as const) {
    const hashing = spyOn(Bun.CryptoHasher, 'hash');
    try {
      await expect(verifyNativeWorkExecution({ execution: f.storage.current(f.key).record!, runner: f.harness.runner,
        port: f.hostOptions.port, decisionLog: { get(id) {
          const entry = f.log.get(id); if (id !== proofId || entry?.status !== 'answered') return entry;
          if (mutation === 'missing') return undefined;
          if (mutation === 'uncertain') return { ...entry, answers: { omitted: noulAnswer(0.4) } };
          if (mutation === 'wrong-state') return { ...entry, stateHash: 'another-goal' as typeof entry.stateHash };
          return { ...entry, questions: { omitted: { type: 'noul', instructions: 'Different literal original source' } } };
        } }, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true,
        signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow('genuine deliverable check');
      expect(hashing.mock.calls.filter(([algorithm, input]) => algorithm === 'sha256' && input === literalSource)).toHaveLength(0);
    } finally { hashing.mockRestore(); }
  }
  const hashing = spyOn(Bun.CryptoHasher, 'hash'), originalSource = canonicalJson(originalObligationSource(contract));
  try {
    const verified = await verifyNativeWorkExecution({ execution: f.storage.current(f.key).record!, runner: f.harness.runner,
      port: f.hostOptions.port, decisionLog: f.log, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true,
      signal: new AbortController().signal, assertCurrent() {} });
    expect(verified.attestation.outcome).toBe('verified');
    expect(hashing.mock.calls.filter(([algorithm, input]) => algorithm === 'sha256' && input === literalSource)).toHaveLength(1);
    expect(hashing.mock.calls.filter(([algorithm, input]) => algorithm === 'sha256' && input === originalSource)).toHaveLength(1);
  } finally { hashing.mockRestore(); }
  expect(f.storage.current(f.key).settlement).toBeNull();
  expect((await f.host.settle(f.key, f.authority)).attestation.outcome).toBe('verified');
});

test('native settlement refuses missing, failing or mismatched final-content proof despite a passed checkpoint', async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority);
  const contract = await completed(f.harness, started.admission.contractId);
  const contentId = contract.checks.at(-1)!.decisionIds.find(id => f.log.get(id)?.context.site === 'contract.check.final-answer-review')!;
  expect(contentId).toBeDefined();
  for (const mutation of ['absent', 'failed-answer', 'wrong-state', 'wrong-question'] as const) {
    await expect(verifyNativeWorkExecution({ execution: f.storage.current(f.key).record!, runner: f.harness.runner,
      port: f.hostOptions.port, decisionLog: { get(id) {
        const entry = f.log.get(id);
        if (id !== contentId || entry?.status !== 'answered') return entry;
        if (mutation === 'absent') return undefined;
        if (mutation === 'failed-answer') return { ...entry, answers: { ...entry.answers as object, unsupported: noulAnswer(0.99) } };
        if (mutation === 'wrong-state') return { ...entry, stateHash: 'copied-from-another-state' as typeof entry.stateHash };
        return { ...entry, questions: { unfinished: { type: 'noul', instructions: 'A different check' }, unsupported: { type: 'noul', instructions: 'A different check' } } };
      } }, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true,
      signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow('genuine final-answer content review');
  }
  expect(f.storage.current(f.key).ledger.revision).toBe(2);
  expect(f.storage.current(f.key).settlement).toBeNull();
});

test('native settlement requires recorded original-obligation coverage bound to the accepted source and answer', async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority);
  const contract = await completed(f.harness, started.admission.contractId);
  const coverageId = contract.checks.at(-1)!.decisionIds.find(id => f.log.get(id)?.context.site === 'contract.check.original-obligation-coverage')!;
  expect(coverageId).toBeDefined();
  const originalSource = canonicalJson(originalObligationSource(contract));
  for (const mutation of ['absent', 'failed-answer', 'wrong-state', 'wrong-question', 'wrong-policy'] as const) {
    const hashing = spyOn(Bun.CryptoHasher, 'hash');
    try {
      await expect(verifyNativeWorkExecution({ execution: f.storage.current(f.key).record!, runner: f.harness.runner,
        port: f.hostOptions.port, decisionLog: { get(id) {
          const entry = f.log.get(id);
          if (id !== coverageId || entry?.status !== 'answered') return entry;
          if (mutation === 'absent') return undefined;
          if (mutation === 'failed-answer') return { ...entry, answers: { original_obligations_unmet: noulAnswer(0.99) } };
          if (mutation === 'wrong-state') return { ...entry, stateHash: 'copied-from-another-state' as typeof entry.stateHash };
          if (mutation === 'wrong-policy') return { ...entry, context: { ...entry.context, batteryVersion: 0 } };
          return { ...entry, questions: { original_obligations_unmet: { type: 'noul', instructions: 'A different check' } } };
        } }, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true,
        signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow('genuine original-obligation coverage');
      expect(hashing.mock.calls.filter(([algorithm, input]) => algorithm === 'sha256' && input === originalSource)).toHaveLength(0);
    } finally { hashing.mockRestore(); }
  }
  expect(f.storage.current(f.key).ledger.revision).toBe(2);
  expect(f.storage.current(f.key).settlement).toBeNull();
});


test('original-coverage v2 verifies without an unused digest, actual v1 stays readable and future or mixed receipt versions refuse', async () => {
  const f = await fixture(), started = await f.host.start(f.target, f.authority);
  const contract = await completed(f.harness, started.admission.contractId);
  const targetId = `${contract.id}.original-obligations`, decision = contract.decisions.findLast(value => value.targetId === targetId)!;
  const original = JSON.parse(decision.reason) as Record<string, unknown>;
  expect(original['schemaVersion']).toBe(2); expect(original).not.toHaveProperty('evidenceDigest');
  for (const format of ['current-v2', 'historical-v1', 'future-v3', 'mixed-v2'] as const) {
    const receipt = format === 'historical-v1' ? { ...original, schemaVersion: 1, evidenceDigest: 'a'.repeat(64) }
      : format === 'future-v3' ? { ...original, schemaVersion: 3 }
      : format === 'mixed-v2' ? { ...original, evidenceDigest: 'unused-field-from-a-different-version' } : original;
    const image = { ...contract, decisions: contract.decisions.map(value => value === decision ? { ...value, reason: JSON.stringify(receipt) } : value) };
    const operation = verifyNativeWorkExecution({ execution: f.storage.current(f.key).record!,
      runner: { get: id => id === contract.id ? image : f.harness.runner.get(id), join: id => f.harness.runner.join(id) },
      port: f.hostOptions.port, decisionLog: f.log, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true,
      signal: new AbortController().signal, assertCurrent() {} });
    if (format === 'current-v2' || format === 'historical-v1') await expect(operation).resolves.toMatchObject({ attestation: { outcome: 'verified' } });
    else await expect(operation).rejects.toThrow('genuine original-obligation coverage');
  }
});

test('native claim verification hashes the complete immutable answer once, rather than once per bounded passage', async () => {
  const output = 'The complete supported result retains all necessary qualifications.\n'.repeat(180);
  const f = await fixture({ harness: { scripts: { u1: finishes(output) }, port: context => context.name === 'unsupported'
    ? noulAnswer(context.state['claimScope'] === undefined ? 0.61 : 0.01) : undefined } });
  const started = await f.host.start(f.target, f.authority), contract = await completed(f.harness, started.admission.contractId);
  const review = JSON.parse(contract.decisions.findLast(value => value.targetId === `${contract.id}.final-answer-review`)!.reason) as { claimReviews: unknown[] };
  expect(review.claimReviews.length).toBeGreaterThan(1);
  const completeAnswer = canonicalJson(contract.answer ?? ''), hashes = spyOn(Bun.CryptoHasher, 'hash');
  try {
    const verified = await verifyNativeWorkExecution({ execution: f.storage.current(f.key).record!, runner: f.harness.runner,
      port: f.hostOptions.port, decisionLog: f.log, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true,
      signal: new AbortController().signal, assertCurrent() {} });
    expect(verified.attestation.outcome).toBe('verified');
    expect(hashes.mock.calls.filter(([algorithm, value]) => algorithm === 'sha256' && value === completeAnswer)).toHaveLength(1);
  } finally { hashes.mockRestore(); }
});

test('native settlement proves every original question across actual deliverable batches and refuses incomplete or mixed proof', async () => {
  let refused = false, refusedContent = false;
  const f = await fixture({ harness: { port: context => {
    const evidence = context.state['evidence'] as { orchestration?: { currentValidation?: { scope: string } } } | undefined;
    if (!refusedContent && context.name === 'unfinished') { refusedContent = true; throw new JudgmentContextLimitError(); }
    if (!refused && context.name === 'goal' && evidence?.orchestration?.currentValidation?.scope === 'deliverable') {
      refused = true; throw new JudgmentContextLimitError();
    }
    return undefined;
  } } });
  const started = await f.host.start(f.target, f.authority);
  const contract = await completed(f.harness, started.admission.contractId);
  expect(contract.status).toBe('passed');
  const rootCheck = contract.checks.at(-1)!;
  const rootIds = rootCheck.decisionIds.filter(id => f.log.get(id)?.context.site === 'contract.check.deliverable-judge');
  expect(rootIds).toHaveLength(2);
  expect(rootCheck.decisionIds).toHaveLength(5);
  expect(new Set(rootIds.map(id => f.log.get(id)!.stateHash)).size).toBe(1);
  for (const [index, criterion] of contract.criteria.entries()) {
    const id = criterion.readings.find(reading => reading.checkId === rootCheck.id)!.decisionId!;
    expect(f.log.get(id)!.questions).toHaveProperty(`criterion_${index}`);
  }
  const targetId = rootIds.find(id => Object.hasOwn(f.log.get(id)!.questions as object, 'criterion_1'))!;
  for (const mutation of ['missing-entry', 'missing-state-hash', 'missing-question', 'extra-question', 'duplicate-question', 'wrong-state', 'wrong-criterion'] as const) {
    await expect(verifyNativeWorkExecution({ execution: f.storage.current(f.key).record!, runner: f.harness.runner,
      port: f.hostOptions.port, decisionLog: { get(id) {
        const entry = f.log.get(id);
        if (id !== targetId || entry?.status !== 'answered') return entry;
        if (mutation === 'missing-entry') return undefined;
        if (mutation === 'missing-state-hash') { const { stateHash: _stateHash, ...unbound } = entry; return unbound; }
        if (mutation === 'wrong-state') return { ...entry, stateHash: 'different-batch-state' as typeof entry.stateHash };
        const questions = JSON.parse(JSON.stringify(entry.questions)), answers = JSON.parse(JSON.stringify(entry.answers));
        if (mutation === 'missing-question') { delete questions.criterion_1; delete answers.criterion_1; }
        if (mutation === 'extra-question') { questions.criterion_99 = questions.criterion_1; answers.criterion_99 = answers.criterion_1; }
        if (mutation === 'duplicate-question') {
          const source = f.log.get(rootIds.find(id => id !== targetId)!)!;
          questions.goal = (source.questions as Record<string, unknown>)['goal']; answers.goal = noulAnswer(0.03);
        }
        if (mutation === 'wrong-criterion') questions.criterion_1.instructions.criterion = 'A replacement requirement';
        return { ...entry, questions, answers };
      } }, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true,
      signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow('genuine deliverable check');
  }
  const contentIds = rootCheck.decisionIds.filter(id => f.log.get(id)?.context.site === 'contract.check.final-answer-review');
  expect(contentIds).toHaveLength(2);
  for (const mutation of ['missing-entry', 'missing-question', 'duplicate-question', 'wrong-state'] as const) {
    await expect(verifyNativeWorkExecution({ execution: f.storage.current(f.key).record!, runner: f.harness.runner,
      port: f.hostOptions.port, decisionLog: { get(id) {
        const entry = f.log.get(id);
        if (id !== contentIds[1] || entry?.status !== 'answered') return entry;
        if (mutation === 'missing-entry') return undefined;
        if (mutation === 'wrong-state') return { ...entry, stateHash: 'different-content-state' as typeof entry.stateHash };
        const questions = JSON.parse(JSON.stringify(entry.questions)), answers = JSON.parse(JSON.stringify(entry.answers));
        if (mutation === 'missing-question') { delete questions.unsupported; delete answers.unsupported; }
        else { questions.unfinished = (f.log.get(contentIds[0]!)!.questions as Record<string, unknown>)['unfinished']; answers.unfinished = noulAnswer(0.03); }
        return { ...entry, questions, answers };
      } }, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true,
      signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow('genuine final-answer content review');
  }
  expect(f.storage.current(f.key).ledger.revision).toBe(2);
  const receipt = await f.host.settle(f.key, f.authority);
  expect(receipt.attestation.outcome).toBe('verified');
  expect(f.harness.agentsOf('u1')).toHaveLength(1);
});

test('an unmet original criterion cannot be hidden by planner success', async () => {
  const f = await fixture({ settlementAnswers: context => context.name === 'criterion_1' ? noulAnswer(0.99) : undefined });
  const started = await f.host.start(f.target, f.authority); expect((await completed(f.harness, started.admission.contractId)).status).toBe('passed');
  const receipt = await f.host.settle(f.key, f.authority);
  expect(receipt.attestation.outcome).toBe('failed'); expect(receipt.attestation.criteriaResults[1]?.status).toBe('unsatisfied');
  expect(f.storage.current(f.key).ledger.works[0]?.reportedState).toBe('complete');
  expect(f.storage.current(f.key).ledger.evidence[0]?.outcome).toBe('failed');
});

test('status stays read-only, explicit concurrent settlement publishes once, and reopened host replays with zero runner effects', async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  for (let index = 0; index < 3; index++) expect(f.host.status(f.key, f.authority).settlement?.state).toBe('required');
  expect(f.storage.current(f.key).ledger.revision).toBe(2);
  const [one, two] = await Promise.all([f.host.settle(f.key, f.authority), f.host.settle(f.key, f.authority)]); expect(one).toEqual(two);
  const reopened = new KnowledgeStore({ dbPath: join(f.root, '.goodvibes', 'knowledge.sqlite') });
  const storage = await reopened.openNativeWorkExecutionStorage('project');
  const replacement = createNativeWorkExecutionHost({ ...f.hostOptions, storage, port: { ...f.hostOptions.port, ask: async () => { throw new Error('No semantic replay allowed'); } } });
  replacement.attachRunner({ ...f.harness.runner, startDurable: async () => { throw new Error('No effect replay'); }, resumeDurable: async () => { throw new Error('No effect resume'); }, join: async () => { throw new Error('No join on durable settlement replay'); } });
  try { expect(await replacement.settle(f.key, f.authority)).toEqual(one); expect(storage.current(f.key).ledger.revision).toBe(4); }
  finally { await replacement.close(); await reopened.close(); }
});

test('revocation during a terminal recorded check publishes no report or evidence', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture({ decoratePort: port => ({ ...port, async ask(request) {
    if (request.context?.site === 'contract.check.unit-judge') { entered(); await gate; } return port.ask(request);
  } }) });
  const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  const settlement = f.host.settle(f.key, f.authority); await ready; f.tokens.revoke(f.paired.id); release();
  await expect(settlement).rejects.toThrow(); expect(f.storage.current(f.key).ledger.revision).toBe(2); expect(f.storage.current(f.key).settlement).toBeNull();
});

test('mutated artifacts, rewritten checkpoint roots and copied receipts cannot verify', async () => {
  let change: (() => void) | undefined;
  const f = await fixture({ decoratePort: port => ({ ...port, async ask(request) { if (request.context?.site === 'contract.check.unit-judge') change?.(); return port.ask(request); } }) });
  const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  change = () => writeFileSync(join(f.root, 'src/csv.ts'), 'changed during check');
  await expect(f.host.settle(f.key, f.authority)).rejects.toThrow('artifact changed'); expect(f.storage.current(f.key).ledger.revision).toBe(2);
  const record = f.storage.current(f.key).record!;
  await expect(verifyNativeWorkExecution({ execution: record, runner: { join: f.harness.runner.join, get: id => { const value = f.harness.runner.get(id)!; return { ...value, goal: 'rewritten' }; } }, port: f.hostOptions.port, decisionLog: f.log, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true, signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow();
  await expect(verifyNativeWorkExecution({ execution: { ...record, receipt: { ...record.receipt!, contractId: 'ctr_000000000000' } }, runner: f.harness.runner, port: f.hostOptions.port, decisionLog: f.log, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true, signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow();
});

test('the held artifact guard compares exact bytes even when two files decode to identical text', async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  const path = join(f.root, 'src/csv.ts');
  const original = Buffer.from([0x61, 0xff, 0x62]), replacement = Buffer.from([0x61, 0xfe, 0x62]);
  expect(original.toString('utf8')).toBe(replacement.toString('utf8'));
  writeFileSync(path, original);
  const proof = await verifyNativeWorkExecution({ execution: f.storage.current(f.key).record!, runner: f.harness.runner,
    port: f.hostOptions.port, decisionLog: f.log, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS),
    readAccessFilter: async () => true, signal: new AbortController().signal, assertCurrent() {} });
  proof.assertCurrent();
  writeFileSync(path, replacement);
  expect(() => proof.assertCurrent()).toThrow('artifact changed');
  expect(f.storage.current(f.key).ledger.evidence).toHaveLength(0);
});

for (const initial of ['absent', 'empty-file'] as const) test(`a held ${initial} artifact is distinct from the other state`, async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  const path = join(f.root, 'src/csv.ts');
  if (initial === 'absent') rmSync(path); else writeFileSync(path, '');
  const proof = await verifyNativeWorkExecution({ execution: f.storage.current(f.key).record!, runner: f.harness.runner,
    port: f.hostOptions.port, decisionLog: f.log, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS),
    readAccessFilter: async () => true, signal: new AbortController().signal, assertCurrent() {} });
  proof.assertCurrent();
  if (initial === 'absent') writeFileSync(path, ''); else rmSync(path);
  expect(() => proof.assertCurrent()).toThrow('artifact changed');
  expect(f.storage.current(f.key).settlement).toBeNull();
});

test('a returned verifier proof stays bound to the complete captured checkpoint', async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority);
  const checkpoint = structuredClone(await completed(f.harness, started.admission.contractId));
  const proof = await verifyNativeWorkExecution({ execution: f.storage.current(f.key).record!,
    runner: { join: f.harness.runner.join, get: () => checkpoint },
    port: f.hostOptions.port, decisionLog: f.log, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS),
    readAccessFilter: async () => true, signal: new AbortController().signal, assertCurrent() {} });
  proof.assertCurrent();
  Object.assign(checkpoint, { answer: 'Changed after the verifier returned.' });
  expect(() => proof.assertCurrent()).toThrow('contract changed');
});

test('automatic completion settles through the owned lifetime and close drains held checks', async () => {
  const f = await fixture({ automatic: true }); const started = await f.host.start(f.target, f.authority);
  await waitFor(() => f.storage.current(f.key).settlement !== null, 'automatic native settlement', 15000);
  expect(f.storage.current(f.key).settlement?.contractId).toBe(started.admission.contractId);
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  const g = await fixture({ automatic: true, decoratePort: port => ({ ...port, async ask(request) { if (request.context?.site === 'contract.check.unit-judge') { entered(); await hold; } return port.ask(request); } }) });
  await g.host.start(g.target, g.authority); await ready;
  let closed = false; const close = g.host.close().then(() => { closed = true; }); await new Promise(resolve => setTimeout(resolve, 20)); expect(closed).toBe(false);
  release(); await close; expect(g.storage.current(g.key).ledger.revision).toBe(2);
});

for (const failure of ['before-publication', 'after-rename'] as const) {
  test(`atomic settlement ${failure} leaves zero partial report and exact lost acknowledgement recovery`, async () => {
    const f = await fixture(); const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
    const path = join(f.root, '.goodvibes', 'knowledge.sqlite'), before = readFileSync(path);
    const write = atomicStore.writeFileAtomic; let failed = false;
    // The publisher captures native IO at construction. Inject at its actual
    // public atomic writer, not a subsequently assigned, unused IO lookalike.
    const fault = spyOn(atomicStore, 'writeFileAtomic').mockImplementation((selected, bytes, options) => {
      if (selected !== path || failed) return write(selected, bytes, options);
      const fail = (): never => { failed = true; throw new Error('Synthetic settlement persistence failure'); };
      if (failure === 'before-publication') return fail();
      return write(selected, bytes, { ...options, onEffect(published) {
        const original: unknown = options?.onEffect?.(published);
        if (original !== undefined) return original as never;
        if (published) fail();
      } });
    });
    try { await expect(f.host.settle(f.key, f.authority)).rejects.toThrow(); }
    finally { fault.mockRestore(); }
    expect(failed).toBe(true);
    if (failure === 'before-publication') expect(readFileSync(path)).toEqual(before);
    const reopened = new KnowledgeStore({ dbPath: join(f.root, '.goodvibes', 'knowledge.sqlite') }); const storage = await reopened.openNativeWorkExecutionStorage('project');
    const current = storage.current(f.key); expect(current.ledger.revision).toBe(failure === 'after-rename' ? 4 : 2);
    expect(current.ledger.history.filter(event => event.type === 'report').length).toBe(current.ledger.evidence.length);
    expect(current.ledger.evidence).toHaveLength(failure === 'after-rename' ? 1 : 0);
    if (failure === 'after-rename') {
      expect(current.settlement).not.toBeNull();
      expect(current.ledger.history.slice(-2).map(event => event.type)).toEqual(['report', 'record_evidence']);
    } else expect(current.settlement).toBeNull();
    const replacement = createNativeWorkExecutionHost({ ...f.hostOptions, storage }); replacement.attachRunner(f.harness.runner);
    let publications = 0;
    const recovery = spyOn(atomicStore, 'writeFileAtomic').mockImplementation((selected, bytes, options) => {
      if (selected === path) publications++;
      return write(selected, bytes, options);
    });
    try {
      const receipt = await replacement.settle(f.key, f.authority);
      if (failure === 'after-rename') expect(receipt).toEqual(current.settlement!);
      expect(publications).toBe(failure === 'after-rename' ? 0 : 1);
      expect(storage.current(f.key).ledger.revision).toBe(4); expect(f.harness.agentsOf('u1')).toHaveLength(1);
    } finally { recovery.mockRestore(); await replacement.close(); await reopened.close(); }
  });
}

test('the real provider loop corrects an original unmet answer before terminal output-only verification', async () => {
  const provider = nativeExecutionProvider(['[unmet] incomplete answer', 'Corrected complete original answer']);
  const f = await fixture({ harness: { executeAgent: provider.executeAgent, port: context => context.name === 'forbids_writing' ? noulAnswer(0.99) : undefined } });
  const started = await f.host.start(f.target, f.authority); const contract = await completed(f.harness, started.admission.contractId);
  expect(contract.status).toBe('passed'); expect(provider.requests.length).toBeGreaterThanOrEqual(2);
  const receipt = await f.host.settle(f.key, f.authority); expect(receipt.attestation.outcome).toBe('verified');
  expect(receipt.attestation.references.filter(item => item.kind === 'artifact')).toHaveLength(0);
});

test('real worktree completion verifies applied owner-tree artifacts; application failure never verifies', async () => {
  const f = await fixture({ harness: { contract: { isolation: 'worktree', autoCommit: false } } });
  const started = await f.host.start(f.target, f.authority); const contract = await completed(f.harness, started.admission.contractId);
  expect(contract.isolation).toBe('worktree'); expect(contract.commit?.status).toBe('applied');
  expect((await f.host.settle(f.key, f.authority)).attestation.outcome).toBe('verified');
  const g = await fixture(); const second = await g.host.start(g.target, g.authority); await completed(g.harness, second.admission.contractId);
  const record = g.storage.current(g.key).record!;
  await expect(verifyNativeWorkExecution({ execution: record, runner: { join: g.harness.runner.join, get: id => ({ ...g.harness.runner.get(id)!, commit: { status: 'failed', note: 'Synthetic apply failure' } }) }, port: g.hostOptions.port, decisionLog: g.log, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true, signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow('not applied');
  expect(g.storage.current(g.key).ledger.revision).toBe(2);
});

test('the complete original source is captured before the first borrowed join hook', async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  const mutable = structuredClone(f.storage.current(f.key).record!);
  const expectedGoal = mutable.request.input.nativeSource!.goal; const expectedCriteria = [...mutable.request.input.nativeSource!.criteria];
  const proof = await verifyNativeWorkExecution({ execution: mutable, runner: { get: f.harness.runner.get, async join(id) {
    Object.assign(mutable.request.input.nativeSource!, { goal: 'Rewritten after the verifier started', criteria: ['Omit every original criterion'] });
    await f.harness.runner.join(id);
  } }, port: f.hostOptions.port, decisionLog: f.log, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true, signal: new AbortController().signal, assertCurrent() {} });
  expect(proof.attestation.outcome).toBe('verified'); expect(proof.attestation.criteriaResults).toHaveLength(expectedCriteria.length);
  expect(expectedGoal).toBe(f.work.goal); expect(expectedCriteria).toEqual(f.work.criteria);
});

test('saved target counters must match the original independently recorded native act, including standalone verification', async () => {
  const f = await fixture(), started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  const original = f.storage.current(f.key).record!;
  for (const field of ['workRevision', 'attemptRevision'] as const) {
    const target = { ...original.target, [field]: original.target[field] + 1 };
    expect(() => parseNativeWorkExecutionRecord({ ...structuredClone(original), target })).toThrow();
    const evidence = original.decision.evidence.map(reference => reference.id === 'native-work-attempt' ? { ...reference, revision: nativeExecutionTargetRevision(target) } : reference);
    const changed = parseNativeWorkExecutionRecord({ ...structuredClone(original), target, decision: { ...original.decision, evidence }, decisionContext: { ...original.decisionContext, evidence } });
    await expect(verifyNativeWorkExecution({ execution: changed, runner: f.harness.runner, port: f.hostOptions.port, decisionLog: f.log,
      settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true, signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow('unavailable');
  }
  expect(f.storage.current(f.key).ledger.revision).toBe(2); expect(f.storage.current(f.key).settlement).toBeNull();
});

// Regression source UNRUN during the coding-first pass.
for (const kind of ['async', 'nonvoid'] as const) test(`standalone native verification refuses a ${kind} owner guard before new readings or publication`, async () => {
  const f = await fixture(), started = await f.host.start(f.target, f.authority);
  await completed(f.harness, started.admission.contractId);
  const execution = f.storage.current(f.key).record!;
  const before = f.log.query({ site: 'contract.check.unit-judge', limit: 100 }).map(entry => entry.id);
  await expect(verifyNativeWorkExecution({ execution, runner: f.harness.runner, port: f.hostOptions.port,
    decisionLog: f.log, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true,
    signal: new AbortController().signal, assertCurrent: kind === 'async'
      ? async () => { throw new Error('synthetic rejected asynchronous owner'); }
      : () => false,
  })).rejects.toMatchObject({ code: 'invalid' });
  expect(f.log.query({ site: 'contract.check.unit-judge', limit: 100 }).map(entry => entry.id)).toEqual(before);
  expect(f.storage.current(f.key).ledger.revision).toBe(2); expect(f.storage.current(f.key).settlement).toBeNull();
});

for (const mutation of ['revise', 'handoff', 'cancel', 'scope'] as const) test(`${mutation} during verification prevents late evidence without replaying the runner`, async () => {
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ decoratePort: port => ({ ...port, async ask(request) { if (request.context?.site === 'contract.check.unit-judge') { entered(); await hold; } return port.ask(request); } }) });
  const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  const pending = f.host.settle(f.key, f.authority); await ready;
  try {
    if (mutation === 'scope') {
      const file = join(f.root, '.goodvibes', 'registrations.json'); const contents = readFileSync(file, 'utf8');
      const original = f.scopes.currentScope(f.root).scopeRevision;
      // Owned fixture generation changes through the current owner API below.
      await f.scopes.remove(f.root); await f.scopes.add(f.root); expect(f.scopes.currentScope(f.root).scopeRevision).not.toBe(original);
      expect(readFileSync(file, 'utf8')).not.toBe(contents);
    } else {
      const command = mutation === 'revise' ? { type: 'revise' as const, title: f.work.title, goal: f.work.goal, criteria: [...f.work.criteria].reverse() }
        : mutation === 'handoff' ? { type: 'handoff' as const, attemptId: f.target.attemptId, targetActorId: 'new-owner', reason: 'Synthetic handoff' }
        : { type: 'cancel' as const, reason: 'Synthetic cancellation' };
      expect(await f.ledger.service.execute({ ...command, requestId: `during-${mutation}`, expectedRevision: 2, workId: f.work.id }, f.actor)).toMatchObject({ kind: 'accepted' });
    }
  } finally { release(); }
  await expect(pending).rejects.toThrow(); expect(f.storage.current(f.key).ledger.evidence).toHaveLength(0); expect(f.storage.current(f.key).settlement).toBeNull();
  expect(f.harness.agentsOf('u1')).toHaveLength(1);
});

test('restricted artifact reads and absent recorded proof remain unavailable, without partial publication', async () => {
  let allowed = true;
  const f = await fixture({ harness: { readAccessFilter: async () => allowed } });
  const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId); allowed = false;
  await expect(f.host.settle(f.key, f.authority)).rejects.toThrow('access-restricted'); expect(f.storage.current(f.key).ledger.revision).toBe(2);
  allowed = true;
  const record = f.storage.current(f.key).record!, path = join(f.root, '.goodvibes', 'knowledge.sqlite'), before = readFileSync(path);
  const requests = spyOn(f.hostOptions.port, 'ask');
  try {
    await expect(verifyNativeWorkExecution({ execution: record, runner: f.harness.runner, port: f.hostOptions.port, decisionLog: { get: () => undefined }, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true, signal: new AbortController().signal, assertCurrent() {} })).rejects.toMatchObject({ code: 'unavailable' });
    expect(requests).not.toHaveBeenCalled();
  } finally { requests.mockRestore(); }
  expect(readFileSync(path)).toEqual(before);
  const unchanged = f.storage.current(f.key);
  expect(unchanged.ledger.revision).toBe(2); expect(unchanged.ledger.evidence).toHaveLength(0); expect(unchanged.settlement).toBeNull();
});

test('independent quality and exact recorded state are required even when every original criterion reads met', async () => {
  const f = await fixture({ settlementAnswers: context => context.name === 'hidden_failure' ? noulAnswer(0.99) : undefined });
  const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  const receipt = await f.host.settle(f.key, f.authority); expect(receipt.attestation.outcome).toBe('failed');
  expect(receipt.attestation.criteriaResults.every(item => item.status === 'satisfied')).toBe(true);
  let copied: string | undefined;
  const g = await fixture({ decoratePort: port => ({ ...port, async ask(request) {
    const result = await port.ask(request); return request.context?.site === 'contract.check.unit-judge' && copied ? { ...result, decisionId: copied } : result;
  } }) });
  const second = await g.host.start(g.target, g.authority); const contract = await completed(g.harness, second.admission.contractId);
  copied = contract.units[0]!.checks.at(-1)!.decisionIds[0];
  await expect(g.host.settle(g.key, g.authority)).rejects.toThrow('provenance'); expect(g.storage.current(g.key).ledger.evidence).toHaveLength(0);
});

test('native verifier never hashes a new borrowed wire state when its result cannot name a recorded decision', async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority);
  await completed(f.harness, started.admission.contractId);
  const original = f.storage.current(f.key).record!;
  const fake = fakePort(() => noulAnswer(0.01));
  const attemptedStates = new Set<string>();
  const port: JudgmentPort = { ...f.hostOptions.port, async ask(request) {
    attemptedStates.add(canonicalJson(request.state));
    return fake.port.ask(request);
  } };
  const hashing = spyOn(Bun.CryptoHasher, 'hash');
  try {
    await expect(verifyNativeWorkExecution({ execution: original, runner: f.harness.runner, port,
      decisionLog: f.log, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true,
      signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow('provenance');
    expect(attemptedStates.size).toBeGreaterThan(0);
    // Older source/output/receipt verifications have their own commitments.
    // Only these exact new forwarded judge states lacked any possible reader.
    expect(hashing.mock.calls.filter(([algorithm, state]) => algorithm === 'sha256'
      && typeof state === 'string' && attemptedStates.has(state))).toHaveLength(0);
    expect(f.storage.current(f.key).ledger.evidence).toHaveLength(0);
  } finally { hashing.mockRestore(); }
});

for (const mode of ['absent', 'failed', 'id', 'id-number', 'id-empty', 'hash-absent', 'hash-shape', 'context', 'context-absent', 'questions', 'answers', 'state'] as const) {
  test(`native verifier refuses ${mode} candidate logs before any unused new wire-state commitment`, async () => {
    const f = await fixture(); const started = await f.host.start(f.target, f.authority);
    await completed(f.harness, started.admission.contractId);
    const original = f.storage.current(f.key).record!, seed = f.log.query({ status: 'answered', limit: 1 })[0];
    if (!seed || seed.status !== 'answered') throw new Error('Actual runner reading missing');
    const fake = fakePort(() => noulAnswer(0.01)), id = 'synthetic-unrecorded-verifier';
    const attemptedStates = new Set<string>();
    const candidates = new Map<string, import('@goodvibes-jev/judgment').DecisionEntry | undefined>(); let sequence = 0;
    const port: JudgmentPort = { ...f.hostOptions.port, async ask(request) {
      attemptedStates.add(canonicalJson(request.state));
      const candidateId = `${id}:${++sequence}`;
      const raw = await fake.port.ask(request);
      const context = (mode === 'context' ? { site: 'unrelated-settlement-site' } : mode === 'context-absent' ? undefined : { ...request.context }) as typeof seed.context;
      const questions = mode === 'questions' ? {} : JSON.parse(canonicalJson(request.questions as unknown as import('@goodvibes-jev/judgment').EntryType)) as typeof seed.questions;
      const common = { id: (mode === 'id' ? 'another-recorded-id' : candidateId) as typeof seed.id, at: seed.at, context, questions, requestedModel: seed.requestedModel,
        stateHash: (mode === 'hash-absent' ? undefined : mode === 'hash-shape' ? 'not-a-sha256' : 'f'.repeat(64)) as typeof seed.stateHash, latencyMs: 0, requestId: undefined };
      const candidate: import('@goodvibes-jev/judgment').DecisionEntry | undefined = mode === 'absent' ? undefined : mode === 'failed'
        ? { ...common, status: 'failed', error: { kind: 'unavailable', message: 'Synthetic failed reading' } }
        : { ...seed, ...common, answers: mode === 'answers' ? {} : JSON.parse(canonicalJson(raw.answers as unknown as import('@goodvibes-jev/judgment').EntryType)) as typeof seed.answers };
      candidates.set(candidateId, candidate);
      return { ...raw, decisionId: mode === 'id-number' ? 42 : mode === 'id-empty' ? '' : candidateId } as never;
    } };
    const hashing = spyOn(Bun.CryptoHasher, 'hash');
    try {
      await expect(verifyNativeWorkExecution({ execution: original, runner: f.harness.runner, port,
        decisionLog: { get(readId) { return readId.startsWith(id + ':') ? candidates.get(readId) : f.log.get(readId); } },
        settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true,
        signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow('provenance');
      expect(attemptedStates.size).toBeGreaterThan(0);
      const count = hashing.mock.calls.filter(([algorithm, state]) => algorithm === 'sha256'
        && typeof state === 'string' && attemptedStates.has(state)).length;
      expect(count).toBe(mode === 'state' ? fake.requests.length : 0);
      expect(f.storage.current(f.key).ledger.evidence).toHaveLength(0);
    } finally { hashing.mockRestore(); }
  });
}

for (const mode of ['returned', 'thrown', 'typed-error'] as const) test(`native verifier drains ${mode} owner guard failure and preserves original failure identity`, async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority);
  await completed(f.harness, started.admission.contractId);
  const execution = f.storage.current(f.key).record!, stale = new Error('Original verifier owner retired');
  let rejected: Promise<never> | undefined;
  const calls = spyOn(f.hostOptions.port, 'ask');
  try {
    const operation = verifyNativeWorkExecution({ execution, runner: f.harness.runner, port: f.hostOptions.port, decisionLog: f.log,
      settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true, signal: new AbortController().signal,
      assertCurrent() {
        if (mode === 'typed-error') throw stale;
        rejected = Promise.reject(stale);
        if (mode === 'thrown') throw rejected;
        return rejected as never;
      } });
    if (mode === 'returned') await expect(operation).rejects.toMatchObject({ code: 'invalid' });
    else if (mode === 'typed-error') await expect(operation).rejects.toBe(stale);
    else { await expect(operation).rejects.toBeInstanceOf(Promise); expect(rejected).toBeDefined(); }
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(calls).not.toHaveBeenCalled(); expect(f.storage.current(f.key).ledger.evidence).toHaveLength(0);
  } finally { calls.mockRestore(); }
});

test('a freshly reconstructed terminal runner verifies without restoring an execution owner or replaying effects', async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  f.harness.store.flush(); await f.host.close();
  const reopened = new KnowledgeStore({ dbPath: join(f.root, '.goodvibes', 'knowledge.sqlite') }); const storage = await reopened.openNativeWorkExecutionStorage('project');
  const host = createNativeWorkExecutionHost({ ...f.hostOptions, storage });
  const restarted = makeHarness({ root: f.root, scripts: { u1: () => { throw new Error('Restart must not execute'); } }, decisionLog: f.log,
    nativeDecisions: host.nativeOwner.decisions, durableAdmission: host.nativeOwner.admission });
  host.attachRunner({ ...restarted.runner, startDurable: async () => { throw new Error('No restart launch'); }, resumeDurable: async () => { throw new Error('No restart resume'); } });
  try {
    const admissionPath = join(f.root, '.goodvibes', 'contracts', 'admissions', `${durableKeyHash(f.key)}.json`); const original = readFileSync(admissionPath);
    expect(host.status(f.key, f.authority).contract?.status).toBe('passed');
    expect(host.status(f.key, f.authority).settlement?.state).toBe('required'); expect(readFileSync(admissionPath)).toEqual(original);
    const receipt = await host.settle(f.key, f.authority); expect(receipt.attestation.outcome).toBe('verified');
    expect(restarted.manager.list()).toHaveLength(0); expect(f.harness.agentsOf('u1')).toHaveLength(1);
  } finally { await host.close(); restarted.dispose(); await reopened.close(); }
});

test('cancelling a running automatic settlement cancels execution before joining its verifier', async () => {
  const f = await fixture({ automatic: true, harness: { scripts: { u1: () => [{ text: 'waiting', stop: { kind: 'hang' } }] } } });
  const started = await f.host.start(f.target, f.authority); await waitFor(() => f.harness.agentsOf('u1').length === 1, 'running automatic native work');
  await f.host.cancel(f.key, f.authority, 'Synthetic cancellation');
  expect(f.harness.runner.get(started.admission.contractId)?.status).toBe('cancelled');
  expect(f.storage.current(f.key).settlement).toBeNull(); expect(f.storage.current(f.key).ledger.evidence).toHaveLength(0);
});

test('an omitted original checkpoint criterion cannot produce any attestation', async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  await expect(verifyNativeWorkExecution({ execution: f.storage.current(f.key).record!, runner: { join: f.harness.runner.join, get: id => { const contract = f.harness.runner.get(id)!; return { ...contract, criteria: contract.criteria.slice(0, 1) }; } },
    port: f.hostOptions.port, decisionLog: f.log, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true, signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow();
});

test('a persisted passed checkpoint cannot settle while another execution lease still owns effects', async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  const release = await new DurableContractAdmissions(f.root).lease(f.key);
  try { await expect(f.host.settle(f.key, f.authority)).rejects.toThrow(); expect(f.storage.current(f.key).ledger.evidence).toHaveLength(0); }
  finally { release(); }
  expect((await f.host.settle(f.key, f.authority)).attestation.outcome).toBe('verified'); expect(f.harness.agentsOf('u1')).toHaveLength(1);
});

test('terminal settlement cancellation interrupts a pending configured backup without late publication', async () => {
  let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; }); let calls = 0;
  const retry = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-fixture' }, model: DEFAULT_MODEL, timeoutMs: 1000,
    fallbacks: [{ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:2', apiKey: 'synthetic-backup' }, model: DEFAULT_MODEL }],
    retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 },
    fetch: async () => { if (++calls === 1) return Response.json({}, { status: 503 }); entered(); return new Promise<Response>(() => {}); } });
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ decoratePort: port => ({ ...port, ask: request => request.context?.site === 'contract.check.unit-judge'
    ? withDecisionLog(retry, f.log).ask(request) : port.ask(request) }) });
  const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  const pending = f.host.settle(f.key, f.authority).catch(error => error); await waiting;
  await f.host.cancel(f.key, f.authority, 'Synthetic settlement cancellation'); expect(await pending).toBeInstanceOf(Error);
  expect(calls).toBe(2); expect(f.storage.current(f.key).ledger.evidence).toHaveLength(0);
}, 5000);

test('current paired authority is rechecked before a shared transport retry', async () => {
  let f!: Awaited<ReturnType<typeof fixture>>; let calls = 0;
  const retry = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-fixture' }, model: DEFAULT_MODEL, timeoutMs: 100,
    retry: { backoffInitialMs: 5, backoffMaxMs: 5, backoffJitter: 0 }, fetch: async () => { calls++; f.tokens.revoke(f.paired.id); return Response.json({}, { status: 503 }); } });
  f = await fixture({ decoratePort: port => ({ ...port, ask: request => request.context?.site === 'contract.check.unit-judge' ? withDecisionLog(retry, f.log).ask(request) : port.ask(request) }) });
  const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  await expect(f.host.settle(f.key, f.authority)).rejects.toThrow(); expect(calls).toBe(1); expect(f.storage.current(f.key).ledger.evidence).toHaveLength(0);
}, 5000);

test('returned passing answers cannot launder a recorded failing criterion', async () => {
  const f = await fixture({ settlementAnswers: context => context.name === 'criterion_1' ? noulAnswer(0.99) : undefined,
    decoratePort: port => ({ ...port, async ask(request) {
      const result = await port.ask(request);
      if (request.context?.site !== 'contract.check.unit-judge') return result;
      const answers = Object.fromEntries(Object.entries(request.questions).map(([name, question]) => [name, question.type === 'noul' ? noulAnswer(0.01) : result.answers[name as keyof typeof result.answers]])) as typeof result.answers;
      return { ...result, answers };
    } }) });
  const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  await expect(f.host.settle(f.key, f.authority)).rejects.toThrow('provenance');
  expect(f.storage.current(f.key).ledger.revision).toBe(2); expect(f.storage.current(f.key).settlement).toBeNull();
});

test('deleted artifacts remain provable when their former parent directory is also absent', async () => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ source: { goal: 'Remove the obsolete directory.', criteria: ['The obsolete directory and its old.txt file are absent.'] },
    harness: { contract: { midRunChecks: false }, scripts: { u1: record => [{ text: 'Remove the obsolete content.', tool: true, after: async () => { rmSync(join(record.workingDirectory ?? f.root, 'obsolete'), { recursive: true }); } }, { text: 'Removed obsolete/old.txt and its empty directory.' }] } } });
  mkdirSync(join(f.root, 'obsolete')); writeFileSync(join(f.root, 'obsolete', 'old.txt'), 'obsolete fixture content');
  const started = await f.host.start(f.target, f.authority); const contract = await completed(f.harness, started.admission.contractId);
  if (contract.status !== 'passed') throw new Error(JSON.stringify({ status: contract.status, error: contract.error, statusLine: contract.statusLine, decisions: contract.decisions.slice(-5), checks: contract.units.map(unit => unit.checks.at(-1)) }));
  expect(contract.units[0]?.touchedPaths).toContain('obsolete/old.txt');
  const receipt = await f.host.settle(f.key, f.authority);
  expect(receipt.attestation.outcome).toBe('verified'); expect(receipt.attestation.references.some(item => item.kind === 'artifact' && item.ref.endsWith(':obsolete/old.txt'))).toBe(true);
});

test('a declared passed checkpoint cannot cite recorded failing prior checks', async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority); const contract = await completed(f.harness, started.admission.contractId);
  const judgeId = contract.units[0]!.checks.at(-1)!.decisionIds[0]!;
  await expect(verifyNativeWorkExecution({ execution: f.storage.current(f.key).record!, runner: f.harness.runner, port: f.hostOptions.port,
    decisionLog: { get(id) { const entry = f.log.get(id); return id === judgeId && entry?.status === 'answered' ? { ...entry, answers: { goal: noulAnswer(0.99), criterion_0: noulAnswer(0.99), criterion_1: noulAnswer(0.99) } } : entry; } },
    settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true, signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow('genuine');
});

test('binary artifacts count raw bytes toward the aggregate host capture bound', async () => {
  const content = '\0'.repeat(11 * 1024 * 1024);
  const f = await fixture({ harness: { scripts: { u1: () => [{ files: { 'src/one.bin': content, 'src/two.bin': content }, text: 'Produced two binary artifacts.' }] } } });
  const started = await f.host.start(f.target, f.authority); const contract = await completed(f.harness, started.admission.contractId);
  expect(contract.status).toBe('passed');
  await expect(f.host.settle(f.key, f.authority)).rejects.toThrow('total budget'); expect(f.storage.current(f.key).ledger.evidence).toHaveLength(0);
});

test('borrowed answer mutation after return cannot change the frozen recorded verdict', async () => {
  const f = await fixture({ settlementAnswers: context => context.name === 'criterion_1' ? noulAnswer(0.99) : undefined,
    decoratePort: port => ({ ...port, async ask(request) {
      const result = await port.ask(request);
      if (request.context?.site !== 'contract.check.unit-judge') return result;
      const answers = structuredClone(result.answers);
      queueMicrotask(() => queueMicrotask(() => { Object.assign(answers, { criterion_1: noulAnswer(0.01) }); }));
      return { ...result, answers };
    } }) });
  const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  const receipt = await f.host.settle(f.key, f.authority); expect(receipt.attestation.outcome).toBe('failed'); expect(receipt.attestation.criteriaResults[1]?.status).toBe('unsatisfied');
});

test('borrowed getter answers cannot execute code while native settlement captures an actual recorded result', async () => {
  let invoked = 0;
  const f = await fixture({ decoratePort: port => ({ ...port, async ask(request) {
    const result = await port.ask(request); if (request.context?.site !== 'contract.check.unit-judge') return result;
    return { ...result, get answers() { invoked++; return result.answers; } };
  } }) });
  const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  await expect(f.host.settle(f.key, f.authority)).rejects.toThrow();
  expect(invoked).toBe(0); expect(f.storage.current(f.key).ledger.revision).toBe(2); expect(f.storage.current(f.key).settlement).toBeNull();
});
