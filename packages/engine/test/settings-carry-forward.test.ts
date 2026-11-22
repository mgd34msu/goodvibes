// Proves: Carrying an earlier release's settings file forward loses no value the owner set: a daemon key moves to the daemon's settings unless that file already sets it, the daemon's own value stays, and the file as it was is kept beside it before anything is taken out.
// Red when: The carry-forward rewrites the program's settings without first keeping a copy, or moves a daemon key over the value the daemon's settings already hold, so a value the owner set (a retired key, a copy the daemon file overrides, the daemon's own setting) is gone.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';

describe('settings an earlier release left are carried forward', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => { for (const step of cleanup.splice(0)) step(); });

  test('the terminal app\'s file is kept as it was, daemon keys move only where the daemon sets nothing, and the daemon\'s own value stays', () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-carry-forward-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const configDir = join(root, 'tui'), daemonDir = join(root, 'daemon');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(daemonDir, { recursive: true });
    const programFile = join(configDir, 'settings.json'), daemonFile = join(daemonDir, 'settings.json');
    // As the owner's 3.4.2 terminal app file held them: daemon keys, a key this release no longer has, and his own settings.
    const original = `${JSON.stringify({
      provider: { model: 'openai:gpt-6.2-sol' },
      permissions: { mode: 'yolo' },
      service: { autostart: true, restartOnFailure: false },
      behavior: { suggestAlternativeOnProviderFail: true },
    }, null, 2)}\n`;
    writeFileSync(programFile, original);
    writeFileSync(daemonFile, `${JSON.stringify({ service: { restartOnFailure: true } }, null, 2)}\n`);

    const config = new ConfigManager({ configDir, daemonTierPath: daemonFile });

    const kept = readdirSync(configDir).filter((name) => name.startsWith('settings.json.before-'));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(configDir, kept[0]!), 'utf-8')).toBe(original);
    const daemon = JSON.parse(readFileSync(daemonFile, 'utf-8')) as { service?: Record<string, unknown> };
    expect(daemon.service).toEqual({ restartOnFailure: true, autostart: true });
    const program = JSON.parse(readFileSync(programFile, 'utf-8')) as Record<string, unknown>;
    expect(program).toEqual({ provider: { model: 'openai:gpt-6.2-sol' }, permissions: { mode: 'yolo' } });
    // In effect after the move: the owner's moved value, the daemon's own value, and his other settings.
    expect(config.get('service.autostart' as ConfigKey)).toBe(true);
    expect(config.get('service.restartOnFailure' as ConfigKey)).toBe(true);
    expect(config.get('provider.model' as ConfigKey)).toBe('openai:gpt-6.2-sol');
  });
});
