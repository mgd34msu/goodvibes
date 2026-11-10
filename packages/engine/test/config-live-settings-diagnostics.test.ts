import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Real fd 2 distinguishes renderer-contained reload notices from fatal boot output. */
function runSettingsHost(body: string) {
  const root = mkdtempSync(join(tmpdir(), 'gv-live-settings-diagnostics-'));
  const source = (path: string): string => JSON.stringify(new URL(path, import.meta.url).pathname);
  const script = join(root, 'host.ts');
  try {
    writeFileSync(script, `
      import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { ConfigManager } from ${source('../platform/src/platform/config/manager.ts')};
      import { describeIngestionNotice } from ${source('../platform/src/platform/config/settings-ingestion.ts')};
      import { installFullScreenTerminalOutputGuard } from ${source('../terminal-shell/src/terminal-output-guard.ts')};
      import { TerminalSystemMessageRouter } from ${source('../terminal-shell/src/system-message-router.ts')};
      import { reportFatalBootFailure } from ${source('../platform/src/platform/daemon/fatal-boot-report.ts')};
      const root = ${JSON.stringify(root)};
      const configDir = join(root, 'client');
      const daemonPath = join(root, 'daemon', 'settings.json');
      mkdirSync(configDir, { recursive: true });
      mkdirSync(join(root, 'daemon'), { recursive: true });
      writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ provider: { model: 'openai:original' }, permissions: { tools: { exec: 'deny' } } }));
      writeFileSync(daemonPath, JSON.stringify({ permissions: { tools: { exec: 'deny' } } }));
      const managerOptions = { homeDir: root, configDir, surfaceRoot: 'goodvibes', daemonTierPath: daemonPath };
      const visible = [];
      const router = new TerminalSystemMessageRouter({
        addSystemMessage: message => { visible.push(message); },
        addTypedSystemMessage: message => { visible.push(message); },
      }, null);
      ${body}
    `);
    const result = spawnSync(process.execPath, ['run', script], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('settings diagnostics under the real fullscreen stream guard', () => {
  test('refused reload reaches the UI once without fd output, replacing accepted values, or rewriting damaged bytes', () => {
    const run = runSettingsHost(`
      const manager = new ConfigManager(managerOptions);
      const originalMode = manager.get('permissions.tools.exec');
      const other = new ConfigManager(managerOptions);
      let otherNotices = 0;
      const stopOther = other.subscribeIngestionNotices(() => { otherNotices++; });
      const stopNotices = manager.subscribeIngestionNotices(notice => router.high(describeIngestionNotice(notice)));
      const guard = installFullScreenTerminalOutputGuard({ stdout: process.stdout, stderr: process.stderr });
      const stopWatch = manager.watchConfigFiles();
      const invalid = JSON.stringify({ permissions: { tools: { exec: 'synthetic-invalid-mode' } } });
      let result;
      try {
        writeFileSync(daemonPath, invalid);
        manager.flushConfigFileChanges();
        manager.flushConfigFileChanges();
        result = { visible, otherNotices, mode: manager.get('permissions.tools.exec'), originalMode,
          model: manager.get('provider.model'), bytes: readFileSync(daemonPath, 'utf8'), invalid,
          noticeCount: manager.getIngestionQuarantine().length };
      } finally { stopWatch(); stopNotices(); stopOther(); guard.dispose(); }
      process.stdout.write(JSON.stringify(result));
    `);
    expect(run.error, run.stderr).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toBe('');
    const result = JSON.parse(run.stdout);
    expect(result.visible).toHaveLength(1);
    expect(result.visible[0]).toContain('Settings: refused permissions.tools.exec');
    expect(result.visible[0]).toContain('expects one of allow, prompt, deny');
    expect(result.visible[0]).not.toContain('refused to start');
    expect(result.otherNotices).toBe(0);
    expect(result.originalMode).toBe('deny');
    expect(result.mode).toBe(result.originalMode);
    expect(result.model).toBe('openai:original');
    expect(result.bytes).toBe(result.invalid);
    expect(result.noticeCount).toBe(1);
  });

  test('unsubscribed host stays detached while later malformed JSON still preserves accepted settings', () => {
    const run = runSettingsHost(`
      const manager = new ConfigManager(managerOptions);
      const stopNotices = manager.subscribeIngestionNotices(notice => router.high(describeIngestionNotice(notice)));
      stopNotices();
      const guard = installFullScreenTerminalOutputGuard({ stdout: process.stdout, stderr: process.stderr });
      const stopWatch = manager.watchConfigFiles();
      let result;
      try {
        writeFileSync(daemonPath, '{"permissions":');
        manager.flushConfigFileChanges();
        result = { visible, mode: manager.get('permissions.tools.exec'),
          bytes: readFileSync(daemonPath, 'utf8'), notices: manager.getIngestionQuarantine() };
      } finally { stopWatch(); guard.dispose(); }
      process.stdout.write(JSON.stringify(result));
    `);
    expect(run.error, run.stderr).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toBe('');
    const result = JSON.parse(run.stdout);
    expect(result.visible).toEqual([]);
    expect(result.mode).toBe('deny');
    expect(result.bytes).toBe('{"permissions":');
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0].action).toBe('refused');
  });

  test('actual boot failure still reaches fd 2 under the fullscreen guard', () => {
    const run = runSettingsHost(`
      const guard = installFullScreenTerminalOutputGuard({ stdout: process.stdout, stderr: process.stderr });
      try {
        writeFileSync(daemonPath, JSON.stringify({ permissions: { tools: { exec: 'synthetic-invalid-mode' } } }));
        try { new ConfigManager(managerOptions); }
        catch (error) { reportFatalBootFailure(error); process.exitCode = 1; }
      } finally { guard.dispose(); }
    `);
    expect(run.error, run.stderr).toBeUndefined();
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toContain('goodvibes daemon host failed:');
    expect(run.stdout).toBe('');
  });
});
