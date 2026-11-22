// Proves: A contract whose checks the decision model cannot answer (the request is over the endpoint's limit, or the endpoint fails) does not fail and keeps the unit's work as delivered, recorded as not judged.
// Red when: A decision-model error in a unit or deliverable check escapes to the contract (the check fails the contract), so every unit's finished work is thrown away because a decision could not be made.
/**
 * The contract harness (real AgentManager, store, orchestration engine and
 * runner, a scripted agent in place of the model loop) with the real System One
 * transport and decision log in place of its scripted port. The decision model
 * is a loopback server on the System One wire: it answers every planning
 * question as a clean plan would and refuses every request that carries the
 * unit's report, as the owner's endpoint did (400 max_tokens_exceeded) or as an
 * endpoint that is down does (HTTP 500).
 */
import { describe, expect, test } from 'bun:test';
import { createSystemOnePort, readSharedContext, SqliteDecisionLog, withDecisionLog } from '@goodvibes/judgment';
import { choiceAnswer } from '@goodvibes/judgment/testing';
import { installJudgmentPort } from '@goodvibes/engine/errors';
import { makeHarness, runnerPort, startContract, type Harness } from './contract/runner-support.ts';
import type { DraftPlan } from './contract/plan-support.ts';

const MARKER = 'AUDIT-REPORT-5e1d';
const REPORT = `${MARKER}\nScheduler audit, read only: no file was changed.\n## race conditions\n- src/scheduler.ts:12 two timers write the queue without a lock.\n## silent failures\n- src/scheduler.ts:40 a rejected job is dropped without a log line.`;
const PLAN: DraftPlan = {
  goal: 'An audit report of the scheduler',
  criteria: [
    { id: 'c1', text: 'The report identifies race conditions in the scheduler', quote: 'race conditions' },
    { id: 'c2', text: 'The report identifies silent failures in the scheduler', quote: 'silent failures' },
  ],
  groups: [{
    id: 'g1', title: 'Audit', goal: 'Read the scheduler and report findings', kind: 'work', dependsOn: [], criteria: [],
    units: [{
      id: 'u1', title: 'Scheduler audit', goal: 'Read src/scheduler.ts and report every finding', role: 'research',
      brief: 'Read src/scheduler.ts and report race conditions and silent failures. Change nothing.', dependsOn: [], files: ['src/scheduler.ts'], attempts: undefined,
      criteria: [{ id: 'u1.c1', text: 'The report names race conditions', serves: ['c1'] }, { id: 'u1.c2', text: 'The report names silent failures', serves: ['c2'] }],
    }],
  }],
};

const answerer = runnerPort((context) => context.name === 'role' && context.question.type === 'choice' && 'research' in context.question.criteria
  ? choiceAnswer(context.question, 'research', 0.97) : undefined);

describe('a check the decision model cannot answer keeps the work', () => {
  test('a unit whose checks are refused for size or fail at the endpoint is kept as delivered, not judged, and the contract does not fail', async () => {
    for (const refusal of ['too-large', 'endpoint-500'] as const) {
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        const text = await request.text();
        if (text.includes(MARKER)) {
          return refusal === 'too-large'
            ? Response.json({ detail: { error_type: 'max_tokens_exceeded', message: 'The request exceeds the token limit.' } }, { status: 400 })
            : Response.json({ error: 'internal' }, { status: 500 });
        }
        const body = JSON.parse(text) as { model: string; state: unknown; questions: Record<string, unknown> };
        const { state, questions } = readSharedContext(body.state as never, body.questions as never);
        const answered = await answerer.port.ask({ state, questions } as never);
        return Response.json({ model: body.model, answers: answered.answers, usage: { input_tokens: 1, output_tokens: 1 } });
      } });
      const owner = new AbortController();
      const log = new SqliteDecisionLog(':memory:');
      const harness: Harness = makeHarness({ plan: PLAN, scripts: { u1: () => [{ text: REPORT }] } });
      try {
        const port = createSystemOnePort({ signal: owner.signal, endpoint: { kind: 'local', baseURL: `http://127.0.0.1:${server.port}`, apiKey: '', authentication: 'none' },
          model: 'jev-latest', timeoutMs: 30_000, retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 } });
        // Installed over the harness's scripted port; the harness's dispose puts back what was there before it.
        installJudgmentPort(withDecisionLog(port, log));
        const ended = new Promise<string>((resolve) => harness.runner.on((event) => {
          if (event.type === 'CONTRACT_ESCALATED' || event.type === 'CONTRACT_PASSED' || event.type === 'CONTRACT_FAILED') resolve(event.type);
        }));
        const started = await startContract(harness, { ask: 'Audit the scheduler for race conditions and silent failures, and report every finding.' });
        const how = await ended;
        const contract = harness.runner.get(started.contract.id)!;
        const unit = contract.units.find((candidate) => candidate.id === 'u1')!;
        // The deliverable could not be judged either: it goes to the owner's acceptance question with the work kept.
        expect({ refusal, how, status: contract.status, unit: unit.status }).toEqual({ refusal, how: 'CONTRACT_ESCALATED', status: 'awaiting-owner', unit: 'passed' });
        expect(unit.answer).toContain(MARKER);
        expect(unit.checks.at(-1)?.notJudged).toBeString();
      } finally {
        await harness.dispose();
        owner.abort();
        log[Symbol.dispose]();
        server.stop(true);
      }
    }
  });
});
