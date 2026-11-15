/**
 * Runs one scenario in this process and writes its report as JSON.
 * Started by run.ts with an isolated HOME/XDG/TMPDIR; never run it directly
 * against a real home.
 *
 *   bun worker.ts <scenario-name> <report.json>
 */
// Only the instrumentation is imported statically. Bun binds a builtin's named
// exports for the whole static graph before any of it runs, so everything that
// touches node:fs is imported dynamically, after the counters are installed.
import { networkLog } from './instrument.ts';
import type { ScenarioReport } from './harness.ts';

const { mkdirSync, writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
const { measure } = await import('./harness.ts');
const { SCENARIOS } = await import('./scenarios/index.ts');

const [name, out] = process.argv.slice(2);
const root = process.env.MEASURE_ROOT;
if (!name || !out || !root || process.env.HOME !== join(root, 'home')) {
  console.error('worker.ts is started by run.ts, with MEASURE_ROOT and an isolated HOME');
  process.exit(2);
}
const entry = SCENARIOS.find((candidate) => candidate.name === name);
if (!entry) { console.error(`unknown scenario ${name}`); process.exit(2); }

const env = { root, home: join(root, 'home'), workspace: join(root, 'workspace') };
mkdirSync(env.workspace, { recursive: true });

let report: ScenarioReport | { name: string; error: string };
try {
  const scenarios = await entry.load();
  const scenario = scenarios.find((candidate) => candidate.name === name);
  if (!scenario) throw new Error(`module for ${name} does not export it`);
  report = await measure(scenario, env);
} catch (error) {
  const cause = error instanceof Error && error.cause !== undefined ? `\ncause: ${error.cause instanceof Error ? error.cause.stack ?? error.cause.message : String(error.cause)}` : '';
  const refused = networkLog.length ? `\nnetwork refused: ${[...new Set(networkLog)].join('; ')}` : '';
  report = { name, error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}${cause}${refused}` : String(error) };
}
writeFileSync(out, JSON.stringify(report, null, 2));
// Background timers in product code must not keep the worker alive.
process.exit(0);
