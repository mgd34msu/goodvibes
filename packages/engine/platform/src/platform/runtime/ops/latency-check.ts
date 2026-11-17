/**
 * A check over one measured latency: the p95 the context's SloCollector has
 * seen against the budget for the same metric in DEFAULT_BUDGETS.
 */
import type { DiagnosticCheckResult } from './types.js';
import type { OpsCheckContext } from './runtime-context.js';
import { DEFAULT_BUDGETS } from '../perf/budgets.js';

export function latencyCheckResult(ctx: OpsCheckContext, metric: string, what: string): DiagnosticCheckResult {
  if (!ctx.latency) {
    return { passed: false, evaluated: false, summary: `${what} is not measured by this app, so this check was not evaluated.`, severity: 'info' };
  }
  const reading = ctx.latency(metric);
  if (!reading) {
    return { passed: false, evaluated: false, summary: `${what} has no measurement yet in this process.`, severity: 'info' };
  }
  const budgetMs = DEFAULT_BUDGETS.find((budget) => budget.metric === metric)?.threshold;
  const slow = budgetMs !== undefined && reading.p95Ms > budgetMs;
  const p95 = Math.round(reading.p95Ms);
  return {
    passed: !slow,
    summary: `${what}: p95 ${p95} ms over the last ${reading.samples} sample(s)${budgetMs === undefined ? '' : slow ? `, above the ${budgetMs} ms budget` : `, within the ${budgetMs} ms budget`}.`,
    severity: slow ? 'warning' : 'info',
    context: { metric, p95Ms: p95, samples: reading.samples, ...(budgetMs === undefined ? {} : { budgetMs }) },
  };
}
