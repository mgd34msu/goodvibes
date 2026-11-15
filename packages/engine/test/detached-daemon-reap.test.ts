import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detachedDaemonRuntimePath,
  reapDetachedDaemonRuntime,
  recordDetachedDaemonRuntime,
  type DetachedDaemonRuntimeRecord,
} from '../platform/src/platform/runtime/detached-daemon-runtime.ts';
import { logger } from '../platform/src/platform/utils/logger.ts';

const dirs: string[] = [];
const dir = (): string => { const d = mkdtempSync(join(tmpdir(), 'detached-reap-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const record = (overrides: Partial<DetachedDaemonRuntimeRecord> = {}): DetachedDaemonRuntimeRecord => ({
  pid: 111, host: '127.0.0.1', port: 3421, command: 'goodvibes-daemon', startedAt: '2026-01-01T00:00:00.000Z', ...overrides,
});

test('reaping removes the record that was judged stale and leaves a receipt', () => {
  const runtimeDir = dir();
  const stale = record();
  recordDetachedDaemonRuntime(runtimeDir, stale);
  const receipt = reapDetachedDaemonRuntime(runtimeDir, stale, 'nothing answered');
  expect(receipt?.reason).toBe('nothing answered');
  expect(existsSync(detachedDaemonRuntimePath(runtimeDir))).toBe(false);
});

test('a daemon that wrote its own record at the same address while the probe ran keeps it', () => {
  const runtimeDir = dir();
  const stale = record();
  const replacement = record({ pid: 222, startedAt: '2026-01-01T00:05:00.000Z' });
  recordDetachedDaemonRuntime(runtimeDir, replacement);
  expect(reapDetachedDaemonRuntime(runtimeDir, stale, 'nothing answered')).toBeNull();
  expect(existsSync(detachedDaemonRuntimePath(runtimeDir))).toBe(true);
});

test('the same pid restarted later is told apart by its start time', () => {
  const runtimeDir = dir();
  recordDetachedDaemonRuntime(runtimeDir, record({ startedAt: '2026-01-01T00:05:00.000Z' }));
  expect(reapDetachedDaemonRuntime(runtimeDir, record(), 'nothing answered')).toBeNull();
  expect(existsSync(detachedDaemonRuntimePath(runtimeDir))).toBe(true);
});

test('a record that could not be written is reported in the log, not silently dropped', () => {
  const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
  try {
    const parent = dir();
    const blocker = join(parent, 'file');
    writeFileSync(blocker, 'not a directory');
    expect(recordDetachedDaemonRuntime(join(blocker, 'runtime'), record())).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('could not write the runtime record');
  } finally { warn.mockRestore(); }
});
