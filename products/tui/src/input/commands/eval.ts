/**
 * /eval command handler.
 *
 * Implements the Evaluation Harness commands:
 *
 *   /eval list                   , List all available eval suites
 *   /eval run <suite>            , Run a named suite (or 'all')
 *   /eval compare <baseline-file>, Compare last run against a baseline file
 *   /eval gate <suite>           , Run suite and apply CI gate (exits 1 on regression)
 */

import type { SlashCommand, CommandContext } from '../command-registry.ts';
import { EvalRunner } from '@/runtime/index.ts';
import { BUILTIN_SUITES } from '@/runtime/index.ts';
import { formatScorecard } from '@/runtime/index.ts';
import { loadBaseline, captureBaseline, formatBaselineComparison, writeBaseline } from '@/runtime/index.ts';
import type { EvalRegistry } from '@goodvibes-jev/engine/platform/platform/observe';
import { formatSuiteResult, formatGateResult } from '@/runtime/index.ts';
import { requireShellPaths } from '@goodvibes-jev/engine/terminal-shell/command-service-access';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';

// ── Subcommand helpers ────────────────────────────────────────────────────────

function printSuiteList(context: CommandContext): void {
  const lines = ['[eval] Available suites:'];
  for (const [name, scenarios] of Object.entries(BUILTIN_SUITES)) {
    lines.push(`  ${name}  (${scenarios.length} scenarios)`);
    for (const s of scenarios) {
      lines.push(`    - ${s.id}: ${s.name}`);
    }
  }
  lines.push('[eval] Usage: /eval run <suite>  or  /eval run all');
  context.print(lines.join('\n'));
}

function getRegistry(context: CommandContext): EvalRegistry | undefined {
  return context.extensions.evalRegistry;
}

/** Runs in flight per registry: the registry's running flag is one boolean, so it is cleared when the last one ends. */
const activeRuns = new WeakMap<EvalRegistry, number>();

/** Runs `work` with the registry marked running until every concurrent run has finished. */
async function withEvalRunning<T>(registry: EvalRegistry | undefined, work: () => Promise<T>): Promise<T> {
  if (!registry) return work();
  activeRuns.set(registry, (activeRuns.get(registry) ?? 0) + 1);
  registry.setRunning(true);
  try {
    return await work();
  } finally {
    const left = (activeRuns.get(registry) ?? 1) - 1;
    activeRuns.set(registry, left);
    if (left === 0) registry.setRunning(false);
  }
}

// ── /eval list ────────────────────────────────────────────────────────────────

function handleList(_args: string[], context: CommandContext): void {
  printSuiteList(context);
}

// ── /eval run ────────────────────────────────────────────────────────────────

async function handleRun(args: string[], context: CommandContext): Promise<void> {
  const suiteName = args[0] ?? 'all';
  const registry = getRegistry(context);

  const suitesToRun =
    suiteName === 'all'
      ? Object.keys(BUILTIN_SUITES)
      : BUILTIN_SUITES[suiteName]
        ? [suiteName]
        : null;

  if (!suitesToRun) {
    context.print(`[eval] Unknown suite: "${suiteName}". Run /eval list to see available suites.`);
    return;
  }

  const runner = new EvalRunner();
  context.print(`[eval] Running ${suitesToRun.length === 1 ? `suite ${suitesToRun[0]}` : `${suitesToRun.length} suites: ${suitesToRun.join(', ')}`}...`);
  // Each suite's report (summary and every scorecard) is printed as one block.
  await withEvalRunning(registry, async () => {
    for (const name of suitesToRun) {
      const scenarios = BUILTIN_SUITES[name];
      if (!scenarios) continue;
      const result = await runner.runSuite(name, scenarios);
      registry?.push(result);
      context.print([formatSuiteResult(result), ...result.results.map((r) => formatScorecard(r.scorecard))].join('\n'));
    }
  });
}

// ── /eval compare ─────────────────────────────────────────────────────────────

async function handleCompare(args: string[], context: CommandContext): Promise<void> {
  const baselineFile = args[0] ?? '.goodvibes/eval/baseline.json';
  const registry = getRegistry(context);
  const projectRoot = requireShellPaths(context).workingDirectory;
  const suiteResults = registry?.getSuiteResults() ?? [];

  if (suiteResults.length === 0) {
    context.print('[eval] No suite results to compare. Run /eval run <suite> first.');
    return;
  }

  const baseline = await loadBaseline(baselineFile, projectRoot);
  if (!baseline) {
    context.print(`[eval] Baseline file not found: ${baselineFile}\n[eval] Tip: run /eval gate <suite> to create a baseline.`);
    return;
  }

  context.print(suiteResults.map((result) => formatBaselineComparison(baseline, result)).join('\n'));
}

// ── /eval gate ────────────────────────────────────────────────────────────────

async function handleGate(args: string[], context: CommandContext): Promise<void> {
  const positionals = args.filter(a => !a.startsWith('--'));
  const suiteName = positionals[0];
  const baselineFile = positionals[1] ?? '.goodvibes/eval/baseline.json';
  const saveFlag = args.includes('--save-baseline');
  const projectRoot = requireShellPaths(context).workingDirectory;

  if (!suiteName) {
    context.print('[eval] Usage: /eval gate <suite> [baseline-file] [--save-baseline]');
    return;
  }

  const scenarios = BUILTIN_SUITES[suiteName];
  if (!scenarios) {
    context.print(`[eval] Unknown suite: "${suiteName}". Run /eval list to see available suites.`);
    return;
  }

  const registry = getRegistry(context);
  const runner = new EvalRunner();

  context.print(`[eval] Gate: running suite "${suiteName}"...`);
  const fresh = await withEvalRunning(registry, async () => {
    const result = await runner.runSuite(suiteName, scenarios);
    registry?.push(result);
    return result;
  });

  const baseline = await loadBaseline(baselineFile, projectRoot);
  const gate = runner.evaluateGate(fresh, baseline);
  registry?.pushGate(gate);

  const report = [formatGateResult(gate)];

  if (saveFlag || !baseline) {
    const label = positionals[0] ?? 'latest';
    const newBaseline = captureBaseline(label, [fresh]);
    try {
      await writeBaseline(baselineFile, newBaseline, projectRoot);
      report.push(`[eval] Baseline saved to ${baselineFile}`);
    } catch (err) {
      report.push(`[eval] Warning: could not save baseline: ${summarizeError(err)}`);
    }
  }

  report.push(gate.passed ? '[eval] Gate PASSED.' : `[eval] Gate FAILED: ${gate.regressions.length} regression(s) detected.`);
  context.print(report.join('\n'));
}

// ── Top-level command ─────────────────────────────────────────────────────────

export const evalCommand: SlashCommand = {
  name: 'eval',
  description: 'Evaluation harness: run benchmark suites, compare baselines, and gate regressions',
  usage: '<subcommand> [args]',
  argsHint: 'list|run <suite>|compare <baseline>|gate <suite>',
  handler: async (args: string[], context: CommandContext): Promise<void> => {
    const [sub, ...rest] = args;

    switch (sub) {
      case 'list':
      case 'ls':
        handleList(rest, context);
        break;

      case 'run':
        await handleRun(rest, context);
        break;

      case 'compare':
      case 'cmp':
        await handleCompare(rest, context);
        break;

      case 'gate':
        await handleGate(rest, context);
        break;

      default: {
        const usage = [
          'Usage: /eval <subcommand>',
          '  list                           — List all available eval suites',
          '  run <suite|all>                — Run a named suite (or all suites)',
          '  compare [baseline-file]        — Compare last results against baseline',
          '  gate <suite> [baseline-file]   — Run suite and apply regression gate',
          '    --save-baseline              — Save fresh run as new baseline',
        ].join('\n');
        context.print(usage);
        break;
      }
    }
  },
};
