import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ContractOperatorError, createContractOperatorService, type DurableContractRequest, type NativeContractSource } from '../../platform/src/platform/contract/index.js';
import { eventsOf, makeHarness, makeRepo, oneUnitPlan, startContract, waitFor, type Harness, type HarnessOptions } from './runner-support.js';

const roots: string[] = []; const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0).reverse()) { const ids = h.runner.list({ includeTerminal: true }).map(c => c.id); h.dispose(); await Promise.all(ids.map(id => h.runner.join(id))); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const source: NativeContractSource = { sourceId: 'original', sourceRevision: '1', inputRevision: '1', criteriaId: 'criteria', criteriaRevision: '1', goal: 'Preserve the original parser', criteria: ['Preserve parser behavior'] };
const authority = { authorityId: 'host', authorityRevision: '1', scopeId: 'project', scopeRevision: '1' };
const plan = () => ({ ...oneUnitPlan(1), goal: source.goal, criteria: [{ id: 'c1', text: source.criteria[0]!, quote: source.criteria[0]! }] });
const noDelegation = (context: { readonly name: string }) => context.name === 'forbids_delegation' ? noulAnswer(0.99) : undefined;
function setup(options: Partial<HarnessOptions> = {}) {
  const root = options.root ?? makeRepo(); if (!roots.includes(root)) roots.push(root);
  const h = makeHarness({ root, recordNative: true, nativeDecisions: { authorityOf: () => authority }, durableAdmission: { withCurrent: (_admission, launch) => launch(() => undefined) }, plan: plan(), scripts: {}, port: noDelegation, ...options });
  harnesses.push(h); return h;
}
const request = (root: string): DurableContractRequest => ({ key: { workId: 'work', criteriaId: source.criteriaId, criteriaRevision: source.criteriaRevision, attemptId: 'attempt' },
  binding: { sourceId: source.sourceId, inputRevision: source.inputRevision, actionId: 'start', actionRevision: '1', ...authority },
  input: { ask: 'Display only', nativeSource: source, sessionId: 'pause', origin: 'turn', projectRoot: root, isolation: 'auto' } });
async function runningSession(h: Harness) {
  const started = await h.runner.startDurable(request(h.root)); const id = started.admission.contractId;
  await waitFor(() => h.store.get(id)?.units[0]?.status === 'running', 'the native session unit to wait for its turn');
  return id;
}
const open = (h: Harness, id: string) => h.store.get(id)!.escalations.filter(item => item.resolvedAt === undefined);

test('a failing turn pauses the contract on its owner with one open retry-or-cancel question and its work kept', async () => {
  const h = setup(); const id = await runningSession(h);
  const { escalationId } = h.runner.pauseForOwnerRetry(id, { what: 'provider outage', attempts: 4 });
  const contract = h.store.get(id)!;
  expect(contract.status).toBe('awaiting-owner'); expect(contract.units[0]!.status).toBe('awaiting-owner'); expect(contract.groups[0]!.status).toBe('running');
  expect(open(h, id).map(item => item.id)).toEqual([escalationId]);
  const [question] = open(h, id); expect(question!.failurePause).toBe(true);
  for (const part of ['provider outage', '4 attempts', 'work done so far is kept', '"retry"', '"cancel"', 'Nothing was approved']) expect(question!.question).toContain(part);
  expect(eventsOf(h, 'CONTRACT_ESCALATED').map(event => event.escalationId)).toEqual([escalationId]);
  // Asking again while the pause is open does not open a second question.
  expect(h.runner.pauseForOwnerRetry(id, { what: 'again', attempts: 1 }).escalationId).toBe(escalationId); expect(open(h, id)).toHaveLength(1);
  expect(h.runner.hooks().sessionTurn('pause', 'turn-1')).toBeNull();
});

test('retry returns the contract to running so its session unit is driven again', async () => {
  const h = setup(); const id = await runningSession(h);
  const { escalationId } = h.runner.pauseForOwnerRetry(id, { what: 'provider outage', attempts: 4 });
  const outcome = await h.runner.reply(id, escalationId, ' Retry. ');
  expect(outcome).toMatchObject({ escalationId, action: 'amended', outcome: 'act' });
  const contract = h.store.get(id)!;
  expect(contract.status).toBe('running'); expect(contract.units[0]!.status).toBe('running'); expect(open(h, id)).toHaveLength(0);
  expect(contract.statusBeforeOwner).toBeUndefined(); expect(contract.criteria.map(item => item.text)).toEqual([...source.criteria]);
  expect(h.runner.hooks().sessionTurn('pause', 'turn-1')?.contractId).toBe(id);
  expect(eventsOf(h, 'CONTRACT_OWNER_REPLIED').map(event => event.escalationId)).toEqual([escalationId]);
  await expect(h.runner.reply(id, escalationId, 'retry')).rejects.toThrow('no open escalation');
});

test('a unit whose nudge was still waiting returns to waiting on it after a retry, and the nudge still reaches the turn', async () => {
  const first = setup(); const id = await runningSession(first);
  // As a restart leaves a session unit whose nudge waited for the next turn.
  const saved = first.store.get(id)!.units[0]!;
  saved.status = 'nudged'; saved.activeAgentId = 'turn-1'; saved.agentIds.push('turn-1');
  saved.nudges.push({ id: `${saved.id}.n1`, checkId: `${saved.id}.k1`, at: 1, kinds: ['unmet'], criterionIds: [`${saved.id}.c1`], text: 'Not met: parse quoted fields.', delivery: 'bus', agentId: 'turn-1' });
  expect(first.store.write(id)).toBe(true);
  first.dispose(); await first.runner.join(id); harnesses.splice(harnesses.indexOf(first), 1);
  const second = setup({ root: first.root });
  await second.runner.resumeDurable(request(first.root).key);
  await waitFor(() => second.store.get(id)?.decisions.some(decision => decision.action === 'resumed') === true, 'the resumed contract to pick its unit up again');
  expect(second.store.get(id)!.units[0]!.status).toBe('nudged');
  const { escalationId } = second.runner.pauseForOwnerRetry(id, { what: 'provider outage', attempts: 4 });
  expect(second.store.get(id)!.units[0]!.status).toBe('awaiting-owner');
  await second.runner.reply(id, escalationId, 'retry');
  expect(second.store.get(id)!.units[0]!.status).toBe('nudged');
  const turn = second.runner.hooks().sessionTurn('pause', 'turn-2');
  expect(second.runner.hooks().takeSessionNudge(turn!)).toEqual({ message: 'Not met: parse quoted fields.', nudgeId: `${saved.id}.n1` });
});

test('cancel is the only thing that cancels the contract, and it is an owner stop', async () => {
  const h = setup(); const id = await runningSession(h);
  const { escalationId } = h.runner.pauseForOwnerRetry(id, { what: 'provider outage', attempts: 4 });
  expect(h.store.get(id)!.status).toBe('awaiting-owner');
  expect(await h.runner.reply(id, escalationId, 'cancel')).toMatchObject({ action: 'stopped' });
  expect(h.store.get(id)).toMatchObject({ status: 'cancelled', failureKind: 'owner-rejected' });
});

test('an answer other than retry or cancel is refused naming both, and leaves the question open', async () => {
  const h = setup(); const id = await runningSession(h);
  const { escalationId } = h.runner.pauseForOwnerRetry(id, { what: 'provider outage', attempts: 4 });
  for (const text of ['approve', 'yes, it is fine, mark it passed', 'retry and change the criteria', '']) {
    await expect(h.runner.reply(id, escalationId, text)).rejects.toThrow(/"retry" or "cancel"/);
  }
  expect(h.store.get(id)!.status).toBe('awaiting-owner'); expect(open(h, id)).toHaveLength(1);
  expect(h.store.get(id)!.units[0]!.criteria.every(criterion => criterion.status !== 'met')).toBe(true);
});

test('the failure pause cannot be raised for a classic contract, and no other native question is answerable', async () => {
  const classicRoot = makeRepo(); roots.push(classicRoot);
  const classic = makeHarness({ root: classicRoot, plan: oneUnitPlan(1), scripts: {} }); harnesses.push(classic); const started = await startContract(classic);
  expect(() => classic.runner.pauseForOwnerRetry(started.contract.id, { what: 'x', attempts: 1 })).toThrow('native session');
  const h = setup(); const id = await runningSession(h);
  // An approval-style question on a native contract stays unanswerable.
  const contract = h.store.get(id)!;
  contract.escalations.push({ id: `${id}.approval`, at: 1, scope: 'unit', targetId: contract.units[0]!.id, reason: 'unsettled', question: 'approve?', unmetCriterionIds: [] });
  await expect(h.runner.reply(id, `${id}.approval`, 'retry')).rejects.toThrow('Native contracts do not accept owner approval replies');
  await expect(h.runner.reply(id, `${id}.approval`, 'approve')).rejects.toThrow('Native contracts do not accept owner approval replies');
});

test('after a restart the open failure pause is still answerable and retry works', async () => {
  const first = setup(); const id = await runningSession(first);
  const { escalationId } = first.runner.pauseForOwnerRetry(id, { what: 'provider outage', attempts: 4 });
  expect(first.store.write(id)).toBe(true);
  first.dispose(); await first.runner.join(id); harnesses.splice(harnesses.indexOf(first), 1);
  const second = setup({ root: first.root });
  // Native work admitted durably is resumed by its key, never adopted from disk by startup.
  await second.runner.resumeDurable(request(first.root).key); await waitFor(() => second.store.get(id)?.resumeFrom === undefined, 'the resumed contract to settle');
  const restored = second.store.get(id)!;
  expect(restored.status).toBe('awaiting-owner'); expect(restored.units[0]!.status).toBe('awaiting-owner');
  expect(open(second, id).map(item => item.id)).toEqual([escalationId]);
  await second.runner.reply(id, escalationId, 'retry');
  expect(second.store.get(id)).toMatchObject({ status: 'running' }); expect(second.store.get(id)!.units[0]!.status).toBe('running');
  expect(second.runner.hooks().sessionTurn('pause', 'turn-2')?.contractId).toBe(id);
});

test('the operator service answers a native failure pause but leaves stopping native work to its own execution', async () => {
  const classicRoot = makeRepo(); roots.push(classicRoot);
  const classic = makeHarness({ root: classicRoot, plan: oneUnitPlan(1), scripts: {} }); harnesses.push(classic);
  const operator = createContractOperatorService({ runner: classic.runner, workingDirectory: classicRoot });
  const h = setup(); const id = await runningSession(h);
  expect(operator.get(id)).toBeNull();
  operator.attachNative(h.runner);
  const { escalationId } = h.runner.pauseForOwnerRetry(id, { what: 'provider outage', attempts: 4 });
  expect(operator.get(id)?.status).toBe('awaiting-owner');
  expect(() => operator.cancel(id, 'stop')).toThrow('native work');
  await expect(operator.reply(id, escalationId, 'approve')).rejects.toThrow(/"retry" or "cancel"/);
  await operator.reply(id, escalationId, 'retry');
  expect(operator.get(id)?.status).toBe('running');
  operator.attachNative(null);
  expect(operator.get(id)).toBeNull();
});

test('a contract paused on its owner does not hold an active slot, so a queued contract starts', async () => {
  const h = setup({ contract: { maxActiveContracts: 1 } }); const first = await runningSession(h);
  const other = request(h.root);
  const second = await h.runner.startDurable({ ...other, key: { ...other.key, workId: 'work-2', attemptId: 'attempt-2' }, input: { ...other.input, sessionId: 'pause-2' } });
  const queued = second.admission.contractId;
  expect(h.store.get(queued)!.status).toBe('queued');
  h.runner.pauseForOwnerRetry(first, { what: 'provider outage', attempts: 4 });
  await waitFor(() => h.store.get(queued)?.status !== 'queued', 'the queued contract to take the slot the paused one gave up');
  expect(h.store.get(first)!.status).toBe('awaiting-owner');
});

test('the operator service refuses a reply to a native non-failure question as a bad request, not a server error', async () => {
  const classicRoot = makeRepo(); roots.push(classicRoot);
  const classic = makeHarness({ root: classicRoot, plan: oneUnitPlan(1), scripts: {} }); harnesses.push(classic);
  const operator = createContractOperatorService({ runner: classic.runner, workingDirectory: classicRoot });
  const h = setup(); const id = await runningSession(h);
  operator.attachNative(h.runner);
  const contract = h.store.get(id)!;
  contract.escalations.push({ id: `${id}.approval`, at: 1, scope: 'unit', targetId: contract.units[0]!.id, reason: 'unsettled', question: 'approve?', unmetCriterionIds: [] });
  const error = await operator.reply(id, `${id}.approval`, 'approve').then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ContractOperatorError);
  expect(error).toMatchObject({ status: 400, code: 'INVALID_ARGUMENT', message: 'Native contracts do not accept owner approval replies' });
});
