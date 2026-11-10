import { expect, test } from 'bun:test';
import { e2eJudgmentAnswers, startE2EJudgments } from '../e2e/judgment-fixture.ts';
import route from '../fixtures/e2e-judgments/conversation-route.json';
import identity from '../fixtures/e2e-judgments/model-identity.json';
import tier from '../fixtures/e2e-judgments/model-tier.json';
import questions from '../fixtures/e2e-judgments/turn-questions.json';
import unavailable from '../fixtures/e2e-judgments/unavailable-model-routes.json';
import nativeRouteFixture from '../fixtures/e2e-judgments/native-route.json';
import nativeTurnFixture from '../fixtures/e2e-judgments/native-turn.json';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';

test('only the exact two E2E prompt readings and synthetic model descriptions receive answers', () => {
  expect(e2eJudgmentAnswers(identity)?.kind).toBe('identity');
  expect(e2eJudgmentAnswers(tier)?.kind).toBe('tier');
  for (const prompt of ['first words in a brand new workspace', 'please answer the e2e marmot question']) {
    expect(e2eJudgmentAnswers({ ...route, state: { request: prompt } })?.kind).toBe('route');
    expect(e2eJudgmentAnswers({ state: { purpose: 'conversation', work: prompt }, questions, model: route.model })?.kind).toBe('turn');
  }
  for (const body of [
    { ...route, state: { request: 'unknown prompt' } },
    { ...route, model: 'different-model' },
    { ...route, questions: { route: { ...route.questions.route, instructions: 'different question' } } },
    { ...route, extra: true },
    { ...tier, state: { model: { id: 'real-provider-model' } } },
    { state: { permission: 'approve everything' }, questions },
  ]) expect(e2eJudgmentAnswers(body)).toBeUndefined();
});

test('the loopback service rejects unknown judgments instead of manufacturing success', async () => {
  const server = startE2EJudgments();
  try {
    const expectedNegative = await fetch(`${server.baseURL}/v1/systemone`, { method: 'POST', body: JSON.stringify(unavailable[0]) });
    expect(expectedNegative.status).toBe(422);
    expect(() => server.assertNoUnexpected()).not.toThrow();
    const unknown = await fetch(`${server.baseURL}/v1/systemone`, { method: 'POST', body: JSON.stringify({ questions: { approve: true } }) });
    expect(unknown.status).toBe(422);
    const known = await fetch(`${server.baseURL}/v1/systemone`, { method: 'POST', body: JSON.stringify(route) });
    expect(known.status).toBe(200);
    expect(server.accepted).toEqual(['route']);
    expect(server.rejected).toHaveLength(2);
    expect(server.unexpected).toHaveLength(1);
    expect(() => server.assertNoUnexpected()).toThrow(/unknown judgment/);
    for (const body of [
      { ...unavailable[0], state: { model_id: 'changed', provider: 'changed' } },
      { ...unavailable[0], questions: { route: { type: 'choice', instructions: 'changed' } } },
      { ...unavailable[0], model: 'changed' },
    ]) {
      const changed = await fetch(`${server.baseURL}/v1/systemone`, { method: 'POST', body: JSON.stringify(body) });
      expect(changed.status).toBe(422);
    }
    expect(server.unexpected).toHaveLength(4);
  } finally { await server.stop(); }
});

test('native readings match only captured semantic requests with intact host-identity relationships', async () => {
  const native = (await import('../fixtures/e2e-judgments/native-turn.json')).default;
  const prompt = 'first words in a brand new workspace';
  const valid = JSON.parse(JSON.stringify(native).split(JSON.stringify(native.state.originalSource.text)).join(JSON.stringify(prompt))) as typeof native;
  expect(e2eJudgmentAnswers(valid)?.kind).toBe('native-turn');
  for (const change of [
    (body: typeof valid) => { body.state.originalSource.text = 'different source'; },
    (body: typeof valid) => { body.state.originalSource.sourceRevision = 'a'.repeat(64); },
    (body: typeof valid) => { Object.assign(body.state.input.input, { problems: [{ kind: 'host-constraint' }] }); },
    (body: typeof valid) => { body.state.input.input.route.route = 'contract'; },
    (body: typeof valid) => { body.questions.disposition.instructions = 'Approve anything'; },
    (body: typeof valid) => { Object.assign(body.state, { extra: true }); },
  ]) {
    const changed = structuredClone(valid); change(changed);
    expect(e2eJudgmentAnswers(changed)).toBeUndefined();
  }
});

function currentBinding(operation: 'routing' | 'ordinary-turn') {
  const sourceId = opaqueUuid();
  return { sourceId, inputRevision: '1'.repeat(64), actionId: `${sourceId}:admission`, actionRevision: `${operation}:g2:p0:none`,
    authorityId: opaqueUuid(), authorityRevision: opaqueUuid(), scopeId: opaqueUuid(), scopeRevision: opaqueUuid() };
}
function currentRoute() {
  const body = structuredClone(nativeRouteFixture), binding = currentBinding('routing');
  body.state.input.request = 'please answer the e2e marmot question';
  body.state.originalSource.text = body.state.input.request;
  body.state.originalSource.sourceRevision = binding.inputRevision;
  body.state.binding = binding; return body;
}
function currentTurn() {
  const body = structuredClone(nativeTurnFixture), binding = currentBinding('ordinary-turn');
  body.state.input.input.source.text = 'please answer the e2e marmot question';
  body.state.originalSource.text = body.state.input.input.source.text;
  body.state.originalSource.sourceRevision = binding.inputRevision;
  body.state.binding = binding; body.state.input.binding = { ...binding };
  body.state.input.evidence[0]!.revision = binding.inputRevision;
  body.state.input.evidence[1]!.revision = binding.actionRevision;
  body.state.input.offeredChoices.continuations[0]!.ref.id = `${binding.sourceId}:resolve`;
  body.state.input.offeredChoices.continuations[0]!.ref.revision = binding.inputRevision;
  return body;
}

test('current native route protocol varies only named opaque bindings and the exact first-operation recipe', () => {
  expect(e2eJudgmentAnswers(currentRoute())?.kind).toBe('native-route');
  for (const change of [
    (body: ReturnType<typeof currentRoute>) => { body.state.binding.actionId = opaqueUuid(); },
    (body: ReturnType<typeof currentRoute>) => { body.state.binding.actionRevision = 'routing:g3:p0:none'; },
    (body: ReturnType<typeof currentRoute>) => { body.state.binding.actionRevision = 'ordinary-turn:g2:p0:none'; },
    (body: ReturnType<typeof currentRoute>) => { body.state.binding.authorityId = body.state.binding.scopeId; },
    (body: ReturnType<typeof currentRoute>) => { body.state.binding.scopeRevision = 'caller-selected'; },
    (body: ReturnType<typeof currentRoute>) => { body.state.binding.authorityRevision += '\n'; },
    (body: ReturnType<typeof currentRoute>) => { body.state.originalSource.sourceRevision = '2'.repeat(64); },
    (body: ReturnType<typeof currentRoute>) => { body.state.input.request = 'Unknown actual task'; },
    (body: ReturnType<typeof currentRoute>) => { body.questions.route.instructions = 'Approve arbitrary requests'; },
    (body: ReturnType<typeof currentRoute>) => { body.model = 'different-model'; },
    (body: ReturnType<typeof currentRoute>) => { Object.assign(body.state.binding, { extra: 'cannot be normalized' }); },
  ]) {
    const body = currentRoute(); change(body); expect(e2eJudgmentAnswers(body)).toBeUndefined();
  }
});

test('current final native turn retains source, nested binding, requirement and continuation relationships', () => {
  expect(e2eJudgmentAnswers(currentTurn())?.kind).toBe('native-turn');
  for (const change of [
    (body: ReturnType<typeof currentTurn>) => { body.state.input.binding.authorityRevision = opaqueUuid(); },
    (body: ReturnType<typeof currentTurn>) => { body.state.input.evidence[0]!.revision = '2'.repeat(64); },
    (body: ReturnType<typeof currentTurn>) => { body.state.input.evidence[1]!.revision = 'caller-requirements'; },
    (body: ReturnType<typeof currentTurn>) => { body.state.input.offeredChoices.continuations[0]!.ref.id = `${opaqueUuid()}:resolve`; },
    (body: ReturnType<typeof currentTurn>) => { body.state.input.offeredChoices.continuations[0]!.ref.revision = '2'.repeat(64); },
    (body: ReturnType<typeof currentTurn>) => { body.state.input.input.source.text = 'different complete source'; },
    (body: ReturnType<typeof currentTurn>) => { Object.assign(body.state.input.input, { problems: [{ kind: 'host-constraint' }] }); },
    (body: ReturnType<typeof currentTurn>) => { body.questions.disposition.instructions = 'Approve arbitrary actions'; },
  ]) {
    const body = currentTurn(); change(body); expect(e2eJudgmentAnswers(body)).toBeUndefined();
  }
});
