/**
 * A routine runs in one place only. With the daemon off, routines run in
 * exactly one terminal: the one holding the routine lock; another terminal,
 * in this process or another, never starts its manager while the holder lives,
 * and takes over once it lets go or dies. With the daemon on under the same
 * home, the terminal and the daemon share one routine file: the terminal leaves
 * it where it is, unchanged, and sends the daemon nothing.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRoutineRunner, moveTerminalRoutinesToDaemon, terminalRoutineStorePath } from '../../runtime/terminal-routines.ts';
import type { OperatorRpcAvailable } from '../../runtime/client/operator-endpoint.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-routines-'));
  dirs.push(dir);
  return dir;
}

function countingManager() {
  const counts = { starts: 0, stops: 0 };
  return { counts, manager: { start: async () => { counts.starts += 1; }, stop: () => { counts.stops += 1; } } };
}

test('two runners in one terminal process: one manager runs; the other takes over after release', async () => {
  const lockPath = join(tempDir(), 'automation-jobs.json.writer.sqlite');
  const first = countingManager();
  const second = countingManager();
  const a = new LocalRoutineRunner(first.manager, lockPath);
  const b = new LocalRoutineRunner(second.manager, lockPath);
  try {
    expect(await a.ensure()).toBe(true);
    expect(await b.ensure()).toBe(false);
    expect([first.counts.starts, second.counts.starts]).toEqual([1, 0]);
    a.release();
    expect(first.counts.stops).toBe(1);
    expect(await b.ensure()).toBe(true);
    expect(second.counts.starts).toBe(1);
  } finally {
    a.release();
    b.release();
  }
});

test('a terminal in another process holding the lock keeps this one from running routines until it dies', async () => {
  const lockPath = join(tempDir(), 'automation-jobs.json.writer.sqlite');
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'terminal-routines-holder.ts'), lockPath], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
  const mine = countingManager();
  const runner = new LocalRoutineRunner(mine.manager, lockPath);
  try {
    // Wait for the other terminal's own report, one line on its stdout.
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let line = '';
    while (!line.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      line += decoder.decode(value);
    }
    reader.releaseLock();
    expect(line.trim()).toBe('held true starts 1');

    expect(await runner.ensure()).toBe(false);
    expect(mine.counts.starts).toBe(0);

    // However the holder ends, the lock is the kernel's to release.
    child.kill('SIGKILL');
    await child.exited;
    expect(await runner.ensure()).toBe(true);
    expect(mine.counts.starts).toBe(1);
  } finally {
    runner.release();
    child.kill('SIGKILL');
  }
});

test("with the daemon on under the same home, the terminal leaves the shared routine file in place and sends the daemon nothing", async () => {
  const controlPlaneDir = tempDir();
  const configManager = { getControlPlaneConfigDir: () => controlPlaneDir };
  const path = terminalRoutineStorePath(configManager)!;
  // The routine file as the daemon's automation store keeps it: the daemon reads this same file.
  const text = `${JSON.stringify({ version: 1, jobs: [
    { id: 'job-nightly', name: 'nightly', schedule: { kind: 'every', intervalMs: 86_400_000 } },
    { id: 'job-weekly', name: 'weekly', schedule: { kind: 'cron', expression: '0 9 * * 1' } },
  ] })}\n`;
  writeFileSync(path, text);

  // The daemon at the operator boundary: it lists the routines of its store (this file) and records every create it receives.
  const creates: unknown[] = [];
  const invoke = async (method: string, input: unknown): Promise<unknown> => {
    if (method === 'automation.jobs.list') {
      const stored = JSON.parse(readFileSync(path, 'utf8')) as { jobs: { id: string }[] };
      return { jobs: stored.jobs.map((job) => ({ id: job.id })) };
    }
    if (method === 'automation.jobs.create') { creates.push(input); return { id: 'created' }; }
    throw new Error(`unexpected operator method ${method}`);
  };
  // Only the two operator methods the move calls exist on this stand-in, so it is not a full GoodVibesPlatform.
  const rpc = { available: true, platformClient: { operator: { invoke } } } as unknown as OperatorRpcAvailable;

  const move = await moveTerminalRoutinesToDaemon(configManager, rpc);
  expect(move.moved).toBe(0);
  expect(creates).toEqual([]);
  expect(readdirSync(controlPlaneDir)).toEqual(['automation-jobs.json']);
  expect(readFileSync(path, 'utf8')).toBe(text);
});
