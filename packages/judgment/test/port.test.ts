// Proves: A malformed answer from the decision endpoint is a failed judgment, never a guessed one.
// Red when: An answer that is missing, of the wrong type, out of range, outside the offered options or inconsistent with its distribution is returned as a reading.
import { describe, expect, test } from 'bun:test';
import {
  choice,
  createSystemOnePort,
  JudgmentError,
  noul,
  score,
  type JudgmentConfig,
} from '../src/index.ts';

type Handler = (body: Record<string, unknown>) => Response;

function portWith(handler: Handler) {
  const calls: Record<string, unknown>[] = [];
  const config: JudgmentConfig = {
    signal: new AbortController().signal,
    endpoint: { kind: 'hosted', baseURL: 'https://judge.test', apiKey: 'test-key' },
    model: 'jev-1.13.0',
    timeoutMs: 1_000,
    retry: { backoffInitialMs: 1, backoffMaxMs: 1 },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(body);
      return handler(body);
    },
  };
  return { port: createSystemOnePort(config), calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const QUESTIONS = {
  urgent: noul('Does this convey urgency?'),
  team: choice('Which team handles this?', { billing: null, technical: null }),
  mood: score('How frustrated is the sender?', ['calm', 'frustrated', 'angry']),
};

const GOOD_ANSWERS = {
  urgent: { type: 'noul', noul: 0.9 },
  team: { type: 'choice', choice: 'billing', confidence: 0.8, probabilities: { billing: 0.9, technical: 0.1 } },
  mood: {
    type: 'score',
    score: 1.2,
    confidence: 0.7,
    legend: { '0': 'calm', '1': 'frustrated', '2': 'angry' },
    probabilities: { '0': 0, '1': 0.8, '2': 0.2 },
  },
};

describe('createSystemOnePort', () => {
  test.each([
    ['missing answer', { urgent: GOOD_ANSWERS.urgent, team: GOOD_ANSWERS.team }],
    ['wrong answer type', { ...GOOD_ANSWERS, urgent: { type: 'score', score: 1 } }],
    ['noul out of range', { ...GOOD_ANSWERS, urgent: { type: 'noul', noul: 1.4 } }],
    ['choice outside criteria', { ...GOOD_ANSWERS, team: { ...GOOD_ANSWERS.team, choice: 'sales' } }],
    ['choice missing a probability', { ...GOOD_ANSWERS, team: { ...GOOD_ANSWERS.team, probabilities: { billing: 1 } } }],
    ['choice has zero total probability', { ...GOOD_ANSWERS, team: { ...GOOD_ANSWERS.team, probabilities: { billing: 0, technical: 0 } } }],
    ['choice exceeds unit total probability', { ...GOOD_ANSWERS, team: { ...GOOD_ANSWERS.team, probabilities: { billing: 1, technical: 1 } } }],
    ['choice is not a maximum', { ...GOOD_ANSWERS, team: { ...GOOD_ANSWERS.team, probabilities: { billing: 0.1, technical: 0.9 } } }],
    ['score above the top level', { ...GOOD_ANSWERS, mood: { ...GOOD_ANSWERS.mood, score: 2.5 } }],
    ['score missing a level', { ...GOOD_ANSWERS, mood: { ...GOOD_ANSWERS.mood, probabilities: { '0': 1 } } }],
    ['score has zero mass', { ...GOOD_ANSWERS, mood: { ...GOOD_ANSWERS.mood, probabilities: { '0': 0, '1': 0, '2': 0 } } }],
    ['score has excess mass', { ...GOOD_ANSWERS, mood: { ...GOOD_ANSWERS.mood, probabilities: { '0': 1, '1': 1, '2': 1 } } }],
    ['score contradicts its distribution', { ...GOOD_ANSWERS, mood: { ...GOOD_ANSWERS.mood, score: 2 } }],
    ['score distribution is an array', { ...GOOD_ANSWERS, mood: { ...GOOD_ANSWERS.mood, probabilities: [0, 0.8, 0.2] } }],
  ])('treats %s as an invalid response', async (_label, answers) => {
    const { port } = portWith(() => json(200, { model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } }));
    const error = await port.ask({ state: 'x', questions: QUESTIONS }).catch((e: unknown) => e);
    expect((error as JudgmentError).kind).toBe('invalid-response');
  });
});
