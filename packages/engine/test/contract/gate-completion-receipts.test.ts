import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContractConfigReader } from '../../sdk/src/platform/contract/config.js';
import { refreshGateResults, runContractGates, type QualityGate } from '../../sdk/src/platform/contract/gates.js';
import { RuntimeEventBus } from '../../sdk/src/platform/runtime/events/index.js';
import { runUnitCheck } from '../../sdk/src/platform/contract/check.js';
import type { UnitEvidence } from '../../sdk/src/platform/contract/evidence.js';
import { makeContract, makeUnit } from './fixtures.js';
import { checkPort } from './check-port.js';
import { captureGateInput } from '../../sdk/src/platform/contract/gate-input.js';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'gate-receipt-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

const shellString = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const program = (value: string) => `bun -e ${shellString(value)}`;
function reader(gates: readonly QualityGate[], timeout = 0): ContractConfigReader {
  return {
    get: () => undefined,
    getCategory: () => ({ gates, gateTimeoutMs: timeout }),
  } as unknown as ContractConfigReader;
}
const run = (gates: readonly QualityGate[], timeout = 0) => runContractGates({
  configManager: reader(gates, timeout), cwd: directory,
  runtimeBus: new RuntimeEventBus(), sessionId: 'session', contractId: 'ctr-01234567', targetId: 'unit',
});
const protocol = (counts = '{ passed: 2, failed: 0, skipped: 0 }', overrides = '', before = '') => program(`
  ${before}
  console.log(JSON.stringify({kind:'goodvibes-gate-result',schemaVersion:1,
    gate:process.env.GOODVIBES_GATE_NAME,runId:process.env.GOODVIBES_GATE_RUN_ID,
    outcome:'passed',checks:${counts},observation:{checked:'fixture'},${overrides}}));
`);

test('an empty test invocation cannot become assertion evidence through exit zero', async () => {
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'echo No tests found' } }));
  const [result] = await run([{ name: 'test', command: 'bun run test', enabled: true }]);
  expect(result).toMatchObject({ passed: false, outcome: 'unverified', required: true });
});

test('a missing required check stays unverified rather than skipped-pass', async () => {
  const [result] = await run([{ name: 'test', command: 'bun run test', enabled: true }]);
  expect(result).toMatchObject({ passed: false, skipped: true, outcome: 'unverified', required: true });
});

test('a custom assertion protocol requires current gate identity and actual checks', async () => {
  const [valid, empty, stale] = await run([
    { name: 'acceptance', command: protocol(), enabled: true, verification: 'assertions', required: true },
    { name: 'empty', command: protocol('{ passed: 0, failed: 0, skipped: 0 }'), enabled: true, verification: 'assertions', required: true },
    { name: 'stale', command: protocol(undefined, "runId:'a-different-run'"), enabled: true, verification: 'assertions', required: true },
  ]);
  expect(valid).toMatchObject({ outcome: 'passed', passed: true, completion: { kind: 'assertions', checks: { passed: 2, failed: 0, skipped: 0 } } });
  expect(empty).toMatchObject({ outcome: 'unverified', passed: false });
  expect(stale).toMatchObject({ outcome: 'unverified', passed: false });
});

test('known Bun tests produce machine assertion evidence', async () => {
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }));
  writeFileSync(join(directory, 'behavior.test.ts'), "import { test, expect } from 'bun:test'; test('real behavior', () => expect(2 + 2).toBe(4));");
  const [result] = await run([{ name: 'test', command: 'bun run test', enabled: true }]);
  expect(result).toMatchObject({ passed: true, outcome: 'passed', completion: { kind: 'assertions', checks: { passed: 1, failed: 0, skipped: 0 } } });
});

test('direct Bun tests work without a package script and cannot opt out of assertion verification', async () => {
  writeFileSync(join(directory, 'behavior.test.ts'), "import { test, expect } from 'bun:test'; test('real behavior', () => expect(2 + 2).toBe(4));");
  const [result] = await run([{ name: 'test', command: 'bun test', enabled: true, verification: 'command' }]);
  expect(result).toMatchObject({ passed: true, outcome: 'passed', completion: { kind: 'assertions', checks: { passed: 1 } } });
});

test('a custom test command can supply registered assertions without an unrelated package script', async () => {
  const [result] = await run([{ name: 'test', command: protocol(), enabled: true }]);
  expect(result).toMatchObject({ passed: true, outcome: 'passed', required: true, completion: { kind: 'assertions', runner: 'registered-protocol' } });
});

test('Bun assertion failure differs from a broken test runner', async () => {
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }));
  writeFileSync(join(directory, 'behavior.test.ts'), "import { test, expect } from 'bun:test'; test('broken behavior', () => expect(2 + 2).toBe(5));");
  const [failed] = await run([{ name: 'test', command: 'bun test', enabled: true }]);
  expect(failed).toMatchObject({ outcome: 'failed', passed: false, completion: { kind: 'assertions', checks: { failed: 1 } } });
  writeFileSync(join(directory, 'behavior.test.ts'), "import './missing-module.ts';");
  const [broken] = await run([{ name: 'test', command: 'bun test', enabled: true }]);
  expect(broken).toMatchObject({ outcome: 'unverified', passed: false });
});

test('a timed-out assertion runner is unverified, not an observed assertion failure', async () => {
  const [result] = await run([{ name: 'acceptance', command: 'sleep 5', enabled: true, verification: 'assertions', required: true }], 40);
  expect(result).toMatchObject({ outcome: 'unverified', passed: false, reason: 'timeout' });
});

test('later source mutation invalidates an earlier successful check', async () => {
  writeFileSync(join(directory, 'source.ts'), 'export const value = 1;');
  const results = await run([
    { name: 'acceptance', command: protocol(), enabled: true, verification: 'assertions', required: true },
    { name: 'mutator', command: program("await Bun.write('source.ts', 'export const value = 2;');"), enabled: true },
  ]);
  expect(results[0]).toMatchObject({ passed: false, outcome: 'unverified', reason: 'source-changed-after-check' });
});

test('a check that changes source cannot certify its own changed tree', async () => {
  writeFileSync(join(directory, 'source.ts'), 'original');
  const command = protocol(undefined, '', "await Bun.write('source.ts', 'changed');");
  const [result] = await run([{ name: 'acceptance', command, enabled: true, verification: 'assertions', required: true }]);
  expect(result).toMatchObject({ outcome: 'unverified', passed: false, reason: 'source-changed-during-check' });
});

async function judge(gates: UnitEvidence['gates'], onAsk?: () => void) {
  return runUnitCheck({
    checkPort: checkPort({}, onAsk).port,
    contract: makeContract({ projectRoot: directory }), unit: makeUnit(), trigger: 'completion', now: Date.now(),
    settings: { acceptanceStakes: 'high', evidenceNudgeLimit: 0, stallLimit: 0, maxNudgesPerUnit: 0 },
    evidence: { output: 'The work is complete.', changedPaths: ['source.ts'], diff: 'updated source', omitted: [], commands: [], ...(gates ? { gates } : {}) },
  });
}

test('a positive semantic judgment cannot pass an unverified required check', async () => {
  const gates = await run([{ name: 'test', command: 'bun test', enabled: true }]);
  const result = await judge(gates);
  expect(result.discarded).toBe(false);
  if (result.discarded) throw new Error('unexpected cancellation');
  expect(result.check.result).not.toBe('pass');
  expect(result.check.problems).toContain('unshown');
});

test('source mutation during semantic judgment invalidates the earlier assertion receipt', async () => {
  writeFileSync(join(directory, 'source.ts'), 'original');
  const gates = await run([{ name: 'acceptance', command: protocol(), enabled: true, verification: 'assertions', required: true }]);
  const result = await judge(gates, () => { writeFileSync(join(directory, 'source.ts'), 'changed after tests'); });
  expect(result.discarded).toBe(false);
  if (result.discarded) throw new Error('unexpected cancellation');
  expect(result.check.result).not.toBe('pass');
  expect(result.check.gates?.[0]).toMatchObject({ outcome: 'unverified', reason: 'source-changed-after-check' });
});

test('check-definition replacement during semantic judgment invalidates the receipt', async () => {
  const gates: QualityGate[] = [{ name: 'acceptance', command: protocol(), enabled: true, verification: 'assertions', required: true }];
  const captured = await run(gates);
  const result = await judge(captured, () => { gates[0]!.command = 'exit 0'; });
  expect(result.discarded).toBe(false);
  if (result.discarded) throw new Error('unexpected cancellation');
  expect(result.check.result).not.toBe('pass');
  expect(result.check.gates?.[0]).toMatchObject({ outcome: 'unverified', reason: 'check-definition-changed-after-check' });
});

test('a saved assertion receipt remains readable but cannot authorize a current pass', async () => {
  const gates = await run([{ name: 'acceptance', command: protocol(), enabled: true, verification: 'assertions', required: true }]);
  const historical = structuredClone(gates);
  expect(historical[0]).toMatchObject({ outcome: 'passed', completion: { kind: 'assertions' } });
  expect(refreshGateResults(historical)[0]).toMatchObject({ outcome: 'unverified', reason: 'historical-check-requires-current-execution' });
  const result = await judge(historical);
  if (result.discarded) throw new Error('unexpected cancellation');
  expect(result.check.result).not.toBe('pass');
});

test('ignored generated output does not invalidate an unchanged Git source tree', async () => {
  expect(Bun.spawnSync(['git', 'init', '-q', directory]).exitCode).toBe(0);
  writeFileSync(join(directory, '.gitignore'), 'generated/\n');
  writeFileSync(join(directory, 'source.ts'), 'original');
  const command = protocol(undefined, '', "await (await import('node:fs/promises')).mkdir('generated'); await Bun.write('generated/result.json', '{}');");
  const [result] = await run([{ name: 'acceptance', command, enabled: true, verification: 'assertions', required: true }]);
  expect(result).toMatchObject({ outcome: 'passed', passed: true });
  expect(result?.provenance?.sourceBefore).toBe(result?.provenance?.sourceAfter);
});

test('source links never silently become partial freshness evidence', async () => {
  writeFileSync(join(directory, 'source.ts'), 'original');
  symlinkSync(join(directory, 'source.ts'), join(directory, 'linked.ts'));
  const [result] = await run([{ name: 'acceptance', command: protocol(), enabled: true, verification: 'assertions', required: true }]);
  expect(result).toMatchObject({ outcome: 'unverified', passed: false, reason: 'source-identity-unavailable', output: '' });
});

test('Git routing and config environment cannot hide changes to the requested source root', () => {
  const foreign = mkdtempSync(join(tmpdir(), 'gate-foreign-repository-'));
  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  try {
    expect(Bun.spawnSync(['git', 'init', '-q', directory]).exitCode).toBe(0);
    expect(Bun.spawnSync(['git', 'init', '-q', foreign]).exitCode).toBe(0);
    writeFileSync(join(directory, 'source.ts'), 'original');
    process.env.GIT_DIR = join(foreign, '.git');
    process.env.GIT_WORK_TREE = foreign;
    process.env.GIT_INDEX_FILE = join(foreign, '.git', 'unrelated-index');
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'core.worktree';
    process.env.GIT_CONFIG_VALUE_0 = foreign;
    const before = captureGateInput(directory);
    writeFileSync(join(directory, 'source.ts'), 'changed');
    expect(captureGateInput(directory).source).not.toBe(before.source);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(foreign, { recursive: true, force: true });
  }
});

test('a standalone project inside an ignored parent directory does not receive an empty source identity', () => {
  expect(Bun.spawnSync(['git', 'init', '-q', directory]).exitCode).toBe(0);
  writeFileSync(join(directory, '.gitignore'), 'ignored/\n');
  const project = join(directory, 'ignored', 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'source.ts'), 'original');
  const before = captureGateInput(project);
  writeFileSync(join(project, 'source.ts'), 'changed');
  expect(captureGateInput(project).source).not.toBe(before.source);
});

test('a replaced package script cannot inherit a previous scripts machine-reporter identity', async () => {
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }));
  writeFileSync(join(directory, 'fake.ts'), `
    const file = process.argv.find(value => value.startsWith('--reporter-outfile='));
    if (file) await Bun.write(file.slice('--reporter-outfile='.length), '<testsuites tests="1" failures="0" skipped="0"><testsuite><testcase name="fake"/></testsuite></testsuites>');
    console.log('NO ASSERTIONS EXECUTED');
  `);
  const gates = await run([
    { name: 'prepare', enabled: true, command: program("await Bun.write('package.json', JSON.stringify({scripts:{test:'bun fake.ts'}}));") },
    { name: 'test', enabled: true, command: 'bun run test' },
  ]);
  expect(gates[1]).toMatchObject({ outcome: 'unverified', passed: false, required: true, reason: 'check-completion-unverified' });
  const result = await judge(gates);
  if (result.discarded) throw new Error('unexpected cancellation');
  expect(result.check.result).not.toBe('pass');
});

test('a changed configured command cannot receive a receipt from the previous planned command', async () => {
  const gates: QualityGate[] = [
    { name: 'prepare', command: 'exit 0', enabled: true },
    { name: 'acceptance', command: protocol(), enabled: true, verification: 'assertions', required: true },
  ];
  const results = await runContractGates({
    configManager: reader(gates), cwd: directory,
    runtimeBus: new RuntimeEventBus(), sessionId: 'session', contractId: 'ctr-01234567', targetId: 'unit',
    onResult: (_results, result) => { if (result.gate === 'prepare') gates[1]!.command = 'exit 0'; },
  });
  expect(results[1]).toMatchObject({ outcome: 'unverified', passed: false, required: true, reason: 'check-definition-changed-before-check', output: '' });
  expect(JSON.stringify(results.map(result => result.provenance))).not.toContain(gates[0]!.command);
  const result = await judge(results);
  if (result.discarded) throw new Error('unexpected cancellation');
  expect(result.check.result).not.toBe('pass');
});
