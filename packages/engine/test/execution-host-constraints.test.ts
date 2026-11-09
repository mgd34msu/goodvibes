import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { withExecutionModeOwner } from '../platform/src/platform/gate/execution-context.ts';
import type { GatePresetName } from '../platform/src/platform/gate/presets.ts';
import { createExecTool } from '../platform/src/platform/tools/exec/runtime.ts';
import { resolveRuntimeSandboxPlan, type ExecSandboxRuntime } from '../platform/src/platform/tools/exec/sandbox.ts';
import { ProcessManager } from '../platform/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../platform/src/platform/tools/shared/overflow.ts';
import { createGoodVibesSettingsTool } from '../platform/src/platform/tools/goodvibes-runtime/index.ts';
import { createAgentSettingsInputProjector } from '../platform/src/platform/tools/goodvibes-runtime/settings-admission.ts';
import { resolveCheckedAddresses } from '../platform/src/platform/tools/fetch/pinned-request.ts';

const roots: string[] = [];
const withMode = <T>(mode: GatePresetName, run: () => T): T => withExecutionModeOwner({ getMode: () => mode, getRevision: () => 0 }, run);
const root = () => { const value = mkdtempSync(join(tmpdir(), 'execution-host-constraints-')); roots.push(value); return value; };
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

test.each(['safe-owner', 'safe-jev', 'yolo'] as const)('%s preserves required execution containment and configured sandbox plans', async mode => {
  const directory = root();
  const process = new ProcessManager();
  const launches = spyOn(process, 'spawn').mockImplementation(async cmd => ({ cmd, exit_code: 0, stdout: 'intercepted', stderr: '', success: true, process_id: 'never-launched' }));
  const sandbox: ExecSandboxRuntime = { config: { enabled: true, egressAllowlist: [], workspaceWritable: [] },
    availability: { available: true, backend: 'bubblewrap', bwrapPath: '/usr/bin/bwrap', reason: 'fixture backend', networkIsolationGuaranteed: true }, featureEnabled: true };
  try {
    await withMode(mode, async () => {
      expect(await resolveRuntimeSandboxPlan(sandbox, 'synthetic-command', directory, directory)).toMatchObject({ sandboxed: true, network: 'disabled' });
      const tool = createExecTool(process, { defaultWorkingDirectory: directory, overflowHandler: new OverflowHandler({ baseDir: directory }), credentialEnvScrub: { enabled: false },
        containment: { posture: 'required', reason: 'host composition requires an isolated execution boundary' } });
      for (const background of [false, true]) {
        const result = await tool.execute({ commands: [{ cmd: 'synthetic-do-not-run', background }] });
        expect(result.success).toBe(false);
        expect(result.output).toContain(background ? 'background command cannot run inside' : 'requires commands to run inside');
      }
      expect(launches).not.toHaveBeenCalled();
    });
  } finally { launches.mockRestore(); await process.close(); }
});

test.each(['safe-owner', 'safe-jev', 'yolo'] as const)('%s keeps declared secret-reference storage format for raw and prepared settings', async mode => {
  const config = new ConfigManager({ configDir: root(), surfaceRoot: 'daemon' });
  const key = 'surfaces.telegram.botToken';
  const tool = createGoodVibesSettingsTool({ configManager: config, configRouting: { hostsDaemon: true } });
  const projector = createAgentSettingsInputProjector(config, { hostsDaemon: true });
  await withMode(mode, async () => {
    for (const value of ['synthetic-private-value', 'goodvibes://unrecognized/raw']) {
      const args = { mode: 'set', key, value, confirm: true };
      expect(await tool.execute(args)).toMatchObject({ success: false });
      expect(config.get(key)).not.toBe(value);
      await expect(projector.project({ callId: 'settings-format', name: 'goodvibes_settings', args, assertCurrent() {} })).rejects.toThrow('held');
    }
    const reference = 'goodvibes://secrets/telegram/bot';
    expect(await tool.execute({ mode: 'set', key, value: reference, confirm: true })).toMatchObject({ success: true });
    expect(config.get(key)).toBe(reference);
  });
});

test.each(['safe-owner', 'safe-jev', 'yolo'] as const)('%s enforces explicit blocked hosts and addresses before DNS or socket admission', async mode => {
  let resolutions = 0;
  const resolveHost = async () => { resolutions++; return [{ address: '127.0.0.1', family: 4 }]; };
  await withMode(mode, async () => {
    await expect(resolveCheckedAddresses('http://blocked.example.invalid/', { trustTierConfig: { blockedHosts: ['*.example.invalid'] }, localhostApproved: true, resolveHost })).rejects.toThrow('explicit blocklist');
    expect(resolutions).toBe(0);
    await expect(resolveCheckedAddresses('http://allowed.invalid/', { trustTierConfig: { blockedHosts: ['127.0.0.1'] }, localhostApproved: true, resolveHost })).rejects.toThrow('explicit blocklist');
    expect(resolutions).toBe(1);
  });
});
