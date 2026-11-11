/** Inspector privacy boundaries and an isolated inert compiled-fixture owner. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { compiledDiagnosticFrame } from './diagnose-macos-native.mjs';

const script = { url: '/$bunfs/root/goodvibes-daemon-macos-arm64' };
const secret = 'private-runtime-token-value';
const frame = (line = 3, functionName = 'retainedFile') => ({ functionName,
  location: { scriptId: '2', lineNumber: line, columnNumber: 42 },
  scopeChain: [{ object: { description: secret, value: secret } }], this: { description: secret },
});
const source = [
  '// @bun',
  '// src/cli/native-sqlite-runtime.ts',
  'function retainedFile(path) {',
  '  throw new Error("Native SQLite companion changed before database construction");',
  '}',
  '// ../../packages/engine/platform/src/platform/runtime/native-file-sources.ts',
  'function captureIdentity() {}',
].join('\n');

test('caught-throw frames retain generated coordinates and only exact public static throw literals', () => {
  expect(compiledDiagnosticFrame(frame(), script, source)).toEqual({
    function: 'retainedFile', source: 'compiled', line: 3, column: 42,
    module: 'src/cli/native-sqlite-runtime.ts', moduleOffset: 2,
    staticThrow: 'Native SQLite companion changed before database construction',
  });
  expect(JSON.stringify(compiledDiagnosticFrame(frame(), script, source))).not.toContain(secret);
  const privateThrow = source.replace('Native SQLite companion changed before database construction', secret);
  expect(compiledDiagnosticFrame(frame(), script, privateThrow)).not.toHaveProperty('staticThrow');
});

test('module markers choose the actual preceding compiled owner without claiming original TS line maps', () => {
  expect(compiledDiagnosticFrame(frame(6, 'captureIdentity'), script, source)).toEqual({
    function: 'captureIdentity', source: 'compiled', line: 6, column: 42,
    module: 'packages/engine/platform/src/platform/runtime/native-file-sources.ts', moduleOffset: 1,
  });
});

test('runtime URLs, locals, unknown names and source text remain absent from public frame records', () => {
  const untrusted = compiledDiagnosticFrame(frame(3, secret), { url: `/Users/${secret}/runtime.ts` }, source);
  expect(untrusted).toEqual({ function: 'withheld', source: 'other', line: 3, column: 42 });
  const unknownName = compiledDiagnosticFrame(frame(3, secret), script, source);
  expect(unknownName.function).toBe('withheld');
  const output = JSON.stringify([untrusted, unknownName]);
  expect(output).not.toContain(secret); expect(output).not.toContain('scopeChain'); expect(output).not.toContain('scriptSource');
});

test('malformed coordinates and foreign or escaping module markers cannot leak arbitrary source paths', () => {
  const observed = compiledDiagnosticFrame({ ...frame(), location: { lineNumber: -1, columnNumber: Infinity } }, script, source);
  expect(observed.line).toBe(0); expect(observed.column).toBe(0);
  for (const marker of [`// /Users/${secret}/runtime.ts`, `// src/../../${secret}/runtime.ts`]) {
    const foreign = compiledDiagnosticFrame(frame(1, 'retainedFile'), script, `${marker}\nfunction retainedFile() {}`);
    expect(foreign).not.toHaveProperty('module'); expect(JSON.stringify(foreign)).not.toContain(secret);
  }
  const ambiguous = source.replace('  throw new Error("Native SQLite companion changed before database construction");',
    '  if (first) throw new Error("Native SQLite companion changed before database construction"); else throw new Error("Original native SQLite source changed");');
  expect(compiledDiagnosticFrame(frame(), script, ambiguous)).not.toHaveProperty('staticThrow');
});

test('ordinary Node drives the actual compiled inspector through rolling caught throws, natural exit and owned cancellation', async () => {
  expect(process.versions.bun).toBe('1.3.14');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-inspector-fixture-')));
  const normalPid = join(root, 'normal.pid'), abortPid = join(root, 'abort.pid');
  const fixtureEnv = { HOME: root, TMPDIR: root, PATH: process.env.PATH ?? '/usr/bin:/bin', NO_COLOR: '1' };
  const retireFixture = async (pidPath: string) => {
    if (!existsSync(pidPath)) return;
    const pid = Number(readFileSync(pidPath, 'utf8'));
    expect(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid).toBe(true);
    try { process.kill(-pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try { process.kill(-pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
      await delay(20);
    }
    throw new Error('Owned inert fixture group did not drain.');
  };
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/fixture.ts'), `function retainedFile() {
  throw new Error('Original native SQLite source changed');
}
if (process.env.FIXTURE_MODE === 'abort') {
  setInterval(() => {}, 1_000);
} else {
  for (let index = 0; index < 160; index++) {
    try { retainedFile(); } catch {}
  }
  process.exitCode = 17;
}
`);
    const daemon = join(root, 'goodvibes-daemon');
    const compiled = spawnSync(process.execPath, ['build', '--compile', './src/fixture.ts', '--outfile', daemon],
      { cwd: root, env: fixtureEnv, encoding: 'utf8', timeout: 30_000 });
    expect(compiled.status, compiled.stderr).toBe(0);
    const controllerUrl = pathToFileURL(resolve(import.meta.dir, 'diagnose-macos-native.mjs')).href;
    const driver = join(root, 'driver.mjs');
    writeFileSync(driver, `import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { inspectCompiledNativeDiagnosticAttempt } from ${JSON.stringify(controllerUrl)};
assert.equal(process.versions.bun, undefined);
assert.equal(typeof WebSocket, 'function');
const daemon = process.argv[2], home = process.cwd(), records = [];
const normalPid = process.argv[3], abortPid = process.argv[4];
const retainStarted = (record, path) => {
  if (record.event !== 'started') return;
  assert(Number.isSafeInteger(record.pid) && record.pid > 0 && record.pid !== process.pid);
  // Controller ownership is retained before inspector attachment or main runs.
  writeFileSync(path, String(record.pid), { flag: 'wx', mode: 0o600 });
};
const groupDrained = path => {
  const pid = Number(readFileSync(path, 'utf8'));
  assert(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
  assert.throws(() => process.kill(-pid, 0), error => error.code === 'ESRCH');
};
await inspectCompiledNativeDiagnosticAttempt(daemon, home,
  { ...process.env, FIXTURE_MODE: 'normal' }, 'version', record => { retainStarted(record, normalPid); records.push(record); });
const finished = records.find(record => record.event === 'finished');
assert.equal(finished.pid, Number(readFileSync(normalPid, 'utf8')));
assert.equal(finished.exitCode, 17);
assert.equal(finished.signal, null);
assert.equal(finished.termination, 'observed-exit');
assert(finished.pause >= 160);
const exceptions = records.filter(record => record.event === 'exception');
assert.equal(exceptions.length, 128);
assert.equal(exceptions[0].pause, finished.pause - 127);
assert.equal(exceptions.at(-1).pause, finished.pause);
assert(exceptions.some(record => record.frames.some(frame => frame.module === 'src/fixture.ts'
  && frame.function === 'retainedFile' && frame.staticThrow === 'Original native SQLite source changed')));
assert(!records.some(record => record.event === 'window-ended' || record.event === 'protocol-failed'));
groupDrained(normalPid);
const aborted = new AbortController(), reason = new Error('Original inert inspector cancellation');
let abortTimer;
records.length = 0;
try {
  await assert.rejects(inspectCompiledNativeDiagnosticAttempt(daemon, home,
    { ...process.env, FIXTURE_MODE: 'abort' }, 'default', record => {
      retainStarted(record, abortPid);
      records.push(record);
      if (record.event === 'attached') abortTimer = setTimeout(() => aborted.abort(reason), 100);
    }, aborted.signal), error => error === reason);
} finally { clearTimeout(abortTimer); }
assert(records.some(record => record.event === 'finished' && record.termination === 'cancelled'));
assert.equal(records.find(record => record.event === 'finished').pid, Number(readFileSync(abortPid, 'utf8')));
groupDrained(abortPid);
console.log(JSON.stringify({ naturalExit: 17, retainedExceptions: 128, observedExceptions: finished.pause, cancellation: 'original-reason', groups: 'drained' }));
`);
    // This is deliberately ordinary Node, matching the controller's production
    // WebSocket implementation. A leaked client socket prevents natural exit.
    const observed = spawnSync('node', [driver, daemon, normalPid, abortPid],
      { cwd: root, env: fixtureEnv, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
    expect(observed.status, observed.stderr).toBe(0);
    expect(observed.signal).toBe(null);
    const proof = JSON.parse(observed.stdout.trim());
    expect(proof).toMatchObject({ naturalExit: 17, retainedExceptions: 128, cancellation: 'original-reason', groups: 'drained' });
    expect(proof.observedExceptions).toBeGreaterThanOrEqual(160);
  } finally {
    const retired = await Promise.allSettled([retireFixture(normalPid), retireFixture(abortPid)]);
    rmSync(root, { recursive: true, force: true });
    const failures = retired.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Owned inert fixture cleanup failed.');
  }
}, 60_000);
