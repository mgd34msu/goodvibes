import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { assertNativeProcessGroupDrained, boundedNativeProcessClose, drainNativeProcessGroup, runNativeBuildCommand, signalNativeProcessGroup } from './native-execution-process.mjs';

test('owned timeout signals the descendant group that holds inherited output', async () => {
  // Real inert Node children; no compiler, provider, model or daemon service.
  const source = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr]});
    child.once('spawn',()=>process.stdout.write('ready\\n')); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stopped = new Promise((yes, no) => { child.once('error', no); child.once('close', (code, signal) => yes({ code, signal })); });
  try {
    const ready = new Promise((yes, no) => { child.stdout.once('data', chunk => chunk.toString() === 'ready\n' ? yes() : no(new Error('Unexpected fixture readiness'))); });
    await boundedNativeProcessClose(ready, 2_000, 'Inert process fixture startup deadline');
    signalNativeProcessGroup(child);
    assert.deepEqual(await boundedNativeProcessClose(stopped, 2_000, 'Inherited output close deadline'), { code: null, signal: 'SIGKILL' });
    await drainNativeProcessGroup(child, stopped); assertNativeProcessGroupDrained(child);
  } finally {
    try { await drainNativeProcessGroup(child, stopped); } finally { child.stdout.destroy(); child.stderr.destroy(); }
  }
});

test('a close promise that never resolves refuses within its explicit budget', async () => {
  await assert.rejects(boundedNativeProcessClose(new Promise(() => {}), 10, 'bounded-close-fixture'), /bounded-close-fixture/);
});

test('native build deadline drains descendants that retain inherited output', async () => {
  const source = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr]});
    child.once('spawn',()=>process.stdout.write(JSON.stringify({parent:process.pid,descendant:child.pid})+'\\n'));
    setInterval(()=>{},1000);`;
  let output = '';
  await assert.rejects(runNativeBuildCommand(process.execPath, ['-e', source], {
    timeoutMs: 2_000, onStdout: chunk => { output += chunk; }, onStderr: () => {},
  }), /Native build command exceeded its deadline/);
  const owner = JSON.parse(output.trim());
  assert(Number.isSafeInteger(owner.descendant) && owner.descendant > 0);
  assert.throws(() => process.kill(-owner.parent, 0), { code: 'ESRCH' });
});

test('native build returns source diagnostics and nonzero status after draining', async () => {
  const streamed = { stdout: '', stderr: '' };
  const result = await runNativeBuildCommand(process.execPath, ['-e', "process.stdout.write('compile\\n'); process.stderr.write('sqlite3.c:1: error: invalid source\\n'); process.exitCode=7;"], {
    timeoutMs: 2_000,
    onStdout: chunk => { streamed.stdout += chunk; }, onStderr: chunk => { streamed.stderr += chunk; },
  });
  assert.deepEqual(result, { exitCode: 7, output: 'compile\n\nsqlite3.c:1: error: invalid source\n' });
  assert.deepEqual(streamed, { stdout: 'compile\n', stderr: 'sqlite3.c:1: error: invalid source\n' });
});

test('native build abort preserves its reason and drains the exact owned group', async () => {
  const controller = new AbortController(), reason = new Error('native-build-abort-fixture');
  const source = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr]});
    child.once('spawn',()=>process.stdout.write(JSON.stringify({parent:process.pid,descendant:child.pid})+'\\n'));
    setInterval(()=>{},1000);`;
  let output = '';
  await assert.rejects(runNativeBuildCommand(process.execPath, ['-e', source], {
    timeoutMs: 2_000, signal: controller.signal,
    onStdout: chunk => { output += chunk; if (output.includes('\n')) controller.abort(reason); }, onStderr: () => {},
  }), error => error === reason);
  const owner = JSON.parse(output.trim());
  assert(Number.isSafeInteger(owner.descendant) && owner.descendant > 0);
  assert.throws(() => process.kill(-owner.parent, 0), { code: 'ESRCH' });
});

test('already aborted native build refuses before spawning a command', async () => {
  const controller = new AbortController(), reason = new Error('native-build-already-aborted-fixture');
  controller.abort(reason);
  await assert.rejects(runNativeBuildCommand('/absent/native-build-must-not-spawn', [], { signal: controller.signal }), error => error === reason);
});

test('native build refuses output beyond its retained bound', async () => {
  await assert.rejects(runNativeBuildCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(65)); setInterval(()=>{},1000);"], {
    timeoutMs: 2_000, maxOutputBytes: 64, onStdout: () => {}, onStderr: () => {},
  }), /Native build command exceeded its output limit/);
});
