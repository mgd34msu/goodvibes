/**
 * eval-harness-contracts.test.ts
 *
 * Baseline path and shape handling, the gate's report of baseline scenarios
 * the run did not produce, and the task-suite verifier's failure reporting.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserialiseBaseline, loadBaseline } from '../platform/src/platform/runtime/eval/baseline.js';
import { EvalRunner } from '../platform/src/platform/runtime/eval/runner.js';
import { formatGateResult } from '../platform/src/platform/runtime/eval/format.js';
import { runTaskSuite, defaultShellVerifier } from '../platform/src/platform/runtime/eval/task-suite.js';
import type { EvalBaseline, EvalSuiteResult } from '../platform/src/platform/runtime/eval/types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-eval-'));
  roots.push(root);
  return root;
}

describe('baseline loading', () => {
  test('a relative path resolves against the project root, not the process directory', async () => {
    const root = tempRoot();
    const baseline: EvalBaseline = { label: 'l', capturedAt: 1, suites: {} };
    writeFileSync(join(root, 'b.json'), JSON.stringify(baseline));
    expect(await loadBaseline('b.json', root)).toEqual(baseline);
    await expect(loadBaseline('../escape.json', root)).rejects.toThrow('within project directory');
  });

  test('suites must be an object', () => {
    for (const suites of ['null', '[]']) {
      expect(() => deserialiseBaseline(`{"label":"l","capturedAt":1,"suites":${suites}}`)).toThrow('Invalid baseline format');
    }
  });
});

function suiteResult(ids: string[]): EvalSuiteResult {
  return {
    suite: 's',
    startedAt: 0,
    meanScore: 90,
    results: ids.map((id) => ({
      scenario: { id, name: id },
      scorecard: { compositeScore: 90, passed: true },
    })),
  } as unknown as EvalSuiteResult;
}

describe('evaluateGate missing scenarios', () => {
  const baseline: EvalBaseline = { label: 'l', capturedAt: 0, suites: { s: { meanScore: 90, scenarioScores: { kept: 90, gone: 90 } } } };

  test('lists baseline scenarios the fresh run did not produce', () => {
    const gate = new EvalRunner().evaluateGate(suiteResult(['kept']), baseline);
    expect(gate.missingFromRun).toEqual(['gone']);
    expect(formatGateResult(gate)).toContain('gone');
  });

  test('does not claim a regression check when the baseline lacks the whole suite or no baseline exists', () => {
    const other: EvalBaseline = { label: 'l', capturedAt: 0, suites: {} };
    const text = formatGateResult(new EvalRunner().evaluateGate(suiteResult(['kept']), other));
    expect(text).not.toContain('No regressions detected');
    const none = formatGateResult(new EvalRunner().evaluateGate(suiteResult(['kept']), undefined));
    expect(none).not.toContain('saved as the new baseline');
  });
});

function makeSuite(verifyBody: string, timeoutMs?: number): string {
  const root = tempRoot();
  const task = join(root, 'task-a');
  mkdirSync(task);
  writeFileSync(join(task, 'task.json'), JSON.stringify({ instruction: 'do it', ...(timeoutMs !== undefined ? { timeoutMs } : {}) }));
  writeFileSync(join(task, 'verify.sh'), verifyBody);
  const second = join(root, 'task-b');
  mkdirSync(second);
  writeFileSync(join(second, 'task.json'), JSON.stringify({ instruction: 'again' }));
  writeFileSync(join(second, 'verify.sh'), 'exit 0\n');
  return root;
}

describe('task suite verification', () => {
  const executor = async () => ({ completed: true });

  test('a verifier that throws fails its own task and keeps the other results', async () => {
    const suite = makeSuite('exit 0\n');
    const result = await runTaskSuite(suite, {
      executor,
      verifier: async (ctx) => {
        if (ctx.taskId === 'task-a') throw new Error('harness broke');
        return { passed: true, output: '' };
      },
    });
    expect(result.results.map((r) => [r.taskId, r.passed])).toEqual([['task-a', false], ['task-b', true]]);
    expect(result.results[0]!.verifierOutput).toContain('harness broke');
  });

  test('a script cut off by the time limit says so in the output', async () => {
    const suite = makeSuite('sleep 30\n');
    const verdict = await defaultShellVerifier({
      taskId: 'task-a',
      taskDir: join(suite, 'task-a'),
      verifyScript: join(suite, 'task-a', 'verify.sh'),
      timeoutMs: 100,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.output).toContain('was stopped after 100 ms');
  });

  test('a script that exits non-zero keeps its own output and no harness fault note', async () => {
    const suite = makeSuite('echo wrong answer\nexit 1\n');
    const verdict = await defaultShellVerifier({
      taskId: 'task-a',
      taskDir: join(suite, 'task-a'),
      verifyScript: join(suite, 'task-a', 'verify.sh'),
    });
    expect(verdict).toEqual({ passed: false, output: 'wrong answer' });
  });
});
