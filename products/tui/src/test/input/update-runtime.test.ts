/** Actual TUI updates use complete release fixtures; preflight-only cases keep inert originals.
 * Regression source intentionally UNRUN during the coding-first pass. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { realUpdateFileIo, type UpdateFileIo } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import { join } from 'node:path';
import { suiteReleaseFixture } from '@goodvibes-jev/engine/toolchain/testing/suite-release';
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
  let calls = 0;
  const printed: string[] = [], progress = createUpdateSwapProgress();
  const result = await applyUpdate({ execPath: '/usr/bin/bun', platform: 'darwin', arch: 'x64', currentVersion: '3.1.2',
    configManager: { get: () => undefined }, print: line => printed.push(line), progress,
    fetchImpl: async () => { calls++; throw new Error('Source installs never download'); } });
  expect(result).toBeUndefined(); expect(calls).toBe(0); expect(progress.begun).toBe(false); expect(progress.committed).toBe(false);
  expect(printed.join('\n')).toContain('running from source');
  expect(printed.join('\n')).toContain('Update with:');
});

test('the actual TUI apply and rollback paths include Agent, daemon, native companions and served WebUI', async () => {
  const f = fixture(), result = await applyUpdate(f.options);
  expect(result?.version).toBe('3.1.3'); expect(f.progress.committed).toBe(true);
  expect([...result!.programs].sort()).toEqual(['goodvibes', 'goodvibes-agent', 'goodvibes-daemon']);
  for (const program of f.programs) expect(readFileSync(join(f.root, program.name), 'utf8')).toBe(program.name + ' version 3.1.3');
  expect(readFileSync(join(f.webui, 'index.html'), 'utf8')).toBe('New WebUI');
  expect(f.printed.some(line => line.includes('goodvibes-agent') && line.includes('goodvibes-daemon'))).toBe(true);
  rollbackUpdate(f.options);
  for (const [path, bytes] of f.original) {
    if (bytes === undefined) throw new Error('Original suite fixture member is missing');
    expect(bytes).toEqual(readFileSync(path));
  }
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
  for (const [path, bytes] of f.original) {
    if (bytes === undefined) throw new Error('Original suite fixture member is missing');
    expect(bytes).toEqual(readFileSync(path));
  }
  expect(f.progress.begun).toBe(false); expect(f.progress.committed).toBe(false);
});

/** Real inert originals for guards that must run before any native receipt/body read.
 * No descriptor or checksum is claimed: these cases never enter verification. */
function preflightOriginals() {
  const root = mkdtempSync(join(tmpdir(), 'gv-tui-update-preflight-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, 'goodvibes'), webui = join(root, 'webui', 'served');
  mkdirSync(webui, { recursive: true });
  const original = new Map([[executable, Buffer.from('Inert original TUI')],
    [join(webui, 'index.html'), Buffer.from('Inert original served WebUI')]]);
  for (const [path, bytes] of original) writeFileSync(path, bytes);
  const reads: string[] = [], sentinel = new Error('Preflight must not read native descriptors or payload bodies');
  const io: UpdateFileIo = { ...realUpdateFileIo, readFile(path) { reads.push(path); throw sentinel; } };
  // Positive controls keep the descriptor/body observer from becoming inert.
  expect(() => io.readFile!(executable + '.readers.json')).toThrow(sentinel.message);
  expect(() => io.readFile!(executable)).toThrow(sentinel.message);
  expect(reads).toHaveLength(2); reads.length = 0;
  const assertOriginals = () => { for (const [path, bytes] of original) expect(readFileSync(path)).toEqual(bytes); };
  return { root, executable, webui, io, reads, assertOriginals };
}

test('the original served WebUI selection is checked after latest-release lookup', async () => {
  const f = preflightOriginals(); let selected = f.webui;
  const calls: string[] = [], progress = createUpdateSwapProgress();
  const fetchImpl: UpdateFetchLike = async (url, init) => {
    calls.push(url); if (url !== LATEST) throw new Error('Changed selection must refuse before asset download');
    const response = await latest('v3.1.3')(url, init); selected = join(f.root, 'webui', 'other'); return response;
  };
  await expect(applyUpdate({ execPath: f.executable, platform: 'darwin', arch: 'x64', currentVersion: '3.1.2',
    fetchImpl, print: () => {}, progress, io: f.io, configManager: { get: key => key === 'controlPlane.webui.bundleDir' ? selected : undefined },
  })).rejects.toThrow('Configured WebUI update selection changed');
  expect(calls).toEqual([LATEST]); expect(f.reads).toEqual([]);
  expect(progress.begun).toBe(false); expect(progress.committed).toBe(false); f.assertOriginals();
});

test('an aborted update performs no publication', async () => {
  const f = preflightOriginals(), owner = new AbortController(); owner.abort();
  let calls = 0; const progress = createUpdateSwapProgress();
  await expect(applyUpdate({ execPath: f.executable, platform: 'darwin', arch: 'x64', currentVersion: '3.1.2',
    configManager: { get: key => key === 'controlPlane.webui.bundleDir' ? f.webui : undefined }, print: () => {}, progress,
    io: f.io, signal: owner.signal, fetchImpl: async () => { calls++; throw new Error('An aborted update never downloads'); },
  })).rejects.toThrow(UPDATE_ABORTED_MESSAGE);
  expect(calls).toBe(0); expect(f.reads).toEqual([]);
  expect(progress.begun).toBe(false); expect(progress.committed).toBe(false); f.assertOriginals();
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
