import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { installJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import { makeHarness, makeRepo, oneUnitPlan, startContract, waitFor } from './runner-support.ts';

test('an internal verifier fault terminates the original contract rather than scheduling another provider read', async () => {
  const h = makeHarness({ root: makeRepo(), plan: oneUnitPlan(1), scripts: {
    u1: () => [{ files: { 'src/csv.ts': 'export const parse = 1;\n' }, text: 'The parser is written.' }],
  } });
  const base = judgmentPort('test.internal-client-fault');
  let checks = 0;
  const previous = installJudgmentPort({ ...base, async ask(request) {
    if (request.context?.battery === 'contract.unit-judge') {
      checks++; throw new JudgmentError('internal', 'Private original verifier fault');
    }
    return base.ask(request);
  } });
  try {
    const { contract } = await startContract(h);
    await waitFor(() => h.store.get(contract.id)?.status === 'failed', 'the terminal internal client fault');
    await h.runner.join(contract.id);
    const actual = h.store.get(contract.id)!;
    expect(actual.failureKind).toBe('other'); expect(checks).toBe(1);
    expect(actual.error).toContain('The decision client failed internally.');
    expect(actual.error).not.toContain('Jev could not answer');
    expect(actual.error).not.toContain('Private original verifier fault');
    expect(JSON.stringify(actual.decisions)).not.toContain('retry in 30 seconds');
  } finally {
    h.runner.dispose();
    await Promise.all(h.runner.list({ includeTerminal: true }).map(contract => h.runner.join(contract.id)));
    installJudgmentPort(previous); h.dispose(); rmSync(h.root, { recursive: true, force: true });
  }
});
