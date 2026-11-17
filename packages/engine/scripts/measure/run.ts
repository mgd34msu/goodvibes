/**
 * Performance measurement harness. Measures, prints and writes JSON. Every
 * scenario checks that its operation succeeded (harness.ts assertOutcome); a
 * scenario that failed reports its reason instead of numbers, and the run
 * exits 1 naming each failure.
 *
 *   bun packages/engine/scripts/measure/run.ts [--only <name>[,<name>...]] [--out <file.json>]
 *
 * Every in-process scenario runs in its own `bun worker.ts` process whose HOME,
 * XDG_* directories, GOODVIBES_HOME and TMPDIR point into a fresh temporary
 * root, so nothing reads or writes the real ~/.goodvibes. The decision model
 * and the conversation model are counting fakes (fakes.ts); every network
 * attempt is refused and counted (instrument.ts). Start-up scenarios spawn the
 * products' source entries with the same isolation and report wall time only.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SCENARIOS } from './scenarios/index.ts';
import { STARTUP_SCENARIOS, measureStartup, type StartupReport } from './startup.ts';
import type { ScenarioReport } from './harness.ts';

const HERE = import.meta.dir;
const REPO = resolve(HERE, '../../../..');

function parseArgs(argv: readonly string[]): { only: Set<string> | null; out: string | null } {
  let only: Set<string> | null = null;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string => { const next = argv[++i]; if (next === undefined) throw new Error(`${arg} needs a value`); return next; };
    if (arg === '--only') only = new Set(value().split(',').map((name) => name.trim()).filter(Boolean));
    else if (arg.startsWith('--only=')) only = new Set(arg.slice(7).split(',').map((name) => name.trim()).filter(Boolean));
    else if (arg === '--out') out = resolve(value());
    else if (arg.startsWith('--out=')) out = resolve(arg.slice(6));
    else if (arg === '--help' || arg === '-h') {
      console.log('bun packages/engine/scripts/measure/run.ts [--only <name>[,<name>...]] [--out <file.json>]');
      console.log(`scenarios: ${[...SCENARIOS.map((s) => s.name), ...STARTUP_SCENARIOS.map((s) => s.name)].join(', ')}`);
      process.exit(0);
    } else throw new Error(`unknown argument ${arg}`);
  }
  return { only, out };
}

/** A fresh isolated root; the returned env never inherits provider keys or config paths. */
export function isolatedEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
  const keep = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'SHELL'];
  const env: Record<string, string> = {};
  for (const name of keep) if (process.env[name] !== undefined) env[name] = process.env[name]!;
  const dirs = {
    HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), GOODVIBES_HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'), XDG_RUNTIME_DIR: join(root, 'runtime'),
    TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
  };
  for (const dir of new Set(Object.values(dirs))) mkdirSync(dir, { recursive: true });
  return { ...env, ...dirs, MEASURE_ROOT: root, NO_COLOR: '1', ...extra };
}

async function runWorker(name: string): Promise<ScenarioReport | { name: string; error: string }> {
  const root = mkdtempSync(join(tmpdir(), `gv-measure-${name}-`));
  const out = join(root, 'report.json');
  try {
    const child = Bun.spawn([process.execPath, '--no-env-file', join(HERE, 'worker.ts'), name, out], {
      cwd: join(root, 'tmp'), env: isolatedEnv(root), stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    clearTimeout(timer);
    try { return JSON.parse(readFileSync(out, 'utf8')) as ScenarioReport; }
    catch { return { name, error: `worker exited ${child.exitCode} without a report\n${(stderr || stdout).slice(-2000)}` }; }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['wall ms', 'wall'], ['decide', 'decisionRequests'], ['llm', 'providerRequests'], ['reads', 'fileReads'], ['writes', 'fileWrites'],
  ['fsync', 'fsyncs'], ['bytes written', 'bytesWritten'], ['bytes read', 'bytesRead'], ['stats', 'stats'], ['sqlite', 'sqliteStatements'],
  ['os wr', 'osWriteCalls'], ['net', 'networkAttempts'],
];

function cell(report: ScenarioReport, key: string): string {
  if (key === 'wall') return report.wallMs.median.toFixed(1);
  const value = report.median[key] ?? 0;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatTable(reports: ReadonlyArray<ScenarioReport | { name: string; error: string }>, startup: readonly StartupReport[]): string {
  const header = ['scenario', ...COLUMNS.map(([title]) => title), 'scenario-specific'];
  const rows: string[][] = [];
  for (const report of reports) {
    if ('error' in report && !('median' in report)) { rows.push([report.name, `ERROR: ${report.error.split('\n')[0]!.slice(0, 120)}`]); continue; }
    const r = report as ScenarioReport;
    const shown = new Set(COLUMNS.map(([, key]) => key));
    const generic = new Set(['opens', 'renames', 'readdirs', 'mkdirs', 'removes', 'osReadCalls', 'osBytesRead', 'osBytesWritten', 'decisionBytes', 'providerBytes', 'fixtureBytes']);
    const specific = Object.entries(r.median).filter(([key]) => !shown.has(key) && !generic.has(key)).map(([key, value]) => `${key}=${Number.isInteger(value) ? value : value.toFixed(1)}`);
    rows.push([r.name + (r.testOnly ? ' *' : ''), ...COLUMNS.map(([, key]) => cell(r, key)), specific.join(' ')]);
  }
  for (const s of startup) rows.push([s.name, s.error ? `ERROR: ${s.error}` : s.wallMs.median.toFixed(0), ...COLUMNS.slice(1).map(() => ''), s.note ?? '']);
  const widths = header.map((_, i) => Math.max(header[i]!.length, ...rows.map((row) => (row[i] ?? '').length)));
  const line = (row: readonly string[]): string => row.map((value, i) => i === 0 || i === row.length - 1 ? value.padEnd(widths[i]!) : value.padStart(widths[i]!)).join('  ').trimEnd();
  return [line(header), line(header.map((_, i) => '-'.repeat(widths[i]!))), ...rows.map(line)].join('\n');
}

async function main(): Promise<void> {
  const { only, out } = parseArgs(process.argv.slice(2));
  const known = new Set([...SCENARIOS.map((s) => s.name), ...STARTUP_SCENARIOS.map((s) => s.name)]);
  for (const name of only ?? []) if (!known.has(name)) throw new Error(`unknown scenario ${name}; known: ${[...known].join(', ')}`);
  const started = performance.now();
  const reports: Array<ScenarioReport | { name: string; error: string }> = [];
  for (const scenario of SCENARIOS) {
    if (only && !only.has(scenario.name)) continue;
    process.stderr.write(`measuring ${scenario.name} ...\n`);
    reports.push(await runWorker(scenario.name));
  }
  const startup: StartupReport[] = [];
  for (const scenario of STARTUP_SCENARIOS) {
    if (only && !only.has(scenario.name)) continue;
    process.stderr.write(`measuring ${scenario.name} ...\n`);
    startup.push(await measureStartup(scenario, REPO, (root, extra) => isolatedEnv(root, extra)));
  }
  console.log(formatTable(reports, startup));
  console.log('\n* test-only capability. Medians; counters include work that landed within 150 ms after the operation returned.');
  const result = {
    measuredAt: new Date().toISOString(),
    bun: Bun.version,
    commit: Bun.spawnSync(['git', '-C', REPO, 'rev-parse', '--short', 'HEAD']).stdout.toString().trim(),
    totalMs: Math.round(performance.now() - started),
    scenarios: reports,
    startup,
  };
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\nwrote ${out}`);
  }
  const failures = [
    ...reports.filter((report): report is { name: string; error: string } => 'error' in report && typeof report.error === 'string'),
    ...startup.filter((report) => report.error !== undefined).map((report) => ({ name: report.name, error: report.error! })),
  ];
  if (failures.length > 0) {
    console.error(`\n${failures.length} scenario(s) failed; their numbers are not reported:`);
    for (const failure of failures) console.error(`- ${failure.name}: ${failure.error.split('\n')[0]}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
