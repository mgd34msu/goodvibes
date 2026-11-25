/**
 * Evaluation Harness, Baseline persistence.
 *
 * Provides load/save/capture utilities for EvalBaseline records.
 * Baselines are stored as JSON files on disk and loaded by the CI gate.
 *
 * File format: a single JSON object matching the EvalBaseline type.
 */

import type { EvalBaseline, EvalSuiteResult, BaselineSuiteSummary } from './types.js';
import { isAbsolute, relative, resolve } from 'node:path';

function resolveBaselinePath(filePath: string, projectRoot: string): string {
  // A relative path is relative to the project root, not to wherever the process was started.
  const resolved = resolve(projectRoot, filePath);
  const fromRoot = relative(resolve(projectRoot), resolved);
  // Inside the root when the relative path neither climbs out nor switches drive.
  if (fromRoot === '..' || fromRoot.startsWith('../') || fromRoot.startsWith('..\\') || isAbsolute(fromRoot)) {
    throw new Error('Baseline path must be within project directory');
  }
  return resolved;
}

// ── Serialisation ─────────────────────────────────────────────────────────────

/**
 * Capture a baseline snapshot from a set of suite results.
 *
 * @param label - Human-readable label (e.g. 'main', 'v0.12.0').
 * @param suiteResults - One or more suite results to capture.
 * @returns A new EvalBaseline.
 */
export function captureBaseline(
  label: string,
  suiteResults: EvalSuiteResult[],
): EvalBaseline {
  const suites: Record<string, BaselineSuiteSummary> = {};

  for (const result of suiteResults) {
    const scenarioScores: Record<string, number> = {};
    for (const r of result.results) {
      scenarioScores[r.scenario.id] = r.scorecard.compositeScore;
    }
    suites[result.suite] = {
      meanScore: result.meanScore,
      scenarioScores,
    };
  }

  return {
    label,
    capturedAt: Date.now(),
    suites,
  };
}

/**
 * Serialise a baseline to a JSON string.
 */
export function serialiseBaseline(baseline: EvalBaseline): string {
  return JSON.stringify(baseline, null, 2);
}

/**
 * Deserialise a baseline from a JSON string.
 * Throws if the payload is not a valid EvalBaseline shape.
 */
export function deserialiseBaseline(json: string): EvalBaseline {
  const parsed = JSON.parse(json) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).label !== 'string' ||
    typeof (parsed as Record<string, unknown>).capturedAt !== 'number' ||
    typeof (parsed as Record<string, unknown>).suites !== 'object' ||
    (parsed as Record<string, unknown>).suites === null ||
    Array.isArray((parsed as Record<string, unknown>).suites)
  ) {
    throw new Error('Invalid baseline format: missing required fields (label, capturedAt, suites).');
  }
  return parsed as EvalBaseline;
}

// ── File I/O (Bun-compatible) ─────────────────────────────────────────────────

/**
 * Write a baseline to a file path.
 * Uses Bun.write for efficient file I/O.
 */
export async function writeBaseline(filePath: string, baseline: EvalBaseline, projectRoot: string): Promise<void> {
  const resolved = resolveBaselinePath(filePath, projectRoot);
  const json = serialiseBaseline(baseline);
  await Bun.write(resolved, json);
}

/**
 * Load a baseline from a file path.
 * Returns undefined if the file does not exist.
 */
export async function loadBaseline(filePath: string, projectRoot: string): Promise<EvalBaseline | undefined> {
  const file = Bun.file(resolveBaselinePath(filePath, projectRoot));
  const exists = await file.exists();
  if (!exists) return undefined;
  const json = await file.text();
  return deserialiseBaseline(json);
}

// ── Comparison helpers ────────────────────────────────────────────────────────

/**
 * Format a comparison summary between a baseline and a fresh suite result.
 */
export function formatBaselineComparison(
  baseline: EvalBaseline,
  fresh: EvalSuiteResult,
): string {
  const lines: string[] = [];
  // A blank line parts the report (a dash rule wrapped at 80 columns).
  const hr = '';

  const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;

  lines.push(hr);
  lines.push(`The run of ${fresh.suite} at ${new Date(fresh.startedAt).toLocaleString()}, against the baseline ${baseline.label} saved ${new Date(baseline.capturedAt).toLocaleString()}:`);
  lines.push(hr);

  const baselineSuite = baseline.suites[fresh.suite];
  if (!baselineSuite) {
    lines.push(`The baseline holds no scores for suite "${fresh.suite}".`);
    lines.push(hr);
    return lines.join('\n');
  }

  for (const result of fresh.results) {
    const baseScore = baselineSuite.scenarioScores[result.scenario.id];
    const score = result.scorecard.compositeScore;
    lines.push(baseScore !== undefined
      ? `  ${result.scenario.name}: ${score.toFixed(1)} now, ${baseScore.toFixed(1)} in the baseline (${signed(score - baseScore)})`
      : `  ${result.scenario.name}: ${score.toFixed(1)} now, not in the baseline`);
  }

  lines.push(hr);
  lines.push(`On average ${fresh.meanScore.toFixed(1)} now, ${baselineSuite.meanScore.toFixed(1)} in the baseline (${signed(fresh.meanScore - baselineSuite.meanScore)}).`);
  lines.push(hr);

  return lines.join('\n');
}
