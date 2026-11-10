import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSystemOnePort, judgmentConfigFromEnv } from '@goodvibes-jev/judgment';
import { readNativeAddonEvidence, proveNativeMemoryRoundTrip } from './boot-smoke-reading.mjs';
import { syntheticSystemOneAnswers } from './hosted-session-protocol.mjs';
import { nativeExecutionSource, retainNativeExecutionFiles, verifyNativeExecutionArtifact } from './native-execution-artifact.mjs';
import { assertNativeProcessGroupDrained, boundedNativeProcessClose, drainNativeProcessGroup, signalNativeProcessGroup } from './native-execution-process.mjs';
import { assertNativeStartupActive, assertNativeStartupBanners, hasNativeStartupReadyBanner, retainNativeStartupProgress } from './native-startup-liveness.mjs';

// Portable original Darwin boot/vector obligation. Linux keeps the stronger
// namespace + hosted consumer; this script makes no isolation/install claim.
assert(!process.versions.bun, 'Native execution controller must use ordinary Node');
assert.equal(process.platform, 'darwin', 'Portable consumer requires its real Darwin host');
const product = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [sourceCommit, headCommit, ...extra] = process.argv.slice(2);
assert(sourceCommit && headCommit && extra.length === 0, 'Usage: verify-native-execution.mjs <checkout SHA> <head SHA>');
const source = nativeExecutionSource(product, sourceCommit, headCommit);
const original = verifyNativeExecutionArtifact(product, source, { allowEarlierAttempt: true });
assert.equal(original.members.length, 5, 'Darwin execution requires all four native payloads and its actual reader metadata');
assert.equal(original.members.at(-1).path, original.members[0].path + '.readers.json', 'Darwin reader must use its actual adjacent installed name');
const root = mkdtempSync(join(realpathSync(tmpdir()), 'daemon-native-execution-'));
const artifacts = join(root, 'artifacts'), work = join(root, 'foreign-work'), home = join(root, 'home');
const tree = join(root, 'tree'), daemon = join(root, 'selected-daemon');
const token = 'synthetic-native-memory-token';
let judgment, judgmentError, host, hostStopped, hostExited = false, hostPid;
const requests = [];
const requestShapes = { modelFactShape: 0, fieldNameShape: 0, settingFormShape: 0, other: 0 };
let cleanupRefused = false;
const childEnv = { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'xdg'),
  GOODVIBES_HOME: tree, GOODVIBES_DAEMON_HOME: daemon, GOODVIBES_WORKING_DIR: work, NO_COLOR: '1',
  // Existing production opt-out: no wake/provider/model acquisition is part of
  // this memory-vector proof. The shipped memory embedding still runs.
  GOODVIBES_SKIP_WAKE_MODEL_DOWNLOAD: '1' };
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));
const wait = ms => new Promise(yes => setTimeout(yes, ms));
// These wire shapes are advisory counts, never decision-site attribution.
function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function textCriteria(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every(entry => entry === null || typeof entry === 'string');
}
function textQuestion(question, type) {
  return exactKeys(question, ['type', 'instructions', 'criteria']) && question.type === type
    && typeof question.instructions === 'string' && textCriteria(question.criteria);
}
function nativeRequestShape(body) {
  const state = body.state, questions = body.questions;
  if (exactKeys(state, ['provider', 'model_id']) && typeof state.provider === 'string' && typeof state.model_id === 'string') {
    if ((exactKeys(questions, ['chat']) && textQuestion(questions.chat, 'noul') && exactKeys(questions.chat.criteria, ['true', 'false']))
      || (exactKeys(questions, ['route']) && textQuestion(questions.route, 'choice'))) return 'modelFactShape';
  }
  if (exactKeys(state, ['field']) && typeof state.field === 'string' && exactKeys(questions, ['kind'])
    && textQuestion(questions.kind, 'choice') && exactKeys(questions.kind.criteria, ['secret', 'owner_profile', 'content', 'other'])) return 'fieldNameShape';
  if (exactKeys(state, ['context', 'candidates']) && exactKeys(state.context, ['section', 'name'])
    && typeof state.context.section === 'string' && typeof state.context.name === 'string' && Array.isArray(state.candidates)
    && state.candidates.length > 0 && state.candidates.every(candidate => exactKeys(candidate, ['id', 'content'])
      && typeof candidate.id === 'string' && (candidate.content === null || typeof candidate.content === 'string'))
    && exactKeys(questions, ['pick', ...state.candidates.map((_, index) => `fits_${index}`)])
    && textQuestion(questions.pick, 'choice')
    && exactKeys(questions.pick.criteria, ['none', ...state.candidates.map(candidate => candidate.id)])
    && state.candidates.every((_, index) => {
      const fit = questions[`fits_${index}`];
      return exactKeys(fit, ['type', 'instructions']) && fit.type === 'noul'
        && exactKeys(fit.instructions, ['question', 'candidate'])
        && typeof fit.instructions.question === 'string' && typeof fit.instructions.candidate === 'string';
    })) return 'settingFormShape';
  return 'other';
}
// Advisory reachability only: a connection never proves listener ownership.
// This runs after qualification already failed, sends no bytes, and cannot
// turn a stalled startup into a pass or revive its expired liveness clock.
async function observeDeadlinePort(port) {
  const socket = createConnection({ host: '127.0.0.1', port });
  let timer;
  try {
    return await new Promise(yes => {
      let portConnection = 'unobserved', closing = false;
      const finish = () => {
        if (closing) return;
        closing = true; clearTimeout(timer); socket.destroy();
        timer = setTimeout(() => yes({ portConnection, probeClosed: false }), 500);
      };
      socket.once('close', () => yes({ portConnection, probeClosed: true }));
      socket.once('connect', () => { if (!closing) portConnection = 'accepted'; finish(); });
      socket.once('error', error => { if (!closing && error.code === 'ECONNREFUSED') portConnection = 'refused'; finish(); });
      timer = setTimeout(finish, 500);
    });
  } finally { clearTimeout(timer); socket.destroy(); }
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections(); await new Promise((yes, no) => server.close(error => error ? no(error) : yes()));
}

try {
  for (const path of [artifacts, work, home, join(root, 'tmp')]) mkdirSync(path, { recursive: true });
  // Copy the retained bytes, never rebuild and never follow receipt-supplied paths.
  for (const file of original.retained.files) {
    const full = join(artifacts, file.path); mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.bytes, { flag: 'wx', mode: file.mode }); chmodSync(full, file.mode);
  }
  original.retained.assertCurrent();
  // The running admitted daemon publishes reader requirements and their lock
  // beside its executable. Those owned sibling writes change directory clocks;
  // retain physical parents and every original member, not an immutable directory
  // revision. The downloaded original cohort above remains strictly immutable.
  const relocated = retainNativeExecutionFiles(artifacts, [...original.members, { path: 'native-execution-artifact.json', mode: 0o644 }], { directoryRevisions: false });
  assert.deepEqual(relocated.files.map(({ path, sha256, mode, size }) => ({ path, sha256, mode, size })),
    original.retained.files.map(({ path, sha256, mode, size }) => ({ path, sha256, mode, size })), 'Relocation changed the retained execution cohort');
  const binary = join(artifacts, original.members[0].path), version = original.artifact.version;
  assert.equal(basename(binary), original.members[0].path);
  writeJson(join(work, 'package.json'), { name: '@fixture/foreign-package', version: '99.8.7', type: 'module' });
  async function run(argv) {
    original.retained.assertCurrent(); relocated.assertCurrent();
    const child = spawn(binary, argv, { cwd: work, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', expired = false;
    const capture = key => chunk => {
      if (key === 'stdout') stdout += chunk; else stderr += chunk;
      if (stdout.length + stderr.length > 1_048_576) { expired = true; signalNativeProcessGroup(child); }
    };
    child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'));
    const stopped = new Promise((yes, no) => { child.once('error', no); child.once('close', (code, signal) => yes({ code, signal })); });
    const timer = setTimeout(() => { expired = true; signalNativeProcessGroup(child); }, 20_000);
    try {
      const result = await boundedNativeProcessClose(stopped, 20_000, 'Native command close deadline'); assert(!expired, 'Portable native command exceeded its deadline/output bound');
      assert.equal(result.signal, null, stderr);
      assertNativeProcessGroupDrained(child);
      original.retained.assertCurrent(); relocated.assertCurrent();
      return { ...result, stdout, stderr };
    } finally {
      clearTimeout(timer);
      try { await drainNativeProcessGroup(child, stopped); }
      catch (error) { cleanupRefused = true; throw error; }
      finally { child.stdout.destroy(); child.stderr.destroy(); }
    }
  }
  assert.deepEqual(await run(['--version']), { code: 0, signal: null, stdout: `goodvibes-daemon ${version}\n`, stderr: '' });
  const help = await run(['--help']); assert.equal(help.code, 0); assert(help.stdout.includes('Usage: goodvibes-daemon')); assert.equal(help.stderr, '');
  const malformedHome = join(root, 'malformed-daemon'); mkdirSync(malformedHome);
  const malformedPath = join(malformedHome, 'settings.json'), malformedBytes = '{ "token": "synthetic-private-malformed-value"';
  writeFileSync(malformedPath, malformedBytes);
  const malformed = await run(['--daemon-home', malformedHome, 'serve']);
  assert.equal(malformed.code, 1, 'Malformed selected settings must refuse real startup');
  assert(malformed.stderr.includes(malformedPath)); assert(malformed.stderr.includes('could not be read as JSON'));
  assert(!malformed.stdout.includes(' bound:')); assert(!malformed.stdout.includes('host started'));
  assert(!(malformed.stdout + malformed.stderr).includes('synthetic-private-malformed-value')); assert.equal(readFileSync(malformedPath, 'utf8'), malformedBytes);

  judgment = createServer((request, response) => {
    void (async () => {
      assert.equal(request.url, '/v1/systemone'); assert.equal(request.method, 'POST');
      let text = ''; for await (const chunk of request) { text += chunk; assert(text.length < 1_048_576); }
      const body = JSON.parse(text); assert.equal(body.model, 'jev-latest'); assert(requests.length < 5_000, 'Unexpected native boot judgment loop'); requests.push(body);
      requestShapes[nativeRequestShape(body)]++;
      const answers = syntheticSystemOneAnswers(body.questions);
      for (const [name, question] of Object.entries(body.questions)) {
        if (question.type === 'noul') answers[name] = { type: 'noul', noul: name === 'native_addon_failure' ? 0.01 : 0.99 };
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 1, output_tokens: 1 } }));
    })().catch(error => { judgmentError = error; response.writeHead(500); response.end('Synthetic native reading failed'); });
  });
  await new Promise((yes, no) => { judgment.once('error', no); judgment.listen(0, '127.0.0.1', yes); });
  const judgmentEnv = { TYPESAFE_BASE_URL: `http://127.0.0.1:${judgment.address().port}`, TYPESAFE_API_KEY: 'synthetic-native-reading-key', TYPESAFE_DEFAULT_MODEL: 'jev-latest' };
  const readingPort = createSystemOnePort(judgmentConfigFromEnv(judgmentEnv));
  mkdirSync(daemon); writeJson(join(daemon, 'settings.json'), { cluster: { enabled: false }, relay: { enabled: false } });
  const lease = createServer(); await new Promise((yes, no) => { lease.once('error', no); lease.listen(0, '127.0.0.1', yes); });
  const port = lease.address().port; await closeServer(lease);
  original.retained.assertCurrent(); relocated.assertCurrent();
  const startupProgress = retainNativeStartupProgress();
  host = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: work, env: { ...childEnv, ...judgmentEnv, GOODVIBES_DAEMON_TOKEN: token, GOODVIBES_NATIVE_STARTUP_OBSERVATION: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  hostPid = host.pid; let output = '', errors = '', startupBannerObservedAt;
  host.stdout.on('data', chunk => {
    output += chunk;
    if (startupBannerObservedAt === undefined && output.includes(' starting:')) startupBannerObservedAt = startupProgress.snapshot().elapsedMs;
    if (output.length + errors.length > 1_048_576) signalNativeProcessGroup(host);
  });
  host.stderr.on('data', chunk => {
    errors += chunk;
    if (output.length + errors.length > 1_048_576) { signalNativeProcessGroup(host); return; }
    startupProgress.append(chunk, requests.length);
  });
  hostStopped = new Promise((yes, no) => {
    host.once('error', no); host.once('close', (code, signal) => { hostExited = true; yes({ code, signal }); });
  }); void hostStopped.catch(() => {});
  while (!hasNativeStartupReadyBanner(output, version)) {
    assert.ifError(judgmentError);
    const progress = startupProgress.snapshot();
    if (hostExited || requests.length !== 0 || progress.failed) {
      assertNativeStartupActive(progress, { processClosed: hostExited, requestCount: requests.length });
    }
    if (progress.stalled) {
      // Capture the failing boundary before the diagnostic yields. These are
      // fixed booleans/counts; no settings, paths, request text or errors enter it.
      const failureOutput = output, failureErrors = errors;
      const observation = { elapsedMs: progress.elapsedMs, noProgressMs: progress.noProgressMs,
        processClosed: hostExited, requestCount: requests.length,
        requestShapes: Object.freeze({ ...requestShapes }), phases: progress.phases,
        startupBannerDelayMs: startupBannerObservedAt ?? null,
        startupBannerObserved: output.includes(' starting:'), boundBannerObserved: output.includes(' bound:'),
        readyBannerObserved: hasNativeStartupReadyBanner(output, version) };
      const portObservation = await observeDeadlinePort(port).catch(() => ({ portConnection: 'unobserved', probeClosed: false }));
      console.error(JSON.stringify({ proof: 'native-startup-deadline-observation', ...observation, ...portObservation }));
      assert.fail(`Native host startup liveness deadline: ${failureOutput} ${failureErrors}`);
    }
    assertNativeStartupActive(progress, { processClosed: hostExited, requestCount: requests.length });
    await wait(25);
  }
  assertNativeStartupActive(startupProgress.snapshot(), { processClosed: hostExited, requestCount: requests.length });
  assertNativeStartupBanners({ pid: hostPid, output, version, port });
  const headers = { Authorization: `Bearer ${token}` };
  const status = await fetch(`http://127.0.0.1:${port}/status`, { headers, signal: AbortSignal.timeout(5_000) });
  assert.equal(status.status, 200); assert.equal((await status.json()).status, 'running');
  assertNativeStartupActive(startupProgress.snapshot(), { processClosed: hostExited, requestCount: requests.length });
  const startupElapsedMs = startupProgress.snapshot().elapsedMs;
  const invoke = async (method, body = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/control-plane/methods/${method}/invoke`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }), signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text(); assert.ifError(judgmentError);
    assert.equal(response.status, method === 'memory.records.add' ? 201 : 200, `${method}: ${text}`); return JSON.parse(text);
  };
  // Same production controls as Linux: structured extension/index availability
  // and finite distance for the exact added record, with no initialization retry.
  const { added, searched, vector } = await proveNativeMemoryRoundTrip(invoke);
  const diagnostic = await readNativeAddonEvidence(readingPort, { stderr: errors }, AbortSignal.timeout(10_000));
  assert.ifError(judgmentError); assert(requests.some(request => 'native_addon_failure' in request.questions));
  assert(!hostExited, 'Native host exited before owned shutdown'); original.retained.assertCurrent(); relocated.assertCurrent();
  host.kill('SIGTERM');
  let timer;
  try {
    assert.deepEqual(await Promise.race([hostStopped, new Promise((_, no) => { timer = setTimeout(() => no(new Error('Native shutdown deadline')), 15_000); })]), { code: 0, signal: null });
  } finally { clearTimeout(timer); }
  assertNativeProcessGroupDrained(host);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/status`, { headers, signal: AbortSignal.timeout(1_000) }), 'Listener remains after clean shutdown');
  original.retained.assertCurrent(); relocated.assertCurrent();
  console.log(JSON.stringify({ proof: 'compiled-daemon-native-execution', target: source.target, sourceCommit, headCommit,
    runId: source.runId, runAttempt: source.runAttempt, producerRunAttempt: original.artifact.runAttempt,
    semanticQualification: 'synthetic-only', modelAcquisition: 'disabled',
    status: 'running', startupElapsedMs, bootSemanticRequests: 0,
    malformedSettingsExit: malformed.code, nativeVectorAvailable: vector.vector.available, cleanShutdown: true, diagnostic }));
} finally {
  try {
    try { if (host && hostStopped) await drainNativeProcessGroup(host, hostStopped); }
    finally { host?.stdout.destroy(); host?.stderr.destroy(); }
  } finally { await closeServer(judgment); }
  if (!cleanupRefused) rmSync(root, { recursive: true, force: true });
}
