import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentConfigManager } from '../../config/host-settings.ts';
import { ensureDaemonConfigMigrated } from '../../config/ensure-daemon-config-migrated.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const dirs: string[] = [];
const savedDaemonHome = process.env['GOODVIBES_DAEMON_HOME'];

afterEach(() => {
  if (savedDaemonHome === undefined) delete process.env['GOODVIBES_DAEMON_HOME'];
  else process.env['GOODVIBES_DAEMON_HOME'] = savedDaemonHome;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = makeProjectTempDir('agent-custom-daemon-home');
  dirs.push(dir);
  return dir;
}

function seedTuiSettings(h: string): void {
  const dir = join(h, '.goodvibes', 'tui');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ surfaces: { telegram: { botUsername: 'legacy_bot' } } }));
}

describe('a custom daemon home', () => {
  test('receives the migrated keys, and the default path is left unwritten', () => {
    const h = home();
    const custom = join(h, 'custom-daemon');
    process.env['GOODVIBES_DAEMON_HOME'] = custom;
    seedTuiSettings(h);

    expect(ensureDaemonConfigMigrated(h)).toContain('Daemon-owned settings');

    const moved = JSON.parse(readFileSync(join(custom, 'settings.json'), 'utf8'));
    expect(moved.surfaces.telegram.botUsername).toBe('legacy_bot');
    expect(existsSync(join(h, '.goodvibes', 'daemon', 'settings.json'))).toBe(false);
  });

  test('is where the Agent config manager reads daemon-owned keys', () => {
    const h = home();
    const custom = join(h, 'custom-daemon');
    process.env['GOODVIBES_DAEMON_HOME'] = custom;
    seedTuiSettings(h);
    ensureDaemonConfigMigrated(h);

    const config = new AgentConfigManager({ homeDir: h, workingDir: h, surfaceRoot: 'tui' });
    expect(config.getDaemonTierPath()).toBe(join(custom, 'settings.json'));
    expect(config.get('surfaces.telegram.botUsername')).toBe('legacy_bot');
  });
});
