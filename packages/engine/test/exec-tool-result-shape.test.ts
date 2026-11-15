/**
 * exec-tool-result-shape.test.ts
 *
 * Regression coverage: createExecTool(...).execute() must
 * populate a top-level `error` summary whenever any command fails, so that
 * consumers keying off `.error` alone (not just `.output`) get a coherent
 * signal. `output` already carried the full per-command diagnostics before
 * this fix, this only adds the top-level summary.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecTool } from '../platform/src/platform/tools/exec/runtime.ts';
import { ProcessManager } from '../platform/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../platform/src/platform/tools/shared/overflow.ts';
import { EXEC_GATE_TABLE } from './_helpers/gate-readings.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

// The tools batteries exec reads (credential names, prompts, retries) and,
// forwarded with EXEC_GATE_TABLE, the gate's questions, in one fake port.
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

function makeTool(root: string) {
  return createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });
}

describe('exec tool: failure result shape', () => {
  test('a single failing command returns success:false, full diagnostics in output, and a populated error summary', async () => {
    const root = tempRoot('gv-exec-fail-single-');
    const tool = makeTool(root);

    const result = await tool.execute({ working_dir: root, commands: [{ cmd: 'exit 1' }] });

    expect(result.success).toBe(false);
    const output = JSON.parse(result.output ?? '{}') as { exit_code?: number };
    expect(output.exit_code).toBe(1);
    expect(typeof result.error).toBe('string');
    expect(result.error).toContain('exit 1');
    expect(result.error).not.toBe('Unknown error');
  });

  test('fail_fast batch: skipped entries and the failing command are both reflected in output, and error names the failure', async () => {
    const root = tempRoot('gv-exec-fail-fast-');
    const tool = makeTool(root);

    const result = await tool.execute({
      working_dir: root,
      fail_fast: true,
      commands: [{ cmd: 'exit 1' }, { cmd: 'echo should-be-skipped' }],
    });

    expect(result.success).toBe(false);
    const output = JSON.parse(result.output ?? '{}') as { commands: Array<{ cmd: string; skipped?: boolean; exit_code?: number | null }> };
    expect(output.commands[0]?.exit_code).toBe(1);
    expect(output.commands[1]?.skipped).toBe(true);
    expect(result.error).toContain('exit 1');
  });

  test('a passing command has no top-level error', async () => {
    const root = tempRoot('gv-exec-pass-');
    const tool = makeTool(root);

    const result = await tool.execute({ working_dir: root, commands: [{ cmd: 'true' }] });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

describe('exec tool: missing terminal', () => {
  test('a piped command that failed for want of a terminal says what to rerun with', async () => {
    const root = tempRoot('gv-exec-tty-');
    const tool = makeTool(root);

    const result = await tool.execute({ working_dir: root, commands: [{ cmd: 'echo "sudo: a terminal is required to read the password" >&2; exit 1' }] });

    expect(result.success).toBe(false);
    const output = JSON.parse(result.output ?? '{}') as { tty_note?: string };
    expect(output.tty_note).toContain('interactive: true');
  });

  test('an ordinary failure carries no terminal note', async () => {
    const root = tempRoot('gv-exec-notty-');
    const tool = makeTool(root);

    const result = await tool.execute({ working_dir: root, commands: [{ cmd: 'echo boom >&2; exit 1' }] });

    expect((JSON.parse(result.output ?? '{}') as { tty_note?: string }).tty_note).toBeUndefined();
  });
});

describe('exec tool: progress reporting', () => {
  test('output arriving from a running command is reported through onProgress, for both the plain and the long-running path', async () => {
    const root = tempRoot('gv-exec-progress-');
    const tool = makeTool(root);
    for (const progress of [false, true]) {
      let reports = 0;
      const result = await tool.execute({ working_dir: root, commands: [{ cmd: 'echo one; echo two >&2', progress }] }, { onProgress: () => { reports++; } } as never);
      expect(result.success).toBe(true);
      expect(reports).toBeGreaterThan(0);
    }
    let silent = 0;
    await tool.execute({ working_dir: root, commands: [{ cmd: 'true' }] }, { onProgress: () => { silent++; } } as never);
    expect(silent).toBe(0);
  });
});
