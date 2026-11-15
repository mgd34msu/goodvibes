import { describe, expect, test } from 'bun:test';
import { evaluateSmokeOutput, runPostBuildSmoke, scanArtifactForEagerNamespaceReads, captureLogger, realExec } from '@goodvibes-jev/engine/toolchain';
import { scriptedExec } from './_helpers.ts';

const config = { bannerPrefix: 'goodvibes-agent ', binaryDefault: 'dist/goodvibes-agent' };

const CLEAN_ARTIFACT = [
  'var exports_bootstrap = {};',
  '__export(exports_bootstrap, {',
  '  saveSession: () => saveSession,',
  '});',
  'var init_thing = __esm(() => {',
  '  var lazy = exports_bootstrap.saveSession;', // indented: runs post-settle, safe
  '});',
].join('\n');

const TAINTED_ARTIFACT = `${CLEAN_ARTIFACT}\nvar saveSession2 = exports_bootstrap.saveSession;\nvar buildUrl2 = exports_transport.buildUrl;`;

describe('post-build-smoke', () => {
  test('passes on a correct banner', () => {
    expect(evaluateSmokeOutput({ status: 0, stdout: 'goodvibes-agent 1.12.0\n', stderr: '' }, config).ok).toBe(true);
  });
  test('fails on a non-zero exit', () => {
    expect(evaluateSmokeOutput({ status: 1, stdout: '', stderr: 'boom' }, config).ok).toBe(false);
  });
  test('any output beyond the banner fails and is shown', () => {
    const r = evaluateSmokeOutput({ status: 0, stdout: 'goodvibes-agent 1.0.0', stderr: 'cannot find sqlite-vec' }, config);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('cannot find sqlite-vec');
    expect(evaluateSmokeOutput({ status: 0, stdout: 'goodvibes-agent 1.0.0\nError: Cannot find module "x"\n', stderr: '' }, config).ok).toBe(false);
  });
  test('fails on a wrong banner prefix', () => {
    expect(evaluateSmokeOutput({ status: 0, stdout: 'v1.0.0', stderr: '' }, config).ok).toBe(false);
  });
  test('runPostBuildSmoke wires exec + banner check', async () => {
    const exec = scriptedExec(() => ({ status: 0, stdout: 'goodvibes-agent 1.12.0\n' }));
    expect((await runPostBuildSmoke({ binary: 'dist/goodvibes-agent', config, exec, logger: captureLogger(), readArtifact: () => CLEAN_ARTIFACT })).ok).toBe(true);
  });
  test('scan flags only column-0 eager namespace reads', () => {
    expect(scanArtifactForEagerNamespaceReads(CLEAN_ARTIFACT)).toEqual([]);
    expect(scanArtifactForEagerNamespaceReads(TAINTED_ARTIFACT)).toEqual([
      'var saveSession2 = exports_bootstrap.saveSession',
      'var buildUrl2 = exports_transport.buildUrl',
    ]);
  });
  test('scan caps its report at the limit', () => {
    const many = Array.from({ length: 12 }, (_, i) => `var alias${i} = exports_shell.member${i};`).join('\n');
    expect(scanArtifactForEagerNamespaceReads(many)).toHaveLength(8);
  });
  test('a booting binary still fails when the artifact carries eager reads', async () => {
    const exec = scriptedExec(() => ({ status: 0, stdout: 'goodvibes-agent 1.12.0\n' }));
    const logger = captureLogger();
    const r = await runPostBuildSmoke({ binary: 'dist/goodvibes-agent', config, exec, logger, readArtifact: () => TAINTED_ARTIFACT });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('eager namespace read');
    expect(r.detail).toContain('exports_bootstrap.saveSession');
  });
  test('an unreadable artifact fails the smoke rather than skipping the scan', async () => {
    const exec = scriptedExec(() => ({ status: 0, stdout: 'goodvibes-agent 1.12.0\n' }));
    const r = await runPostBuildSmoke({ binary: 'dist/goodvibes-agent', config, exec, logger: captureLogger(), readArtifact: () => { throw new Error('EACCES'); } });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('cannot read dist/goodvibes-agent');
  });
});

test('reserved module names in an ordinary version banner are protocol data', () => {
  expect(evaluateSmokeOutput({ status: 0, stdout: 'sqlite-vec-cli 1.2.3\n', stderr: '' }, { bannerPrefix: 'sqlite-vec-cli ' }).ok).toBe(true);
  expect(evaluateSmokeOutput({ status: 0, stdout: 'goodvibes-agent 1.2.3+sqlite-vec\n', stderr: '' }, config).ok).toBe(true);
});

test.each(['goodvibes-agent garbage\n', 'goodvibes-agent 1.2\n', 'goodvibes-agent 1.2.3 failed\n'])('invalid banner remains a deterministic refusal: %s', stdout => {
  expect(evaluateSmokeOutput({ status: 0, stdout, stderr: '' }, config).ok).toBe(false);
});

test('real subprocess success captures stderr and signal/spawn/timeout failures remain failures', () => {
  const output = realExec(process.execPath, ['-e', 'process.stdout.write("banner\\n"); process.stderr.write("diagnostic\\n");']);
  expect(output).toEqual({ status: 0, stdout: 'banner\n', stderr: 'diagnostic\n' });
  expect(realExec(process.execPath, ['-e', 'process.kill(process.pid,"SIGTERM");']).status).toBe(1);
  expect(realExec('/nonexistent-smoke-executable', []).status).toBe(1);
  expect(realExec(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},100);'], { timeoutMs: 150 }).status).toBe(1);
});
