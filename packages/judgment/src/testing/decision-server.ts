import type { Question } from '../index.ts';
import { choiceAnswer, noulAnswer, scoreAnswer } from './fake-port.ts';

/**
 * One scripted answer for one question of a decision request, or undefined to
 * give it the neutral answer. `state` is the request's state as sent.
 */
export type DecisionScript = (name: string, question: Question, state: unknown) => unknown;

/** The answer a question gets when no script claims it: "none" when offered, else the first option; the lowest score; "no". */
export function neutralDecisionAnswer(question: Question): unknown {
  if (question.type === 'choice') {
    const options = Object.keys(question.criteria);
    return choiceAnswer(question, options.includes('none') ? 'none' : options[0]!, 0.9);
  }
  if (question.type === 'score') return scoreAnswer(question, 0, 0.9);
  return noulAnswer(0.03);
}

/**
 * The answers a plain conversation turn gets from a working decision model: the
 * request is ordinary conversation, a tool step may go ahead, and a finished
 * answer is complete. Every other question takes the neutral answer.
 */
export const conversationDecisionScript: DecisionScript = (name, question) => {
  if (question.type === 'choice' && name === 'route' && 'converse' in question.criteria) return choiceAnswer(question, 'converse', 0.97);
  if (question.type === 'choice' && name === 'disposition' && 'act' in question.criteria) return choiceAnswer(question, 'act', 0.97);
  if (question.type === 'noul' && name === 'completion_required') return noulAnswer(0.99);
  return undefined;
};

/** One decision request as it reached the server. */
export interface ScriptedDecisionRequest {
  readonly model: unknown;
  readonly questions: Readonly<Record<string, Question>>;
  readonly state: unknown;
}

export interface ScriptedDecisionServer {
  /** Give this as the decision endpoint (judgment.endpoint or TYPESAFE_BASE_URL). */
  readonly baseURL: string;
  /** Every request answered, in order. */
  readonly requests: readonly ScriptedDecisionRequest[];
  /** Bodies the server could not read as a decision request; each was answered 400. */
  readonly unreadable: readonly unknown[];
  /** Throws when any request was unreadable. */
  assertNoUnexpected(): void;
  stop(): Promise<void>;
}

function isQuestion(value: unknown): value is Question {
  if (!value || typeof value !== 'object') return false;
  const { type } = value as { type?: unknown };
  if (type === 'noul') return true;
  const { criteria } = value as { criteria?: unknown };
  if (type === 'choice') return !!criteria && typeof criteria === 'object' && !Array.isArray(criteria) && Object.keys(criteria).length > 0;
  return type === 'score' && Array.isArray(criteria) && criteria.length > 0;
}

function readRequest(body: unknown): ScriptedDecisionRequest | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const { model, questions, state } = body as Record<string, unknown>;
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) return undefined;
  const entries = Object.entries(questions);
  if (entries.length === 0 || !entries.every(([, question]) => isQuestion(question))) return undefined;
  return { model, questions: questions as Record<string, Question>, state };
}

/**
 * A decision model on the HTTP wire (`POST /v1/systemone`, `GET /v1/models`) that answers every
 * well-formed request at once from a script, so a program can run with a
 * decision model in use (the `Hybrid` policy) without a real one. A request it
 * cannot read is answered 400 and recorded, and assertNoUnexpected reports it.
 */
export function startScriptedDecisionServer(options: { readonly script?: DecisionScript; readonly model?: string } = {}): ScriptedDecisionServer {
  const script = options.script ?? conversationDecisionScript;
  const model = options.model ?? 'jev-scripted';
  const requests: ScriptedDecisionRequest[] = [];
  const unreadable: unknown[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    // The model list a settings screen or picker reads: the one scripted model.
    if (request.method === 'GET' && path === '/v1/models') return Response.json({ models: [{ name: model, description: 'Scripted decision model', release_date: '' }] });
    if (request.method !== 'POST' || path !== '/v1/systemone') return new Response('not found', { status: 404 });
    let body: unknown;
    try { body = await request.json(); } catch { unreadable.push('(not JSON)'); return new Response('invalid JSON', { status: 400 }); }
    const decision = readRequest(body);
    if (!decision) { unreadable.push(body); return Response.json({ error: { message: 'Not a decision request' } }, { status: 400 }); }
    requests.push(decision);
    const answers = Object.fromEntries(Object.entries(decision.questions)
      .map(([name, question]) => [name, script(name, question, decision.state) ?? neutralDecisionAnswer(question)]));
    return Response.json({ model, answers, usage: { input_tokens: 10, output_tokens: 3 } });
  } });
  return {
    baseURL: `http://127.0.0.1:${server.port}`,
    requests, unreadable,
    assertNoUnexpected() {
      if (unreadable.length) throw new Error(`The scripted decision server could not read ${unreadable.length} request(s): ${JSON.stringify(unreadable).slice(0, 2000)}`);
    },
    stop: () => server.stop(true),
  };
}
