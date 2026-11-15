/**
 * Contracts that resume only held (they have no run) are reported, never
 * followed; a failed startup resume is named by every command that needs it.
 */
import { describe, expect, test } from 'bun:test';
import { EXIT_FAILED, EXIT_OK, runContractCli } from '../../platform/src/platform/contract/cli.js';
import { FakeIo, cliHarness } from './cli-support.js';
import { makeContract } from './fixtures.js';

describe('resume with held contracts', () => {
  test('a held running contract is reported on stderr and does not keep resume waiting', async () => {
    const harness = cliHarness({
      report: { resumed: [], queued: [], reaped: [], skipped: ['ctr-00000020'], heldForPolicy: [{ contractId: 'ctr-00000020', reason: 'decision-model-required' }] },
    });
    harness.runner.hold(makeContract({ id: 'ctr-00000020' }));
    const io = new FakeIo(false);
    expect(await runContractCli(['resume'], io, harness.deps)).toBe(EXIT_OK);
    expect(io.stderr).toEqual(['Contract ctr-00000020 was not resumed: it needs a decision model, which is not configured.']);
    expect(io.stdout.join('\n')).toContain('Nothing to resume');
  });

  test('a held terminal failed contract does not make resume exit 1', async () => {
    const harness = cliHarness({ report: { resumed: [], queued: [], reaped: [], skipped: ['ctr-00000021'] } });
    harness.runner.hold(makeContract({ id: 'ctr-00000021', status: 'failed' }));
    expect(await runContractCli(['resume'], new FakeIo(false), harness.deps)).toBe(EXIT_OK);
  });
});

describe('a failed startup resume', () => {
  test('cancel and reply name the resume failure instead of an unknown contract', async () => {
    for (const argv of [['cancel', 'ctr-00000022'], ['reply', 'ctr-00000022', 'go ahead']]) {
      const harness = cliHarness({ report: null });
      const io = new FakeIo(false);
      expect(await runContractCli(argv, io, harness.deps)).toBe(EXIT_FAILED);
      expect(io.stderr).toHaveLength(1);
      expect(io.stderr[0]).toContain('failed; the log under .goodvibes/logs says why');
      expect(io.stderr[0]).not.toContain('No running contract');
    }
  });
});
