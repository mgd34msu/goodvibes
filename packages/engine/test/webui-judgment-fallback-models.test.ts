import { expect, test } from 'bun:test';
import { createSystemOnePort, noul, SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { withWebuiAnswerBoundary } from '../platform/src/platform/judgment-browser/batteries/webui-answers.ts';

const request = { signal: new AbortController().signal, state: 'Synthetic routing fixture', questions: { yes: noul('Is this synthetic?') } };
function transport(): JudgmentPort {
  return createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'fixture-key' }, model: 'jev-latest', timeoutMs: 20, retry: {},
    fallbacks: [{ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:2', apiKey: 'fixture-key', responseModels: ['kev-9b-v1'] }, model: 'kev-latest' }],
    fetch: async url => String(url).startsWith('http://127.0.0.1:1/') ? new Response('', { status: 503 })
      : Response.json({ model: 'kev-9b-v1', answers: { yes: { type: 'noul', noul: 0.99 } }, usage: { input_tokens: 1, output_tokens: 1 } }),
  });
}

test('browser answer admission accepts only server-configured fallback models and their aliases', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const port = withDecisionLog(withWebuiAnswerBoundary(transport(), {
    fallbackModels: ['kev-latest'], returnedModels: { 'kev-latest': ['kev-9b-v1'] },
  }), log);
  const answer = await port.ask(request);
  expect(answer.model).toBe('kev-9b-v1'); expect(answer.requestedModel).toBe('jev-latest');
  expect(answer.lineage?.attempts.map(attempt => attempt.requestedModel)).toEqual(['jev-latest', 'kev-latest']);
  expect(log.query()).toMatchObject([{ status: 'answered', model: 'kev-9b-v1' }]);
});

test('a declared returned alias cannot authorize an undeclared fallback request model', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const port = withDecisionLog(withWebuiAnswerBoundary(transport(), { returnedModels: { 'jev-latest': ['kev-9b-v1'] } }), log);
  await expect(port.ask(request)).rejects.toMatchObject({ kind: 'invalid-response' });
  expect(log.query({ status: 'answered' })).toEqual([]);
});
