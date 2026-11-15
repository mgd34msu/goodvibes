/**
 * precision_exec-style retry jitter + retryable classification
 *
 * Tests:
 * 1. Timed-out and cancelled runs are never retried, and nothing is read
 * 2. A failure Jev reads as lasting is not retried
 * 3. A failure in a category the caller lists is retried
 * 4. retry.on is honoured: an unlisted category is not retried
 * 5. The retry delay: fixed, capped exponential and full jitter
 * 6. The retry loop: attempts, reported retries, stopping on a lasting failure
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeRetryDelay, createExecTool, isRetryableExecResult } from '../platform/src/platform/tools/exec/runtime.js';
import { ProcessManager } from '../platform/src/platform/tools/shared/process-manager.js';
import { OverflowHandler } from '../platform/src/platform/tools/shared/overflow.js';
import { EXEC_GATE_TABLE } from './_helpers/gate-readings.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

// Jev reads which kind of failure a run hit; these fakes stand in for it.
// Output no entry names reads as a lasting failure.
const readings = useToolReadings([
  ['ECONNRESET', { failure: 'network' }],
  ['ENOTFOUND', { failure: 'network' }],
  ['index.lock', { failure: 'lock' }],
  ['EBUSY', { failure: 'busy' }],
  ['ENOMEM', { failure: 'oom' }],
], EXEC_GATE_TABLE);

function makeResult(overrides: Partial<{
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}>): Parameters<typeof isRetryableExecResult>[0] {
  return {
    cmd: 'test',
    exit_code: overrides.exit_code ?? 1,
    stdout: overrides.stdout ?? '',
    stderr: overrides.stderr ?? '',
    success: overrides.success ?? false,
    timed_out: overrides.timed_out,
  };
}

describe('isRetryableExecResult', () => {
  test('timed_out and cancelled are never retried, and nothing is read', async () => {
    expect(await isRetryableExecResult(makeResult({ timed_out: true, stderr: 'ECONNRESET' }))).toBe(false);
    expect(await isRetryableExecResult({ ...makeResult({ stderr: 'ECONNRESET' }), cancelled: true })).toBe(false);
    expect(readings.requests).toHaveLength(0);
  });

  test('a failure read as lasting is not retried', async () => {
    expect(await isRetryableExecResult(makeResult({ stderr: 'bash: foobar: command not found' }))).toBe(false);
    expect(await isRetryableExecResult(makeResult({ stderr: 'EACCES: permission denied' }), ['network', 'lock', 'busy', 'oom'])).toBe(false);
  });

  test('network, lock and busy failures are retried by default', async () => {
    expect(await isRetryableExecResult(makeResult({ stderr: 'Error: read ECONNRESET' }))).toBe(true);
    expect(await isRetryableExecResult(makeResult({ stderr: 'getaddrinfo ENOTFOUND registry.npmjs.org' }))).toBe(true);
    expect(await isRetryableExecResult(makeResult({ stderr: "fatal: Unable to create '.git/index.lock': File exists." }))).toBe(true);
    expect(await isRetryableExecResult(makeResult({ stderr: 'EBUSY: resource busy or locked' }))).toBe(true);
  });

  test('oom is retried only when the caller lists it', async () => {
    const result = makeResult({ stderr: 'ENOMEM: Cannot allocate memory' });
    expect(await isRetryableExecResult(result)).toBe(false);
    expect(await isRetryableExecResult(result, ['oom'])).toBe(true);
    expect(await isRetryableExecResult(result, ['network'])).toBe(false);
  });

  test('retry.on filter: only network allowed: a busy failure is not retried', async () => {
    expect(await isRetryableExecResult(makeResult({ stderr: 'EBUSY: locked' }), ['network'])).toBe(false);
  });

  test('the reading sees the command, exit code and output ends', async () => {
    await isRetryableExecResult(makeResult({ exit_code: 7, stdout: 'partial', stderr: 'Error: read ECONNRESET' }));
    expect(readings.requests[0]!.state).toEqual({ command: 'test', exitCode: 7, stderr: 'Error: read ECONNRESET', stdout: 'partial' });
  });
});

describe('computeRetryDelay', () => {
  // The random source receives the exclusive upper bound, so recording it shows the cap.
  const upper = (min: number, max: number): number => {
    expect(min).toBe(0);
    return max - 1;
  };

  test('fixed backoff returns the base delay unchanged, whatever the attempt', () => {
    expect(computeRetryDelay(0, 1000, 'fixed')).toBe(1000);
    expect(computeRetryDelay(10, 1000, 'fixed', 30_000)).toBe(1000);
  });

  test('exponential backoff doubles the cap each attempt', () => {
    expect(computeRetryDelay(0, 1000, 'exponential', 30_000, upper)).toBe(1000);
    expect(computeRetryDelay(1, 1000, 'exponential', 30_000, upper)).toBe(2000);
    expect(computeRetryDelay(3, 1000, 'exponential', 30_000, upper)).toBe(8000);
  });

  test('exponential backoff never exceeds max_delay_ms, however many attempts', () => {
    expect(computeRetryDelay(10, 1000, 'exponential', 30_000, upper)).toBe(30_000);
    expect(computeRetryDelay(10, 1000, 'exponential', 5_000, upper)).toBe(5_000);
    // With the real random source the result is still inside the bound.
    for (let i = 0; i < 50; i++) {
      const delay = computeRetryDelay(10, 1000, 'exponential', 30_000);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(30_000);
    }
  });

  test('full jitter spans from zero to the cap', () => {
    expect(computeRetryDelay(2, 1000, 'exponential', 30_000, (min) => min)).toBe(0);
  });
});

describe('exec retry loop', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  // A command that fails `failures` times with `stderr`, then succeeds, counting its runs in a file.
  function flaky(root: string, failures: number, stderr: string): string {
    const counter = join(root, 'runs');
    return `n=$(cat ${counter} 2>/dev/null || echo 0); echo $((n+1)) > ${counter}; if [ "$n" -lt ${failures} ]; then echo ${stderr} >&2; exit 1; fi`;
  }

  async function run(failures: number, stderr: string, retry: Record<string, unknown>) {
    const root = mkdtempSync(join(tmpdir(), 'gv-exec-retry-'));
    roots.push(root);
    const tool = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });
    const result = await tool.execute({
      working_dir: root,
      commands: [{ cmd: flaky(root, failures, stderr), retry: { backoff: 'fixed', delay_ms: 1, ...retry } }],
    });
    const output = JSON.parse(result.output ?? '{}') as { retries?: number };
    return { result, retries: output.retries, runs: Number(readFileSync(join(root, 'runs'), 'utf8').trim()) };
  }

  test('a retryable failure is rerun until it succeeds, and the retries used are reported', async () => {
    const { result, retries, runs } = await run(2, 'ECONNRESET', { max: 5 });
    expect(result.success).toBe(true);
    expect(runs).toBe(3);
    expect(retries).toBe(2);
  });

  test('retries stop at max and the last failure is returned', async () => {
    const { result, retries, runs } = await run(10, 'ECONNRESET', { max: 2 });
    expect(result.success).toBe(false);
    expect(runs).toBe(3);
    expect(retries).toBe(2);
  });

  test('a lasting failure is not retried', async () => {
    const { result, retries, runs } = await run(10, 'permission-denied', { max: 5 });
    expect(result.success).toBe(false);
    expect(runs).toBe(1);
    expect(retries).toBe(0);
  });

  test('a failure category the caller did not list is not retried', async () => {
    const { runs } = await run(10, 'EBUSY', { max: 5, on: ['network'] });
    expect(runs).toBe(1);
  });
});
