// Proves: A daemon-hosted conversational turn runs a command directly on the host when the sandbox is required but unavailable, switched off or not wired.
// Red when: The containment decision allows a command when the boundary is required and the plan is unavailable, switched off or absent, or the exec tool (in the foreground or the background) runs without consulting it.
/**
 * hosted-exec-containment.test.ts, a hosted conversational turn does not get
 * the host.
 *
 * Two layers, proved separately so a regression says which one moved:
 *
 *  1. The containment decision (exec/containment.ts), pure. Whether a
 *     composition that REQUIRES the boundary may run a command given the plan
 *     the sandbox layer resolved, and whether an omitted posture changes
 *     anything (it must not).
 *  2. The exec tool end to end, a real `createExecTool` under each posture,
 *     because the decision functions being right is not the same claim as the
 *     tool consulting them on every path (foreground, retried, background).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decideExecContainment,
  type ExecContainmentRequirement,
} from '../platform/src/platform/tools/exec/containment.ts';
import type { ExecSandboxPlan } from '../platform/src/platform/tools/exec/sandbox.ts';
import { createExecTool } from '../platform/src/platform/tools/exec/index.ts';
import { ProcessManager } from '../platform/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../platform/src/platform/tools/shared/overflow.ts';
import { EXEC_GATE_TABLE } from './_helpers/gate-readings.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

// The tools batteries exec reads (credential names, prompts, retries) and,
// forwarded with EXEC_GATE_TABLE, the gate's questions, in one fake port.
useToolReadings([], EXEC_GATE_TABLE);

// ── Fixtures ────────────────────────────────────────────────────────────────

const REQUIRED: ExecContainmentRequirement = {
  posture: 'required',
  reason: 'this is a daemon-hosted conversational turn',
};

const contained: ExecSandboxPlan = {
  sandboxed: true,
  argvPrefix: ['/usr/bin/bwrap', '--ro-bind', '/', '/', '--'],
  boundary: 'bubblewrap: workspace writable, system read-only',
  network: 'disabled',
  escalationsGranted: [],
  homeMasked: true,
};
const unavailable: ExecSandboxPlan = {
  sandboxed: false,
  argvPrefix: [],
  boundary: 'no sandbox: bubblewrap (bwrap) was not found on PATH',
  network: 'enabled',
  escalationsGranted: [],
  homeMasked: false,
  unavailableReason: 'per-command exec sandbox unavailable: bubblewrap (bwrap) was not found on PATH',
};
const switchedOff: ExecSandboxPlan = {
  sandboxed: false,
  argvPrefix: [],
  boundary: 'no sandbox: per-command exec sandbox is not enabled',
  network: 'enabled',
  escalationsGranted: [],
  homeMasked: false,
};

// ── 1. The containment decision ─────────────────────────────────────────────

describe('decideExecContainment', () => {
  test('a composition that requires the boundary runs a command only inside a real one', () => {
    expect(decideExecContainment(REQUIRED, contained).allowed).toBe(true);
    // The host cannot provide one, the sandbox is switched off, or none is wired: each refuses.
    for (const plan of [unavailable, switchedOff, null]) expect(decideExecContainment(REQUIRED, plan).allowed).toBe(false);
  });
});

// ── 2. The exec tool, end to end ────────────────────────────────────────────

describe('exec tool under a hosted conversational posture', () => {
  const roots: string[] = [];
  afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  /** A tool with no sandbox wired at all, and the file a command that ran would create. */
  const makeTool = (containment?: ExecContainmentRequirement) => {
    const root = mkdtempSync(join(tmpdir(), 'gv-hosted-exec-'));
    roots.push(root);
    const tool = createExecTool(new ProcessManager(), {
      overflowHandler: new OverflowHandler({ baseDir: root }),
      defaultWorkingDirectory: root,
      ...(containment ? { containment } : {}),
    });
    return { tool, marker: join(root, 'ran') };
  };

  test('required + no boundary: the command does not run', async () => {
    const { tool, marker } = makeTool(REQUIRED);
    const result = await tool.execute({ commands: [{ cmd: `touch ${marker}` }] });
    expect(result.success).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  test('required + no boundary: `background: true` does not get the command onto the host either', async () => {
    const { tool, marker } = makeTool(REQUIRED);
    const result = await tool.execute({ commands: [{ cmd: `touch ${marker}`, background: true }] });
    expect(result.success).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
});
