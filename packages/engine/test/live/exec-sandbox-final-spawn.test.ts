/**
 * Inside real bubblewrap, a command that needs the network runs only on the
 * owner's escalation permit, and the permit is claimed at the final spawn: a
 * permit revoked at that moment means nothing is spawned, in every exec mode
 * (foreground, progress, until-pattern, PTY). A plain boolean approval from a
 * callback cannot stand in for the owned permit.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecTool } from '../../platform/src/platform/tools/exec/runtime.ts';
import { detectSandboxAvailability, probeSandboxHost, type SandboxEscalationPermit } from '../../platform/src/platform/tools/exec/sandbox.ts';
import { detectPtyAvailability, probePtyHost } from '../../platform/src/platform/tools/exec/interactive.ts';
import { ProcessManager } from '../../platform/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../../platform/src/platform/tools/shared/overflow.ts';
import { useToolReadings } from '../_helpers/tool-readings.ts';
import { requireLiveHost } from '../_helpers/exec-containment-proof.ts';

const command = 'printf owned-final-spawn';
useToolReadings([], [[command, { needsNetwork: true }]]);
const availability = detectSandboxAvailability(probeSandboxHost());
const pty = detectPtyAvailability(probePtyHost());
requireLiveHost('sandbox', availability.available);
requireLiveHost('PTY', pty.available);
let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
for (const mode of ['foreground', 'progress', 'until', 'pty'] as const) {
  for (const revoked of [true]) {
    test(`${mode} claims exact admission at final spawn; revoked=${revoked}`, async () => {
      root = mkdtempSync(join(tmpdir(), 'sandbox-final-spawn-'));
      const controller = new AbortController();
      let claims = 0; let closes = 0; let spawns = 0;
      const permit: SandboxEscalationPermit = Object.freeze({ signal: controller.signal,
        assertCurrent() { controller.signal.throwIfAborted(); },
        claim() { claims++; if (revoked) throw new Error('fixture admission revoked at final effect'); },
        close() { closes++; },
      });
      const manager = new ProcessManager();
      const tool = createExecTool(manager, { defaultWorkingDirectory: root,
        overflowHandler: new OverflowHandler({ baseDir: root }), credentialEnvScrub: { enabled: false },
        sandbox: { config: { enabled: true, egressAllowlist: ['printf'], workspaceWritable: [] }, availability, featureEnabled: true,
          async requestEscalation(input) {
            expect(input.command).toBe(command); expect(input.workingDirectory).toBe(root!);
            expect(input.plan?.argvPrefix).not.toContain('--unshare-net');
            expect(Object.isFrozen(input.plan?.argvPrefix)).toBe(true);
            return permit;
          } },
        ...(mode === 'pty' ? { interaction: { availability: pty } } : {}),
      });
      const original = Bun.spawn;
      const spy = spyOn(Bun, 'spawn').mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
        spawns++; expect(claims).toBe(1);
        return original(...args);
      }) as typeof Bun.spawn);
      try {
        const result = await tool.execute({ commands: [{ cmd: command, timeout_ms: 1000, interactive: mode === 'pty',
          progress: mode === 'progress', ...(mode === 'until' ? { until: { pattern: 'owned-final-spawn', kill_after: true } } : {}) }] });
        expect(claims).toBe(1); expect(closes).toBe(1); expect(spawns).toBe(revoked ? 0 : 1);
        if (revoked) expect(result.success).toBe(false);
        else {
          const output = JSON.parse(result.output!);
          expect(output.sandboxed).toBe(true); expect(output.sandbox_network).toBe('enabled');
        }
      } finally { spy.mockRestore(); await manager.close(); }
    });
  }
}
