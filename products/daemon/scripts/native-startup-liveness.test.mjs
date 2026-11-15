import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { assertNativeProcessGroupDrained, boundedNativeProcessClose, drainNativeProcessGroup } from './native-execution-process.mjs';
import { assertNativeStartupActive, assertNativeStartupBanners, hasNativeStartupReadyBanner, retainNativeStartupProgress } from './native-startup-liveness.mjs';

const marker = phase => `[goodvibes-daemon:native-startup-phase] ${phase}\n`;
const active = progress => assertNativeStartupActive(progress.snapshot(), { processClosed: false, requestCount: 0 });
function clock() {
  let now = 0;
  const progress = retainNativeStartupProgress(() => now);
  return { progress, advance(milliseconds) { now += milliseconds; } };
}
const banners = { pid: 123, version: '3.1.2', port: 18273 };
const starting = 'goodvibes-daemon 3.1.2 starting: intended-host="127.0.0.1" intended-port=18273';
const bound = 'goodvibes-daemon 3.1.2 bound: host="127.0.0.1" port=18273';
const ready = 'goodvibes-daemon 3.1.2 host started (ready)';

test('a slow start between phases is not a failure', () => {
  const f = clock(); f.progress.append(marker('runtime-base'), 0);
  f.advance(120_000); active(f.progress);
  f.progress.append(marker('base-knowledge'), 0); active(f.progress);
  assert.deepEqual(f.progress.snapshot().phases.map(row => [row.phase, row.delayMs]), [['runtime-base', 0], ['base-knowledge', 120_000]]);
});

test('any phase the daemon prints is recorded once, in arrival order, without a copy of the daemon list', () => {
  const f = clock();
  f.progress.append(marker('base-knowledge') + marker('a-phase-added-later') + marker('base-knowledge') + marker('Not A Token') + 'ordinary\n', 0);
  assert.deepEqual(f.progress.snapshot().phases.map(row => row.phase), ['base-knowledge', 'a-phase-added-later']);
});

test('partial and overlong log lines cannot supply a phase', () => {
  const f = clock(); f.progress.append('[goodvibes-daemon:native-startup-phase] runtime-', 0);
  f.progress.append('x'.repeat(200) + '\n' + 'ordinary\n', 0);
  assert.deepEqual(f.progress.snapshot().phases, []);
  f.progress.append('[goodvibes-daemon:native-startup-phase] runtime-', 0); f.advance(5); f.progress.append('base\n', 0);
  assert.deepEqual(f.progress.snapshot().phases, [{ phase: 'runtime-base', delayMs: 5, requestCount: 0 }]);
});

test('the fixed startup failure marker refuses immediately even after later-looking progress', () => {
  const f = clock(); f.progress.append(marker('foreground-ready'), 0);
  f.advance(1); f.progress.append(marker('runtime-base-failed'), 0);
  assert.throws(() => active(f.progress), /failed startup phase/);
});

test('semantic requests and an exited child refuse independently of progress and ready-looking output', () => {
  const f = clock(); f.progress.append(marker('foreground-ready'), 0);
  assert.throws(() => assertNativeStartupActive(f.progress.snapshot(), { processClosed: false, requestCount: 1 }), /made a semantic request/);
  assert.throws(() => assertNativeStartupActive(f.progress.snapshot(), { processClosed: true, requestCount: 0 }), /exited before readiness/);
});

test('foreground-ready phases and advisory listener claims cannot stand in for exact bound and ready banners', () => {
  const f = clock(); f.progress.append(marker('foreground-ready'), 0); active(f.progress);
  assert.throws(() => assertNativeStartupBanners({ ...banners, output: `${starting}\n${bound}\n` }), /readiness banner is missing/);
  assert.throws(() => assertNativeStartupBanners({ ...banners, output: `${starting}\n${ready}\n` }));
  assert.throws(() => assertNativeStartupBanners({ ...banners, output: `${starting}\n${ready}\n${bound}\n` }));
  assert.throws(() => assertNativeStartupBanners({ ...banners, output: `${starting}\n${bound}\nsome other host started\n` }), /readiness banner is missing/);
  assertNativeStartupBanners({ ...banners, output: `${starting}\n${bound}\n${ready}\n` });
});

test('partial ready chunks, unrelated logs and foreign versions cannot end the readiness wait', () => {
  const prefix = `${starting}\n${bound}\n`;
  assert.equal(hasNativeStartupReadyBanner(`${prefix}goodvibes-daemon 3.1.2 host started (rea`, banners.version), false);
  assert.equal(hasNativeStartupReadyBanner(`${prefix}some other host started\n`, banners.version), false);
  assert.equal(hasNativeStartupReadyBanner(`${prefix}goodvibes-daemon 99.0.0 host started (ready)\n`, banners.version), false);
  assert.equal(hasNativeStartupReadyBanner(`${prefix}${ready}\n`, banners.version), true);
  assert.equal(hasNativeStartupReadyBanner(`${prefix}goodvibes-daemon 3.1.2 host started (degraded)\n`, banners.version), true);
});

test('observation records are immutable', () => {
  const f = clock(); f.progress.append(marker('runtime-base'), 0);
  const observed = f.progress.snapshot();
  assert.throws(() => { observed.phases[0].phase = 'foreground-ready'; }, TypeError);
  assert.throws(() => observed.phases.push({ phase: 'foreground-ready' }), TypeError);
});

test('an actual child exit after its final phase cannot be accepted as native readiness', async () => {
  const child = spawn(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(marker('foreground-ready'))})`], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const f = clock(); child.stderr.on('data', chunk => f.progress.append(chunk, 0));
  const stopped = new Promise((yes, no) => { child.once('error', no); child.once('close', (code, signal) => yes({ code, signal })); });
  try {
    assert.deepEqual(await boundedNativeProcessClose(stopped, 2_000, 'Inert startup exit did not drain'), { code: 0, signal: null });
    assert.equal(f.progress.snapshot().phases[0]?.phase, 'foreground-ready');
    assert.throws(() => assertNativeStartupActive(f.progress.snapshot(), { processClosed: true, requestCount: 0 }), /exited before readiness/);
    assertNativeProcessGroupDrained(child);
  } finally {
    try { await drainNativeProcessGroup(child, stopped); }
    finally { child.stdout.destroy(); child.stderr.destroy(); }
  }
});
