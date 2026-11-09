import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

function groupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

/** Call only for the retained ChildProcess just created with detached:true. */
export function signalNativeProcessGroup(child, signal = 'SIGKILL') {
  if (child.pid === undefined) { child.kill(signal); return; }
  assert(Number.isSafeInteger(child.pid) && child.pid > 0 && child.pid !== process.pid, 'Retain the actual owned child process group');
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

export function assertNativeProcessGroupDrained(child) {
  if (child.pid !== undefined) assert(!groupExists(child.pid), 'Native command left an owned process group');
}

export async function boundedNativeProcessClose(stopped, milliseconds, message) {
  let timer;
  try { return await Promise.race([stopped, new Promise((_, no) => { timer = setTimeout(() => no(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

export async function drainNativeProcessGroup(child, stopped) {
  signalNativeProcessGroup(child);
  await boundedNativeProcessClose(stopped.catch(() => {}), 2_000, 'Owned native close did not drain');
  const started = Date.now();
  while (child.pid && groupExists(child.pid) && Date.now() - started < 2_000) await new Promise(yes => setTimeout(yes, 20));
  assertNativeProcessGroupDrained(child);
}

/** The archive producer writes only to its caller's retained exclusive file
 * descriptor, never an output pathname. Own its complete group through close. */
export async function runNativeArchive(members, cwd, fd, signal) {
  assert(Array.isArray(members) && members.length > 0 && members.every(path => typeof path === 'string'
    && path.length > 0 && !path.startsWith('-') && !path.startsWith('/') && !path.includes('\\')
    && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')), 'Native archive requires fixed relative members');
  signal?.throwIfAborted();
  const child = spawn('tar', ['--format=ustar', '-czf', '-', ...members], { cwd, detached: true, stdio: ['ignore', fd, 'ignore'] });
  const closed = new Promise((yes, no) => {
    child.once('error', no);
    child.once('close', (code, stoppedBy) => code === 0 && stoppedBy === null ? yes() : no(new Error('Native archive command failed')));
  });
  let rejectCancellation;
  const cancelled = new Promise((_yes, no) => { rejectCancellation = no; });
  const cancel = () => {
    try { signalNativeProcessGroup(child, 'SIGTERM'); rejectCancellation(new Error('Native archive cancelled')); }
    catch (error) { rejectCancellation(error); }
  };
  signal?.addEventListener('abort', cancel, { once: true });
  let failure, failed = false;
  try {
    if (signal?.aborted) cancel();
    await boundedNativeProcessClose(Promise.race([closed, cancelled]), 30_000, 'Native archive command exceeded its deadline');
    signal?.throwIfAborted();
  } catch (error) { failure = error; failed = true; }
  finally {
    signal?.removeEventListener('abort', cancel);
    try { await drainNativeProcessGroup(child, closed); }
    catch (error) { failure = failed ? new AggregateError([failure, error], 'Native archive drain failed') : error; failed = true; }
  }
  if (failed) throw failure;
  signal?.throwIfAborted();
}
