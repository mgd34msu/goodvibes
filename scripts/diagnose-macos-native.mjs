/** Failure-only inspector observations of the already installed native payload.
 * No locals, exception objects, configuration or process output is exported.
 * The only evaluation is the fixed read-only primitive process.exitCode.
 * Bun 1.3.14 accepts inspector runtime flags through BUN_OPTIONS in a
 * compiled executable; this does not rebuild or replace the released program.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { join, resolve } from 'node:path';
import { boundedNativeProcessClose, drainNativeProcessGroup } from '../products/daemon/scripts/native-execution-process.mjs';

const retainedExceptions = 128, retainedFrames = 12;
const compiledPath = /^\/\$bunfs\/root\/(?:entrypoint\.js|(?:(?:native|products\/daemon\/native)\/)?goodvibes-daemon(?:-(?:macos|darwin)-(?:x64|arm64))?)$/;
const maxSourceLength = 64 * 1024 * 1024, maxProtocolLength = 128 * 1024 * 1024;
const publicModule = /^(?:packages|products|node_modules|src)\/[A-Za-z0-9_@.+/-]+\.(?:[cm]?[jt]sx?)$/;
const publicFunction = /^[A-Za-z_$][A-Za-z0-9_$]*(?:[ .][A-Za-z_$][A-Za-z0-9_$]*)*$/;
const sourceIndexBrand = Symbol('private compiled source index');
const repairLine = 'Native daemon startup could not verify its installation. Repair using the released suite installer: curl -fsSL https://goodvibes.sh/install.sh | sh . The installer preserves existing application data.';
const startupPhases = new Set(['runtime-base', 'base-project-context', 'base-credentials', 'base-providers', 'base-knowledge',
  'base-native-intake-storage', 'base-native-intake-ready', 'runtime-base-failed', 'handler-surfaces', 'contract-recovery',
  'provider-preload', 'listener-construction', 'secondary-listener-construction', 'cluster-startup', 'device-recovery',
  'device-grant-sweep', 'device-capture-sweep', 'device-disclosure-read', 'device-disclosure-persist', 'listener-startup',
  'secondary-listener-startup', 'boot-tasks', 'foreground-ready']);
// Exact public producer literals only. Never inspect an exception description
// to guess its class or recover values swallowed by an application catch.
const staticThrows = new Set([
  'Original compiled Darwin SQLite owner is unavailable',
  'Darwin daemon target is unsupported',
  'Unsupported Darwin native SQLite architecture',
  'Native SQLite library is not the declared Mach-O architecture',
  'Native SQLite parent is not a regular directory',
  'Native SQLite companion must be a regular file with mode 0644',
  'Native SQLite companion exceeds its compiled size bound',
  'Native SQLite companion changed during bounded read',
  'Native SQLite lifetime must be synchronous',
  'Native SQLite runtime is undeclared',
  'Native SQLite compiled producer owner is absent or invalid',
  'Native SQLite library differs from the compiled producer bytes',
  'Native SQLite companion owner or bytes differ from the declared runtime',
  'Native SQLite companion changed before database construction',
  'Bun refused the retained native SQLite runtime before database construction',
  'Original native SQLite source changed',
  'Native daemon I/O requires retained file observations and reads',
  'Native daemon installation changed during preparation',
  'Native update directory is not a retained regular directory',
  'Native update payload is not a regular file',
]);

const coordinate = value => Number.isSafeInteger(value) && value >= 0 && value < 100_000_000 ? value : 0;
const revision = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid].join(':');
const safeSignal = signal => typeof signal === 'string' && Object.hasOwn(osConstants.signals, signal) ? signal : null;
const appendFailure = (failures, error) => {
  for (const value of error instanceof AggregateError ? error.errors : [error]) if (!failures.includes(value)) failures.push(value);
};

function compiledScriptKind(url) {
  if (typeof url !== 'string') return 'other';
  // Accept only literal local compiler URLs. Never normalize traversal, URL
  // authorities, escapes, query strings or arbitrary filesystem paths into one.
  if (compiledPath.test(url)) return 'compiled-path';
  if (url.startsWith('file:///') && compiledPath.test(url.slice('file://'.length))) return 'compiled-file-url';
  return 'other';
}
function scriptKind(url) {
  const compiled = compiledScriptKind(url);
  if (compiled !== 'other') return compiled;
  if (typeof url !== 'string') return 'other';
  if (url.startsWith('file:///$bunfs/')) return 'unrecognized-file-virtual';
  if (url.startsWith('/$bunfs/')) return 'unrecognized-virtual';
  if (url.startsWith('bun:') || url.startsWith('node:')) return 'builtin';
  return 'other';
}

function indexCompiledSource(text) {
  if (typeof text !== 'string' || text.length > maxSourceLength) return undefined;
  // A real bundle has over a million lines. Keep compact offsets rather than
  // allocating a second array of a million source strings on every script.
  const starts = [], markers = [];
  let start = 0, line = 0;
  while (start <= text.length) {
    starts.push(start);
    const newline = text.indexOf('\n', start), end = newline < 0 ? text.length : newline;
    const marker = /^\/\/ ((?:\.\.\/)*(?:packages|products|node_modules|src)\/[^\r\n]+)$/.exec(text.slice(start, end));
    if (marker) {
      const module = marker[1].replace(/^(?:\.\.\/)+/, '');
      if (module.length <= 240 && publicModule.test(module) && !module.split('/').includes('..')) markers.push({ line, module });
    }
    if (newline < 0) break;
    start = newline + 1; line++;
  }
  return { [sourceIndexBrand]: true, text, starts: Uint32Array.from(starts), markers, names: new Map() };
}

/** Inspect only static compiler module comments and the current source line.
 * Offsets describe bundled code; they are not claimed as TypeScript line maps.
 */
export function compiledDiagnosticFrame(frame, script, source) {
  const line = coordinate(frame?.location?.lineNumber), column = coordinate(frame?.location?.columnNumber);
  const index = source?.[sourceIndexBrand] ? source : indexCompiledSource(source);
  if (compiledScriptKind(script?.url) === 'other' || !index) {
    return { function: 'withheld', source: 'other', line, column };
  }
  const name = frame?.functionName;
  if (typeof name === 'string' && name.length <= 160 && publicFunction.test(name) && !index.names.has(name) && index.names.size < 4096) {
    index.names.set(name, index.text.includes(name));
  }
  const functionName = name === 'module code' || name === 'global code' ? name
    : index.names.get(name) === true ? name : 'withheld';
  const result = { function: functionName, source: 'compiled', line, column };
  const { starts, markers } = index;
  if (line >= starts.length) return result;
  let low = 0, high = markers.length - 1, selected = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (markers[middle].line <= line) { selected = middle; low = middle + 1; } else high = middle - 1;
  }
  if (selected >= 0) { result.module = markers[selected].module; result.moduleOffset = line - markers[selected].line; }
  const sourceLine = index.text.slice(starts[line], line + 1 < starts.length ? starts[line + 1] - 1 : index.text.length);
  const literals = [...sourceLine.matchAll(/\bthrow new (?:Error|TypeError|RangeError)\((['"])([^'"\\\r\n]*)\1\)/g)];
  if (literals.length === 1 && staticThrows.has(literals[0][2])) result.staticThrow = literals[0][2];
  return result;
}

async function inspectAttempt(daemon, home, env, attempt, emit, signal) {
  signal?.throwIfAborted();
  const args = attempt === 'version' ? ['--version'] : [];
  const timeoutMs = attempt === 'version' ? 30_000 : 60_000;
  const inspectorPath = '/goodvibes-native-diagnostic';
  const childEnv = { ...env, BUN_OPTIONS: `--inspect-brk=127.0.0.1:0${inspectorPath}`, GOODVIBES_NATIVE_STARTUP_OBSERVATION: '1' };
  for (const name of Object.keys(childEnv)) if (name.startsWith('BUN_INSPECT')) delete childEnv[name];
  let child;
  try { child = spawn(daemon, args, { cwd: home, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new Error('Native diagnostic child could not start.'); }
  const childPid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : undefined;
  let settleClose;
  const closed = new Promise(resolveClose => { settleClose = resolveClose; });
  let closeResult, spawnFailed = false;
  child.once('error', () => { spawnFailed = true; settleClose({ code: null, signal: null }); });
  child.once('close', (code, signal) => { closeResult = { code, signal: safeSignal(signal) }; settleClose(closeResult); });
  let failAttempt;
  const interrupted = new Promise((_yes, no) => { failAttempt = no; });
  // Attach immediately: a bounded protocol failure must never become an
  // unhandled rejection while the controller is still initializing.
  interrupted.catch(() => {});
  const scripts = new Map(), sources = new Map(), exceptions = [];
  let socket, nextId = 0, outputBytes = 0, stderrPrefix = '', lineRemainder = '', pauseCount = 0, attached = false, ended = false, detachRequested = false;
  let exitPoll, observedRepair = false, socketClosed = Promise.resolve(), describedScripts = 0;
  const observedPhases = new Set();
  let tasks = Promise.resolve();
  const pending = new Map();
  const fail = () => failAttempt(new Error('Native diagnostic inspector could not complete.'));
  const request = (method, params = {}) => new Promise((yes, no) => {
    if (ended || socket?.readyState !== WebSocket.OPEN) { no(new Error('Native diagnostic inspector is unavailable.')); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); no(new Error('Native diagnostic protocol exceeded its bound.')); }, 5_000);
    pending.set(id, { yes, no, timer });
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch { clearTimeout(timer); pending.delete(id); no(new Error('Native diagnostic protocol send failed.')); }
  });
  const detach = () => {
    if (ended || detachRequested) return;
    detachRequested = true;
    // Flush any already observed pause before detaching. Disconnection resumes
    // an outstanding pause in Bun as well; this never evaluates application code.
    tasks.then(() => socket?.close()).catch(fail);
  };
  const pollExit = async () => {
    if (ended || detachRequested) return;
    try {
      const observation = await request('Runtime.evaluate', { expression: 'process.exitCode', returnByValue: true,
        doNotPauseOnExceptionsAndMuteConsole: true, generatePreview: false });
      const value = observation?.result;
      if (!observation.wasThrown && value?.type === 'number' && Number.isSafeInteger(value.value) && value.value >= 0 && value.value <= 255) {
        emit({ phase: 'inspector', event: 'exit-intent', attempt, exitCode: value.value }); detach(); return;
      }
    } catch { if (!ended && !detachRequested) fail(); return; }
    if (!ended && !detachRequested) exitPoll = setTimeout(pollExit, 250);
  };
  const sourceFor = async scriptId => {
    const script = scripts.get(scriptId);
    if (compiledScriptKind(script?.url) === 'other') return undefined;
    if (!sources.has(scriptId)) {
      if (sources.size >= 8) return undefined;
      sources.set(scriptId, request('Debugger.getScriptSource', { scriptId }).then(result => {
        const source = result.scriptSource, indexed = indexCompiledSource(source);
        emit({ phase: 'inspector', event: 'source-index', attempt, scriptKind: compiledScriptKind(script.url),
          sourceLength: typeof source === 'string' ? source.length : 0, indexed: indexed !== undefined });
        return indexed;
      }));
    }
    return sources.get(scriptId);
  };
  const paused = async parameters => {
    try {
      if (parameters?.reason === 'exception') {
        pauseCount++;
        const frames = [];
        for (const frame of (Array.isArray(parameters.callFrames) ? parameters.callFrames : []).slice(0, retainedFrames)) {
          const scriptId = frame?.location?.scriptId;
          frames.push(compiledDiagnosticFrame(frame, scripts.get(scriptId), await sourceFor(scriptId)));
        }
        exceptions.push({ phase: 'inspector', event: 'exception', attempt, pause: pauseCount, frames });
        if (exceptions.length > retainedExceptions) exceptions.shift();
      }
    } finally {
      // Retention is rolling. An application can throw any number of caught
      // exceptions; this observer always lets it continue past the bound.
      if (!ended && socket?.readyState === WebSocket.OPEN) await request('Debugger.resume');
    }
  };
  const connect = url => {
    socket = new WebSocket(url);
    socketClosed = new Promise(resolveClose => { socket.addEventListener('close', resolveClose, { once: true }); });
    socket.addEventListener('error', () => { if (!ended && !detachRequested) fail(); });
    socket.addEventListener('message', event => {
      try {
      if (ended) return;
      if (typeof event.data !== 'string' || event.data.length > maxProtocolLength) { fail(); return; }
      let message;
      try { message = JSON.parse(event.data); } catch { fail(); return; }
      if (Number.isSafeInteger(message.id)) {
        const waiter = pending.get(message.id); if (!waiter) return;
        clearTimeout(waiter.timer); pending.delete(message.id);
        if (message.error) waiter.no(new Error('Native diagnostic protocol rejected its fixed request.'));
        else waiter.yes(message.result ?? {});
      } else if (message.method === 'Debugger.scriptParsed') {
        const script = message.params;
        if (typeof script?.scriptId === 'string' && scripts.size < 4096) {
          const url = compiledScriptKind(script.url) !== 'other' ? script.url
            : compiledScriptKind(script.sourceURL) !== 'other' ? script.sourceURL : script.url;
          scripts.set(script.scriptId, { url });
          if (describedScripts < 16) {
            describedScripts++; emit({ phase: 'inspector', event: 'script-observed', attempt, scriptKind: scriptKind(url) });
          }
        }
      } else if (message.method === 'Debugger.paused') {
        // Never retain the protocol's exception data, scopes, this values or
        // asynchronous runtime objects; only static call-frame coordinates.
        const parameters = { reason: message.params?.reason,
          callFrames: (Array.isArray(message.params?.callFrames) ? message.params.callFrames : []).slice(0, retainedFrames)
            .map(frame => ({ functionName: frame.functionName, location: frame.location })) };
        tasks = tasks.then(() => paused(parameters)).catch(fail);
      }
      } catch { fail(); }
    });
    socket.addEventListener('open', () => {
      tasks = tasks.then(async () => {
        await request('Inspector.enable');
        await request('Runtime.enable');
        await request('Debugger.enable');
        await request('Debugger.setPauseOnExceptions', { state: 'all' });
        await request('Debugger.setBreakpointsActive', { active: true });
        await request('Inspector.initialized');
        attached = true; emit({ phase: 'inspector', event: 'attached', attempt });
        exitPoll = setTimeout(pollExit, 250);
      }).catch(fail);
    });
  };
  const consume = (chunk, stderr) => {
    outputBytes += chunk.length;
    if (outputBytes > 1024 * 1024) { fail(); return; }
    if (stderr) {
      lineRemainder += chunk.toString('utf8');
      const lines = lineRemainder.split('\n'); lineRemainder = lines.pop().slice(-4096);
      for (const raw of lines) {
        const line = raw.replace(/\u001b\[[0-9;]*m/g, '').trim();
        const phase = /^\[goodvibes-daemon:native-startup-phase\] ([a-z-]+)$/.exec(line)?.[1];
        if (startupPhases.has(phase) && !observedPhases.has(phase)) {
          observedPhases.add(phase); emit({ phase: 'inspector', event: 'startup-phase', attempt, startupPhase: phase });
        }
        if (!observedRepair && (line === repairLine || line === `error: ${repairLine}` || line === `Error: ${repairLine}`)) {
          observedRepair = true;
          emit({ phase: 'inspector', event: 'startup-repair', attempt }); detach();
        }
      }
    }
    // Keep only a tiny startup prefix privately to discover this child's
    // loopback endpoint. No stdout/stderr is published or used as an error.
    if (!stderr || socket || stderrPrefix.length >= 16_384) return;
    stderrPrefix += chunk.toString('utf8').slice(0, 16_384 - stderrPrefix.length);
    const endpoint = /ws:\/\/127\.0\.0\.1:([0-9]{1,5})\/goodvibes-native-diagnostic(?=[\s\u001b]|$)/.exec(stderrPrefix);
    if (endpoint && Number(endpoint[1]) > 0 && Number(endpoint[1]) <= 65535) connect(`ws://127.0.0.1:${endpoint[1]}${inspectorPath}`);
  };
  child.stdout.on('data', chunk => { try { consume(chunk, false); } catch { fail(); } });
  child.stderr.on('data', chunk => { try { consume(chunk, true); } catch { fail(); } });
  const failures = [];
  let observationEnd = 'observed-exit';
  let rejectCancellation, windowTimer;
  const cancelled = new Promise((_yes, no) => { rejectCancellation = no; });
  cancelled.catch(() => {});
  const cancel = () => rejectCancellation(signal.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  const windowEnded = Symbol('diagnostic observation window ended');
  try {
    emit({ phase: 'inspector', event: 'started', attempt, ...(childPid === undefined ? {} : { pid: childPid }) });
    if (signal?.aborted) cancel();
    try {
      const result = await Promise.race([closed, interrupted, cancelled,
        new Promise(yes => { windowTimer = setTimeout(() => yes(windowEnded), timeoutMs); })]);
      if (result === windowEnded) {
        observationEnd = 'observation-window'; emit({ phase: 'inspector', event: 'window-ended', attempt });
      }
    }
    catch (error) {
      failures.push(error);
      observationEnd = signal?.aborted ? 'cancelled' : 'inspector-failure';
      if (!signal?.aborted) emit({ phase: 'inspector', event: 'protocol-failed', attempt });
    }
  } finally {
    ended = true;
    clearTimeout(windowTimer);
    clearTimeout(exitPoll);
    signal?.removeEventListener('abort', cancel);
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.no(new Error('Native diagnostic inspector closed.')); }
    pending.clear();
    try { socket?.close(); } catch { failures.push(new Error('Native diagnostic inspector transport could not close.')); }
    // Detaching lets a completed Bun program retire normally. A default daemon
    // that remains alive is still drained as the exact owned process group.
    try { await boundedNativeProcessClose(closed, 1_000, 'Native diagnostic child remains active.'); } catch {}
    try { await drainNativeProcessGroup(child, closed); }
    catch { failures.push(new Error('Native diagnostic process group did not drain.')); }
    try { await boundedNativeProcessClose(socketClosed, 2_000, 'Native diagnostic inspector transport did not drain.'); }
    catch { failures.push(new Error('Native diagnostic inspector transport did not drain.')); }
    await tasks;
    child.stdout.destroy(); child.stderr.destroy();
    for (const record of exceptions) emit(record);
    emit({ phase: 'inspector', event: 'finished', attempt, pause: pauseCount,
      ...(childPid === undefined ? {} : { pid: childPid }), termination: observationEnd,
      exitCode: Number.isInteger(closeResult?.code) ? closeResult.code : null, signal: closeResult?.signal ?? null });
  }
  if (signal?.aborted && !failures.includes(signal.reason)) failures.unshift(signal.reason);
  if (!signal?.aborted && (spawnFailed || !attached)) failures.push(new Error('Native diagnostic inspector attempt failed.'));
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Native diagnostic inspector attempt failed.');
}

// Diagnostic-tooling seam for the actual isolated compiled-fixture regression.
// The acceptance entry below additionally admits the original installed owner.
export { inspectAttempt as inspectCompiledNativeDiagnosticAttempt };

/** Caller admits the disposable original account and exact installed daemon.
 * Version runs beside the original managed service. Only then does the caller
 * retire that owned service before observing the original bare default argv.
 */
export async function diagnoseMacosNative({ daemon, home, env, stopService, onSafeEvidence, signal }) {
  signal?.throwIfAborted();
  assert.equal(process.platform, 'darwin', 'Native macOS diagnosis requires macOS.');
  assert.equal(typeof stopService, 'function'); assert.equal(typeof onSafeEvidence, 'function');
  assert.equal(resolve(home), home); assert.equal(realpathSync(home), home);
  assert.equal(daemon, join(home, '.local/bin/goodvibes-daemon'));
  assert.equal(realpathSync(daemon), daemon);
  assert.equal(env.HOME, home);
  assert.ok(!env.BUN_BE_BUN, 'Native diagnosis must retain the bundled entrypoint.');
  const homeOwner = lstatSync(home, { bigint: true });
  const fd = openSync(daemon, constants.O_RDONLY | constants.O_NOFOLLOW);
  let original;
  const assertCurrent = checkpoint => {
    onSafeEvidence({ phase: 'inspector', event: 'retained-file-recheck', checkpoint });
    const currentHome = lstatSync(home, { bigint: true }), current = lstatSync(daemon, { bigint: true });
    const descriptor = fstatSync(fd, { bigint: true }), changed = [];
    if (!currentHome.isDirectory() || currentHome.isSymbolicLink()) changed.push('home-type');
    for (const field of ['dev', 'ino', 'uid']) if (currentHome[field] !== homeOwner[field]) changed.push(`home-${field}`);
    if (!original.isFile() || !current.isFile() || current.isSymbolicLink()) changed.push('payload-type');
    for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid']) {
      if (descriptor[field] !== original[field]) changed.push(`retained-${field}`);
      if (current[field] !== original[field]) changed.push(`selected-${field}`);
    }
    if (changed.length) onSafeEvidence({ phase: 'inspector', event: 'owner-retired', checkpoint, changed });
    assert.ok(currentHome.isDirectory() && !currentHome.isSymbolicLink()
      && currentHome.dev === homeOwner.dev && currentHome.ino === homeOwner.ino && currentHome.uid === homeOwner.uid);
    assert.ok(original.isFile() && current.isFile() && !current.isSymbolicLink()
      && revision(descriptor) === revision(original) && revision(current) === revision(original));
    onSafeEvidence({ phase: 'inspector', event: 'retained-path-recheck', checkpoint });
    const selectedPath = realpathSync(daemon);
    if (selectedPath !== daemon) onSafeEvidence({ phase: 'inspector', event: 'owner-retired', checkpoint, changed: ['selected-path'] });
    assert.equal(selectedPath, daemon);
  };
  const failures = [];
  try {
    original = fstatSync(fd, { bigint: true });
    assertCurrent('before-version');
    try { await inspectAttempt(daemon, home, env, 'version', onSafeEvidence, signal); } catch (error) { appendFailure(failures, error); }
    signal?.throwIfAborted();
    assertCurrent('after-version');
    onSafeEvidence({ phase: 'inspector', event: 'service-stop-requested' });
    await stopService(signal); signal?.throwIfAborted(); assertCurrent('after-service-stop');
    onSafeEvidence({ phase: 'inspector', event: 'service-stopped' });
    try { await inspectAttempt(daemon, home, env, 'default', onSafeEvidence, signal); } catch (error) { appendFailure(failures, error); }
    signal?.throwIfAborted();
    assertCurrent('after-default'); onSafeEvidence({ phase: 'inspector', event: 'payload-retained' });
  } catch (error) { appendFailure(failures, error); }
  finally { try { closeSync(fd); } catch (error) { failures.push(error); } }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Native inspector diagnosis was incomplete.');
}
