/**
 * Evaluation Harness, console formatting helpers.
 *
 * Provides formatSuiteResult() and formatGateResult() for console and
 * panel output. Kept separate from scorecard.ts to avoid circular imports.
 */

import type { EvalSuiteResult, EvalGateResult } from './types.js';

/** Parts of a report are parted by a blank line: a 72-dash rule wrapped into a second line of dashes at 80 columns. */
const HR = '';

/**
 * Format an EvalSuiteResult as a multi-line string for console output.
 */
export function formatSuiteResult(result: EvalSuiteResult): string {
  const lines: string[] = [];
  const durationMs = result.finishedAt - result.startedAt;

  lines.push(HR);
  lines.push(`Suite: ${result.suite}`);
  lines.push(`Run:   ${new Date(result.startedAt).toISOString()}`);
  lines.push(`Time:  ${durationMs}ms  Scenarios: ${result.results.length}`);
  lines.push(`Mean Score: ${result.meanScore.toFixed(1)}/100  ${result.passed ? 'PASSED' : 'FAILED'}`);
  lines.push(HR);

  for (const r of result.results) {
    const sc = r.scorecard;
    const flag = sc.passed ? 'PASS' : 'FAIL';
    lines.push(
      `  [${flag}] ${r.scenario.name.padEnd(44)} ${sc.compositeScore.toFixed(1).padStart(5)}/100`,
    );
  }

  lines.push(HR);
  return lines.join('\n');
}

/**
 * Format an EvalGateResult as a multi-line string.
 */
export function formatGateResult(gate: EvalGateResult): string {
  const lines: string[] = [];

  lines.push(HR);
  lines.push(`The gate for ${gate.suite} ${gate.passed ? 'passed' : 'failed'}.`);
  lines.push(`A task fails it by scoring ${gate.regressionThreshold} points or more below the baseline.`);
  lines.push(
    gate.baseline ? `Baseline: ${gate.baseline.label}, saved ${new Date(gate.baseline.capturedAt).toLocaleString()}.` : 'There was no baseline yet: this is the first run.',
  );
  lines.push(HR);

  if (gate.floorFailures.length > 0) {
    lines.push('Tasks that failed outright (these fail the gate with or without a baseline):');
    for (const f of gate.floorFailures) {
      lines.push(`  ${f.scenarioName}: scored ${f.freshScore.toFixed(1)}`);
      for (const dim of f.failingDimensions) {
        lines.push(`      - ${dim}`);
      }
    }
    lines.push(HR);
  }

  if (gate.regressions.length > 0) {
    lines.push('Tasks that scored lower than the baseline:');
    for (const r of gate.regressions) {
      lines.push(`  ${r.scenarioName}: ${r.freshScore.toFixed(1)} now, ${r.baselineScore.toFixed(1)} in the baseline (${r.delta.toFixed(1)})`);
    }
    lines.push(HR);
  } else if (!gate.baseline) {
    lines.push('There was no baseline to compare against, so no regression check was made.');
    lines.push(HR);
  } else if (gate.baseline.suites[gate.suite] === undefined) {
    lines.push(`The baseline holds no scores for suite "${gate.suite}", so no regression check was made.`);
    lines.push(HR);
  } else if (gate.floorFailures.length === 0) {
    lines.push('No regressions detected.');
    lines.push(HR);
  }

  if (gate.missingFromRun.length > 0) {
    lines.push('Tasks in the baseline that this run did not have (not checked):');
    for (const id of gate.missingFromRun) lines.push(`  ${id}`);
    lines.push(HR);
  }

  if (gate.unbaselined.length > 0) {
    lines.push('Tasks the baseline does not hold (checked against the floor only; gate the suite on the Evaluations tab of the Work place with "Save this run as the baseline" to check them for regressions):');
    for (const u of gate.unbaselined) {
      lines.push(`  ${u.scenarioName}: scored ${u.freshScore.toFixed(1)}, ${u.floorPassed ? 'passed' : 'failed'}`);
    }
    lines.push(HR);
  }

  return lines.join('\n');
}
