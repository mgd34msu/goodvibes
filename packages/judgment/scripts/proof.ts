import { judgmentProcessSignal } from './process-owner.ts';
/**
 * Live proof of the judgment foundation. Every reference decision of a
 * pattern a product ships runs its fixtures against the configured System One
 * endpoint, then fan-out, a composition that is not a decision of its own,
 * runs on a real example. With --library the pattern library no product calls
 * yet (its reference decisions, the verify-then-escalate cascade, compound
 * split and features) runs too; without it nothing is spent on them. Every
 * call lands in a decision log. Exits non-zero on any decision below its
 * floor, any wrong composition result, or any call the log lacks (a call
 * made through the port that has no entry in the log, or an answered call
 * whose readings were not recorded).
 *
 *   bun run proof [--library]
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  calibrate,
  createSystemOnePort,
  fanOut,
  featurize,
  formatReport,
  noul,
  readingsOf,
  score,
  splitCompound,
  judgmentConfigFromEnv,
  type JudgmentPort,
  SqliteDecisionLog,
  verifyThenEscalate,
  withDecisionLog,
} from '../src/index.ts';
import { judge, libraryRegistry, multipleActions, registry, ticketTriage, ticketUrgency } from './reference-registry.ts';

const { values } = parseArgs({ args: process.argv.slice(2), options: { library: { type: 'boolean', default: false } } });
const library = values.library;

const config = judgmentConfigFromEnv(process.env);
const logPath = join(tmpdir(), `judgment-proof-${Date.now()}.sqlite`);
using log = new SqliteDecisionLog(logPath);
const logged = withDecisionLog(createSystemOnePort({ ...config, signal: judgmentProcessSignal() }), log);
// Every ask the proof makes goes through here, so the number issued can be set against the log.
let issued = 0;
const port: JudgmentPort = {
  get model() { return logged.model; },
  ...(logged.health ? { health: () => logged.health!() } : {}),
  ...(logged.recorder ? { recorder: logged.recorder } : {}),
  ask: (request) => { issued++; return logged.ask(request); },
};

const decisions = library ? [...registry.list(), ...libraryRegistry.list()] : registry.list();
const report = await calibrate(port, decisions, { endpoint: { kind: config.endpoint.kind, baseURL: config.endpoint.baseURL } });
console.log(formatReport(report));
let failed = report.passed ? 0 : 1;

const fanned = await fanOut(port, 'Nobody on our team can log in since this morning. Every attempt returns a 500 error. We need this fixed now.', {
  urgency: ticketUrgency,
  triage: ticketTriage,
});
const r = fanned.readings;
const fanOk =
  r.urgency.urgent.verdict === 'yes' && r.triage.category.choice === 'bug_report' && r.triage.severity.level === 2 && r.triage.refund.verdict === 'no';
console.log(`\n${fanOk ? 'PASS' : 'FAIL'}  fan-out  ${JSON.stringify(r)}`);
if (!fanOk) failed++;

if (library) {
  const page = 'NYU Events Calendar. Search Events. About the Events Calendar. Report issue or provide feedback. Campus Map. Contact Us.';
  const cascade = await verifyThenEscalate(
    port,
    judge,
    [
      { name: 'small', produce: async () => ({ registration_open_date: '', description: 'Registration opens for the fall semester' }) },
      { name: 'strong', produce: async () => ({ registration_open_date: '', description: '' }) },
    ],
    {
      goal: 'Report what `evidence.page` states about the fall registration open date: the date and a description of it where the page states them, and empty fields where it does not.',
      criteria: ['No field contains anything `evidence.page` does not state.', 'A field is left empty only when `evidence.page` does not state it.'],
      evidence: () => ({ page }),
    },
  );
  const cascadeOk = cascade.accepted && cascade.tier === 'strong';
  console.log(`${cascadeOk ? 'PASS' : 'FAIL'}  cascade  ${JSON.stringify(cascade.attempts.map((a) => ({ tier: a.tier, verdict: a.judgment.verdict })))}`);
  if (!cascadeOk) failed++;

  const split = await splitCompound(port, multipleActions, async (request) => request.split(' and '), 'turn off the living room lights and lock the front door');
  const splitOk = split.parts.length === 2 && !split.uncertain;
  console.log(`${splitOk ? 'PASS' : 'FAIL'}  compound split  ${JSON.stringify(split.parts)} p=${split.reading.probability}`);
  if (!splitOk) failed++;

  const columns = await featurize(
    port,
    {
      oak: score('How strongly does the tasting note dwell on oak?', ['Not present', 'Mentioned in passing', 'Moderate', 'Dominant']),
      fault: noul('Does the tasting note name a fault or defect in the wine?'),
    },
    ['Heavy toasted oak, vanilla and cedar dominate the palate from start to finish.', 'Bright citrus and green apple; unfortunately the wine is corked and smells of wet cardboard.'],
    { label: 'proof.features' },
  );
  const oak = columns.find((column) => column.name === 'oak')!.values;
  const fault = columns.find((column) => column.name === 'fault')!.values;
  const featuresOk = oak[0]! > oak[1]! && fault[1]! > fault[0]! && columns.some((column) => column.name === 'oak_sd');
  console.log(`${featuresOk ? 'PASS' : 'FAIL'}  features  ${JSON.stringify(columns)}`);
  if (!featuresOk) failed++;
}

const entries = log.query({ limit: 100_000 });
const unlogged = entries.filter((entry) => entry.status === 'answered' && readingsOf(entry) === undefined);
const missing = Math.max(0, issued - entries.length);
console.log(`\ndecision log: ${entries.length} entries at ${logPath}; ${issued} calls issued, ${missing} not in the log, ${unlogged.length} without readings`);
if (unlogged.length > 0 || missing > 0) failed++;
// Leave through the exit code so the module finishes and `using log` closes the database.
process.exitCode = failed === 0 ? 0 : 1;
