import { afterEach, expect, jest, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getMcpConfigLocations } from '../platform/src/platform/mcp/index.ts';
import { startMcpConfigAutoReload } from '../terminal-shell/src/mcp-runtime-reload.ts';

const dirs: string[] = [];
afterEach(() => { jest.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('a reload that keeps failing is retried less and less often, and an edit retries at once', async () => {
  jest.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), 'mcp-reload-')); dirs.push(root);
  const roots = { workingDirectory: root, homeDirectory: join(root, 'home') } as never;
  const config = getMcpConfigLocations(roots).find(location => location.scope === 'project' && location.writable)!.path;
  mkdirSync(dirname(config), { recursive: true });
  const write = (text: string, seconds: number) => { writeFileSync(config, text); utimesSync(config, seconds, seconds); };
  write('{}', 1000);
  let calls = 0; let errors = 0; let fail = true;
  const handle = startMcpConfigAutoReload({ roots, intervalMs: 500,
    registry: { reload: async () => { calls += 1; if (fail) throw new Error('unreachable'); return {} as never; }, listServerSecurity: () => [] },
    onError: () => { errors += 1; } });
  write('{"servers":[]}', 2000);
  const ticks = async (count: number) => { for (let n = 0; n < count; n += 1) { jest.advanceTimersByTime(500); await Promise.resolve(); await Promise.resolve(); } };
  await ticks(1);
  expect(calls).toBe(1);
  await ticks(10);
  // Failures at ticks 1, 3, 7: far fewer than one per tick.
  expect(calls).toBeLessThanOrEqual(4);
  expect(errors).toBe(calls);
  const before = calls;
  write('{"servers":[{}]}', 3000);
  await ticks(1);
  expect(calls).toBe(before + 1);
  fail = false;
  await ticks(40);
  expect(calls).toBeGreaterThan(before + 1);
  const settled = calls;
  await ticks(10);
  expect(calls).toBe(settled);
  handle.stop();
});

function setup(servers: Array<{ connected: boolean }>, intervalMs: number) {
  jest.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), 'mcp-reload-')); dirs.push(root);
  const roots = { workingDirectory: root, homeDirectory: join(root, 'home') } as never;
  const config = getMcpConfigLocations(roots).find(location => location.scope === 'project' && location.writable)!.path;
  mkdirSync(dirname(config), { recursive: true });
  const write = (text: string, seconds: number) => { writeFileSync(config, text); utimesSync(config, seconds, seconds); };
  write('{}', 1000);
  const summaries: Array<{ connected: number; total: number }> = [];
  let calls = 0;
  const handle = startMcpConfigAutoReload({ roots, intervalMs,
    registry: { reload: async () => { calls += 1; return {} as never; }, listServerSecurity: () => servers as never },
    onReload: summary => { summaries.push(summary); } });
  const advance = async (ms: number) => { jest.advanceTimersByTime(ms); await Promise.resolve(); await Promise.resolve(); };
  return { handle, write, summaries, advance, calls: () => calls };
}

test('a changed config reloads once and reports how many servers connected', async () => {
  const { handle, write, summaries, advance, calls } = setup([{ connected: true }, { connected: false }, { connected: true }], 500);
  await advance(500);
  expect(calls()).toBe(0);
  expect(summaries).toEqual([]);
  write('{"servers":[]}', 2000);
  await advance(500);
  expect(calls()).toBe(1);
  expect(summaries).toEqual([{ connected: 2, total: 3 }]);
  await advance(2000);
  expect(calls()).toBe(1);
  handle.stop();
});

test('a stopped watcher never reloads, even when the config changes afterwards', async () => {
  const { handle, write, advance, calls } = setup([], 500);
  handle.stop();
  write('{"servers":[]}', 2000);
  await advance(5000);
  expect(calls()).toBe(0);
  handle.stop();
});

test('a requested interval under 500ms is raised to 500ms', async () => {
  const { handle, write, advance, calls } = setup([], 100);
  write('{"servers":[]}', 2000);
  await advance(100);
  expect(calls()).toBe(0);
  await advance(400);
  expect(calls()).toBe(1);
  handle.stop();
});
