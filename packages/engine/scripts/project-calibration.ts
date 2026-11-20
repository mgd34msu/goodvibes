#!/usr/bin/env bun
/**
 * Calibrate every engine and foundation registry through the genuine configured
 * System One port. Only each battery's built-in fixture inputs are submitted.
 *
 * bun packages/engine/scripts/project-calibration.ts --out /tmp/calibration.json --log /tmp/calibration.sqlite
 * Add --inventory-only to enumerate without contacting the service, --only a,b
 * for a repair run, or --provisional while the integrated source is changing.
 * --gate runs only the decisions the permission gate registers (the run that
 * decides whether Jev may stand in for the owner by default) and writes the
 * compact calibration record the product ships, platform/gate/gate-calibration-record.ts,
 * which the permission manager reads to tell whether those decisions were
 * measured at their current versions on the configured model (gate/calibration.ts).
 * --record <path> writes the record elsewhere: a .ts path as that module, any
 * other path as JSON.
 */
import { mkdirSync, renameSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BatteryRegistry, CALIBRATION_SITE, calibrate, calibrationRecord, createSystemOnePort, formatReport, judgmentConfigFromEnv, readingsOf,
  SqliteDecisionLog, withDecisionLog,
  type CalibrationReport, type DecisionReport, type NamedDecision,
} from '@goodvibes/judgment';
import { ENGINE_ROOT, loadEngineRegistries } from './judgment-registries.ts';
import { observeProjectSource, sameProjectSource } from './project-source-observation.ts';

const REPO_ROOT = resolve(ENGINE_ROOT, '../..');
/** The registry of every decision the permission gate makes. */
const GATE_REGISTRY = 'platform/src/platform/gate/judgment-registry.ts';
/** The record the product ships and reads (gate/calibration.ts); a --gate run writes it unless --record names another path. */
const GATE_RECORD_MODULE = 'platform/src/platform/gate/gate-calibration-record.ts';

/** The record as the module the product imports: the same type and export name, with this run's values. */
function gateRecordModule(record: unknown): string {
  return [
    "import type { CalibrationRecord } from '@goodvibes/judgment';",
    '',
    '/** A calibration record as the calibration script writes it: the run\'s measurements, the source it measured and the endpoint it asked. */',
    'export type GateCalibrationRecord = CalibrationRecord & { readonly source?: string; readonly endpoint?: string };',
    '',
    '/**',
    ' * The last calibration run over the decisions the permission gate registers,',
    ' * written by `bun packages/engine/scripts/project-calibration.ts --gate` (a',
    ' * paid run against the configured decision endpoint). Null until a run has',
    ' * been recorded: the default mode then asks the owner instead of letting Jev',
    ' * decide (gate/calibration.ts).',
    ' */',
    `export const GATE_CALIBRATION_RECORD: GateCalibrationRecord | null = ${JSON.stringify(record, null, 2)};`,
    '',
  ].join('\n');
}
const THIS_SCRIPT = relative(REPO_ROOT, import.meta.path);

function sourceSnapshot() {
  return observeProjectSource(REPO_ROOT, ['packages/engine', 'packages/judgment', 'products',
    'package.json', 'bun.lock', 'tsconfig.base.json'], [THIS_SCRIPT]);
}

export async function loadProjectCalibration() {
  const engine = await loadEngineRegistries();
  const referencePath = 'packages/judgment/scripts/reference-registry.ts';
  const reference: unknown = await import(resolve(REPO_ROOT, referencePath));
  if (typeof reference !== 'object' || reference === null || !('registry' in reference)
    || !(reference.registry instanceof BatteryRegistry)) throw new Error(`${referencePath} does not export a BatteryRegistry`);
  const byName = new Map<string, { decision: NamedDecision; registries: string[] }>();
  const registries = [
    ...engine.byFile.map(({ file, decisions }) => ({ file: `packages/engine/${file}`, decisions })),
    { file: referencePath, decisions: reference.registry.list() },
  ];
  const conflicts = new Set(engine.conflicts);
  for (const { file, decisions } of registries) for (const decision of decisions) {
    const known = byName.get(decision.name);
    if (known === undefined) byName.set(decision.name, { decision, registries: [file] });
    else {
      if (known.decision !== decision) conflicts.add(decision.name);
      known.registries.push(file);
    }
  }
  if (conflicts.size > 0) throw new Error(`Conflicting registered batteries: ${[...conflicts].sort().join(', ')}`);
  const entries = [...byName.values()].sort((a, b) => a.decision.name.localeCompare(b.decision.name));
  return {
    gate: engine.byFile.find(({ file }) => file === GATE_REGISTRY)?.decisions.map((decision) => decision.name) ?? [],
    decisions: entries.map(({ decision }) => decision),
    inventory: entries.map(({ decision, registries: sources }) => ({
      name: decision.name, version: decision.version, description: decision.description,
      declaredModel: decision.model ?? null, accuracyFloor: decision.accuracyFloor,
      fixtureCount: decision.fixtureCount, registries: sources,
    })),
    registries: registries.map(({ file, decisions }) => ({ file, batteries: decisions.map((decision) => decision.name) })),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    out: { type: 'string' }, log: { type: 'string' }, only: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    'inventory-only': { type: 'boolean', default: false },
    gate: { type: 'boolean', default: false },
    record: { type: 'string' },
    provisional: { type: 'boolean', default: false },
    'source-sha': { type: 'string' },
  } });
  if (values.out === undefined) throw new Error('--out is required');
  const outPath = resolve(values.out);
  const concurrency = Number(values.concurrency);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer');
  const source = await sourceSnapshot();
  if (values['source-sha'] !== undefined && values['source-sha'] !== source.sha) throw new Error('HEAD does not match --source-sha');
  const project = await loadProjectCalibration();
  if (values.gate && project.gate.length === 0) throw new Error(`${GATE_REGISTRY} registers no decisions`);
  const names = values.only?.split(',') ?? (values.gate ? project.gate : undefined);
  if (names !== undefined) for (const name of names) {
    if (!project.decisions.some((decision) => decision.name === name)) throw new Error(`Unknown battery: ${name}`);
  }
  const decisions = project.decisions.filter((decision) => names === undefined || names.includes(decision.name));
  const inventory = {
    source, provisional: values.provisional, registries: project.registries, batteries: project.inventory,
    totalRegistries: project.registries.length, totalBatteries: project.decisions.length,
    totalFixtures: project.decisions.reduce((sum, decision) => sum + decision.fixtureCount, 0),
    selectedBatteries: decisions.map((decision) => decision.name),
  };
  mkdirSync(dirname(outPath), { recursive: true });
  console.log(`[project-calibration] ${inventory.totalBatteries} unique batteries, ${inventory.totalFixtures} declared fixtures, ${inventory.totalRegistries} registries`);
  if (values['inventory-only']) {
    await Bun.write(outPath, `${JSON.stringify({ ...inventory, mode: 'inventory', executed: false }, null, 2)}\n`);
    return;
  }
  if (values.log === undefined) throw new Error('--log is required for genuine calibration');
  const logPath = resolve(values.log);
  mkdirSync(dirname(logPath), { recursive: true });
  const config = judgmentConfigFromEnv(process.env);
  const endpoint = { kind: config.endpoint.kind, baseURL: config.endpoint.baseURL };
  using log = new SqliteDecisionLog(logPath);
  const previousIds = new Set(log.query({ limit: 1_000_000 }).map((entry) => entry.id));
  const port = withDecisionLog(createSystemOnePort(config), log);
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error('Calibration cancelled by operator'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const reports: DecisionReport[] = [];
  const queue = [...decisions];
  let pendingWrite = Promise.resolve();
  const startedAt = new Date().toISOString();
  const currentReport = (): CalibrationReport => ({
    at: startedAt, endpoint, decisions: [...reports].sort((a, b) => a.name.localeCompare(b.name)),
    passed: reports.length === decisions.length && reports.every((report) => report.passed),
  });
  const persist = async (complete: boolean) => {
    const entries = log.query({ limit: 1_000_000 }).filter((entry) => !previousIds.has(entry.id));
    const after = complete ? await sourceSnapshot() : undefined;
    const sourceStable = after === undefined ? null : sameProjectSource(source, after);
    const coverage = decisions.flatMap((declared) => {
      const report = reports.find((candidate) => candidate.name === declared.name);
      if (report === undefined) return [];
      const checkedFixtures = new Set(report.checks.map((check) => check.fixture)).size;
      // Fidelity's literal quote check deliberately needs no model or log entry.
      // Preserve these checks separately from genuine provider answers.
      const deterministicFixtures = [...new Set(report.checks.filter((check) =>
        check.aspect === 'fidelity' && check.expected === 'fabricated' && check.got === 'fabricated'
        && check.signal === 1 && check.outcome === 'act',
      ).map((check) => check.fixture))];
      // A composed decision (a rank-recheck, a tournament) asks several
      // questions per fixture. Its checks judge the composed answer, so
      // calibrate attaches them to no single call; such a fixture is covered
      // when every one of its calls was a genuine answered request.
      const calls = new Map<string, { answered: number; total: number }>();
      for (const entry of entries) {
        const { site, battery, batteryVersion, fixture } = entry.context;
        if (site !== CALIBRATION_SITE || battery !== declared.name || batteryVersion !== declared.version || fixture === undefined) continue;
        const seen = calls.get(fixture) ?? { answered: 0, total: 0 };
        seen.total++;
        if (entry.status === 'answered') seen.answered++;
        calls.set(fixture, seen);
      }
      const composedFixtures = [...calls].filter(([, seen]) => seen.total > 1 && seen.answered === seen.total).map(([fixture]) => fixture);
      return { name: report.name, declaredFixtures: declared.fixtureCount, checkedFixtures,
        truthRecorded: report.truthRecorded ?? 0, deterministicFixtures, composedFixtures,
        complete: checkedFixtures === declared.fixtureCount
          && (report.truthRecorded ?? 0) + deterministicFixtures.length + composedFixtures.length === declared.fixtureCount };
    });
    const answered = entries.filter((entry) => entry.status === 'answered');
    const logEvidence = {
      path: logPath, entries: entries.length, answered: answered.length, failed: entries.length - answered.length,
      answeredWithoutReadings: answered.filter((entry) => readingsOf(entry) === undefined).length,
      observedModels: [...new Set(answered.map((entry) => entry.model))].sort(),
      calls: entries.map((entry) => ({ id: entry.id, at: entry.at, context: entry.context,
        status: entry.status, requestedModel: entry.requestedModel, observedModel: entry.status === 'answered' ? entry.model : null,
        requestId: entry.requestId, lineage: entry.lineage, stateHash: entry.stateHash })),
    };
    const report = currentReport();
    const passed = complete && sourceStable === true && report.passed
      && coverage.every((battery) => battery.complete) && logEvidence.failed === 0 && logEvidence.answeredWithoutReadings === 0;
    const serialized = `${JSON.stringify({ ...inventory, mode: 'genuine-calibration', startedAt,
      complete, completedAt: complete ? new Date().toISOString() : null, sourceStable,
      sourceAfter: after, requestedDefaultModel: config.model,
      protocol: { method: 'POST', path: '/v1/systemone' },
      notRunBatteries: decisions.filter((decision) => !reports.some((report) => report.name === decision.name)).map((decision) => decision.name),
      coverage, report, logEvidence, passed,
    }, null, 2)}\n`;
    pendingWrite = pendingWrite.then(async () => {
      await Bun.write(`${outPath}.next`, serialized);
      renameSync(`${outPath}.next`, outPath);
    });
    await pendingWrite;
    return passed;
  };
  await persist(false);
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, decisions.length) }, async () => {
      while (queue.length > 0 && !abort.signal.aborted) {
        const decision = queue.shift();
        if (decision === undefined) break;
        const result = await calibrate(port, [decision], { endpoint, log, signal: abort.signal });
        reports.push(...result.decisions);
        for (const report of result.decisions) console.log(`[project-calibration] ${report.passed ? 'PASS' : 'FAIL'} ${report.name}@${report.version} ${report.accuracy.toFixed(3)}/${report.accuracyFloor} ${report.checks.length} checks${report.error === undefined ? '' : ` ${report.error}`}`);
        await persist(false);
      }
    }));
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
  const passed = await persist(true);
  const recordTarget = values.record ?? (values.gate && values.only === undefined ? resolve(ENGINE_ROOT, GATE_RECORD_MODULE) : undefined);
  if (recordTarget !== undefined) {
    const recordPath = resolve(recordTarget);
    // The endpoint is part of what the run certifies: the gate compares it with where its requests go.
    const record = { ...calibrationRecord(currentReport(), config.model), passed, source: source.sha, endpoint: endpoint.baseURL };
    mkdirSync(dirname(recordPath), { recursive: true });
    await Bun.write(recordPath, recordPath.endsWith('.ts') ? gateRecordModule(record) : `${JSON.stringify(record, null, 2)}\n`);
    console.log(`[project-calibration] record: ${recordPath}`);
  }
  console.log(formatReport(currentReport()));
  console.log(`[project-calibration] ${passed ? 'PASS' : 'FAIL'}; report: ${outPath}; decision log: ${logPath}`);
  process.exitCode = passed ? 0 : 1;
}

if (import.meta.main) await main();
