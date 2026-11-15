/**
 * A foreground exec that is timed out or cancelled stops the whole command,
 * not only its /bin/sh, and the model still sees what the command printed and
 * what the earlier commands of a batch did.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecTool } from '../platform/src/platform/tools/exec/runtime.js';
import { ProcessManager } from '../platform/src/platform/tools/shared/process-manager.js';
import { OverflowHandler } from '../platform/src/platform/tools/shared/overflow.js';
import { EXEC_GATE_TABLE } from './_helpers/gate-readings.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';
import { waitFor } from './_helpers/test-timeout.js';

useToolReadings([], EXEC_GATE_TABLE);

const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function childPid(pidFile: string): Promise<number> {
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf-8').trim().length > 0);
  return Number(readFileSync(pidFile, 'utf-8').trim());
}

describe('exec foreground stop reaches the whole command', () => {
  test('a timeout terminates a child the shell started, and keeps what was printed', async () => {
    const root = tempRoot('gv-exec-group-timeout-');
    const pidFile = join(root, 'child.pid');
    const tool = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });
    const result = await tool.execute({
      working_dir: root,
      commands: [{ cmd: `echo started; sleep 30 & echo $! > ${pidFile}; wait`, timeout_ms: 400 }],
    });
    const pid = await childPid(pidFile);
    await waitFor(() => !alive(pid)).catch(() => undefined);
    const survived = alive(pid);
    if (survived) process.kill(pid, 'SIGKILL');
    expect(survived).toBe(false);
    const output = JSON.parse(result.output ?? '{}') as { timed_out?: boolean; stdout?: string };
    expect(output.timed_out).toBe(true);
    expect(output.stdout).toContain('started');
  }, 10_000);

  test('a cancel terminates a child the shell started', async () => {
    const root = tempRoot('gv-exec-group-cancel-');
    const pidFile = join(root, 'child.pid');
    const tool = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });
    const controller = new AbortController();
    const pending = tool.execute({
      working_dir: root,
      commands: [{ cmd: `sleep 30 & echo $! > ${pidFile}; wait`, timeout_ms: 20_000 }],
    }, { signal: controller.signal });
    const pid = await childPid(pidFile);
    controller.abort();
    const result = await pending;
    await waitFor(() => !alive(pid)).catch(() => undefined);
    const survived = alive(pid);
    if (survived) process.kill(pid, 'SIGKILL');
    expect(survived).toBe(false);
    expect((JSON.parse(result.output ?? '{}') as { cancelled?: boolean }).cancelled).toBe(true);
  }, 10_000);

  test('a cancel mid-batch keeps the finished commands and marks the rest skipped', async () => {
    const root = tempRoot('gv-exec-batch-cancel-');
    const startedFile = join(root, 'second.pid');
    const tool = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });
    const controller = new AbortController();
    const pending = tool.execute({
      working_dir: root,
      // The second command writes its pid once it is running, which proves the
      // first has finished, so no fixed delay stands in for either.
      commands: [{ cmd: 'echo first' }, { cmd: `echo $$ > ${startedFile}; sleep 30`, timeout_ms: 20_000 }, { cmd: 'echo third' }],
    }, { signal: controller.signal });
    await childPid(startedFile);
    controller.abort();
    const result = await pending;
    expect(result.success).toBe(false);
    const output = JSON.parse(result.output ?? '{}') as {
      cancelled?: boolean;
      commands?: Array<{ cmd: string; stdout?: string; cancelled?: boolean; skipped?: boolean; exit_code?: number | null }>;
    };
    expect(output.cancelled).toBe(true);
    expect(output.commands?.[0]?.stdout).toContain('first');
    expect(output.commands?.[0]?.exit_code).toBe(0);
    expect(output.commands?.[1]?.cancelled).toBe(true);
    expect(output.commands?.[2]?.skipped).toBe(true);
  }, 10_000);
});
