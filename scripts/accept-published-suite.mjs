/** Native lifecycle acceptance on disposable GitHub-hosted accounts only.
 * Public and staged delivery share the actual source installer, compiled native
 * programs and original service manager; no simulated service substitutes. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { constants as osConstants, tmpdir, userInfo } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { boundedNativeProcessClose, drainNativeProcessGroup, signalNativeProcessGroup } from '../products/daemon/scripts/native-execution-process.mjs';

const repository = 'mgd34msu/goodvibes';
const products = ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent'];
const unit = 'goodvibes.service', label = 'sh.goodvibes.daemon';

/** Harness inspection only. Consume the dedicated credential before any child
 * environment is captured; the installer, assets and updater stay anonymous. */
export function consumeAcceptanceMetadataFetch(env = process.env, fetchImpl = fetch) {
  const token = env.GOODVIBES_ACCEPTANCE_METADATA_TOKEN;
  delete env.GOODVIBES_ACCEPTANCE_METADATA_TOKEN;
  const tag = 'v[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?';
  const route = new RegExp(`^https://api\\.github\\.com/repos/mgd34msu/goodvibes/(?:releases/(?:latest|tags/${tag})|git/ref/tags/${tag}|git/tags/[a-f0-9]{40})$`);
  return {
    authentication: token ? 'read-only-ci-token' : 'anonymous',
    fetch(url, options) {
      if (typeof url !== 'string' || url.trim() !== url || !route.test(url) || options?.method !== undefined && options.method !== 'GET') return fetchImpl(url, options);
      const headers = token ? new Headers(options?.headers) : undefined;
      if (headers) headers.set('authorization', `Bearer ${token}`);
      // No credential can follow a redirect, even to another GitHub endpoint.
      return fetchImpl(url, { ...options, redirect: 'error', ...(headers ? { headers } : {}) });
    },
  };
}

const safeErrorNames = new Set(['Error', 'AssertionError', 'TypeError', 'SyntaxError', 'RangeError', 'AggregateError', 'AbortError', 'TimeoutError']);
const safeErrorCodes = new Set(['ERR_ASSERTION', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'EBADF', 'EIO', 'EINVAL',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ABORT_ERR', 'ERR_ACCEPTANCE_READINESS_TIMEOUT']);
const safeError = error => ({ name: safeErrorNames.has(error?.name) ? error.name : 'Error',
  ...(safeErrorCodes.has(error?.code) ? { code: error.code } : {}) });
const safeExitSignal = signal => typeof signal === 'string' && Object.hasOwn(osConstants.signals, signal) ? signal : undefined;
const nativeDaemonFailureKinds = new Set(['token-missing', 'invalid-port', 'unreachable', 'auth-refused', 'route-missing',
  'unreadable-reply', 'cli-command-caught', 'native-startup-repair', 'unknown']);
const nativeStartupFailureCodes = new Set(['SQLITE_ARCH_UNSUPPORTED', 'SQLITE_ARCH_MISMATCH', 'SQLITE_PARENT_TYPE', 'SQLITE_FILE_MODE',
  'SQLITE_SIZE_BOUND', 'SQLITE_READ_CHANGED', 'SQLITE_LIFETIME_ASYNC', 'SQLITE_RUNTIME_UNDECLARED', 'SQLITE_COMPILED_OWNER',
  'SQLITE_BYTES_MISMATCH', 'SQLITE_PROVENANCE_MISMATCH', 'SQLITE_ADMISSION_CHANGED', 'SQLITE_LOADER_REFUSED', 'SQLITE_SOURCE_CHANGED',
  'DARWIN_SQLITE_OWNER', 'DARWIN_TARGET', 'DARWIN_IO_OBSERVATIONS', 'DARWIN_SOURCE_CHANGED',
  'ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'EBADF', 'EIO', 'ELOOP', 'ERR_DLOPEN_FAILED', 'METADATA_JSON', 'UNKNOWN']);
function nativeStartupFailure(stdout, stderr) {
  for (const output of [stderr, stdout]) for (const line of output.split(/\r?\n/)) {
    const match = /^\[goodvibes-daemon:native-startup-failure\] (sqlite|darwin-original) ([A-Z_]+)$/.exec(line.replace(/\u001b\[[0-9;]*m/g, '').trim());
    if (match && nativeStartupFailureCodes.has(match[2])) return { stage: match[1], code: match[2] };
  }
}

/** Match only fixed producer vocabulary. All private error/fix/target/header
 * values remain local, including malformed or malicious machine responses. */
function nativeDaemonFailure(stdout, stderr) {
  for (const output of [stderr, stdout]) {
    const lines = output.split(/\r?\n/).map(line => line.replace(/\u001b\[[0-9;]*m/g, '').trim());
    if (lines.includes('Daemon command failed')) return 'cli-command-caught';
    const repair = 'Native daemon startup could not verify its installation. Repair using the released suite installer: curl -fsSL https://goodvibes.sh/install.sh | sh . The installer preserves existing application data.';
    if (lines.some(line => line === repair || line === `error: ${repair}` || line === `Error: ${repair}`)) return 'native-startup-repair';
    // CLI warnings may precede its final pretty-printed failure object.
    const start = output.indexOf('{\n  "ok": false,');
    let failure;
    try { failure = JSON.parse(start < 0 ? output.trim() : output.slice(start)); } catch { continue; }
    if (failure?.ok !== false || typeof failure.error !== 'string') continue;
    const error = failure.error;
    if (error === 'no operator token was found for this machine') return 'token-missing';
    if (error.startsWith("'") && error.endsWith("' is not a usable port")) return 'invalid-port';
    if (error === 'could not reach the daemon on this machine' || error.startsWith('could not reach the daemon at ')) return 'unreachable';
    const where = suffix => error === `the daemon on this machine${suffix}` || error.startsWith('the daemon at ') && error.endsWith(suffix);
    if (where(' refused the operator token')) return 'auth-refused';
    if (where(' does not know this command')) return 'route-missing';
    if (where(' sent a reply this build could not read')) return 'unreadable-reply';
  }
  return 'unknown';
}

function preserveAcceptanceCancellation(error, signal) {
  if (!signal?.aborted || error === signal.reason || (error instanceof AggregateError && error.errors.includes(signal.reason))) return error;
  return new AggregateError([signal.reason, error], 'Acceptance cancellation and owned operation failed.');
}

/** Copy only owned checkpoints and safe error classes, never assertion values,
 * messages, paths, or status/configuration output into the public receipt. */
export function acceptanceFailureRecord(evidence, error) {
  return { stage: evidence.stage, check: evidence.check, command: evidence.command, exitCode: evidence.exitCode,
    diagnostics: evidence.diagnostics, error: safeError(error),
    ...(Number.isInteger(evidence.httpStatus) && evidence.httpStatus >= 100 && evidence.httpStatus <= 599 ? { httpStatus: evidence.httpStatus } : {}),
    ...(['previous', 'target', 'other'].includes(evidence.observedRelease) ? { observedRelease: evidence.observedRelease } : {}),
    ...(evidence.exitCode !== 0 && safeExitSignal(evidence.exitSignal) ? { exitSignal: evidence.exitSignal } : {}),
    ...(Number.isInteger(evidence.exitCode) && evidence.exitCode !== 0 && nativeDaemonFailureKinds.has(evidence.nativeDaemonFailure)
      ? { nativeDaemonFailure: evidence.nativeDaemonFailure } : {}),
    ...(Number.isInteger(evidence.exitCode) && evidence.exitCode !== 0 && evidence.nativeStartupFailure
      && ['sqlite', 'darwin-original'].includes(evidence.nativeStartupFailure.stage) && nativeStartupFailureCodes.has(evidence.nativeStartupFailure.code)
      ? { nativeStartupFailure: { stage: evidence.nativeStartupFailure.stage, code: evidence.nativeStartupFailure.code } } : {}),
    ...(error?.code === 'ERR_ACCEPTANCE_READINESS_TIMEOUT' ? { lastProbeError: safeError(error.cause) } : {}) };
}

export function markAcceptanceCheckpoint(evidence, check) {
  evidence.check = check; evidence.command = undefined; evidence.exitCode = undefined; evidence.exitSignal = undefined;
  evidence.diagnostics = undefined; evidence.nativeDaemonFailure = undefined; evidence.nativeStartupFailure = undefined;
  evidence.httpStatus = undefined;
  evidence.observedRelease = undefined;
}

/** Every attempt observes the actual service before the status/HTTP proof.
 * Failed probes retain their safe cause; cancellation keeps its original reason
 * and interrupts the owned retry timer rather than waiting for the next probe. */
export async function waitForAcceptanceReadiness(serviceReady, verifyReady, { signal, timeoutMs = 90_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs; let lastError;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      await serviceReady(); signal?.throwIfAborted();
      await verifyReady(); signal?.throwIfAborted(); return;
    } catch (error) {
      if (signal?.aborted) throw preserveAcceptanceCancellation(error, signal);
      lastError = error;
    }
    try { await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())), undefined, { signal }); }
    catch (error) {
      if (signal?.aborted && error?.name === 'AbortError' && error?.code === 'ABORT_ERR') throw signal.reason;
      throw preserveAcceptanceCancellation(error, signal);
    }
  }
  signal?.throwIfAborted();
  const error = new Error('Acceptance readiness did not become complete before its existing deadline.', { cause: lastError });
  error.code = 'ERR_ACCEPTANCE_READINESS_TIMEOUT'; throw error;
}

/** launchctl bootout can return before print stops finding the original job.
 * Keep only the first and final fixed/numeric observations, never its output. */
export async function waitForNativeServiceRetirement(probe, { signal, onObservation, intervalMs = 500 } = {}) {
  let first, last;
  const observe = result => {
    const state = /^\s*state = (running|not running|spawn scheduled)\s*$/m.exec(result.stdout)?.[1];
    const number = (key, signed = false) => {
      const found = new RegExp(`^\\s*${key} = (${signed ? '-?' : ''}\\d+)\\s*$`, 'm').exec(result.stdout)?.[1];
      const value = found === undefined ? undefined : Number(found);
      return Number.isSafeInteger(value) && (!signed || value >= -2147483648 && value <= 2147483647) ? value : undefined;
    };
    const pid = number('pid'), runs = number('runs'), lastExitCode = number('last exit code', true);
    return { exitCode: result.code, signal: safeExitSignal(result.exitSignal) ?? null,
      state: state === 'running' ? 'running' : state === 'not running' ? 'notrunning' : state === 'spawn scheduled' ? 'spawn-scheduled' : 'other',
      ...(pid !== undefined && pid > 0 && pid <= 2147483647 ? { pid } : {}),
      ...(runs === undefined ? {} : { runs }), ...(lastExitCode === undefined ? {} : { lastExitCode }) };
  };
  try {
    await waitForAcceptanceReadiness(async () => {
      const result = await probe(); signal?.throwIfAborted(); last = observe(result);
      if (!first) { first = last; onObservation?.(first); }
      assert.equal(result.exitSignal, undefined, 'A terminated print probe cannot prove native service retirement.');
      assert.notEqual(result.code, 0, 'The original native service must retire before foreground diagnosis.');
    }, async () => {}, { signal, intervalMs });
  } finally { if (last && last !== first) onObservation?.(last); }
}

/** Cleanup intentionally survives cancellation. A receipt may be written only
 * after the owned delivery has drained and the original owner is still active. */
export async function finishAcceptance({ signal, finish, assertCurrent, writeReceipt }) {
  try { await finish?.(); assertCurrent?.(); }
  catch (error) { throw preserveAcceptanceCancellation(error, signal); }
  signal?.throwIfAborted(); writeReceipt();
}

// Acceptance-only metadata: Bash (including macOS sh) records source line
// numbers without tracing commands, arguments or credentials. Dash skips this.
// Opening/closing the private scalar journal avoids passing another descriptor
// into installed services. Freeze before the installer's EXIT cleanup runs.
const installerLineProbe = `if [ -n "\${BASH_VERSION:-}" ]; then
  set -T
  trap 'case "\${FUNCNAME[0]-}:$BASH_COMMAND" in cleanup_release_install:*|*:cleanup_release_install) trap - DEBUG ;; *) if [ "\${BASH_SOURCE[0]-}" = "$GOODVIBES_ACCEPTANCE_SOURCE_PATH" ] && [ "$LINENO" -gt 0 ] && [ "$LINENO" -le "$GOODVIBES_ACCEPTANCE_LINE_LIMIT" ]; then printf "%s\\n" "$LINENO" 2>/dev/null >"$GOODVIBES_ACCEPTANCE_LINE_PATH" || :; fi ;; esac' DEBUG
fi
. "$0"`;

/** Emit public source literals and fixed error classes only. In particular,
 * paths, expanded shell variables and unrelated stdout/stderr stay private. */
function installerFailureDiagnostics(source, stdout, stderr) {
  const templates = [], sourceLines = source.split('\n').length;
  for (const match of source.matchAll(/\bfail\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/g)) {
    const text = (match[1] ?? match[2]).split('\n')[0];
    // Unsupported shell quoting/substitution must never turn into raw output.
    if (!text || /[\\`]|\$\(/.test(text)) continue;
    const parts = match[1] !== undefined ? [text] : text.split(/(\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?]))/g);
    if (!parts.some((part, index) => index % 2 === 0 && /[A-Za-z]{3}/.test(part))) continue;
    templates.push({ literals: parts.filter((_part, index) => index % 2 === 0).map((part, index) => index === 0 ? `install.sh: ${part}` : part),
      diagnostic: `install.sh: ${parts.map((part, index) => index % 2 ? '[redacted]' : part).join('')}`.slice(0, 512) });
  }
  const diagnostics = new Set();
  for (const line of `${stderr}\n${stdout}`.split(/\r?\n/)) {
    const template = templates.find(({ literals }) => {
      if (literals.length === 1) return line === literals[0];
      if (!line.startsWith(literals[0]) || !line.endsWith(literals.at(-1))) return false;
      let offset = literals[0].length;
      return literals.slice(1).every(literal => {
        const found = line.indexOf(literal, offset); if (found < 0) return false;
        offset = found + literal.length; return true;
      });
    });
    if (template) diagnostics.add(template.diagnostic);
    // Shells print different prefixes; preserve only an in-range source line.
    const number = /:\s*(?:line\s+)?(\d+):/.exec(line)?.[1];
    const location = number && Number(number) > 0 && Number(number) <= sourceLines ? ` at installer line ${Number(number)}` : '';
    const reason = /(?:^|: )(Bad file descriptor|Bad fd number|Is a directory|Not a directory|Permission denied|Operation not permitted|No such file(?: or directory)?|not found|command not found|parameter not set|unbound variable|Illegal instruction|Segmentation fault|Exec format error|Argument list too long|Syntax error|Bad substitution|Read-only file system|Too many open files|No space left on device|unexpected operator)(?:$|[ .(:])/i.exec(line)?.[1];
    // Dash abbreviates missing read-redirection targets to "No such file".
    const canonicalReason = /^no such file(?: or directory)?$/i.test(reason ?? '') ? 'no such file or directory' : reason?.toLowerCase();
    if (canonicalReason) diagnostics.add(`Shell/OS failure${location}: ${canonicalReason}`);
    else if (location && !template) diagnostics.add(`Unclassified shell failure${location}; dynamic output withheld.`);
    const curl = /^curl: \((\d{1,3})\)/.exec(line);
    if (curl) diagnostics.add(`curl failed with error ${Number(curl[1])}; dynamic output withheld.`);
    if (diagnostics.size >= 8) break;
  }
  return [...diagnostics].slice(0, 8);
}

export function assertHostedContext(input) {
  assert.equal(input.env.GITHUB_ACTIONS, 'true', 'Acceptance requires a disposable Actions account.');
  assert.equal(input.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Persistent/self-hosted accounts are refused.');
  assert.match(input.tag, /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  assert.match(input.source, /^[a-f0-9]{40}$/);
  assert.equal(input.target, `${input.platform}-${input.arch}`);
  assert.ok(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'].includes(input.target));
  assert.equal(input.home, input.accountHome, 'A HOME override cannot isolate a native service manager.');
  assert.ok(input.uid > 0, 'Do not install into the root account.');
  assert.ok(input.env.RUNNER_TEMP && isAbsolute(input.env.RUNNER_TEMP));
}

/** Drain the exact admitted child before reporting timeout/cancellation. Output
 * stays bounded/private: installer/status output can contain local credentials. */
export async function runOwnedCommand(command, args, options = {}) {
  const { timeoutMs = 120_000, signal, installerSource, installerSourcePath = args[0], nativeDaemonDiagnostics = false, ...spawnOptions } = options;
  signal?.throwIfAborted();
  if (nativeDaemonDiagnostics) assert.ok(command.split(sep).at(-1) === 'goodvibes-daemon',
    'Native daemon diagnostics require the installed daemon executable basename.');
  const shell = command.split(sep).at(-1);
  const probe = installerSource !== undefined && ['sh', 'bash', 'dash'].includes(shell);
  const probeRoot = probe ? mkdtempSync(join(tmpdir(), 'goodvibes-acceptance-line-')) : undefined;
  const probePath = probeRoot && join(probeRoot, 'line');
  let child;
  try {
    if (probePath) writeFileSync(probePath, '', { flag: 'wx', mode: 0o600 });
    child = spawn(command, probe ? [...(shell === 'bash' ? ['--posix'] : []), '-c', installerLineProbe, ...args] : args,
      { ...spawnOptions, ...(probePath ? { env: { ...(spawnOptions.env ?? process.env), GOODVIBES_ACCEPTANCE_LINE_PATH: probePath,
        GOODVIBES_ACCEPTANCE_SOURCE_PATH: installerSourcePath,
        GOODVIBES_ACCEPTANCE_LINE_LIMIT: String(installerSource.split('\n').length) } } : {}), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) { if (probeRoot) rmSync(probeRoot, { recursive: true, force: true }); throw error; }
  let stdout = '', stderr = '', bytes = 0, failOutput;
  const overflow = new Promise((_yes, no) => { failOutput = no; });
  const consume = (chunk, retain) => {
    bytes += chunk.length;
    if (bytes > 512 * 1024) failOutput(new Error('Acceptance command output exceeded its bound.'));
    else if (retain) stdout += chunk.toString('utf8');
    else if (installerSource !== undefined || nativeDaemonDiagnostics) stderr += chunk.toString('utf8');
  };
  child.stdout.on('data', chunk => consume(chunk, true));
  child.stderr.on('data', chunk => consume(chunk, false));
  const closed = new Promise((yes, no) => {
    child.once('error', () => no(new Error('Acceptance command could not start.')));
    child.once('close', (code, signal) => yes({ code: code ?? 1, stdout,
      ...(safeExitSignal(signal) ? { exitSignal: signal } : {}) }));
  });
  let rejectCancellation;
  const cancelled = new Promise((_yes, no) => { rejectCancellation = no; });
  const cancel = () => {
    try { signalNativeProcessGroup(child, 'SIGTERM'); rejectCancellation(signal.reason); }
    catch (error) { rejectCancellation(error); }
  };
  signal?.addEventListener('abort', cancel, { once: true });
  let result, failure, lastInstallerLine;
  try {
    if (signal?.aborted) cancel();
    result = await boundedNativeProcessClose(Promise.race([closed, overflow, cancelled]), timeoutMs, 'Acceptance command exceeded its bound.');
  } catch (error) { failure = error; }
  finally {
    signal?.removeEventListener('abort', cancel);
    try { await drainNativeProcessGroup(child, closed); }
    catch (error) { failure = failure ? new AggregateError([failure, error], 'Acceptance child drain failed.') : error; }
    if (probeRoot) {
      try {
        const metadata = readFileSync(probePath, 'utf8');
        if (/^\d{1,10}\n$/.test(metadata) && Number(metadata) > 0 && Number(metadata) <= installerSource.split('\n').length)
          lastInstallerLine = Number(metadata);
      } catch { /* Numeric metadata is optional; original failures stay primary. */ }
      finally {
        try { rmSync(probeRoot, { recursive: true, force: true }); }
        catch (error) { failure = failure ? new AggregateError([failure, error], 'Acceptance diagnostic cleanup failed.') : error; }
      }
    }
  }
  if (failure) throw preserveAcceptanceCancellation(failure, signal);
  if (result.code !== 0 && installerSource !== undefined) {
    result.diagnostics = installerFailureDiagnostics(installerSource, stdout, stderr);
    if (lastInstallerLine) result.diagnostics.unshift(`Installer exited nonzero after source line ${lastInstallerLine}; line captured before EXIT cleanup.`);
    result.diagnostics = result.diagnostics.slice(0, 8);
  }
  if (result.code !== 0 && nativeDaemonDiagnostics) {
    const startup = nativeStartupFailure(stdout, stderr);
    result.nativeDaemonFailure = startup ? 'native-startup-repair' : nativeDaemonFailure(stdout, stderr);
    if (startup) result.nativeStartupFailure = startup;
  }
  signal?.throwIfAborted(); return result;
}

/** A single ordering contract, shared by all four native workflow jobs. Cleanup
 * is always awaited and failures retain both the primary and cleanup failure. */
export async function runAcceptanceSteps(host) {
  await host.admit();
  let attempted = false, primary;
  try {
    attempted = true; await host.install();
    await host.verifyInstalled(); await host.verifyDefaults();
    await host.verifyNativeLifecycle?.();
    await host.disableUpdates(); await host.restartAndVerifyOptOut();
    await host.install(); await host.verifyOptOut();
    await host.uninstall(); await host.verifyPreserved();
    await host.uninstall(); await host.verifyPreserved();
    await host.install(); await host.verifyInstalled(); await host.verifyOptOut();
  } catch (error) {
    primary = error;
    try { await host.diagnoseFailure?.(); }
    catch (error) { primary = new AggregateError([primary, error], 'Acceptance and failure diagnostics failed.'); }
  }
  finally {
    if (attempted) {
      try { await host.uninstall(); await host.verifyPreserved(); }
      catch (error) { primary = primary ? new AggregateError([primary, error], 'Acceptance and owned cleanup failed.') : error; }
    }
  }
  if (primary) throw primary;
}

/** Linux historical delivery uses the actual old unattended updater. The
 * current installer is reserved for finally-cleanup, never upgrade repair. */
export async function runHistoricalUpgradeSteps(host) {
  await host.admit();
  let attempted = false, primary;
  try {
    attempted = true; await host.installPrevious();
    await host.verifyPrevious(); await host.seedPreviousData();
    await host.startPreviousService(); await host.awaitAutomaticUpgrade();
    await host.verifyUpgradedData(); await host.verifyRollbackRefusal();
  } catch (error) { primary = error; }
  finally {
    if (attempted) {
      try { await host.uninstall(); await host.verifyPreserved(); }
      catch (error) { primary = primary ? new AggregateError([primary, error], 'Historical acceptance and owned cleanup failed.') : error; }
    }
  }
  if (primary) throw primary;
}

/** Real previous-release delivery. Only the original daemon may perform the
 * forward transition; the current installer is reserved for owned cleanup. */
export async function runPreviousReleaseUpgradeSteps(host) {
  await host.admit();
  let attempted = false, primary;
  try {
    attempted = true; await host.installPrevious(); await host.verifyPrevious();
    await host.seedPreviousData(); await host.prepareDelivery();
    await host.startPreviousService(); await host.verifyPreviousService();
    await host.awaitAutomaticUpgrade(); await host.verifyUpgradedData();
    await host.verifyCompleteRollback();
  } catch (error) { primary = error; }
  finally {
    if (attempted) {
      try { await host.uninstall(); await host.verifyPreserved(); }
      catch (error) { primary = primary ? new AggregateError([primary, error], 'Previous-release acceptance and owned cleanup failed.') : error; }
    }
  }
  if (primary) throw primary;
}

export function assertPreviousReleaseInputs({ tag, previousTag, previousSource }) {
  const parse = value => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value ?? '')?.slice(1).map(Number);
  const current = parse(tag), previous = parse(previousTag);
  assert.ok(current && previous, 'Previous-release acceptance requires stable version tags.');
  assert.ok([...current, ...previous].every(Number.isSafeInteger), 'Release version components must be exact integers.');
  assert.match(previousSource ?? '', /^[a-f0-9]{40}$/);
  const difference = current.findIndex((value, index) => value !== previous[index]);
  assert.ok(difference >= 0 && current[difference] > previous[difference], 'The previous release must precede the selected release.');
}

/** Shared native startup rollback proof. Only failed-start history is seeded;
 * the installed compiled daemon owns reader admission, rollback and handover. */
export async function verifyCompiledSuiteRollback({ host, target, source, sourceRoot, previousVersion, currentVersion,
  previousReaders, webuiDirectory, verifyPreserved }) {
  const { bin, data, root, daemon, invoke, setting, checkpoint, signal } = host;
  signal?.throwIfAborted(); checkpoint('rollback.previous-cohort');
  const suffix = target.replace(/^darwin-/, 'macos-'), paths = new Set();
  const previousMetadata = path => {
    const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 131072);
    return JSON.parse(readFileSync(path, 'utf8'));
  };
  for (const name of products) {
    const reader = previousReaders.get(name); assert.ok(reader);
    for (const file of reader.files) {
      const asset = `${name}-${suffix}`;
      assert.ok(file.path === asset || file.path.startsWith(`${asset}.`) || /^lib\/[A-Za-z0-9_.\/-]+$/.test(file.path));
      const relative = file.path.startsWith(asset) ? name + file.path.slice(asset.length) : file.path;
      assert.ok(!relative.split('/').includes('..')); paths.add(join(bin, relative));
    }
    const metadata = join(bin, name === 'goodvibes-daemon' && target.startsWith('linux-') ? 'daemon-installation.json' : `${name}.readers.json`);
    paths.add(metadata);
    const previous = previousMetadata(`${metadata}.previous`);
    assert.deepEqual(name === 'goodvibes-daemon' && target.startsWith('linux-') ? previous.artifact : previous, reader);
  }
  for (const path of paths) { const stat = lstatSync(`${path}.previous`); assert.ok(stat.isFile() && !stat.isSymbolicLink()); }
  for (const path of [join(bin, 'playwright-core'), webuiDirectory]) {
    const stat = lstatSync(`${path}.previous`); assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    assert.equal(previousMetadata(join(`${path}.previous`, '.goodvibes-release.json')).version, previousVersion);
  }
  const updatedPid = await host.servicePid();
  checkpoint('rollback.stop-before-seeded-history'); await host.stopService();
  const marker = join(data, 'tui', 'control-plane', 'daemon-lifecycle.json');
  assert.equal(await setting('update.rollbackAfterFailedStarts'), 3);
  const selectedSource = realpathSync(sourceRoot);
  assert.equal(await invoke('git', ['-C', selectedSource, 'rev-parse', 'HEAD']), source);
  const module = pathToFileURL(join(selectedSource, 'packages/engine/platform/src/platform/daemon/lifecycle-marker.ts')).href;
  const seed = join(root, 'seed-failed-start-history.mjs');
  writeFileSync(seed, `import assert from 'node:assert/strict';\nimport {recordDaemonStartAttempt,readLifecycleMarker} from ${JSON.stringify(module)};\nconst path=process.argv[2];\nconst original=readLifecycleMarker(path);\nassert.equal(original?.version,${JSON.stringify(currentVersion)});\nassert.equal(original?.failedStarts,0);\nassert.equal(original?.autoRollbackAt,undefined);\nfor(let i=0;i<3;i++) recordDaemonStartAttempt(path,{version:${JSON.stringify(currentVersion)}});\nassert.equal(readLifecycleMarker(path)?.failedStarts,3);\n`, { flag: 'wx', mode: 0o600 });
  const seedRevision = () => {
    const stat = lstatSync(seed, { bigint: true }); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16384n);
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid].join(':');
  };
  const originalSeed = seedRevision();
  checkpoint('rollback.seeded-history-writer'); await invoke('bun', [seed, marker]);
  assert.equal(seedRevision(), originalSeed);
  checkpoint('rollback.native-startup'); await host.startService();
  await waitForAcceptanceReadiness(async () => {
    checkpoint('rollback.restored-version');
    for (const name of products) assert.equal(await invoke(join(bin, name), ['--version']), `${name} ${previousVersion}`);
  }, () => host.verifyCohort(previousVersion, previousReaders), { signal, timeoutMs: 10 * 60_000, intervalMs: 1000 });
  await verifyPreserved();
  const rolledBackPid = await host.servicePid(); assert.notEqual(rolledBackPid, updatedPid);
  checkpoint('rollback.status');
  const status = JSON.parse(await invoke(daemon, ['status', '--json']));
  checkpoint('rollback.status-ok'); assert.equal(status.ok, true);
  checkpoint('rollback.status-version'); assert.equal(status.data.identity.version, previousVersion);
  checkpoint('rollback.marker-version'); assert.equal(status.data.local.marker.version, previousVersion);
  checkpoint('rollback.rejected-version'); assert.equal(status.data.local.marker.rejectedVersion, currentVersion);
  checkpoint('rollback.marker-state'); assert.equal(status.data.local.marker.state, 'running');
  checkpoint('rollback.marker-pid'); assert.equal(status.data.local.marker.pid, rolledBackPid);
  checkpoint('rollback.failed-starts'); assert.equal(status.data.local.marker.failedStarts, 0);
  // The healthy restored boot clears the temporary anti-ping-pong guard while
  // retaining the rejected version that blocks downloading the same bad build.
  checkpoint('rollback.rollback-guard'); assert.equal(status.data.local.marker.autoRollbackAt, undefined);
  checkpoint('rollback.seed-source');
  assert.equal(seedRevision(), originalSeed);
  return { updatedPid, rolledBackPid };
}

/** Explicit public-installer recovery, independent of the old automatic
 * updater. A running opted-out old service is migrated by the real installer. */
export async function runInstallerMigrationSteps(host) {
  await host.admit();
  let attempted = false, primary;
  try {
    attempted = true; await host.installPrevious();
    await host.verifyPrevious(); await host.seedPreviousData(); await host.disablePreviousUpdates();
    await host.startPreviousService(); await host.verifyPreviousService();
    await host.installCurrent(); await host.verifyCurrent(); await host.verifyMigratedData();
    await host.restartAndVerifyMigrated();
  } catch (error) { primary = error; }
  finally {
    if (attempted) {
      try { await host.uninstall(); await host.verifyPreserved(); }
      catch (error) { primary = primary ? new AggregateError([primary, error], 'Installer migration and owned cleanup failed.') : error; }
    }
  }
  if (primary) throw primary;
}

/** Invoke the actual platform API against the downloaded installed tree.
 * The separately built verifier supplies no installed bytes and does not claim
 * an interactive compiled /update rollback was driven by this acceptance. */
export async function assertHistoricalRollbackRefusal(input, verifier) {
  input.signal?.throwIfAborted();
  const modulePath = name => input.sourceRoot
    ? pathToFileURL(join(input.sourceRoot, 'packages/engine/platform/dist/platform/runtime', name)).href
    : new URL(`../packages/engine/platform/dist/platform/runtime/${name}`, import.meta.url).href;
  const api = verifier ?? await import(modulePath('self-update.js'));
  const sources = verifier ?? await import(modulePath('compiled-native-startup.js'));
  const trees = verifier ?? await import(modulePath('update-directories.js'));
  const options = { execPath: join(input.bin, 'goodvibes-daemon'), platform: 'linux', arch: process.arch,
    currentVersion: input.version, version: input.version, webuiDirectory: input.webuiDirectory };
  const plan = api.resolveSuiteUpdatePlan(options);
  // This is the real historical absence, not a constructed invalid argument.
  assert.ok(plan.files.some(file => !existsSync(file.path + '.previous')), 'The historical previous native cohort is unexpectedly complete.');
  const files = sources.retainNativeUpdateSources(plan.files.flatMap(file => ['', '.previous'].map(tail => file.path + tail)),
    api.captureUpdateFileIo(api.realUpdateFileIo));
  const transient = sources.retainNativeUpdateSources(plan.files.flatMap(file => ['.update-transaction', '.update-download', '.update-previous', '.rollback-exchange'].map(tail => file.path + tail)),
    api.captureUpdateFileIo(api.realUpdateFileIo));
  const directories = plan.directories.flatMap(directory => [directory.path, directory.path + '.previous']).map(path => trees.retainNativeUpdateTree(path));
  const current = () => { input.signal?.throwIfAborted(); plan.assertCurrent(); files(); for (const directory of directories) directory.assertCurrent(); };
  let commitReached = false, refusal;
  current(); transient();
  try {
    api.rollbackSuiteUpdate({ ...options, assertCurrent: current, beforeCommit() {
      commitReached = true; throw new Error('Historical rollback unexpectedly reached the commit boundary.');
    } });
  } catch (error) { refusal = error; }
  assert.equal(commitReached, false, 'The historical rollback must refuse before admission to effects.');
  assert.ok(refusal instanceof api.UpdateTransactionError, 'Only the actual incomplete native-cohort refusal counts.');
  assert.equal(refusal.receipt.operation, 'rollback'); assert.equal(refusal.receipt.phase, 'admission');
  assert.equal(refusal.receipt.committed, false); assert.equal(refusal.receipt.recoveryRequired, false);
  assert.ok(refusal.cause instanceof Error);
  assert.equal(refusal.cause.message, 'Previous native cohort is incomplete; refusing partial rollback');
  current(); transient();
}

/** These are the actual public per-program producer descriptors. The suite
 * archive's suite-release-source-* inventory is intentionally not published. */
export async function readPublishedReaders(input, load) {
  const suffix = input.target.replace(/^darwin-/, 'macos-'), records = new Map();
  for (const command of products) {
    const asset = `${command}-${suffix}`, descriptor = `${asset}.reader-ci-artifact.json`;
    const check = field => input.onCheck?.(`catalog.reader.${command}.${field}`);
    check('assets');
    assert.ok(input.assets.has(asset) && input.assets.has(descriptor), 'A public native reader cohort is missing.');
    const value = await load(descriptor);
    check('target'); assert.equal(value.target, input.target);
    check('source'); assert.equal(value.sourceCommit, input.source);
    check('head'); assert.equal(value.headCommit, input.source);
    check('version');
    assert.equal(value.version ?? value.readers?.version, input.tag.slice(1));
    check('files');
    assert.ok(Array.isArray(value.files) && value.files.some(file => file.path === asset));
    records.set(command, value);
  }
  return records;
}

async function fetchBytes(url, limit = 1_048_576, signal, onHttpStatus, fetchImpl = fetch) {
  try {
    const timeout = AbortSignal.timeout(60_000);
    const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) onHttpStatus?.(response.status);
    const reader = response.body?.getReader();
    const chunks = []; let size = 0;
    try {
      assert.equal(response.status, 200, 'Public release request did not succeed.');
      assert.ok(reader);
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length; assert.ok(size <= limit, 'Public metadata exceeds its bound.'); chunks.push(value);
      }
    } finally { await reader?.cancel(); }
    return { bytes: Buffer.concat(chunks), url: response.url };
  } catch (error) {
    if (signal?.aborted && error?.name === 'AbortError' && (error?.code === 'ABORT_ERR' || error?.code === 20)) throw signal.reason;
    throw preserveAcceptanceCancellation(error, signal);
  }
}

/** The actual public admission path, with fixed checkpoints and status-only
 * observations. The injected fetch seam supplies owned HTTP fixtures in tests. */
export async function readPublicAcceptanceDelivery({ tag, source, target, signal, checkpoint, onHttpStatus }, fetchImpl = fetch) {
  const api = `https://api.github.com/repos/${repository}`;
  const request = async (check, url, limit) => {
    checkpoint(check);
    return fetchBytes(url, limit, signal, onHttpStatus, fetchImpl);
  };
  const release = JSON.parse((await request('catalog.release.http', `${api}/releases/tags/${tag}`)).bytes);
  checkpoint('catalog.release.tag'); assert.equal(release.tag_name, tag);
  checkpoint('catalog.release.draft'); assert.equal(release.draft, false);
  checkpoint('catalog.release.asset-count');
  assert.ok(Array.isArray(release.assets) && release.assets.length >= 65, 'The complete native suite must be published first.');
  checkpoint('catalog.release.unique-assets');
  const names = new Set(release.assets.map(asset => asset.name)); assert.equal(names.size, release.assets.length);
  checkpoint('catalog.release.manifest'); assert.ok(names.has('SHA256SUMS.txt'));
  const readers = await readPublishedReaders({ tag, source, target, assets: names, onCheck: checkpoint }, async name => {
    const suffix = target.replace(/^darwin-/, 'macos-');
    const command = products.find(command => name === `${command}-${suffix}.reader-ci-artifact.json`); assert.ok(command);
    const value = JSON.parse((await request(`catalog.reader.${command}.http`, `https://github.com/${repository}/releases/download/${tag}/${name}`, 131_072)).bytes);
    return value;
  });
  const latest = JSON.parse((await request('catalog.latest.http', `${api}/releases/latest`)).bytes);
  checkpoint('catalog.latest.tag');
  assert.equal(latest.tag_name, tag, 'Default updater acceptance requires this exact tag to be latest.');
  const immutable = await request('installer.immutable.http', `https://raw.githubusercontent.com/${repository}/${source}/scripts/install.sh`);
  const published = await request('installer.public.http', 'https://goodvibes.sh/install.sh');
  checkpoint('installer.public.redirect');
  assert.match(published.url, /^https:\/\/raw\.githubusercontent\.com\/mgd34msu\/goodvibes\/(?:main|[a-f0-9]{40})\/scripts\/install\.sh$/);
  checkpoint('installer.public.bytes');
  assert.ok(published.bytes.equals(immutable.bytes), 'The public installer differs from the accepted release source.');
  return { readers, published, immutable };
}

/** A real public previous cohort need not be latest. Require its immutable tag
 * and all three producer descriptors, rather than synthesizing older readers. */
export async function readPreviousReleaseCohort({ tag, source, target, signal, checkpoint, onHttpStatus }, fetchImpl = fetch) {
  const api = `https://api.github.com/repos/${repository}`;
  const request = async (check, url, limit = 1_048_576) => {
    checkpoint(check); return fetchBytes(url, limit, signal, onHttpStatus, fetchImpl);
  };
  const release = JSON.parse((await request('previous.catalog.release.http', `${api}/releases/tags/${tag}`)).bytes);
  checkpoint('previous.catalog.release');
  assert.equal(release.tag_name, tag); assert.equal(release.draft, false); assert.equal(release.prerelease, false);
  assert.ok(Array.isArray(release.assets) && release.assets.length >= 65);
  const names = new Set(release.assets.map(asset => asset.name)); assert.equal(names.size, release.assets.length);
  for (const name of ['SHA256SUMS.txt', 'browser-driver.tar.gz', `goodvibes-webui-bundle-${tag.slice(1)}.tar.gz`]) assert.ok(names.has(name));
  const reference = JSON.parse((await request('previous.catalog.tag.http', `${api}/git/ref/tags/${tag}`, 131_072)).bytes);
  checkpoint('previous.catalog.tag'); assert.equal(reference.ref, `refs/tags/${tag}`);
  let object = reference.object; assert.match(object.sha, /^[a-f0-9]{40}$/);
  if (object.type === 'tag') {
    const annotated = JSON.parse((await request('previous.catalog.annotated-tag.http', `${api}/git/tags/${object.sha}`, 131_072)).bytes);
    checkpoint('previous.catalog.annotated-tag'); assert.equal(annotated.sha, object.sha); assert.equal(annotated.tag, tag); object = annotated.object;
  }
  checkpoint('previous.catalog.source'); assert.equal(object.type, 'commit'); assert.equal(object.sha, source);
  const readers = await readPublishedReaders({ tag, source, target, assets: names,
    onCheck: check => checkpoint(`previous.${check}`) }, async name => JSON.parse((await request(
      'previous.catalog.reader.http', `https://github.com/${repository}/releases/download/${tag}/${name}`, 131_072)).bytes));
  const installer = await request('previous.installer.http', `https://raw.githubusercontent.com/${repository}/${source}/scripts/install.sh`);
  return { readers, installer: installer.bytes };
}

export async function acceptPublishedSuite(input) {
  const metadata = consumeAcceptanceMetadataFetch();
  const evidence = { stage: 'account-admission', failures: [], metadataInspection: {
    authentication: metadata.authentication, scope: 'canonical-repository-metadata-get-only', publicDownloads: 'anonymous',
  } };
  try { await performPublishedAcceptance(input, evidence, metadata.fetch); }
  catch (error) {
    error = preserveAcceptanceCancellation(error, input.signal);
    const diagnostic = { tag: input.tag, source: input.source, target: input.target, accepted: false, metadataInspection: evidence.metadataInspection,
      failures: evidence.failures.length ? evidence.failures : [acceptanceFailureRecord(evidence, error)],
      diagnostic: input.delivery ? 'Staged native install/service/cleanup acceptance failed.' : 'Published native install/service/cleanup acceptance failed.' };
    if (evidence.root) writeFileSync(join(evidence.root, 'acceptance-result.json'), JSON.stringify(diagnostic) + '\n', { flag: 'wx', mode: 0o600 });
    console.error(JSON.stringify(diagnostic));
    throw error;
  }
}

async function performPublishedAcceptance({ tag, source, target, signal, scenario = 'fresh', delivery, previousTag, previousSource: selectedPreviousSource }, evidence, metadataFetch) {
  assert.ok(scenario === 'fresh' || scenario === 'upgrade-v3.1.1' || scenario === 'installer-migrate-v3.1.1' || scenario === 'upgrade-previous', 'Unknown published acceptance scenario.');
  const historical = scenario === 'upgrade-v3.1.1';
  const migration = scenario === 'installer-migrate-v3.1.1';
  const previousRelease = scenario === 'upgrade-previous';
  if (previousRelease) assertPreviousReleaseInputs({ tag, previousTag, previousSource: selectedPreviousSource });
  else assert.ok(previousTag === undefined && selectedPreviousSource === undefined, 'Previous inputs belong to previous-release acceptance only.');
  if (historical) {
    assert.equal(process.platform, 'linux', 'The published old automatic updater supports Linux only.');
    assert.equal(tag, 'v3.1.2', 'This scenario verifies the actual v3.1.1 to v3.1.2 delivery contract.');
  }
  if (migration) {
    assert.equal(process.platform, 'linux', 'The installer migration fixture requires the actual old Linux release cohort.');
    assert.equal(tag, 'v3.1.2', 'Installer migration verifies actual public v3.1.1 to v3.1.2 delivery.');
    assert.equal(delivery, undefined, 'Installer migration must exercise the actual public installer and release.');
  }
  const account = userInfo(), home = realpathSync(process.env.HOME ?? '');
  assertHostedContext({ env: process.env, platform: process.platform, arch: process.arch,
    home, accountHome: realpathSync(account.homedir), uid: account.uid, tag, source, target });
  const originalHome = lstatSync(home, { bigint: true });
  const assertHome = () => {
    const now = lstatSync(home, { bigint: true });
    assert.ok(now.isDirectory() && !now.isSymbolicLink() && now.dev === originalHome.dev && now.ino === originalHome.ino && now.uid === originalHome.uid);
    assert.equal(realpathSync(home), home);
  };
  const bin = join(home, '.local/bin'), data = join(home, '.goodvibes');
  const servicePath = process.platform === 'linux' ? join(home, '.config/systemd/user', unit)
    : join(home, 'Library/LaunchAgents', `${label}.plist`);
  for (const path of [data, servicePath, ...products.map(name => join(bin, name))])
    assert.equal(lstatSync(path, { throwIfNoEntry: false }), undefined, 'Existing GoodVibes ownership is not an acceptance fixture.');
  for (const path of [join(home, '.local'), bin, join(home, '.config'), join(home, '.config/systemd'), join(home, '.config/systemd/user'),
    join(home, 'Library'), join(home, 'Library/LaunchAgents')]) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat) assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === path, 'Native install parents must belong to the original account.');
  }
  const root = mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP), 'goodvibes-published-')); evidence.root = root;
  evidence.stage = 'native-service-context';
  const env = { ...process.env, HOME: home };
  for (const name of Object.keys(env)) if (/^(?:GOODVIBES_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|JEV_|CLEF_)/.test(name)
    || ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'DBUS_SESSION_BUS_ADDRESS', 'NODE_OPTIONS', 'BUN_OPTIONS'].includes(name)) delete env[name];
  const checkpoint = check => markAcceptanceCheckpoint(evidence, check);
  const invoke = async (command, args, extra = {}, cleanup = false, installerSource, installerSourcePath) => {
    assertHome(); evidence.command = command.split(sep).at(-1); evidence.exitCode = undefined; evidence.exitSignal = undefined;
    evidence.diagnostics = undefined; evidence.nativeDaemonFailure = undefined; evidence.nativeStartupFailure = undefined;
    const result = await runOwnedCommand(command, args, { cwd: home, env: { ...env, ...extra }, timeoutMs: 300_000,
      signal: cleanup ? undefined : signal, installerSource, installerSourcePath,
      nativeDaemonDiagnostics: evidence.command === 'goodvibes-daemon' }); assertHome();
    evidence.exitCode = result.code; evidence.exitSignal = result.exitSignal;
    evidence.diagnostics = result.diagnostics; evidence.nativeDaemonFailure = result.nativeDaemonFailure;
    evidence.nativeStartupFailure = result.nativeStartupFailure;
    assert.equal(result.code, 0, `Acceptance command failed: ${command.split(sep).at(-1)}`); return result.stdout.trim();
  };
  if (process.platform === 'linux') {
    env.XDG_RUNTIME_DIR = `/run/user/${account.uid}`;
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${env.XDG_RUNTIME_DIR}/bus`;
    await invoke('sudo', ['-n', 'loginctl', 'enable-linger', account.username]);
    await invoke('sudo', ['-n', 'systemctl', 'start', `user@${account.uid}.service`]);
    await invoke('systemctl', ['--user', 'show-environment']);
    for (const name of [unit, 'goodvibes-daemon.service']) {
      const probe = await runOwnedCommand('systemctl', ['--user', 'show', name, '--property=LoadState', '--value'], { env });
      assert.equal(probe.stdout.trim(), 'not-found', 'An existing native service must never be adopted.');
    }
  } else {
    await invoke('launchctl', ['print', `gui/${account.uid}`]);
    const probe = await runOwnedCommand('launchctl', ['print', `gui/${account.uid}/${label}`], { env });
    assert.notEqual(probe.code, 0, 'An existing LaunchAgent must never be adopted.');
  }
  evidence.stage = 'published-catalog'; evidence.command = undefined; evidence.exitCode = undefined;
  const api = `https://api.github.com/repos/${repository}`;
  let readers, published, installer;
  if (delivery) {
    evidence.stage = 'staged-candidate';
    ({ readers, published, installer } = await delivery.admit({ tag, source, target, root, signal }));
  } else {
    let immutable;
    ({ readers, published, immutable } = await readPublicAcceptanceDelivery({ tag, source, target, signal,
      checkpoint(check) { evidence.stage = check.startsWith('installer.') ? 'public-installer' : 'published-catalog'; checkpoint(check); },
      onHttpStatus(status) { evidence.httpStatus = status; },
    }, metadataFetch));
    installer = join(root, 'install.sh'); writeFileSync(installer, published.bytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(root, 'immutable-install.sh'), immutable.bytes, { flag: 'wx', mode: 0o600 });
  }
  const installEnv = { GOODVIBES_VERSION: tag, GOODVIBES_WAKE_MODEL: '0', GOODVIBES_SHADOW_REMOVE: '0' };
  let previousInstaller, previousSource, previousReader, previousReaders;
  if (previousRelease) {
    evidence.stage = 'previous-release-source';
    const cohort = await readPreviousReleaseCohort({ tag: previousTag, source: selectedPreviousSource, target, signal,
      checkpoint, onHttpStatus(status) { evidence.httpStatus = status; } }, metadataFetch);
    previousSource = selectedPreviousSource; previousReaders = cohort.readers;
    previousInstaller = join(root, 'install-previous.sh'); writeFileSync(previousInstaller, cohort.installer, { flag: 'wx', mode: 0o600 });
  }
  if (historical || migration) {
    evidence.stage = 'historical-source';
    const oldRelease = JSON.parse((await fetchBytes(`${api}/releases/tags/v3.1.1`, undefined, signal, undefined, metadataFetch)).bytes);
    assert.equal(oldRelease.tag_name, 'v3.1.1'); assert.equal(oldRelease.draft, false);
    const oldNames = new Set(oldRelease.assets.map(asset => asset.name));
    const suffix = target;
    for (const name of [...products.flatMap(command => ['', '.bun', '.bun.json', '.bun.LICENSE.md'].map(tail => `${command}-${suffix}${tail}`)),
      `goodvibes-daemon-${suffix}.ci-artifact.json`, `sqlite-vec-${target}.so`, 'browser-driver.tar.gz', 'goodvibes-webui-bundle-3.1.1.tar.gz', 'SHA256SUMS.txt']) {
      assert.ok(oldNames.has(name), 'The actual old Linux release cohort is incomplete.');
    }
    const reference = JSON.parse((await fetchBytes(`${api}/git/ref/tags/v3.1.1`, 131_072, signal, undefined, metadataFetch)).bytes);
    assert.equal(reference.ref, 'refs/tags/v3.1.1');
    let object = reference.object; assert.match(object.sha, /^[a-f0-9]{40}$/);
    if (object.type === 'tag') {
      const annotated = JSON.parse((await fetchBytes(`${api}/git/tags/${object.sha}`, 131_072, signal, undefined, metadataFetch)).bytes);
      assert.equal(annotated.sha, object.sha); assert.equal(annotated.tag, 'v3.1.1'); object = annotated.object;
    }
    assert.equal(object.type, 'commit'); previousSource = object.sha; assert.match(previousSource, /^[a-f0-9]{40}$/);
    previousReader = JSON.parse((await fetchBytes(`https://github.com/${repository}/releases/download/v3.1.1/goodvibes-daemon-${target}.ci-artifact.json`, 131_072, signal)).bytes);
    assert.equal(previousReader.target, target); assert.equal(previousReader.sourceCommit, previousSource); assert.equal(previousReader.headCommit, previousSource);
    const old = await fetchBytes(`https://raw.githubusercontent.com/${repository}/${previousSource}/scripts/install.sh`, undefined, signal);
    previousInstaller = join(root, 'install-v3.1.1.sh');
    writeFileSync(previousInstaller, old.bytes, { flag: 'wx', mode: 0o600 });
  }
  const daemon = join(bin, 'goodvibes-daemon'), version = tag.slice(1);
  const setting = async key => {
    checkpoint(`configuration.${key}`);
    const result = JSON.parse(await invoke(daemon, ['config', 'get', key, '--json']));
    assert.equal(result.ok, true); assert.equal(result.data.key, key); return result.data.value;
  };
  const assertServiceOwned = () => {
    assertHome(); const stat = lstatSync(servicePath); assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.ok(readFileSync(servicePath, 'utf8').includes(daemon), 'The service must retain this exact admitted executable.');
  };
  const service = async action => {
    checkpoint('service.ownership');
    assertServiceOwned();
    checkpoint(action === 'restart' ? 'service.restart' : 'service.running');
    if (process.platform === 'linux') await invoke('systemctl', ['--user', action === 'restart' ? 'restart' : 'is-active', unit]);
    else {
      if (action === 'restart') await invoke('launchctl', ['kickstart', '-k', `gui/${account.uid}/${label}`]);
      else { const status = await invoke('launchctl', ['print', `gui/${account.uid}/${label}`]); assert.match(status, /state = running/); }
    }
  };
  const sentinel = join(data, 'published-acceptance-preserved.txt'); let preserved, originalWebui;
  const verifyOptOut = async () => { for (const key of ['update.auto', 'update.autoUpdateAtLaunch']) assert.equal(await setting(key), false); };
  const verifyPreserved = async () => {
    if (preserved !== undefined) assert.equal(readFileSync(sentinel, 'utf8'), preserved);
    for (const name of products) assert.ok(!existsSync(join(bin, name)), 'Uninstall must remove original installed programs.');
    assert.equal(lstatSync(servicePath, { throwIfNoEntry: false }), undefined, 'Uninstall must retire its original native service.');
    const stopped = process.platform === 'linux'
      ? await runOwnedCommand('systemctl', ['--user', 'is-active', unit], { env })
      : await runOwnedCommand('launchctl', ['print', `gui/${account.uid}/${label}`], { env });
    assert.notEqual(stopped.code, 0, 'The original service must stop before uninstall is acknowledged.');
  };
  const host = {
    async admit() { assertHome(); },
    async install() { await invoke('sh', [installer], installEnv, false, delivery?.installerSource ?? readFileSync(installer, 'utf8'), delivery?.installerSourcePath); },
    async verifyInstalled(expected = {}) {
      const expectedVersion = expected.version ?? version, expectedReaders = expected.readers ?? readers;
      for (const name of products) {
        checkpoint(`installed.${name}.version`);
        assert.equal(await invoke(join(bin, name), ['--version']), `${name} ${expectedVersion}`);
        const reader = expectedReaders.get(name);
        checkpoint(`installed.${name}.compiled-readers`);
        assert.deepEqual(JSON.parse(await invoke(join(bin, name), ['check-install-reader', '--describe'])), reader.readers);
        checkpoint(`installed.${name}.reader-evidence`);
        const installed = JSON.parse(readFileSync(join(bin, name === 'goodvibes-daemon' && process.platform === 'linux' ? 'daemon-installation.json' : `${name}.readers.json`), 'utf8'));
        assert.deepEqual(name === 'goodvibes-daemon' && process.platform === 'linux' ? installed.artifact : installed, reader);
      }
      const extension = process.platform === 'linux' ? 'so' : 'dylib';
      checkpoint('installed.vector-library');
      assert.ok(lstatSync(join(bin, 'lib', `sqlite-vec-${target}`, `vec0.${extension}`)).isFile());
      if (process.platform === 'darwin') for (const name of ['libsqlite3.dylib', 'libsqlite3.dylib.json']) {
        checkpoint(name === 'libsqlite3.dylib' ? 'installed.sqlite-library' : 'installed.sqlite-evidence');
        assert.ok(lstatSync(join(bin, 'lib', `sqlite-${target}`, name)).isFile());
      }
      checkpoint('installed.browser-manifest');
      assert.ok(lstatSync(join(bin, 'playwright-core', 'package.json')).isFile());
      if (previousRelease) {
        checkpoint('installed.browser-release-marker');
        assert.equal(JSON.parse(readFileSync(join(bin, 'playwright-core', '.goodvibes-release.json'), 'utf8')).version, expectedVersion);
      }
      if (expected.serviceDisabled) {
        assert.equal(lstatSync(servicePath, { throwIfNoEntry: false }), undefined, 'Previous programs must be verified before service activation.');
        return;
      }
      await waitForAcceptanceReadiness(() => service('check'), async () => {
        checkpoint('service.status-version');
        const status = JSON.parse(await invoke(daemon, ['status', '--json']));
        assert.equal(status.ok, true); assert.equal(status.data.identity.version, expectedVersion);
        const port = await setting('controlPlane.port'); checkpoint('webui.port');
        assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
        const bundle = await setting('controlPlane.webui.bundleDir'); checkpoint('webui.bundle-selection');
        if (expected.webuiDirectory !== undefined) assert.equal(resolve(bundle), expected.webuiDirectory);
        else if (!historical) assert.equal(resolve(bundle), join(bin, 'webui', version));
        else assert.equal(resolve(bundle), originalWebui, 'Automatic upgrade must preserve the actual configured WebUI selection.');
        checkpoint('webui.release-marker');
        const marker = JSON.parse(readFileSync(join(bundle, '.goodvibes-release.json'), 'utf8')); assert.equal(marker.version, expectedVersion);
        assert.equal(await setting('controlPlane.webui.serve'), true);
        checkpoint('webui.http-response');
        const page = await fetchBytes(`http://127.0.0.1:${port}/`, 2_097_152, signal);
        checkpoint('webui.installed-content');
        assert.ok(page.bytes.equals(readFileSync(join(bundle, 'index.html'))), 'Actual daemon must serve the installed released WebUI.');
      }, { signal });
    },
    async verifyDefaults() { for (const key of ['update.auto', 'update.autoUpdateAtLaunch']) assert.equal(await setting(key), true); },
    async disableUpdates() {
      for (const key of ['update.auto', 'update.autoUpdateAtLaunch']) await invoke(daemon, ['config', 'set', key, 'false']);
      mkdirSync(data, { recursive: true }); preserved = 'Original owned data survives actual uninstall and reinstall.\n';
      writeFileSync(sentinel, preserved, { flag: 'wx', mode: 0o600 });
    },
    async restartAndVerifyOptOut() { await service('restart'); await host.verifyInstalled(); await verifyOptOut(); },
    verifyOptOut,
    async uninstall() { await invoke('sh', [installer], { ...installEnv, GOODVIBES_UNINSTALL: '1' }, true, delivery?.installerSource ?? readFileSync(installer, 'utf8'), delivery?.installerSourcePath); },
    verifyPreserved,
  };
  const nativeLifecycle = { daemon, bin, data, root, setting, invoke, signal, checkpoint,
      verifyCohort: (version, readers) => host.verifyInstalled({ version, readers, ...(previousRelease ? { webuiDirectory: originalWebui } : {}) }),
      restartService: () => service('restart'),
      async servicePid() {
        await service('check');
        if (process.platform === 'linux') {
          const value = await invoke('systemctl', ['--user', 'show', unit, '--property=MainPID', '--value']);
          assert.match(value, /^[1-9]\d*$/); const pid = Number(value); assert.ok(Number.isSafeInteger(pid) && pid <= 2147483647); return pid;
        }
        const printed = await invoke('launchctl', ['print', `gui/${account.uid}/${label}`]);
        assert.match(printed, /state = running/); const match = /^\s*pid = (\d+)\s*$/m.exec(printed);
        assert.ok(match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0); return Number(match[1]);
      },
      async stopService() {
        assertServiceOwned();
        const command = process.platform === 'linux' ? 'systemctl' : 'launchctl';
        await invoke(command, process.platform === 'linux' ? ['--user', 'stop', unit] : ['bootout', `gui/${account.uid}/${label}`]);
        await waitForNativeServiceRetirement(() => runOwnedCommand(command, process.platform === 'linux'
          ? ['--user', 'is-active', unit] : ['print', `gui/${account.uid}/${label}`],
          { cwd: home, env, timeoutMs: 300_000, signal }), { signal });
      },
      async startService() {
        assertServiceOwned();
        if (process.platform === 'linux') await invoke('systemctl', ['--user', 'start', unit]);
        else await invoke('launchctl', ['bootstrap', `gui/${account.uid}`, servicePath]);
      },
  };
  if (delivery?.verifyNativeLifecycle) {
    assert.equal(process.platform, 'darwin', 'The unpublished native lifecycle fixture is Mac-only.');
    host.verifyNativeLifecycle = () => delivery.verifyNativeLifecycle(nativeLifecycle);
  }
  const previousInstallEnv = { GOODVIBES_VERSION: 'v3.1.1', GOODVIBES_WAKE_MODEL: '0' };
  const upgrade = {
    admit: host.admit,
    async installPrevious() { await invoke('sh', [previousInstaller], { ...previousInstallEnv, GOODVIBES_DAEMON_SERVICE: '0' }, false, readFileSync(previousInstaller, 'utf8')); },
    async verifyPrevious() {
      for (const name of products) assert.equal(await invoke(join(bin, name), ['--version']), `${name} 3.1.1`);
      await host.verifyDefaults();
      const installed = JSON.parse(readFileSync(join(bin, 'daemon-installation.json'), 'utf8'));
      assert.equal(installed.version, '3.1.1'); assert.deepEqual(installed.artifact, previousReader);
      assert.equal(lstatSync(servicePath, { throwIfNoEntry: false }), undefined, 'Old programs must be recorded before service activation.');
      originalWebui = resolve(await setting('controlPlane.webui.bundleDir'));
      assert.equal(originalWebui, join(bin, 'webui', '3.1.1'));
    },
    async seedPreviousData() {
      mkdirSync(data, { recursive: true }); preserved = migration ? 'Original 3.1.1 data survives the actual public installer migration.\n'
        : 'Original 3.1.1 data survives the actual automatic delivery and refusal.\n';
      writeFileSync(sentinel, preserved, { flag: 'wx', mode: 0o600 });
      // A real supported saved value, distinct from its default, must survive.
      await invoke(daemon, ['config', 'set', 'update.intervalMinutes', '61']);
      assert.equal(await setting('update.intervalMinutes'), 61);
      if (delivery) await delivery.preparePrevious({ invoke, daemon, setting });
    },
    async startPreviousService() {
      // Deliberately re-run the OLD installer. No current installer or direct
      // apply API is permitted to perform the version transition being proved.
      await invoke('sh', [previousInstaller], previousInstallEnv, false, readFileSync(previousInstaller, 'utf8'));
    },
    async awaitAutomaticUpgrade() {
      await waitForAcceptanceReadiness(async () => {
        await service('check');
        for (const name of products) {
          checkpoint(`upgraded.${name}.version`);
          assert.equal(await invoke(join(bin, name), ['--version']), `${name} ${version}`);
        }
      }, () => host.verifyInstalled(), { signal, timeoutMs: 10 * 60_000, intervalMs: 1000 });
      await host.verifyDefaults();
    },
    async verifyUpgradedData() {
      assert.equal(readFileSync(sentinel, 'utf8'), preserved);
      assert.equal(await setting('update.intervalMinutes'), 61);
      assert.equal(resolve(await setting('controlPlane.webui.bundleDir')), originalWebui);
    },
    async verifyRollbackRefusal() {
      await host.verifyInstalled(); await upgrade.verifyUpgradedData();
      // Retire the real periodic owner before its installed-tree API check.
      await invoke(daemon, ['config', 'set', 'update.auto', 'false']);
      await service('restart'); await host.verifyInstalled(); await upgrade.verifyUpgradedData();
      // Implemented below through the actual source-bound platform rollback
      // API, never by inventing old reader metadata or a nonexistent CLI verb.
      await assertHistoricalRollbackRefusal({ bin, version, webuiDirectory: originalWebui, signal,
        ...(delivery?.rollbackSourceRoot ? { sourceRoot: delivery.rollbackSourceRoot } : {}) });
      await host.verifyInstalled(); await upgrade.verifyUpgradedData();
    },
    uninstall: host.uninstall, verifyPreserved,
  };
  const installerMigration = {
    admit: upgrade.admit, installPrevious: upgrade.installPrevious, verifyPrevious: upgrade.verifyPrevious,
    seedPreviousData: upgrade.seedPreviousData, startPreviousService: upgrade.startPreviousService,
    async disablePreviousUpdates() {
      for (const key of ['update.auto', 'update.autoUpdateAtLaunch']) await invoke(daemon, ['config', 'set', key, 'false']);
      await verifyOptOut();
    },
    async verifyPreviousService() {
      await waitForAcceptanceReadiness(() => service('check'), async () => {
        checkpoint('migration.previous.status-version');
        const status = JSON.parse(await invoke(daemon, ['status', '--json']));
        assert.equal(status.ok, true); assert.equal(status.data.identity.version, '3.1.1');
        const port = await setting('controlPlane.port'); checkpoint('migration.previous.webui-port');
        assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
        assert.equal(resolve(await setting('controlPlane.webui.bundleDir')), originalWebui);
        assert.equal(await setting('controlPlane.webui.serve'), true);
        checkpoint('migration.previous.webui-http');
        const page = await fetchBytes(`http://127.0.0.1:${port}/`, 2_097_152, signal);
        assert.ok(page.bytes.equals(readFileSync(join(originalWebui, 'index.html'))));
      }, { signal });
      await installerMigration.verifyMigratedData();
    },
    installCurrent: host.install, verifyCurrent: host.verifyInstalled,
    async verifyMigratedData() {
      checkpoint('migration.saved-data'); assert.equal(readFileSync(sentinel, 'utf8'), preserved);
      assert.equal(await setting('update.intervalMinutes'), 61); await verifyOptOut();
    },
    async restartAndVerifyMigrated() {
      await service('restart'); await host.verifyInstalled(); await installerMigration.verifyMigratedData();
    },
    uninstall: host.uninstall, verifyPreserved,
  };
  let initialPid, updatedPid, rolledBackPid, previousRuntimeObservation, previousPort, previousWebuiIndex;
  const canonicalFeed = `https://github.com/${repository}/releases/latest`;
  let selectedFeed = canonicalFeed, priorRequirements;
  const verifyPreviousReleaseData = async () => {
    checkpoint('previous.preserved-data-settings');
    assert.equal(readFileSync(sentinel, 'utf8'), preserved);
    assert.equal(await setting('update.intervalMinutes'), 61);
    assert.equal(await setting('update.firstCheckSeconds'), 30);
    assert.equal(await setting('update.releasesUrl'), selectedFeed);
    assert.equal(resolve(await setting('controlPlane.webui.bundleDir')), originalWebui);
    await host.verifyDefaults();
    const path = join(bin, '.goodvibes-reader-requirements.json'), stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) { assert.equal(priorRequirements, undefined); return; }
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 131072);
    const value = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(value.schema, 1); assert.ok(Array.isArray(value.formats)); assert.match(value.minimumReader, /^\d+\.\d+\.\d+$/);
    if (priorRequirements) {
      for (const format of priorRequirements.formats) assert.ok(value.formats.includes(format));
      const before = priorRequirements.minimumReader.split('.').map(Number), after = value.minimumReader.split('.').map(Number);
      const difference = after.findIndex((number, index) => number !== before[index]);
      assert.ok(difference === -1 || after[difference] > before[difference], 'Reader requirements must never be lowered.');
    }
    priorRequirements = value;
  };
  const previousUpgrade = {
    admit: host.admit,
    async installPrevious() {
      await invoke('sh', [previousInstaller], { GOODVIBES_VERSION: previousTag, GOODVIBES_WAKE_MODEL: '0',
        GOODVIBES_SHADOW_REMOVE: '0', GOODVIBES_DAEMON_SERVICE: '0' }, false, readFileSync(previousInstaller, 'utf8'));
    },
    async verifyPrevious() {
      await host.verifyInstalled({ version: previousTag.slice(1), readers: previousReaders, serviceDisabled: true });
      await host.verifyDefaults();
      assert.equal(await setting('update.releasesUrl'), canonicalFeed);
      assert.equal(await setting('update.firstCheckSeconds'), 30);
      originalWebui = resolve(await setting('controlPlane.webui.bundleDir'));
      assert.equal(originalWebui, join(bin, 'webui', previousTag.slice(1)));
      for (const directory of [originalWebui, join(bin, 'playwright-core')]) {
        assert.equal(JSON.parse(readFileSync(join(directory, '.goodvibes-release.json'), 'utf8')).version, previousTag.slice(1));
      }
      previousWebuiIndex = readFileSync(join(originalWebui, 'index.html'));
      assert.equal(await setting('controlPlane.webui.serve'), true);
      previousPort = await setting('controlPlane.port'); assert.ok(Number.isInteger(previousPort) && previousPort > 0 && previousPort < 65536);
    },
    async seedPreviousData() {
      mkdirSync(data, { recursive: true }); preserved = 'Original published previous-release data survives native automatic update and complete-cohort rollback.\n';
      writeFileSync(sentinel, preserved, { flag: 'wx', mode: 0o600 });
      await invoke(daemon, ['config', 'set', 'update.intervalMinutes', '61']);
      await verifyPreviousReleaseData();
    },
    async startPreviousService() {
      await invoke('sh', [previousInstaller], { GOODVIBES_VERSION: previousTag, GOODVIBES_WAKE_MODEL: '0', GOODVIBES_SHADOW_REMOVE: '0' },
        false, readFileSync(previousInstaller, 'utf8'));
    },
    async verifyPreviousService() {
      // All baseline readers/settings were checked while service-off. The
      // default-on updater may legitimately finish before a second CLI scan.
      await waitForAcceptanceReadiness(async () => {
        const pid = await nativeLifecycle.servicePid(); checkpoint('previous.service.status-version');
        const status = JSON.parse(await invoke(daemon, ['status', '--json'])); assert.equal(status.ok, true);
        const observed = status.data.identity.version;
        assert.ok(observed === previousTag.slice(1) || observed === version);
        if (observed === previousTag.slice(1)) { initialPid ??= pid; previousRuntimeObservation = 'previous-version-observed'; }
        else previousRuntimeObservation ??= 'target-reached-before-first-status';
      }, async () => {
        checkpoint('previous.service.webui-http');
        const page = await fetchBytes(`http://127.0.0.1:${previousPort}/`, 2_097_152, signal);
        // A valid concurrent update can replace this same configured tree.
        assert.ok(page.bytes.equals(previousWebuiIndex) || page.bytes.equals(readFileSync(join(originalWebui, 'index.html'))));
      }, { signal });
    },
    async prepareDelivery() {
      if (delivery) {
        // Public default delivery never enters this configurable custom-feed port.
        await delivery.preparePrevious({ invoke, daemon, setting });
        selectedFeed = await setting('update.releasesUrl');
        assert.match(selectedFeed, /^http:\/\/127\.0\.0\.1:\d+\/releases\/latest$/);
      }
      await verifyPreviousReleaseData();
    },
    async awaitAutomaticUpgrade() {
      await waitForAcceptanceReadiness(async () => {
        await service('check');
        for (const name of products) {
          checkpoint(`upgraded.${name}.version`);
          const observed = await invoke(join(bin, name), ['--version']);
          evidence.observedRelease = observed === `${name} ${version}` ? 'target'
            : observed === `${name} ${previousTag.slice(1)}` ? 'previous' : 'other';
          assert.equal(observed, `${name} ${version}`);
        }
      }, () => nativeLifecycle.verifyCohort(version, readers), { signal, timeoutMs: 10 * 60_000, intervalMs: 1000 });
      updatedPid = await nativeLifecycle.servicePid();
      if (initialPid !== undefined) assert.notEqual(updatedPid, initialPid);
    },
    verifyUpgradedData: verifyPreviousReleaseData,
    async verifyCompleteRollback() {
      assert.ok(process.env.CANDIDATE_SOURCE_ROOT, 'The original target source is required for the failed-start history writer.');
      ({ rolledBackPid } = await verifyCompiledSuiteRollback({ host: nativeLifecycle, target, source,
        sourceRoot: process.env.CANDIDATE_SOURCE_ROOT, previousVersion: previousTag.slice(1), currentVersion: version,
        previousReaders, webuiDirectory: originalWebui, verifyPreserved: verifyPreviousReleaseData }));
    },
    uninstall: host.uninstall, verifyPreserved,
  };
  if (process.platform === 'darwin' && delivery && process.env.GOODVIBES_ACCEPTANCE_DIAGNOSTICS === '1') {
    host.diagnoseFailure = async () => {
      if (signal?.aborted) return;
      checkpoint('native.failure-diagnostics');
      const records = []; let diagnosticFailure;
      try {
        const { diagnoseMacosNative } = await import('./diagnose-macos-native.mjs');
        await diagnoseMacosNative({ daemon, home, env, signal, onSafeEvidence: record => { records.push(record); }, stopService: async stopSignal => {
          const activeSignal = stopSignal ?? signal;
          let stopCheckpoint = 'ownership';
          const observeStop = () => { records.push({ phase: 'inspector', event: 'service-stop-checkpoint', checkpoint: stopCheckpoint }); };
          try {
            activeSignal?.throwIfAborted(); observeStop(); assertServiceOwned();
            stopCheckpoint = 'bootout'; observeStop();
            const bootout = await runOwnedCommand('launchctl', ['bootout', `gui/${account.uid}/${label}`], { cwd: home, env, timeoutMs: 300_000, signal: activeSignal });
            records.push({ phase: 'inspector', event: 'service-stop-result', checkpoint: stopCheckpoint,
              exitCode: bootout.code, signal: bootout.exitSignal ?? null });
            stopCheckpoint = 'home-after-bootout'; observeStop(); assertHome();
            stopCheckpoint = 'print'; observeStop();
            await waitForNativeServiceRetirement(() => runOwnedCommand('launchctl', ['print', `gui/${account.uid}/${label}`],
              { cwd: home, env, timeoutMs: 300_000, signal: activeSignal }), {
              signal: activeSignal, onObservation: result => {
                records.push({ phase: 'inspector', event: 'service-stop-result', checkpoint: stopCheckpoint, ...result });
              },
            });
            stopCheckpoint = 'retired'; observeStop();
          } catch (error) {
            const safe = safeError(error);
            records.push({ phase: 'inspector', event: 'service-stop-failed', checkpoint: stopCheckpoint,
              errorName: safe.name, errorCode: safe.code ?? 'unknown' });
            throw error;
          }
        } });
      } catch (error) { diagnosticFailure = error; }
      try {
        // The owned controller admits only bounded fixed codes/numbers and
        // sanitized public source coordinates, never runtime values or output.
        writeFileSync(join(root, 'native-diagnostics.json'), JSON.stringify({ target, evidence: records }) + '\n', { flag: 'wx', mode: 0o600 });
      } catch (error) {
        diagnosticFailure = diagnosticFailure ? new AggregateError([diagnosticFailure, error], 'Native diagnosis and evidence publication failed.') : error;
      }
      if (diagnosticFailure) throw diagnosticFailure;
    };
  }
  const selectedHost = historical ? upgrade : migration ? installerMigration : previousRelease ? previousUpgrade : host;
  for (const name of Object.keys(selectedHost)) {
    const original = selectedHost[name];
    selectedHost[name] = async (...args) => {
      evidence.stage = name; checkpoint(undefined);
      try { return await original(...args); }
      catch (error) { evidence.failures.push(acceptanceFailureRecord({ ...evidence, stage: name }, error)); throw error; }
    };
  }
  if (historical) await runHistoricalUpgradeSteps(selectedHost);
  else if (migration) await runInstallerMigrationSteps(selectedHost);
  else if (previousRelease) await runPreviousReleaseUpgradeSteps(selectedHost);
  else await runAcceptanceSteps(selectedHost);
  await finishAcceptance({ signal, finish: delivery?.finish ? async () => {
    evidence.stage = 'staged-delivery-drain'; checkpoint('delivery.finish'); await delivery.finish();
  } : undefined, assertCurrent: () => delivery?.assertCurrent(), writeReceipt: () => {
    writeFileSync(join(root, 'acceptance-result.json'), JSON.stringify({ tag, source, target, scenario, metadataInspection: evidence.metadataInspection,
    ...(historical || migration ? { previousTag: 'v3.1.1', previousSource } : previousRelease ? { previousTag, previousSource } : {}),
    ...(delivery ? { delivery: historical || previousRelease ? 'exact staged candidate; installer fetch adapter and owned loopback update feed'
      : 'exact staged candidate; installer fetch adapter', candidateInstaller: published.url, publicDelivery: 'not claimed' } : { publicInstaller: published.url }),
    installedProducts: [...products, 'goodvibes-webui'], defaultService: true, updateDefaults: !migration, optOutPersisted: !(historical || previousRelease),
    ...(previousRelease ? { unattendedUpdateVerified: true, completeCohortRollbackVerified: true,
      upgradeDelivery: delivery ? 'owned loopback custom feed; public default delivery not claimed' : 'untouched canonical public default feed',
      previousInstaller: `git:${previousSource}:scripts/install.sh`, baselineVersion: previousTag.slice(1), updatedVersion: version,
      restoredVersion: previousTag.slice(1), initialPid, updatedPid, rolledBackPid,
      previousRuntimeObservation, replacementPidObserved: initialPid !== undefined,
      rollbackTrigger: 'three failed-start history entries seeded through the source lifecycle writer while service stopped; crashes not observed',
      savedDataAndSettingsPreserved: true, configuredWebuiPathPreserved: true, readerRequirementsPreserved: true } : {}),
    ...(migration ? { installerMigration: 'actual public installer; running v3.1.1 service to v3.1.2; saved data, interval61 and updater opt-out preserved through restart' } : {}),
    uninstallPreservedData: true, futureVersionUpgrade: historical ? 'actual old unattended daemon plus pre-graph suite repair' : 'not claimed',
    publicRollback: historical ? 'incomplete historical cohort refused without effects' : previousRelease
      ? delivery ? 'actual compiled startup rollback of staged candidate to public previous cohort; seeded failed-start history'
        : 'actual compiled startup rollback of public release to public previous cohort; seeded failed-start history' : 'not claimed' }) + '\n', { flag: 'wx', mode: 0o600 });
  } });

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, source, target, scenario = 'fresh', previousTag, previousSource] = process.argv.slice(2);
  const controller = new AbortController(), stop = () => controller.abort(new Error('Acceptance owner stopped.'));
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  acceptPublishedSuite({ tag, source, target, scenario, previousTag, previousSource, signal: controller.signal }).catch(() => { console.error('Published suite acceptance failed; no successful native install claim was emitted.'); process.exitCode = 1; })
    .finally(() => { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); });
}
