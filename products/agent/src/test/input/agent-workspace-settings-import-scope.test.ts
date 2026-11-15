import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { AgentConfigManager } from '../../config/host-settings.ts';
import {
  captureAgentWorkspaceTuiSettingsImport,
  captureAgentWorkspaceTuiSettingsImportPreview,
  importAgentWorkspaceTuiSettings,
  previewAgentWorkspaceTuiSettingsImport,
} from '../../input/agent-workspace-settings.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { createShellPathService } from '../../runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function fixture(files: { user?: unknown; project?: unknown }) {
  const root = makeProjectTempDir('agent-settings-import-scope');
  const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: join(root, 'home') });
  const write = (path: string, value: unknown) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  };
  if (files.user !== undefined) write(shellPaths.resolveUserPath('tui', 'settings.json'), files.user);
  if (files.project !== undefined) write(shellPaths.resolveProjectPath('tui', 'settings.json'), files.project);
  const config = new AgentConfigManager({ configDir: join(root, 'config') });
  const context = { platform: { configManager: config }, workspace: { shellPaths } } as unknown as CommandContext;
  return { config, context };
}

const projectFile = { permissions: { mode: 'yolo' }, behavior: { hitlMode: 'off' }, display: { stream: false } };

describe('settings import from a project file', () => {
  test('the preview marks approval and permission keys skipped with a reason and still offers ordinary ones', () => {
    const { context } = fixture({ project: projectFile });
    const preview = previewAgentWorkspaceTuiSettingsImport(context)!;
    const byKey = new Map(preview.settings.map((entry) => [entry.key, entry]));
    expect(byKey.get('permissions.mode')?.status).toBe('skipped');
    expect(byKey.get('permissions.mode')?.reason).toContain('user settings');
    expect(byKey.get('behavior.hitlMode')?.status).toBe('skipped');
    expect(byKey.get('display.stream')?.status).not.toBe('skipped');
    expect(preview.summary.settingsSkipped).toBe(2);
  });

  test('apply leaves the blocked settings untouched and reports them as skipped', async () => {
    const { config, context } = fixture({ project: projectFile });
    const before = { mode: config.get('permissions.mode'), hitl: config.get('behavior.hitlMode') };
    const outcome = await importAgentWorkspaceTuiSettings(context);
    expect(config.get('permissions.mode')).toBe(before.mode);
    expect(config.get('behavior.hitlMode')).toBe(before.hitl);
    expect(config.get('display.stream')).toBe(false);
    expect(outcome.result.detail).toContain('permissions.mode');
  });

  test('the same keys still import from the user settings file', async () => {
    const { config, context } = fixture({ user: { permissions: { mode: 'yolo' } } });
    await importAgentWorkspaceTuiSettings(context);
    expect(config.get('permissions.mode')).toBe('yolo');
  });

  test('a user value is kept when the project file names the same blocked key', () => {
    const { context } = fixture({ user: { permissions: { mode: 'safe-jev' } }, project: { permissions: { mode: 'yolo' } } });
    const entry = previewAgentWorkspaceTuiSettingsImport(context)!.settings.find((candidate) => candidate.key === 'permissions.mode');
    expect(entry?.status).not.toBe('skipped');
    expect(entry?.incoming).toBe('safe-jev');
  });

  test('model admission capture also leaves project-scope blocked keys out', () => {
    const { context } = fixture({ project: projectFile });
    const captured = captureAgentWorkspaceTuiSettingsImport(context);
    const keys = captured.settings.map((entry) => entry.key);
    expect(keys).toContain('display.stream');
    expect(keys).not.toContain('permissions.mode');
    expect(keys).not.toContain('behavior.hitlMode');
  });

  test('a malformed settings file is shown to the model by size only, never as its text', () => {
    const secret = 'xoxb-1234-secret-token';
    const { context } = fixture({ user: `{ "surfaces": { "slack": { "botToken": "${secret}" ` });
    const withSession = { ...context, session: { runtime: { sessionId: 's1' } } } as unknown as CommandContext;
    const capture = captureAgentWorkspaceTuiSettingsImportPreview(withSession);
    expect(capture.sourceViews[0]).toEqual({ status: 'invalid', length: expect.any(Number) });
    expect(JSON.stringify(capture)).not.toContain(secret);
  });
});
