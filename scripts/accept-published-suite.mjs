/** Native lifecycle acceptance on a disposable account: a GitHub-hosted runner, or
 * any account started with --disposable-account (a throwaway container with a user
 * service manager, a fresh macOS user) that holds nothing of GoodVibes.
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

/** The installer's own `REPO=` line is the release source: it is piped from curl, so it
 * cannot import a constant, and the acceptance run must verify exactly the repository
 * that installer downloads from. */
function readInstallerRepository() {
  const text = readFileSync(fileURLToPath(new URL('./install.sh', import.meta.url)), 'utf8');
  const match = /^REPO="([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)"$/m.exec(text);
  assert.ok(match, 'scripts/install.sh does not declare its release repository.');
  return match[1];
}
export const repository = readInstallerRepository();
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const products = ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent'];
/** The daemon registers its own service (`goodvibes-daemon install-service`; the installer
 * writes none). On Linux that is a systemd user unit named goodvibes-jev on an account that
 * has none (DAEMON_SERVICE_NAME in packages/engine/platform/src/platform/daemon/
 * daemon-service-default.ts). A unit an earlier release registered as goodvibes keeps that
 * name and is managed, never duplicated. goodvibes-daemon is the name an older installer used.
 * On macOS it is the LaunchAgent sh.goodvibes.daemon. */
const currentUnit = 'goodvibes-jev.service', productUnits = [currentUnit, 'goodvibes.service'];
const retiredUnit = 'goodvibes-daemon.service', label = 'sh.goodvibes.daemon';

/** Harness inspection only. Consume the dedicated credential before any child
 * environment is captured; the installer, assets and updater stay anonymous. */
export function consumeAcceptanceMetadataFetch(env = process.env, fetchImpl = fetch) {
  const token = env.GOODVIBES_ACCEPTANCE_METADATA_TOKEN;
  delete env.GOODVIBES_ACCEPTANCE_METADATA_TOKEN;
  const tag = 'v[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?';
  const route = new RegExp(`^https://api\\.github\\.com/repos/${escapeRegExp(repository)}/(?:releases/(?:latest|tags/${tag})|git/ref/tags/${tag}|git/tags/[a-f0-9]{40})$`);
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
const nativeDaemonFailureCodes = new Set(['token-missing', 'invalid-port', 'invalid-host', 'unreachable', 'auth-refused',
  'route-missing', 'unreadable-reply', 'refused']);
const nativeDaemonFailureKinds = new Set([...nativeDaemonFailureCodes, 'cli-command-caught', 'native-startup-repair', 'unknown']);
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
    if (failure?.ok !== false) continue;
    // The daemon CLI states why in `code`, from its closed list (DAEMON_FAILURE_CODES); the sentences are for people.
    if (typeof failure.code === 'string' && nativeDaemonFailureCodes.has(failure.code)) return failure.code;
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

/** Emit fixed vocabulary only: the installer's stable refusal ids (INSTALL_E###, printed
 * after every refusal), OS error classes and curl codes. Paths, expanded shell variables
 * and the rest of stdout/stderr stay private. */
function installerFailureDiagnostics(source, stdout, stderr) {
  const sourceLines = source.split('\n').length, diagnostics = new Set();
  for (const line of `${stderr}\n${stdout}`.split(/\r?\n/)) {
    const refusal = /\((INSTALL_E\d{3})\)$/.exec(line)?.[1];
    if (refusal) diagnostics.add(`install.sh refusal ${refusal}`);
    // Shells print different prefixes; preserve only an in-range source line.
    const number = /:\s*(?:line\s+)?(\d+):/.exec(line)?.[1];
    const location = number && Number(number) > 0 && Number(number) <= sourceLines ? ` at installer line ${Number(number)}` : '';
    const reason = /(?:^|: )(Bad file descriptor|Bad fd number|Is a directory|Not a directory|Permission denied|Operation not permitted|No such file(?: or directory)?|not found|command not found|parameter not set|unbound variable|Illegal instruction|Segmentation fault|Exec format error|Argument list too long|Syntax error|Bad substitution|Read-only file system|Too many open files|No space left on device|unexpected operator)(?:$|[ .(:])/i.exec(line)?.[1];
    // Dash abbreviates missing read-redirection targets to "No such file".
    const canonicalReason = /^no such file(?: or directory)?$/i.test(reason ?? '') ? 'no such file or directory' : reason?.toLowerCase();
    if (canonicalReason) diagnostics.add(`Shell/OS failure${location}: ${canonicalReason}`);
    else if (location && !refusal) diagnostics.add(`Unclassified shell failure${location}; dynamic output withheld.`);
    const curl = /^curl: \((\d{1,3})\)/.exec(line);
    if (curl) diagnostics.add(`curl failed with error ${Number(curl[1])}; dynamic output withheld.`);
    if (diagnostics.size >= 8) break;
  }
  return [...diagnostics].slice(0, 8);
}

/** Acceptance installs, starts and removes real services in this account, so it needs one that may be
 * thrown away: a GitHub-hosted runner, or an account the caller declares disposable. Either way the
 * account must hold nothing of GoodVibes (checked separately before any work). */
export function assertDisposableAccount(input) {
  const hosted = input.env.GITHUB_ACTIONS === 'true' && input.env.RUNNER_ENVIRONMENT === 'github-hosted';
  assert.ok(hosted || input.disposableAccount === true,
    'Acceptance installs and removes real services in this account. Run it on a GitHub-hosted runner, or pass --disposable-account in a throwaway container or a fresh user account.');
  assert.match(input.tag, /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  assert.match(input.source, /^[a-f0-9]{40}$/);
  assert.equal(input.target, `${input.platform}-${input.arch}`);
  assert.ok(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'].includes(input.target));
  assert.equal(input.home, input.accountHome, 'A HOME override cannot isolate a native service manager.');
  assert.ok(input.uid > 0, 'Do not install into the root account.');
  if (hosted) assert.ok(input.env.RUNNER_TEMP && isAbsolute(input.env.RUNNER_TEMP));
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
    await host.disableUpdates(); await host.restartAndVerifyOptOut();
    await host.install(); await host.verifyOptOut();
    await host.uninstall(); await host.verifyPreserved();
    await host.uninstall(); await host.verifyPreserved();
    await host.install(); await host.verifyInstalled(); await host.verifyOptOut();
  } catch (error) {
    primary = error;
  }
  finally {
    if (attempted) {
      try { await host.uninstall(); await host.verifyPreserved(); }
      catch (error) { primary = primary ? new AggregateError([primary, error], 'Acceptance and owned cleanup failed.') : error; }
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
 * observations. The injected fetch seam supplies owned HTTP fixtures in tests.
 *
 * `release` (the default) runs when the release is published and keeps both
 * moving-target comparisons: the tag must still be the repository's latest and the
 * public installer must equal the one in the release's source commit. `recheck`
 * re-verifies bytes that were published earlier, when either may legitimately have
 * moved on (a newer release, a later change to the installer on main): it installs
 * the tag explicitly from the installer committed at its source, and compares
 * neither. The staged, pre-publication path never uses `recheck`. */
export async function readPublicAcceptanceDelivery({ tag, source, target, signal, checkpoint, onHttpStatus, mode = 'release' }, fetchImpl = fetch) {
  assert.ok(mode === 'release' || mode === 'recheck', 'Unknown published acceptance mode.');
  const api = `https://api.github.com/repos/${repository}`;
  const request = async (check, url, limit) => {
    checkpoint(check);
    return fetchBytes(url, limit, signal, onHttpStatus, fetchImpl);
  };
  const release = JSON.parse((await request('catalog.release.http', `${api}/releases/tags/${tag}`)).bytes);
  checkpoint('catalog.release.tag'); assert.equal(release.tag_name, tag);
  checkpoint('catalog.release.draft'); assert.equal(release.draft, false);
  checkpoint('catalog.release.assets');
  assert.ok(Array.isArray(release.assets), 'The release asset catalog must be an array.');
  checkpoint('catalog.release.unique-assets');
  const names = new Set(release.assets.map(asset => asset.name)); assert.equal(names.size, release.assets.length);
  checkpoint('catalog.release.manifest'); assert.ok(names.has('SHA256SUMS.txt'));
  const readers = await readPublishedReaders({ tag, source, target, assets: names, onCheck: checkpoint }, async name => {
    const suffix = target.replace(/^darwin-/, 'macos-');
    const command = products.find(command => name === `${command}-${suffix}.reader-ci-artifact.json`); assert.ok(command);
    const value = JSON.parse((await request(`catalog.reader.${command}.http`, `https://github.com/${repository}/releases/download/${tag}/${name}`, 131_072)).bytes);
    return value;
  });
  if (mode === 'release') {
    const latest = JSON.parse((await request('catalog.latest.http', `${api}/releases/latest`)).bytes);
    checkpoint('catalog.latest.tag');
    assert.equal(latest.tag_name, tag, 'Default updater acceptance requires this exact tag to be latest.');
  }
  const immutable = await request('installer.immutable.http', `https://raw.githubusercontent.com/${repository}/${source}/scripts/install.sh`);
  if (mode === 'recheck') return { readers, published: { bytes: immutable.bytes, url: immutable.url }, immutable, mode };
  const published = await request('installer.public.http', 'https://goodvibes.sh/install.sh');
  checkpoint('installer.public.redirect');
  assert.match(published.url, new RegExp(`^https://raw\\.githubusercontent\\.com/${escapeRegExp(repository)}/(?:main|[a-f0-9]{40})/scripts/install\\.sh$`));
  checkpoint('installer.public.bytes');
  assert.ok(published.bytes.equals(immutable.bytes), 'The public installer differs from the accepted release source.');
  return { readers, published, immutable, mode };
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
  assert.ok(Array.isArray(release.assets));
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
    const diagnostic = { tag: input.tag, source: input.source, target: input.target, accepted: false,
      ...(input.delivery ? {} : { mode: input.mode ?? 'release' }), metadataInspection: evidence.metadataInspection,
      failures: evidence.failures.length ? evidence.failures : [acceptanceFailureRecord(evidence, error)],
      diagnostic: input.delivery ? 'Staged native install/service/cleanup acceptance failed.' : 'Published native install/service/cleanup acceptance failed.' };
    if (evidence.root) writeFileSync(join(evidence.root, 'acceptance-result.json'), JSON.stringify(diagnostic) + '\n', { flag: 'wx', mode: 0o600 });
    console.error(JSON.stringify(diagnostic));
    throw error;
  }
}

async function performPublishedAcceptance({ tag, source, target, signal, scenario = 'fresh', delivery, previousTag, previousSource: selectedPreviousSource, mode = 'release', disposableAccount = false }, evidence, metadataFetch) {
  assert.ok(delivery === undefined || mode === 'release', 'A staged candidate is accepted before publication; recheck applies to published releases only.');
  assert.ok(scenario === 'fresh' || scenario === 'upgrade-previous', 'Unknown published acceptance scenario.');
  const previousRelease = scenario === 'upgrade-previous';
  if (previousRelease) assertPreviousReleaseInputs({ tag, previousTag, previousSource: selectedPreviousSource });
  else assert.ok(previousTag === undefined && selectedPreviousSource === undefined, 'Previous inputs belong to previous-release acceptance only.');
  const account = userInfo(), home = realpathSync(process.env.HOME ?? '');
  assertDisposableAccount({ env: process.env, platform: process.platform, arch: process.arch, disposableAccount,
    home, accountHome: realpathSync(account.homedir), uid: account.uid, tag, source, target });
  const originalHome = lstatSync(home, { bigint: true });
  const assertHome = () => {
    const now = lstatSync(home, { bigint: true });
    assert.ok(now.isDirectory() && !now.isSymbolicLink() && now.dev === originalHome.dev && now.ino === originalHome.ino && now.uid === originalHome.uid);
    assert.equal(realpathSync(home), home);
  };
  const bin = join(home, '.local/bin'), data = join(home, '.goodvibes');
  const unitPath = name => join(home, '.config/systemd/user', name);
  // Every definition the product's service can have. A fresh install must register the current
  // name; the previous-release scenario takes the one name that release registered (see
  // pinPreviousServiceUnit), and an upgrade must keep supervising under it.
  const serviceDefinitions = process.platform === 'linux' ? productUnits.map(unitPath) : [join(home, 'Library/LaunchAgents', `${label}.plist`)];
  let unit = process.platform === 'linux' && !previousRelease ? currentUnit : undefined;
  const selectedUnit = () => { assert.ok(unit, 'The daemon service unit has not been identified yet.'); return unit; };
  const servicePath = () => process.platform === 'linux' ? unitPath(selectedUnit()) : serviceDefinitions[0];
  const pinPreviousServiceUnit = () => {
    if (process.platform !== 'linux') return;
    const present = productUnits.filter(name => lstatSync(unitPath(name), { throwIfNoEntry: false }) !== undefined);
    assert.equal(present.length, 1, 'The previous release must register exactly one daemon service unit.');
    unit = present[0];
  };
  for (const path of [data, ...serviceDefinitions, ...products.map(name => join(bin, name))])
    assert.equal(lstatSync(path, { throwIfNoEntry: false }), undefined, 'Existing GoodVibes ownership is not an acceptance fixture.');
  for (const path of [join(home, '.local'), bin, join(home, '.config'), join(home, '.config/systemd'), join(home, '.config/systemd/user'),
    join(home, 'Library'), join(home, 'Library/LaunchAgents')]) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat) assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === path, 'Native install parents must belong to the original account.');
  }
  const temporary = process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP) ? process.env.RUNNER_TEMP : tmpdir();
  const root = mkdtempSync(join(realpathSync(temporary), 'goodvibes-published-')); evidence.root = root;
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
    // A runner account has no user service manager until one is started for it; an account that already
    // runs one (a container started with it, a logged-in user) needs no administrator step.
    if ((await runOwnedCommand('systemctl', ['--user', 'show-environment'], { env, signal })).code !== 0) {
      await invoke('sudo', ['-n', 'loginctl', 'enable-linger', account.username]);
      await invoke('sudo', ['-n', 'systemctl', 'start', `user@${account.uid}.service`]);
    }
    await invoke('systemctl', ['--user', 'show-environment']);
    for (const name of [...productUnits, retiredUnit]) {
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
    ({ readers, published, immutable } = await readPublicAcceptanceDelivery({ tag, source, target, signal, mode,
      checkpoint(check) { evidence.stage = check.startsWith('installer.') ? 'public-installer' : 'published-catalog'; checkpoint(check); },
      onHttpStatus(status) { evidence.httpStatus = status; },
    }, metadataFetch));
    installer = join(root, 'install.sh'); writeFileSync(installer, published.bytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(root, 'immutable-install.sh'), immutable.bytes, { flag: 'wx', mode: 0o600 });
  }
  const installEnv = { GOODVIBES_VERSION: tag, GOODVIBES_WAKE_MODEL: '0', GOODVIBES_SHADOW_REMOVE: '0' };
  let previousInstaller, previousSource, previousReaders;
  if (previousRelease) {
    evidence.stage = 'previous-release-source';
    const cohort = await readPreviousReleaseCohort({ tag: previousTag, source: selectedPreviousSource, target, signal,
      checkpoint, onHttpStatus(status) { evidence.httpStatus = status; } }, metadataFetch);
    previousSource = selectedPreviousSource; previousReaders = cohort.readers;
    previousInstaller = join(root, 'install-previous.sh'); writeFileSync(previousInstaller, cohort.installer, { flag: 'wx', mode: 0o600 });
  }
  const daemon = join(bin, 'goodvibes-daemon'), version = tag.slice(1);
  const setting = async key => {
    checkpoint(`configuration.${key}`);
    const result = JSON.parse(await invoke(daemon, ['config', 'get', key, '--json']));
    assert.equal(result.ok, true); assert.equal(result.data.key, key); return result.data.value;
  };
  const assertServiceOwned = () => {
    assertHome(); const path = servicePath(), stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === account.uid);
    assert.ok(readFileSync(path, 'utf8').includes(daemon), 'The service must retain this exact admitted executable.');
    for (const other of serviceDefinitions) if (other !== path) {
      assert.equal(lstatSync(other, { throwIfNoEntry: false }), undefined, 'The daemon must run under one service definition, never a duplicate.');
    }
  };
  const service = async action => {
    checkpoint('service.ownership');
    assertServiceOwned();
    checkpoint(action === 'restart' ? 'service.restart' : 'service.running');
    if (process.platform === 'linux') await invoke('systemctl', ['--user', action === 'restart' ? 'restart' : 'is-active', selectedUnit()]);
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
    for (const path of serviceDefinitions) assert.equal(lstatSync(path, { throwIfNoEntry: false }), undefined, 'Uninstall must retire its original native service.');
    for (const probe of process.platform === 'linux' ? productUnits.map(name => ['systemctl', ['--user', 'is-active', name]])
      : [['launchctl', ['print', `gui/${account.uid}/${label}`]]]) {
      const stopped = await runOwnedCommand(probe[0], probe[1], { env });
      assert.notEqual(stopped.code, 0, 'The original service must stop before uninstall is acknowledged.');
    }
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
        for (const path of serviceDefinitions) assert.equal(lstatSync(path, { throwIfNoEntry: false }), undefined, 'Previous programs must be verified before service activation.');
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
        else assert.equal(resolve(bundle), join(bin, 'webui', version));
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
          const value = await invoke('systemctl', ['--user', 'show', selectedUnit(), '--property=MainPID', '--value']);
          assert.match(value, /^[1-9]\d*$/); const pid = Number(value); assert.ok(Number.isSafeInteger(pid) && pid <= 2147483647); return pid;
        }
        const printed = await invoke('launchctl', ['print', `gui/${account.uid}/${label}`]);
        assert.match(printed, /state = running/); const match = /^\s*pid = (\d+)\s*$/m.exec(printed);
        assert.ok(match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0); return Number(match[1]);
      },
      async stopService() {
        assertServiceOwned();
        const command = process.platform === 'linux' ? 'systemctl' : 'launchctl';
        await invoke(command, process.platform === 'linux' ? ['--user', 'stop', selectedUnit()] : ['bootout', `gui/${account.uid}/${label}`]);
        await waitForNativeServiceRetirement(() => runOwnedCommand(command, process.platform === 'linux'
          ? ['--user', 'is-active', selectedUnit()] : ['print', `gui/${account.uid}/${label}`],
          { cwd: home, env, timeoutMs: 300_000, signal }), { signal });
      },
      async startService() {
        assertServiceOwned();
        if (process.platform === 'linux') await invoke('systemctl', ['--user', 'start', selectedUnit()]);
        else await invoke('launchctl', ['bootstrap', `gui/${account.uid}`, servicePath()]);
      },
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
      pinPreviousServiceUnit();
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
  const selectedHost = previousRelease ? previousUpgrade : host;
  for (const name of Object.keys(selectedHost)) {
    const original = selectedHost[name];
    selectedHost[name] = async (...args) => {
      evidence.stage = name; checkpoint(undefined);
      try { return await original(...args); }
      catch (error) { evidence.failures.push(acceptanceFailureRecord({ ...evidence, stage: name }, error)); throw error; }
    };
  }
  if (previousRelease) await runPreviousReleaseUpgradeSteps(selectedHost);
  else await runAcceptanceSteps(selectedHost);
  await finishAcceptance({ signal, finish: delivery?.finish ? async () => {
    evidence.stage = 'staged-delivery-drain'; checkpoint('delivery.finish'); await delivery.finish();
  } : undefined, assertCurrent: () => delivery?.assertCurrent(), writeReceipt: () => {
    writeFileSync(join(root, 'acceptance-result.json'), JSON.stringify({ tag, source, target, scenario, metadataInspection: evidence.metadataInspection,
    ...(previousRelease ? { previousTag, previousSource } : {}),
    ...(delivery ? { delivery: previousRelease ? 'exact staged candidate; installer fetch adapter and owned loopback update feed'
      : 'exact staged candidate; installer fetch adapter', candidateInstaller: published.url, publicDelivery: 'not claimed' }
      : mode === 'recheck' ? { mode, publicInstaller: 'not compared: recheck of an earlier release', releaseInstaller: published.url }
        : { mode, publicInstaller: published.url }),
    installedProducts: [...products, 'goodvibes-webui'], defaultService: true, updateDefaults: true, optOutPersisted: !previousRelease,
    ...(previousRelease ? { unattendedUpdateVerified: true, completeCohortRollbackVerified: true,
      upgradeDelivery: delivery ? 'owned loopback custom feed; public default delivery not claimed' : 'untouched canonical public default feed',
      previousInstaller: `git:${previousSource}:scripts/install.sh`, baselineVersion: previousTag.slice(1), updatedVersion: version,
      restoredVersion: previousTag.slice(1), initialPid, updatedPid, rolledBackPid,
      previousRuntimeObservation, replacementPidObserved: initialPid !== undefined,
      rollbackTrigger: 'three failed-start history entries seeded through the source lifecycle writer while service stopped; crashes not observed',
      savedDataAndSettingsPreserved: true, configuredWebuiPathPreserved: true, readerRequirementsPreserved: true } : {}),
    uninstallPreservedData: true, futureVersionUpgrade: 'not claimed',
    publicRollback: previousRelease
      ? delivery ? 'actual compiled startup rollback of staged candidate to public previous cohort; seeded failed-start history'
        : 'actual compiled startup rollback of public release to public previous cohort; seeded failed-start history' : 'not claimed' }) + '\n', { flag: 'wx', mode: 0o600 });
  } });

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), disposableAccount = argv.includes('--disposable-account');
  const [tag, source, target, scenario = 'fresh', previousTag, previousSource] = argv.filter(arg => arg !== '--disposable-account');
  // Set to `recheck` to re-verify an already published release (see readPublicAcceptanceDelivery).
  const mode = process.env.GOODVIBES_ACCEPTANCE_MODE === 'recheck' ? 'recheck' : 'release';
  const controller = new AbortController(), stop = () => controller.abort(new Error('Acceptance owner stopped.'));
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  acceptPublishedSuite({ tag, source, target, scenario, previousTag, previousSource, mode, disposableAccount, signal: controller.signal }).catch(() => { console.error('Published suite acceptance failed; no successful native install claim was emitted.'); process.exitCode = 1; })
    .finally(() => { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); });
}
