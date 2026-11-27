// Proves: A turn acting on someone else's input runs a command on the host when no real sandbox applies.
// Red when: containmentForTurn leaves a turn of someone else's input under its composition's host-allowed posture, the decision allows a command when the boundary is required and the plan is unavailable, switched off or absent, or the exec tool (in the foreground or the background) runs a command without asking whose input its turn acts on.
/**
 * hosted-exec-containment.test.ts, someone else's input does not get the host.
 *
 * Every door's turn composes the one command rule (exec/containment.ts `TURN_EXEC_CONTAINMENT`, host-allowed: the
 * shared sandbox setting and the owner's mode decide). Whose input a turn acts on is the one exception
 * (security/turn-input-party.ts): a channel message, a guest, a web chat message the owner did not send, input an outside
 * caller put into a hosted session runs commands only inside a real sandbox, whatever the mode.
 *
 * Two layers, proved separately so a regression says which one moved:
 *
 *  1. The decision (exec/containment.ts `containmentForTurn` then `decideExecContainment`), pure.
 *  2. The exec tool end to end, a real `createExecTool` composed with the one rule, run inside a turn of someone else's
 *     input and inside the owner's, because the decision being right is not the same claim as the tool consulting it
 *     on every path (foreground, background).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TURN_EXEC_CONTAINMENT, containmentForTurn, decideExecContainment } from '../platform/src/platform/tools/exec/containment.ts';
import type { ExecSandboxPlan } from '../platform/src/platform/tools/exec/sandbox.ts';
import { withOtherPartyInput, withOwnerInput } from '../platform/src/platform/security/turn-input-party.ts';
import { createExecTool } from '../platform/src/platform/tools/exec/index.ts';
import { ProcessManager } from '../platform/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../platform/src/platform/tools/shared/overflow.ts';
import { EXEC_GATE_TABLE } from './_helpers/gate-readings.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

// The tools batteries exec reads (credential names, prompts, retries) and,
// forwarded with EXEC_GATE_TABLE, the gate's questions, in one fake port.
useToolReadings([], EXEC_GATE_TABLE);

// ── Fixtures ────────────────────────────────────────────────────────────────

const OTHER = { party: 'other', who: 'a message on telegram' } as const;
const OWNER = { party: 'owner' } as const;

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

// ── 1. The decision ─────────────────────────────────────────────────────────

describe('containmentForTurn', () => {
  test('someone else\'s input runs a command only inside a real sandbox; the owner\'s runs under the one rule', () => {
    const plans: Record<string, ExecSandboxPlan | null> = { contained, unavailable, 'switched off': switchedOff, 'none wired': null };
    const allowed = (party: typeof OTHER | typeof OWNER) => Object.fromEntries(Object.entries(plans).map(([row, plan]) =>
      [row, decideExecContainment(containmentForTurn(TURN_EXEC_CONTAINMENT, party), plan).allowed]));
    expect(allowed(OTHER)).toEqual({ contained: true, unavailable: false, 'switched off': false, 'none wired': false });
    // Control: the owner's turn under the same composition is not held to the boundary.
    expect(allowed(OWNER)).toEqual({ contained: true, unavailable: true, 'switched off': true, 'none wired': true });
  });
});

// ── 2. The exec tool, end to end ────────────────────────────────────────────

describe('exec tool composed with the one command rule', () => {
  const roots: string[] = [];
  afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  /** A tool with no sandbox wired at all, and the file a command that ran would create. */
  const makeTool = () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-foreign-exec-'));
    roots.push(root);
    const tool = createExecTool(new ProcessManager(), {
      overflowHandler: new OverflowHandler({ baseDir: root }),
      defaultWorkingDirectory: root,
      containment: TURN_EXEC_CONTAINMENT,
    });
    return { tool, marker: join(root, 'ran') };
  };

  test('someone else\'s input + no boundary: the command does not run, the owner\'s does', async () => {
    const other = makeTool();
    const refused = await withOtherPartyInput('a message on telegram', () => other.tool.execute({ commands: [{ cmd: `touch ${other.marker}` }] }));
    expect(refused.success).toBe(false);
    expect(existsSync(other.marker)).toBe(false);
    // Control: the same composition runs the owner's command.
    const owner = makeTool();
    const ran = await withOwnerInput(() => owner.tool.execute({ commands: [{ cmd: `touch ${owner.marker}` }] }));
    expect(ran.success).toBe(true);
    expect(existsSync(owner.marker)).toBe(true);
  });

  test('someone else\'s input + no boundary: `background: true` does not get the command onto the host either', async () => {
    const { tool, marker } = makeTool();
    const result = await withOtherPartyInput('a message on telegram', () => tool.execute({ commands: [{ cmd: `touch ${marker}`, background: true }] }));
    expect(result.success).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
});
