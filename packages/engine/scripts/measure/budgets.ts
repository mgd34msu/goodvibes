/**
 * Speed budgets: what a measured run may cost, per scenario, against the
 * figures recorded in budgets.json. Only counts and bytes fail the check, so a
 * busy machine or a slow CI runner never fails it and a real regression
 * always does.
 *
 * - Decision-model requests, conversation-model requests, file reads, file
 *   writes, fsyncs and SQL statements: at or below the recorded figure.
 * - Bytes written: at most 10% above the recorded figure.
 * - Measures a scenario names in `budgeted` (and `budgetedBytes`): the same
 *   two rules.
 * - A scenario that failed, a scenario without a budget, or a budget for a
 *   scenario that no longer exists, is a violation.
 *
 * Times are printed, never judged (timingInformation): the time
 * turn-8-slow-reads' slow reads add to the turn (its wall time minus
 * turn-8-reads', in this run) over its slowest read, and each start-up's
 * multiple of startup-bun-floor beside the recorded multiple.
 */
import type { ScenarioReport } from './harness.ts';
import type { StartupReport } from './startup.ts';

/** Counts that must not grow. */
export const COUNT_MEASURES = ['decisionRequests', 'providerRequests', 'fileReads', 'fileWrites', 'fsyncs', 'sqliteStatements'] as const;
/** Byte totals that may grow by BYTES_TOLERANCE at most. */
export const BYTE_MEASURES = ['bytesWritten'] as const;
export const BYTES_TOLERANCE = 0.1;
/** The reference start-up: bun and the harness preload, no product code. */
export const STARTUP_FLOOR = 'startup-bun-floor';
/** Wall-time ratios inside one run, printed as information: (scenario's wall time - `minus` scenario's) / the scenario's `per` measure, beside what it was expected to be near. */
export const WALL_RATIOS: ReadonlyArray<{ readonly scenario: string; readonly minus: string; readonly per: string; readonly expected: string }> = [
  { scenario: 'turn-8-slow-reads', minus: 'turn-8-reads', per: 'slowestReadMs', expected: 'about 1 when the reads run side by side, about 5.5 one after another' },
];

export interface ScenarioBudget {
  /** Recorded counts: the run may be at or below each. */
  readonly counts: Readonly<Record<string, number>>;
  /** Recorded byte totals: the run may be at most 10% above each. */
  readonly bytes: Readonly<Record<string, number>>;
}

export interface StartupBudget {
  /** The scenario's median wall time over the floor's, in the recorded run, printed beside this run's as information; absent for the floor itself. */
  readonly multipleOfFloor?: number;
}

export interface BudgetsFile {
  readonly about: string;
  readonly recorded: { readonly commit: string; readonly measuredAt: string; readonly bun: string };
  readonly scenarios: Readonly<Record<string, ScenarioBudget>>;
  readonly startup: Readonly<Record<string, StartupBudget>>;
}

/** What run.ts produced: in-process scenario reports (or their failures) and start-up timings. */
export interface MeasuredRun {
  readonly commit: string;
  readonly measuredAt: string;
  readonly bun: string;
  readonly scenarios: ReadonlyArray<ScenarioReport | { readonly name: string; readonly error: string }>;
  readonly startup: readonly StartupReport[];
}

/** Scenario-declared extra measures, by scenario name (from the scenario definitions). */
export interface ExtraMeasures {
  readonly counts: readonly string[];
  readonly bytes: readonly string[];
}

export interface Violation {
  readonly scenario: string;
  readonly measure: string;
  readonly recorded: string;
  readonly now: string;
}

const ABOUT = 'Speed budgets checked by `bun run measure:check` (packages/engine/scripts/measure/run.ts --check). '
  + 'Counts may not grow; bytes written may grow 10%; times are printed as information and never fail the check. '
  + 'To change a budget on purpose, run `bun run measure -- --write-budgets packages/engine/scripts/measure/budgets.json` '
  + '(add --only <names> to rewrite only those scenarios) and commit the diff with the reason.';

function measured(report: ScenarioReport | { readonly name: string; readonly error: string }): report is ScenarioReport {
  return 'median' in report;
}

const fmt = (value: number): string => Number.isInteger(value) ? String(value) : value.toFixed(2);

/** The floor a start-up is divided by: the one timed beside its samples, else the floor scenario of the same run. */
function floorOf(run: MeasuredRun, report: StartupReport): number | undefined {
  if (report.floorMs !== undefined && report.floorMs > 0) return report.floorMs;
  const floor = run.startup.find((candidate) => candidate.name === STARTUP_FLOOR);
  return floor && floor.error === undefined && floor.wallMs.median > 0 ? floor.wallMs.median : undefined;
}

/** A budgets file from a run. Entries for scenarios the run did not include are kept from `previous`. */
export function budgetsFromRun(run: MeasuredRun, extras: ReadonlyMap<string, ExtraMeasures>, previous?: BudgetsFile): BudgetsFile {
  const failed = run.scenarios.filter((report) => !measured(report)).map((report) => report.name)
    .concat(run.startup.filter((report) => report.error !== undefined).map((report) => report.name));
  if (failed.length > 0) throw new Error(`budgets are written only from a run where every scenario succeeded; failed: ${failed.join(', ')}`);
  const scenarios: Record<string, ScenarioBudget> = { ...previous?.scenarios };
  for (const report of run.scenarios) {
    if (!measured(report)) continue;
    const extra = extras.get(report.name) ?? { counts: [], bytes: [] };
    const pick = (names: readonly string[]): Record<string, number> => Object.fromEntries(names.map((name) => [name, report.median[name] ?? 0]));
    scenarios[report.name] = { counts: pick([...COUNT_MEASURES, ...extra.counts]), bytes: pick([...BYTE_MEASURES, ...extra.bytes]) };
  }
  const startup: Record<string, StartupBudget> = { ...previous?.startup };
  for (const report of run.startup) {
    if (report.name === STARTUP_FLOOR) { startup[report.name] = {}; continue; }
    const floorMs = floorOf(run, report);
    if (floorMs === undefined) throw new Error(`start-up budgets need ${STARTUP_FLOOR} timed in the same run`);
    startup[report.name] = { multipleOfFloor: Math.round((report.wallMs.median / floorMs) * 100) / 100 };
  }
  const sorted = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]!]));
  return {
    about: ABOUT,
    recorded: { commit: run.commit, measuredAt: run.measuredAt, bun: run.bun },
    scenarios: sorted(scenarios),
    startup: sorted(startup),
  };
}

/**
 * Every budget the run breaks. `known` is every scenario the harness defines;
 * only scenarios in the run are compared, and a budget for a name the harness
 * no longer defines is reported whatever the run included.
 */
export function checkBudgets(run: MeasuredRun, budgets: BudgetsFile, known: ReadonlySet<string>): Violation[] {
  const violations: Violation[] = [];
  const add = (scenario: string, measure: string, recorded: string, now: string): void => { violations.push({ scenario, measure, recorded, now }); };
  for (const name of [...Object.keys(budgets.scenarios), ...Object.keys(budgets.startup)]) {
    if (!known.has(name)) add(name, 'scenario', 'budgeted', 'no such scenario');
  }
  for (const report of run.scenarios) {
    if (!measured(report)) { add(report.name, 'outcome', 'succeeded', `failed: ${report.error.split('\n')[0]}`); continue; }
    const budget = budgets.scenarios[report.name];
    if (!budget) { add(report.name, 'budget', 'none', 'scenario has no budget'); continue; }
    for (const [measure, recorded] of Object.entries(budget.counts)) {
      const now = report.median[measure];
      if (now === undefined) add(report.name, measure, fmt(recorded), 'not reported');
      else if (now > recorded) add(report.name, measure, fmt(recorded), fmt(now));
    }
    for (const [measure, recorded] of Object.entries(budget.bytes)) {
      const now = report.median[measure];
      if (now === undefined) add(report.name, measure, fmt(recorded), 'not reported');
      else if (now > recorded * (1 + BYTES_TOLERANCE)) add(report.name, measure, `${fmt(recorded)} (+10% allowed)`, fmt(now));
    }
  }
  for (const report of run.startup) {
    if (report.error !== undefined) { add(report.name, 'outcome', 'succeeded', `failed: ${report.error.split('\n')[0]}`); continue; }
    const budget = budgets.startup[report.name];
    if (!budget) { add(report.name, 'budget', 'none', 'scenario has no budget'); continue; }
  }
  return violations;
}

/**
 * The timings of this run as lines of information, never violations: each
 * wall-time ratio, and each start-up's multiple of the floor beside the
 * recorded multiple. Machine load moves these; they never fail the check.
 */
export function timingInformation(run: MeasuredRun, budgets: BudgetsFile | null): string[] {
  const lines: string[] = [];
  for (const ratio of WALL_RATIOS) {
    const report = run.scenarios.find((candidate) => candidate.name === ratio.scenario);
    const base = run.scenarios.find((candidate) => candidate.name === ratio.minus);
    if (!report || !measured(report) || !base || !measured(base)) continue;
    const per = report.median[ratio.per];
    if (per === undefined || per <= 0) continue;
    lines.push(`${ratio.scenario}: (wall - ${ratio.minus} wall) / ${ratio.per} = ${fmt((report.wallMs.median - base.wallMs.median) / per)} (${ratio.expected})`);
  }
  for (const report of run.startup) {
    if (report.error !== undefined || report.name === STARTUP_FLOOR) continue;
    const floorMs = floorOf(run, report);
    if (floorMs === undefined) continue;
    const recorded = budgets?.startup[report.name]?.multipleOfFloor;
    lines.push(`${report.name}: ${fmt(report.wallMs.median / floorMs)} times ${STARTUP_FLOOR}${recorded === undefined ? '' : ` (recorded ${fmt(recorded)})`}`);
  }
  return lines;
}

/** The violations as aligned lines: scenario, measure, recorded, now. */
export function formatViolations(violations: readonly Violation[]): string {
  const rows = [['scenario', 'measure', 'recorded', 'now'], ...violations.map((v) => [v.scenario, v.measure, v.recorded, v.now])];
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((row) => row[i]!.length)));
  return rows.map((row) => row.map((cell, i) => i < 3 ? cell.padEnd(widths[i]!) : cell).join('  ')).join('\n');
}
