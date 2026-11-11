import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JudgmentContextLimitError, JudgmentError } from '@goodvibes-jev/judgment';
import { makeHarness, oneUnitPlan, startContract, waitFor, type Harness } from './runner-support.js';
import { contractOf, finishes, judgeOf, terminal } from './steps-support.js';

let harness: Harness | undefined;
afterEach(() => { harness?.dispose(); harness = undefined; });

const exhaustedFailures = [
  { name: 'context limit', reason: 'The judgment request exceeds the endpoint token limit.', error: () => new JudgmentContextLimitError() },
  { name: 'invalid request', reason: 'the judgment request was invalid', error: () => new JudgmentError('invalid-request', 'The complete input exceeds the deployment capability.') },
  { name: 'rejected request', reason: 'the judgment request was rejected (HTTP 400)', error: () => new JudgmentError('rejected', 'The endpoint rejected the request.', { status: 400 }) },
  ...[429, 503].map(status => ({ name: `exhausted HTTP ${status} fallback chain`, reason: 'No decision models are currently available. Check API keys, endpoint addresses, model names and local model services, then retry. The operation has stopped.',
    error: () => new JudgmentError('unavailable', 'All configured targets failed.', { status }) })),
];

for (const stage of ['unit', 'group', 'deliverable', 'final-answer'] as const) {
  test.each(exhaustedFailures)(`${stage} verification stops on $name and retains the candidate without scheduled retries`, async ({ error, reason }) => {
    const plan = oneUnitPlan(1);
    plan.groups[0]!.criteria = [{ id: 'g1.c1', text: 'The parser is coherent', serves: ['c1'] }];
    const output = 'The retained parser candidate.';
    let requests = 0, workers = 0;
    const h = harness = makeHarness({ plan,
      scripts: { u1: (record, runtime) => { workers++; return finishes(output)(record, runtime); } },
      port: context => {
        const target = stage === 'final-answer' ? context.name === 'unfinished'
          : context.name === 'goal' && judgeOf(context) === stage;
        if (target) { requests++; throw error(); }
        return undefined;
      },
    });
    const { contract, owner } = await startContract(h);
    await waitFor(() => terminal(h, contract.id), 'terminal verification failure');
    await h.runner.join(contract.id);
    const failed = contractOf(h, contract.id);
    expect(failed.status).toBe('failed');
    expect(failed.failureKind).toBe('judgment-unavailable');
    expect(failed.error).toContain(reason);
    expect(failed.answer).toBeUndefined();
    expect(failed.commit).toBeUndefined();
    expect(failed.units[0]!.lastOutput).toBe(output);
    expect(readFileSync(join(h.root, 'src/csv.ts'), 'utf8')).toBe(`${output}\n`);
    expect(failed.units[0]!.status).toBe(stage === 'unit' ? 'cancelled' : 'passed');
    expect(failed.units[0]!.checks).toHaveLength(stage === 'unit' ? 0 : 1);
    expect(failed.decisions.some(decision => decision.reason.startsWith('verification pending:'))).toBe(false);
    expect(h.manager.getStatus(owner.id)?.status).toBe('failed');
    expect(workers).toBe(1);
    // Deliverable/content review already has a separate, complete per-question
    // reading for a context refusal. If that also fails, it must stop too.
    expect(requests).toBe((stage === 'final-answer' || stage === 'deliverable') && error() instanceof JudgmentContextLimitError ? 2 : 1);
    expect(h.events.filter(event => event.type === 'CONTRACT_FAILED')).toHaveLength(1);
  });
}
