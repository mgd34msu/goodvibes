/** Private .ips bodies stay local. Export only fixed native crash vocabulary.
 * Format: https://developer.apple.com/documentation/xcode/interpreting-the-json-format-of-a-crash-report
 */
import assert from 'node:assert/strict';
import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const processNames = new Set(['goodvibes-daemon', 'goodvibes-daemon-macos-x64', 'goodvibes-daemon-macos-arm64']);
const exceptions = new Set(['EXC_BAD_ACCESS', 'EXC_CRASH', 'EXC_BAD_INSTRUCTION', 'EXC_BREAKPOINT', 'EXC_RESOURCE', 'EXC_GUARD', 'EXC_SYSCALL', 'EXC_ARITHMETIC', 'EXC_EMULATION', 'EXC_SOFTWARE', 'EXC_CORPSE_NOTIFY']);
const signals = new Set(['SIGKILL', 'SIGSEGV', 'SIGABRT', 'SIGBUS', 'SIGILL', 'SIGTRAP', 'SIGTERM', 'SIGQUIT', 'SIGFPE', 'SIGSYS', 'SIGXCPU']);
const namespaces = new Set(['CODESIGNING', 'DYLD', 'SIGNAL', 'LIBSYSTEM', 'SANDBOX', 'RUNNINGBOARD', 'FRONTBOARD', 'TCC', 'ENDPOINTSECURITY', 'WATCHDOG', 'JETSAM', 'EXEC']);
const indicators = new Set(['Invalid Page', 'Invalid Signature', 'Code Signature Invalid', 'Library missing', 'Symbol missing', 'Malformed Mach-O', 'Incompatible library version', 'Library not loaded', 'Missing dependent library', 'Killed: 9', 'Segmentation fault: 11', 'Abort trap: 6', 'Bus error: 10', 'Illegal instruction: 4']);
const images = new Set([...processNames, 'libsqlite3.dylib', 'libsqlite3.0.dylib', 'vec0.dylib', 'dyld', 'libdyld.dylib', 'libsystem_kernel.dylib', 'libsystem_platform.dylib', 'libsystem_pthread.dylib', 'libsystem_c.dylib', 'libc++.1.dylib', 'libc++abi.dylib', 'JavaScriptCore']);
const symbols = new Set(['sqlite3_initialize', 'sqlite3_os_init', 'sqlite3_open_v2', 'sqlite3Malloc', 'sqlite3MallocZero', 'sqlite3_free', 'sqlite3_malloc64', 'sqlite3_msize', 'sqlite3_mutex_enter', 'sqlite3_mutex_leave', 'sqlite3_step', 'sqlite3_prepare_v2', 'sqlite3_auto_extension', 'sqlite3_extension_init', 'sqlite3_vec_init', 'sqlite3_vec0_init', 'abort', '__pthread_kill', 'pthread_kill', '__abort_with_payload', 'abort_with_payload', '__terminate_with_payload', 'dyld4::halt', 'dyld4::prepare', 'dyld4::Loader::runInitializersBottomUp', 'dyld4::APIs::dlopen_from', 'dlopen', 'dlsym', 'start', 'main', '_start', '__dyld_start']);
const revision = value => [value.dev, value.ino, value.mode, value.uid, value.nlink, value.size, value.mtimeMs, value.ctimeMs].join(':');
function timestamp(value) {
  if (typeof value !== 'string' || value.length > 64) return NaN;
  const native = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\.(\d+))? ([+-]\d\d)(\d\d)$/.exec(value);
  return Date.parse(native ? `${native[1]}T${native[2]}.${(native[3] ?? '').padEnd(3, '0').slice(0, 3)}${native[4]}:${native[5]}` : value);
}

export function summarizeMacosCrash(raw, { startedAtMs, nowMs = Date.now(), daemonPath }) {
  let report;
  try { report = JSON.parse(raw); }
  catch {
    const newline = raw.indexOf('\n');
    assert(newline > 0);
    const header = JSON.parse(raw.slice(0, newline));
    assert(header.bug_type === '309' || header.bug_type === 309);
    report = JSON.parse(raw.slice(newline + 1));
  }
  const mainImage = Array.isArray(report?.usedImages) ? report.usedImages[0] : undefined;
  assert(report && typeof daemonPath === 'string' && (report.procPath === daemonPath
    || mainImage?.path === daemonPath), 'Not a native daemon crash');
  const captured = timestamp(report.captureTime), launched = timestamp(report.procLaunch);
  assert(Number.isFinite(startedAtMs) && captured >= startedAtMs && captured <= nowMs && launched >= startedAtMs && launched <= captured, 'Not a fresh diagnostic process');
  const exception = {}, termination = {};
  if (exceptions.has(report.exception?.type)) exception.type = report.exception.type;
  if (signals.has(report.exception?.signal)) exception.signal = report.exception.signal;
  if (namespaces.has(report.termination?.namespace)) termination.namespace = report.termination.namespace;
  if (Number.isSafeInteger(report.termination?.code) && report.termination.code >= 0 && report.termination.code <= 0xffffffff) termination.code = report.termination.code;
  if (indicators.has(report.termination?.indicator)) termination.indicator = report.termination.indicator;
  const frames = [], threads = Array.isArray(report.threads) ? report.threads : [], used = Array.isArray(report.usedImages) ? report.usedImages : [];
  const triggered = threads.flatMap((thread, index) => thread?.triggered === true ? [index] : []);
  const index = Number.isSafeInteger(report.faultingThread) ? report.faultingThread : triggered.length === 1 ? triggered[0] : -1;
  if (index >= 0 && index < threads.length && triggered.every(value => value === index)) {
    for (const frame of (Array.isArray(threads[index]?.frames) ? threads[index].frames.slice(0, 8) : [])) {
      const image = Number.isSafeInteger(frame?.imageIndex) && frame.imageIndex >= 0 ? used[frame.imageIndex]?.name : undefined;
      if (!images.has(image)) continue;
      const safe = { image };
      if (symbols.has(frame.symbol)) safe.symbol = frame.symbol;
      frames.push(safe);
    }
  }
  return { exception, termination, frames };
}

export function collectMacosCrashes({ directory, startedAtMs, nowMs = Date.now(), uid = process.getuid(), daemonPath }) {
  const reports = [];
  try {
    assert(Number.isFinite(startedAtMs) && startedAtMs <= nowMs);
    const owner = lstatSync(directory);
    assert(owner.isDirectory() && !owner.isSymbolicLink() && owner.uid === uid && realpathSync(directory) === directory);
    const candidates = [], stream = opendirSync(directory);
    try {
      for (let count = 0, entry; count < 512 && (entry = stream.readSync()); count++) {
        if (!entry.name.endsWith('.ips')) continue;
        const path = join(directory, entry.name), stat = lstatSync(path);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid && stat.nlink === 1 && stat.mtimeMs >= startedAtMs && stat.mtimeMs <= nowMs && stat.size > 0 && stat.size <= 2 * 1024 * 1024) candidates.push({ path, stat });
      }
    } finally { stream.closeSync(); }
    for (const candidate of candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, 16)) {
      let fd;
      try {
        fd = openSync(candidate.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        assert(revision(fstatSync(fd)) === revision(candidate.stat));
        const bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
        let length = 0, count;
        while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
        assert(length <= 2 * 1024 * 1024 && length === candidate.stat.size);
        const raw = bytes.subarray(0, length).toString('utf8');
        assert(revision(fstatSync(fd)) === revision(candidate.stat) && revision(lstatSync(candidate.path)) === revision(candidate.stat));
        reports.push(summarizeMacosCrash(raw, { startedAtMs, nowMs, daemonPath }));
      } catch { /* Invalid, stale, changing or ambiguous private reports stay private. */ }
      finally { if (fd !== undefined) closeSync(fd); }
    }
    const current = lstatSync(directory);
    assert(current.isDirectory() && !current.isSymbolicLink() && current.uid === uid && current.ino === owner.ino && current.dev === owner.dev && realpathSync(directory) === directory);
  } catch { return { schema: 1, status: 'unavailable', reports: [] }; }
  return { schema: 1, status: reports.length ? 'reports-found' : 'no-matching-reports', reports };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [startFile, outputFile] = process.argv.slice(2);
  try {
  assert(process.platform === 'darwin' && process.getuid() !== 0 && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted' && homedir() === userInfo().homedir, 'Disposable hosted macOS account required');
  const start = JSON.parse(readFileSync(startFile, 'utf8'));
  const directory = join(realpathSync(homedir()), 'Library/Logs/DiagnosticReports');
  let result;
  for (let attempt = 0; attempt < 4; attempt++) {
    result = collectMacosCrashes({ directory, startedAtMs: start.startedAtMs, daemonPath: join(realpathSync(homedir()), '.local/bin/goodvibes-daemon') });
    if (result.status !== 'no-matching-reports' || attempt === 3) break;
    await new Promise(yes => setTimeout(yes, 1_000));
  }
  writeFileSync(outputFile, JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
  } catch {
    try { writeFileSync(outputFile, JSON.stringify({ schema: 1, status: 'unavailable', reports: [] }) + '\n', { flag: 'wx', mode: 0o600 }); } catch { /* Never overwrite another diagnostic owner. */ }
    console.error('macOS crash summary unavailable; private report details withheld.');
    process.exitCode = 1;
  }
}
