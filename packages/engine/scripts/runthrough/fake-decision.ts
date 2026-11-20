/**
 * A scripted decision model on loopback, speaking the System One wire
 * (POST /v1/systemone { model, state, questions } -> { model, answers, usage };
 * GET /v1/models), so a product runs under Hybrid or Decision Model Only with
 * a working model and no outside service.
 *
 * A decision is known by the names of its questions. Each question is answered
 * by the first rule whose pattern matches its name (or, with `state`, also the
 * request's state); without a rule a yes/no question answers no, a choice the
 * first label and a score the lowest level, all with full confidence. Every
 * request is recorded, so a journey can show which decisions asked and how.
 */
export type DecisionAnswer =
  | { readonly noul: number }
  | { readonly choice: string }
  | { readonly score: number };

export interface DecisionRule {
  /** Matched against the question name. */
  readonly question: RegExp;
  /** When present, also matched against the request's state (as JSON). */
  readonly state?: RegExp;
  readonly answer: DecisionAnswer;
}

export interface DecisionRequest {
  readonly at: number;
  readonly questions: readonly string[];
  readonly state: string;
  readonly answers: Record<string, unknown>;
}

export interface FakeDecision {
  readonly port: number;
  readonly url: string;
  readonly requests: DecisionRequest[];
  /** Rules added later win over earlier ones. */
  answer(rule: DecisionRule): void;
  /** While true every request fails with a 503, as a model that went away. */
  failing: boolean;
  /** Answers every question in a shape no reader accepts: the model answered, but nothing it said can be read. */
  unreadable: boolean;
  stop(): void;
}

type Question = { readonly type?: unknown; readonly criteria?: unknown };

function answerFor(question: Question, chosen: DecisionAnswer | undefined): Record<string, unknown> {
  if (question.type === 'noul') {
    return { type: 'noul', noul: chosen && 'noul' in chosen ? chosen.noul : 0 };
  }
  if (question.type === 'choice') {
    const labels = Object.keys((question.criteria ?? {}) as Record<string, unknown>);
    const choice = chosen && 'choice' in chosen && labels.includes(chosen.choice) ? chosen.choice : labels[0] ?? '';
    return { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(labels.map((label) => [label, label === choice ? 1 : 0])) };
  }
  const levels = Array.isArray(question.criteria) ? question.criteria.length : 2;
  const score = chosen && 'score' in chosen ? Math.max(0, Math.min(levels - 1, Math.round(chosen.score))) : 0;
  return {
    type: 'score', score, confidence: 1,
    legend: Object.fromEntries((question.criteria as unknown[] | undefined ?? []).map((entry, index) => [String(index), entry])),
    probabilities: Object.fromEntries(Array.from({ length: levels }, (_, index) => [String(index), index === score ? 1 : 0])),
  };
}

export function startFakeDecision(model = 'rt-jev'): FakeDecision {
  const rules: DecisionRule[] = [];
  const requests: DecisionRequest[] = [];
  const state = { failing: false, unreadable: false };
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        return Response.json({ data: [{ name: model, description: 'run-through scripted decision model', release_date: '2026-01-01' }] });
      }
      if (request.method !== 'POST' || url.pathname !== '/v1/systemone') return new Response('not found', { status: 404 });
      if (state.failing) return Response.json({ detail: 'scripted outage' }, { status: 503 });
      const body = await request.json() as { model?: string; state?: unknown; questions?: Record<string, Question> };
      const stateText = JSON.stringify(body.state ?? null);
      const answers: Record<string, unknown> = {};
      for (const [name, question] of Object.entries(body.questions ?? {})) {
        if (state.unreadable) { answers[name] = { type: 'unreadable', value: '???' }; continue; }
        const rule = [...rules].reverse().find((candidate) => candidate.question.test(name) && (!candidate.state || candidate.state.test(stateText)));
        answers[name] = answerFor(question, rule?.answer);
      }
      requests.push({ at: Date.now(), questions: Object.keys(body.questions ?? {}), state: stateText.slice(0, 2_000), answers });
      return Response.json({ model: body.model ?? model, answers, usage: { input_tokens: 10, output_tokens: 1 } });
    },
  });
  return {
    port: server.port!,
    url: `http://127.0.0.1:${server.port}`,
    requests,
    answer(rule) { rules.push(rule); },
    get failing() { return state.failing; },
    set failing(value: boolean) { state.failing = value; },
    get unreadable() { return state.unreadable; },
    set unreadable(value: boolean) { state.unreadable = value; },
    stop() { server.stop(true); },
  };
}

/**
 * The readings a working decision model gives for the run-through's own work,
 * so a journey under a decision model sees what a model would say rather than
 * every default: a tool call's effect and risk read from its arguments (a
 * shell write or delete is a mutation, `rm -rf` is destructive and
 * irreversible, a file write is a file mutation), a provider's HTTP 400 is a
 * bad request, a plan's criteria are checkable, a cart line is the item asked
 * for, and a checkout page read again after the card is typed is unchanged.
 */
export function answerAsAModelWould(decision: FakeDecision): void {
  const exec = /"tool":"exec"/;
  const shellWrite = /"tool":"exec".*("cmd":"[^"]*(>|rm |mv |touch |mkdir ))/;
  const destructive = /"tool":"exec".*"cmd":"[^"]*rm -rf/;
  const fileWrite = /"tool":"(write|edit)"/;
  decision.answer({ question: /^effect__kind$/, state: exec, answer: { choice: 'shell' } });
  decision.answer({ question: /^effect__kind$/, state: fileWrite, answer: { choice: 'write' } });
  decision.answer({ question: /^effect__mutates$/, state: shellWrite, answer: { noul: 1 } });
  decision.answer({ question: /^effect__mutates$/, state: fileWrite, answer: { noul: 1 } });
  decision.answer({ question: /^risk__family$/, state: exec, answer: { choice: 'shell-read' } });
  decision.answer({ question: /^risk__family$/, state: shellWrite, answer: { choice: 'shell-mutation' } });
  decision.answer({ question: /^risk__family$/, state: destructive, answer: { choice: 'shell-destructive' } });
  decision.answer({ question: /^risk__family$/, state: fileWrite, answer: { choice: 'file-mutation' } });
  decision.answer({ question: /^risk__irreversible$/, state: destructive, answer: { noul: 1 } });
  decision.answer({ question: /^category$/, state: /HTTP status: 400/, answer: { choice: 'bad_request' } });
  decision.answer({ question: /^checkable$/, answer: { noul: 1 } });
  decision.answer({ question: /^fits_\d+$/, answer: { noul: 1 } });
  decision.answer({ question: /^unchanged$/, answer: { noul: 1 } });
}
