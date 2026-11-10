import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { assertNativeProcessGroupDrained, boundedNativeProcessClose, drainNativeProcessGroup } from './native-execution-process.mjs';
import { assertNativeStartupActive, assertNativeStartupBanners, hasNativeStartupReadyBanner, nativeStartupPhases, retainNativeStartupProgress } from './native-startup-liveness.mjs';

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

test('a silent startup expires at the unchanged twenty-second no-progress boundary', () => {
  const f = clock(); f.advance(19_999); active(f.progress);
  f.advance(1);
  assert.throws(() => active(f.progress), /no forward phase progress for 20 seconds/);
  assert.equal(f.progress.snapshot().elapsedMs, 20_000);
});

test('finite forward startup work can exceed twenty seconds total without a twenty-second stall', () => {
  const f = clock();
  for (const phase of nativeStartupPhases.filter(phase => phase !== 'runtime-base-failed')) {
    f.advance(19_000); f.progress.append(marker(phase), 0); active(f.progress);
  }
  const observed = f.progress.snapshot();
  assert(observed.elapsedMs > 20_000);
  assert.equal(observed.phases.length, nativeStartupPhases.length - 1);
  assert.equal(observed.noProgressMs, 0);
  f.advance(20_000);
  assert.throws(() => active(f.progress), /no forward phase progress/);
});

test('optional omitted stages do not prevent actual forward progress', () => {
  const f = clock();
  f.progress.append(marker('listener-construction'), 0);
  f.advance(19_000); f.progress.append(marker('cluster-startup'), 0); active(f.progress);
  f.advance(19_000); f.progress.append(marker('listener-startup'), 0); active(f.progress);
  f.advance(19_000); f.progress.append(marker('boot-tasks'), 0); active(f.progress);
  assert.deepEqual(f.progress.snapshot().phases.map(row => row.phase), ['listener-construction', 'cluster-startup', 'listener-startup', 'boot-tasks']);
});

test('duplicates, backward phases, unknown phases and log spam cannot keep a stalled stage alive', () => {
  const f = clock(); f.progress.append(marker('base-knowledge'), 0);
  f.advance(19_000);
  f.progress.append(marker('base-knowledge') + marker('base-providers') + marker('unknown-stage') + 'still working\n', 0);
  assert.equal(f.progress.snapshot().noProgressMs, 19_000);
  assert.deepEqual(f.progress.snapshot().phases.map(row => row.phase), ['base-knowledge']);
  f.advance(1_000);
  assert.throws(() => active(f.progress), /no forward phase progress/);
});

test('partial and overlong log lines cannot supply forward phase progress', () => {
  const f = clock(); f.progress.append('[goodvibes-daemon:native-startup-phase] runtime-', 0);
  f.advance(19_000); f.progress.append('x'.repeat(200) + '\n' + 'ordinary\n', 0);
  assert.deepEqual(f.progress.snapshot().phases, []);
  f.advance(1_000); assert.throws(() => active(f.progress), /no forward phase progress/);
});

test('split legitimate markers advance only when the complete line arrives', () => {
  const f = clock(); f.progress.append('[goodvibes-daemon:native-startup-phase] runtime-', 0);
  f.advance(19_000); f.progress.append('base\n', 0);
  assert.deepEqual(f.progress.snapshot().phases, [{ phase: 'runtime-base', delayMs: 19_000, requestCount: 0 }]);
  f.advance(19_999); active(f.progress);
  f.advance(1); assert.throws(() => active(f.progress), /no forward phase progress/);
});

test('a late first or later phase cannot revive an expired startup observation', () => {
  for (const initial of [false, true]) {
    const f = clock(); if (initial) f.progress.append(marker('runtime-base'), 0);
    f.advance(20_000); f.progress.append(marker('base-project-context'), 0);
    assert.throws(() => active(f.progress), /no forward phase progress/);
    f.advance(1); f.progress.append(marker('foreground-ready'), 0);
    assert.throws(() => active(f.progress), /no forward phase progress/);
  }
});

test('the fixed startup failure marker refuses immediately even after later-looking progress', () => {
  const f = clock(); f.progress.append(marker('foreground-ready'), 0);
  f.advance(1); f.progress.append(marker('runtime-base-failed'), 0);
  assert.equal(f.progress.snapshot().stalled, false);
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

test('observation records are immutable and cannot create an extra progress allowance', () => {
  const f = clock(); f.progress.append(marker('runtime-base'), 0);
  const observed = f.progress.snapshot();
  assert.throws(() => { observed.phases[0].phase = 'foreground-ready'; }, TypeError);
  assert.throws(() => observed.phases.push({ phase: 'foreground-ready' }), TypeError);
  f.advance(20_000); assert.throws(() => active(f.progress), /no forward phase progress/);
});

test('an actual stalled owned process is killed and drained without a semantic request or retry', async () => {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('inert-started\\n');setInterval(()=>{},1000)"], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stopped = new Promise((yes, no) => { child.once('error', no); child.once('close', (code, signal) => yes({ code, signal })); });
  try {
    const entered = new Promise((yes, no) => child.stdout.once('data', chunk => String(chunk) === 'inert-started\n' ? yes() : no(new Error('Unexpected inert child output'))));
    await boundedNativeProcessClose(entered, 2_000, 'Inert startup fixture did not enter');
    const f = clock(); f.progress.append(marker('runtime-base'), 0); f.advance(20_000);
    assert.throws(() => active(f.progress), /no forward phase progress/);
    await drainNativeProcessGroup(child, stopped); assertNativeProcessGroupDrained(child);
    assert.deepEqual(await stopped, { code: null, signal: 'SIGKILL' });
  } finally {
    try { await drainNativeProcessGroup(child, stopped); }
    finally { child.stdout.destroy(); child.stderr.destroy(); }
  }
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
