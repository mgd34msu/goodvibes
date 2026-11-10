import { CALIBRATION_SITE, FixtureRunError, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import type { DecisionEntry, DecisionLog } from '../log/types.ts';
import type { JudgmentPort } from '../port/types.ts';
import { summarize, type CalibrationReport, type DecisionReport } from './report.ts';

export interface CalibrateOptions {
  readonly endpoint: { readonly kind: string; readonly baseURL: string };
  /** Only these decision names; all when omitted. */
  readonly only?: readonly string[];
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  /**
   * The decision log the port records to. When given, each fixture's checks
   * are attached to that fixture's logged call as ground truth, so accuracy
   * against confidence can later be read from the log alone.
   */
  readonly log?: DecisionLog;
}

/** How far back to look for one decision's calibration calls; one decision's fixtures never come near it. */
const RECENT_CALLS = 100_000;

/** The same bounded, deterministic window on both sides of fixture execution.
 * Native logs need no unrelated questions, answers or notes for this membership
 * check. Older/custom logs preserve their existing full-query semantics. */
const recentCallIds = (log: DecisionLog): readonly string[] => {
  const query = { site: CALIBRATION_SITE, status: 'answered', limit: RECENT_CALLS } as const;
  const queryIds = log.queryIds;
  return queryIds ? queryIds.call(log, query) : log.query(query).map(entry => entry.id);
};

/** Capture only IDs returned by this execution, even when other calibrations share the log. */
function fixturePort(port: JudgmentPort, returned: Set<string>, models: Set<string>): JudgmentPort {
  return {
    get model() { return port.model; },
    ...(port.recorder === undefined ? {} : { recorder: port.recorder }),
    ...(port.health === undefined ? {} : { health: () => port.health!() }),
    async ask(request) {
      const result = await port.ask(request);
      models.add(result.model);
      if (result.decisionId !== undefined) returned.add(result.decisionId);
      return result;
    },
  };
}

/**
 * Attaches each fixture's checks to the newest calibration call recorded for
 * it during this execution with this exact decision name and version. Checks
 * on a composed result are not truth about a helper's different question.
 * Opaque IDs carry no chronology, including mixed legacy keys.
 * Requires append-only immutable entries and stable query ordering, so entries
 * outside the prior window cannot enter the later window. Calls displaced by
 * its cap receive no truth rather than an unscoped fallback. Returns how many fixtures had a call to attach to.
 */
function recordFixtureTruth(
  log: DecisionLog, decision: NamedDecision, checks: readonly FixtureCheck[], before: ReadonlySet<string>, returned: ReadonlySet<string>,
): number {
  const calls: DecisionEntry[] = [];
  for (const id of recentCallIds(log)) {
    if (before.has(id) || !returned.has(id)) continue;
    // A lookup is eligible only after the current bounded-window and run-ID
    // intersection. It never rescues an old, missing or displaced call.
    const entry = log.get(id);
    if (entry?.id === id && entry.status === 'answered' && entry.context.site === CALIBRATION_SITE
      && entry.context.battery === decision.name && entry.context.batteryVersion === decision.version
      && entry.context.fixture !== undefined) calls.push(entry);
  }
  const fixtures = [...new Set(checks.map((check) => check.fixture))];
  let recorded = 0;
  for (const fixture of fixtures) {
    const call = calls.find(entry => entry.context.fixture === fixture);
    if (call === undefined) continue;
    log.attach(call.id, { kind: 'truth', truth: { source: 'fixture', checks: checks.filter((check) => check.fixture === fixture) } });
    recorded++;
  }
  return recorded;
}

/**
 * Runs every decision's fixtures live through the port (which should record
 * to a decision log) and scores each against its accuracy floor. A decision
 * that cannot run at all is reported as failed with its error; the others
 * still run.
 */
export async function calibrate(
  port: JudgmentPort,
  decisions: readonly NamedDecision[],
  options: CalibrateOptions,
): Promise<CalibrationReport> {
  const selected = options.only === undefined ? decisions : decisions.filter((decision) => options.only!.includes(decision.name));
  if (options.only !== undefined) {
    const missing = options.only.filter((name) => !decisions.some((decision) => decision.name === name));
    if (missing.length > 0) throw new RangeError(`no decision named ${missing.join(', ')}`);
  }
  const { log } = options;
  const reports: DecisionReport[] = [];
  for (const decision of selected) {
    const model = decision.model ?? port.model;
    const before = new Set(log === undefined ? [] : recentCallIds(log));
    const returned = new Set<string>();
    const models = new Set<string>();
    let checks: readonly FixtureCheck[] = [];
    let failure: string | undefined;
    let fixtureExecutions: DecisionReport['fixtureExecutions'];
    try {
      checks = await decision.checkFixtures(fixturePort(port, returned, models), options.signal === undefined ? {} : { signal: options.signal });
    } catch (error) {
      if (error instanceof FixtureRunError) {
        checks = error.checks;
        fixtureExecutions = error.fixtureExecutions;
      }
      failure = error instanceof FixtureRunError ? error.message : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    let truthRecorded: number | undefined;
    if (log !== undefined) {
      try { truthRecorded = recordFixtureTruth(log, decision, checks, before, returned); }
      catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        failure = failure === undefined ? message : `${failure}; fixture truth recording failed: ${message}`;
      }
    }
    const report = summarize(decision, model, checks);
    reports.push({ ...report, passed: failure === undefined && report.passed,
      resolvedModels: [...models],
      ...(truthRecorded === undefined ? {} : { truthRecorded }),
      ...(fixtureExecutions === undefined ? {} : { fixtureExecutions }),
      ...(failure === undefined ? {} : { error: failure }),
    });
  }
  return {
    at: (options.now ?? (() => new Date()))().toISOString(),
    endpoint: options.endpoint,
    decisions: reports,
    passed: reports.length > 0 && reports.every((report) => report.passed),
  };
}
