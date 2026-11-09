/** Actual TUI update commands over a complete synthetic suite release.
 * Regression source intentionally UNRUN during the coding-first pass. */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { suiteReleaseFixture } from '../../../../../packages/engine/test/_helpers/suite-release-fixture.ts';
import { applyUpdate, checkForUpdate, createUpdateSwapProgress, detectDaemonServiceManaged, rollbackUpdate, UPDATE_ABORTED_MESSAGE,
  type ApplyUpdateOptions, type RunCommand } from '../../input/commands/update-runtime.ts';
import type { UpdateFetchLike } from '../../runtime/update-check.ts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const LATEST = 'https://github.com/mgd34msu/goodvibes/releases/latest';
function latest(tag: string, assets?: UpdateFetchLike): UpdateFetchLike {
  return async (url, init) => url === LATEST ? { ok: false, status: 302, url,
    headers: { get: name => name.toLowerCase() === 'location' ? `https://github.com/mgd34msu/goodvibes/releases/tag/${tag}` : null },
    text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) } : assets ? assets(url, init) : new Response('No fixture asset', { status: 404 });
}
function fixture() {
  const f = suiteReleaseFixture(); cleanups.push(f.cleanup);
  const printed: string[] = [], progress = createUpdateSwapProgress();
  const options: ApplyUpdateOptions = { execPath: join(f.root, 'goodvibes'), platform: 'darwin', arch: 'x64', currentVersion: '3.1.2',
    fetchImpl: latest('v3.1.3', f.fetchImpl), print: line => printed.push(line),
    configManager: { get: key => key === 'controlPlane.webui.bundleDir' ? f.webui : undefined }, progress };
  return { ...f, options, printed, progress };
}

test('source installs remain read-only and print their actual update guidance', async () => {
  const f = fixture(); let calls = 0;
  await applyUpdate({ ...f.options, execPath: '/usr/bin/bun', fetchImpl: async () => { calls++; throw new Error('Source installs never download'); } });
  expect(calls).toBe(0); expect(f.progress.begun).toBe(false);
});

test('the actual TUI apply and rollback paths include Agent, daemon, native companions and served WebUI', async () => {
  const f = fixture(), result = await applyUpdate(f.options);
  expect(result?.version).toBe('3.1.3'); expect(f.progress.committed).toBe(true);
  expect([...result!.programs].sort()).toEqual(['goodvibes', 'goodvibes-agent', 'goodvibes-daemon']);
  for (const program of f.programs) expect(readFileSync(join(f.root, program.name), 'utf8')).toBe(program.name + ' version 3.1.3');
  expect(readFileSync(join(f.webui, 'index.html'), 'utf8')).toBe('New WebUI');
  expect(f.printed.some(line => line.includes('goodvibes-agent') && line.includes('goodvibes-daemon'))).toBe(true);
  rollbackUpdate(f.options);
  for (const [path, bytes] of f.original) expect(readFileSync(path)).toEqual(bytes);
  expect(readFileSync(join(f.webui, 'original.txt'), 'utf8')).toBe('Retained original directory');
});

test('an already-current TUI can repair peers left at the previous suite version', async () => {
  const f = fixture();
  const terminal = join(f.root, 'goodvibes');
  writeFileSync(terminal, f.release.get('goodvibes-macos-x64')!);
  writeFileSync(terminal + '.readers.json', f.release.get('goodvibes-macos-x64.reader-ci-artifact.json')!);
  const result = await applyUpdate({ ...f.options, currentVersion: '3.1.3' });
  expect(result?.version).toBe('3.1.3');
  expect(readFileSync(join(f.root, 'goodvibes-agent'), 'utf8')).toBe('goodvibes-agent version 3.1.3');
  expect(f.printed.some(line => line.includes('Repairing the installed GoodVibes suite'))).toBe(true);
});

test('a missing required macOS companion refuses every live replacement', async () => {
  const f = fixture(); f.release.delete('sqlite-darwin-x64.dylib.json');
  await expect(applyUpdate(f.options)).rejects.toThrow('missing');
  for (const [path, bytes] of f.original) expect(readFileSync(path)).toEqual(bytes);
  expect(f.progress.begun).toBe(false); expect(f.progress.committed).toBe(false);
});

test('the original served WebUI selection is checked after latest-release lookup', async () => {
  const f = fixture(); let selected = f.webui;
  const fetchImpl: UpdateFetchLike = async (url, init) => { const response = await f.options.fetchImpl(url, init); if (url === LATEST) selected = join(f.root, 'webui', 'other'); return response; };
  await expect(applyUpdate({ ...f.options, fetchImpl, configManager: { get: () => selected } })).rejects.toThrow('selection changed');
  for (const [path, bytes] of f.original) expect(readFileSync(path)).toEqual(bytes);
});

test('an aborted update performs no publication', async () => {
  const f = fixture(), owner = new AbortController(); owner.abort();
  await expect(applyUpdate({ ...f.options, signal: owner.signal })).rejects.toThrow(UPDATE_ABORTED_MESSAGE);
  for (const [path, bytes] of f.original) expect(readFileSync(path)).toEqual(bytes);
});

test('version check reports the actual release tag', async () => {
  expect(await checkForUpdate(latest('v3.1.2'), '3.1.2')).toEqual({ latestTag: 'v3.1.2', isCurrent: true });
  expect(await checkForUpdate(latest('v3.1.3'), '3.1.2')).toEqual({ latestTag: 'v3.1.3', isCurrent: false });
});

describe('detectDaemonServiceManaged', () => {
  const activeRunner: RunCommand = () => ({ status: 0, stdout: 'active\n' });
  const inactiveRunner: RunCommand = () => ({ status: 3, stdout: 'inactive\n' });

  test('reports managed with the real restart command when systemctl reports the unit active on Linux', () => {
    const info = detectDaemonServiceManaged('linux', { get: () => undefined }, activeRunner);
    expect(info.managed).toBe(true);
    expect(info.restartCommand).toBe('systemctl --user restart goodvibes.service');
  });

  test('reports not managed when the unit is not active', () => {
    const info = detectDaemonServiceManaged('linux', { get: () => undefined }, inactiveRunner);
    expect(info.managed).toBe(false);
  });

  test('honors a configured non-default service name', () => {
    const info = detectDaemonServiceManaged('linux', { get: (key) => (key === 'service.serviceName' ? 'my-goodvibes' : undefined) }, activeRunner);
    expect(info.restartCommand).toBe('systemctl --user restart my-goodvibes.service');
  });

  test('reports not managed on non-Linux platforms without shelling out at all', () => {
    let called = false;
    const info = detectDaemonServiceManaged('darwin', { get: () => undefined }, () => {
      called = true;
      return { status: 0, stdout: 'active' };
    });
    expect(info.managed).toBe(false);
    expect(called).toBe(false);
  });
});
