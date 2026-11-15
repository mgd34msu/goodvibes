/**
 * The eval gate's regression threshold: a drop exactly at the threshold passes,
 * a drop past it fails, and a configured threshold replaces the default of 5.
 */

import { describe, expect, test } from 'bun:test';
import { EvalRunner } from '../platform/src/platform/runtime/eval/runner.js';
import type { EvalBaseline, EvalSuiteResult } from '../platform/src/platform/runtime/eval/types.js';

const BASELINE: EvalBaseline = { label: 'main', capturedAt: 0, suites: { s: { meanScore: 90, scenarioScores: { only: 90 } } } };

function freshAt(score: number): EvalSuiteResult {
  return {
    suite: 's',
    startedAt: 0,
    finishedAt: 0,
    meanScore: score,
    passed: true,
    results: [{
      scenario: { id: 'only', name: 'only', suite: 's', description: '', tags: [], run: async () => ({ completed: true, durationMs: 0 }) },
      raw: { completed: true, durationMs: 0 },
      scorecard: { scenarioId: 'only', scenarioName: 'only', dimensions: [], compositeScore: score, passed: true },
      startedAt: 0,
      finishedAt: 0,
    }],
  };
}

describe('EvalRunner.evaluateGate regression threshold', () => {
  test('the default threshold of 5 passes a 5-point drop and fails a larger one', () => {
    const runner = new EvalRunner();
    const atThreshold = runner.evaluateGate(freshAt(85), BASELINE);
    expect(atThreshold.regressionThreshold).toBe(5);
    expect(atThreshold.regressions).toEqual([]);
    expect(atThreshold.passed).toBe(true);

    const past = runner.evaluateGate(freshAt(84.5), BASELINE);
    expect(past.passed).toBe(false);
    expect(past.regressions.map((entry) => entry.scenarioId)).toEqual(['only']);
    expect(past.regressions[0]?.delta).toBeCloseTo(-5.5);
  });

  test('a configured threshold replaces the default in both directions', () => {
    const strict = new EvalRunner({ regressionThreshold: 0.1 }).evaluateGate(freshAt(89), BASELINE);
    expect(strict.regressionThreshold).toBe(0.1);
    expect(strict.passed).toBe(false);

    const lenient = new EvalRunner({ regressionThreshold: 10 }).evaluateGate(freshAt(81), BASELINE);
    expect(lenient.regressionThreshold).toBe(10);
    expect(lenient.passed).toBe(true);
  });
});
