import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { useBrowserProvisionReadings } from './_helpers/browser-provision-readings.js';
import { extractTarGzTree } from '../platform/src/platform/browser/browser-driver-archive.js';
import { createBrowserProvisionIo, verifyDriverArchive } from '../platform/src/platform/browser/browser-provision-io.js';
import { ensureBrowserBinary } from '../platform/src/platform/browser/browser-provisioning.js';
import type { BrowserProvisionIo, CommandOutcome } from '../platform/src/platform/browser/browser-types.js';

useBrowserProvisionReadings();

const BROWSERS_PATH = '/cache/ms-playwright';
const EXECUTABLE = `${BROWSERS_PATH}/chromium-1234/chrome-linux64/chrome`;

function outcome(overrides: Partial<CommandOutcome> = {}): CommandOutcome {
  return { code: 0, stdout: '', stderr: '', timedOut: false, spawnError: null, ...overrides };
}

function ioWithProbes(probes: readonly CommandOutcome[], systemBrowsers: readonly string[] = []): { io: BrowserProvisionIo; removed: string[]; commands: string[] } {
  const removed: string[] = [];
  const commands: string[] = [];
  const remaining = [...probes];
  const io: BrowserProvisionIo = {
    resolveDriver: () => ({ available: true, packageDirectory: '/pkg', cliPath: '/pkg/cli.js', version: '1.62.0', error: null }),
    expectedExecutablePath: () => EXECUTABLE,
    browsersPath: () => BROWSERS_PATH,
    pathExists: () => true,
    isExecutableFile: () => true,
    directoryWritable: () => true,
    removePath: (path) => { removed.push(path); },
    runCommand: async (command, args) => {
      commands.push(`${command} ${args.join(' ')}`);
      if (!args.includes('--version')) return outcome({ stdout: 'ok' });
      return remaining.shift() ?? outcome({ stdout: 'Chromium 151.0' });
    },
    systemBrowserCandidates: () => systemBrowsers,
    now: () => 0,
  };
  return { io, removed, commands };
}

describe('a browser that is slow to answer its version probe', () => {
  test('is probed again, and kept when the second probe answers', async () => {
    const { io, removed, commands } = ioWithProbes([outcome({ code: null, timedOut: true }), outcome({ stdout: 'Chromium 151.0' })]);
    const report = await ensureBrowserBinary(io);
    expect(report.ok).toBe(true);
    expect(report.source).toBe('managed-cache');
    expect(removed).toEqual([]);
    expect(commands.filter((command) => command.includes('--version'))).toHaveLength(2);
  });

  test('is not deleted and reinstalled when it times out twice', async () => {
    const { io, removed, commands } = ioWithProbes([outcome({ code: null, timedOut: true }), outcome({ code: null, timedOut: true })]);
    const report = await ensureBrowserBinary(io);
    expect(report.ok).toBe(false);
    expect(report.failure).toBe('binary-not-executable');
    expect(removed).toEqual([]);
    expect(commands.some((command) => command.includes('install'))).toBe(false);
  });
});

describe('a managed browser that times out twice while a system browser works', () => {
  test('the system browser is used and the managed build is kept', async () => {
    const system = '/usr/bin/google-chrome';
    const { io, removed, commands } = ioWithProbes([
      outcome({ code: null, timedOut: true }),
      outcome({ code: null, timedOut: true }),
      outcome({ stdout: 'Google Chrome 151.0' }),
    ], [system]);
    const report = await ensureBrowserBinary(io);
    expect(report.ok).toBe(true);
    expect(report.source).toBe('system-browser');
    expect(report.executablePath).toBe(system);
    expect(removed).toEqual([]);
    expect(commands.some((command) => command.includes('install'))).toBe(false);
  });
});

describe('a browser build that is actually broken', () => {
  test('its revision directory, and only that, is removed before the reinstall', async () => {
    const { io, removed, commands } = ioWithProbes([outcome({ code: 1, stderr: 'segfault' })]);
    const report = await ensureBrowserBinary(io);
    expect(removed).toEqual([`${BROWSERS_PATH}/chromium-1234`]);
    expect(commands.some((command) => command.includes('install'))).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.source).toBe('managed-download');
  });
});

describe('the downloaded driver archive', () => {
  test('bytes that are not the published package are refused', () => {
    expect(() => verifyDriverArchive(Buffer.from('not the playwright-core tarball'))).toThrow(/does not match the published/);
  });

  test('a tar whose last member is cut short fails the extraction instead of leaving a partial tree', () => {
    const header = Buffer.alloc(512);
    header.write('package/index.js', 0, 'utf-8');
    header.write('0000644\0', 100, 'utf-8');
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write((4000).toString(8).padStart(11, '0') + '\0', 124, 'utf-8');
    header.write('00000000000\0', 136);
    header.write('0', 156, 'utf-8');
    header.write('ustar\0', 257, 'utf-8');
    header.write('00', 263, 'utf-8');
    header.write('        ', 148, 8, 'utf-8');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf-8');
    const archive = Buffer.from(gzipSync(Buffer.concat([header, Buffer.alloc(512, 1)])));
    const destination = mkdtempSync(join(tmpdir(), 'gv-truncated-'));
    expect(() => extractTarGzTree(archive, destination, { stripComponents: 1 })).toThrow(/Truncated tar member/);
  });
});

describe('installing the driver from a download that fails its checksum', () => {
  test('nothing is installed and no package manager is started', async () => {
    const root = mkdtempSync(join(tmpdir(), 'browser-driver-tamper-'));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(Buffer.from('tampered tarball'))) as unknown as typeof fetch;
    try {
      const io = createBrowserProvisionIo({ homeDirectory: root, surfaceRoot: 'test' });
      const outcome = await io.installDriver!(root, {});
      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toMatch(/does not match the published/);
      expect(outcome.stderr).not.toMatch(/bun:|npm:/);
      expect(existsSync(join(root, 'node_modules'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
