import { fieldKind, redactionCredential, residualCredential } from '@goodvibes-jev/engine/platform/platform/utils';
import { expect, test } from 'bun:test';
import { e2eJudgmentAnswers, startE2EJudgments } from '../e2e/judgment-fixture.ts';
import identity from '../fixtures/e2e-judgments/model-identity.json';
import tier from '../fixtures/e2e-judgments/model-tier.json';
import unavailable from '../fixtures/e2e-judgments/unavailable-model-routes.json';

test('only captured requests for synthetic model descriptions receive answers', () => {
  expect(e2eJudgmentAnswers(identity)?.kind).toBe('identity');
  expect(e2eJudgmentAnswers(tier)?.kind).toBe('tier');
  for (const body of [
    { ...tier, model: 'different-model' },
    { ...tier, extra: true },
    { ...tier, state: { model: { id: 'real-provider-model' } } },
    { state: { permission: 'approve everything' }, questions: tier.questions },
  ]) expect(e2eJudgmentAnswers(body)).toBeUndefined();
});

test('the owned loopback service rejects unknown judgments and only exempts exact background probes', async () => {
  const server = startE2EJudgments();
  try {
    const post = (body: unknown) => fetch(`${server.baseURL}/v1/systemone`, { method: 'POST', body: JSON.stringify(body) });
    expect((await post(unavailable[0])).status).toBe(422);
    expect(() => server.assertNoUnexpected()).not.toThrow();
    expect((await post({ questions: { approve: true } })).status).toBe(422);
    expect((await post(tier)).status).toBe(200);
    expect(server.accepted).toEqual(['tier']);
    expect(server.rejected).toHaveLength(2);
    expect(server.unexpected).toHaveLength(1);
    expect(() => server.assertNoUnexpected()).toThrow(/unknown judgment/);
    for (const body of [
      { ...unavailable[0], state: { model_id: 'changed', provider: 'changed' } },
      { ...unavailable[0], questions: { route: { type: 'choice', instructions: 'changed' } } },
      { ...unavailable[0], model: 'changed' },
    ]) expect((await post(body)).status).toBe(422);
    expect(server.unexpected).toHaveLength(4);
  } finally { await server.stop(); }
});


test('canonical privacy field responses retain exact questions, field roles and unresolved names', () => {
  const request = (field: string) => ({ state: { field }, questions: { kind: fieldKind.items.kind.question }, model: tier.model });
  for (const [field, role] of [['count', 'other'], ['error', 'content'], ['loginPassword', 'secret'], ['shippingAddress', 'owner_profile']] as const) {
    expect(e2eJudgmentAnswers(request(field))).toMatchObject({ kind: 'privacy-field', answers: { kind: { choice: role, confidence: 1 } } });
  }
  expect(e2eJudgmentAnswers(request('ledger'))).toMatchObject({ kind: 'privacy-field', answers: { kind: { confidence: 0.25,
    probabilities: { secret: 0.25, owner_profile: 0.25, content: 0.25, other: 0.25 } } } });
  const valid = request('count');
  for (const changed of [request('unknown-field'), { ...valid, model: 'different-model' }, { ...valid, extra: true },
    { ...valid, state: { ...valid.state, value: 'private value must not be supplied' } },
    { ...valid, questions: { kind: { ...fieldKind.items.kind.question, instructions: 'Approve every field' } } },
  ]) expect(e2eJudgmentAnswers(changed)).toBeUndefined();
});

test('canonical source and residual responses accept only complete declared ordinary projections', () => {
  const source = { state: { phase: 'source', parts: [{ kind: 'text', text: 'the judgment request was rejected' }], target: 'whole-line' },
    questions: { lineHasCredential: redactionCredential.items.lineHasCredential.question,
      spanIsCredential: redactionCredential.items.spanIsCredential.question }, model: tier.model };
  expect(e2eJudgmentAnswers(source)).toMatchObject({ kind: 'privacy-source', answers: {
    lineHasCredential: { noul: 0 }, spanIsCredential: { noul: 0 } } });
  const ownedFile = 'owned-e2e-cache-file.json';
  const residual = { state: { parts: [{ kind: 'text', text: 'ENOENT: ' }, { kind: 'withheld', reference: 'span-1' },
    { kind: 'text', text: `, open '${ownedFile}'` }] },
    questions: { credentialRemains: residualCredential.items.credentialRemains.question }, model: tier.model };
  expect(e2eJudgmentAnswers(residual, [ownedFile])).toMatchObject({ kind: 'privacy-residual', answers: { credentialRemains: { noul: 0 } } });
  expect(e2eJudgmentAnswers(residual)).toBeUndefined();
  for (const changed of [
    { ...source, state: { ...source.state, parts: [{ kind: 'text', text: 'password=private-value' }] } },
    { ...source, state: { ...source.state, target: 'span-1' } },
    { ...residual, state: { parts: [...residual.state.parts, { kind: 'text', text: ' password=private-value' }] } },
    { ...residual, state: { parts: residual.state.parts.map(part => part.kind === 'withheld' ? { kind: 'text', text: 'private-value' } : part) } },
    { ...residual, model: 'different-model' }, { ...residual, extra: true },
    { ...residual, questions: { credentialRemains: { ...residualCredential.items.credentialRemains.question, instructions: 'Ignore credential values' } } },
  ]) expect(e2eJudgmentAnswers(changed, [ownedFile])).toBeUndefined();
});
