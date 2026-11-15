/** The daemon's companion chat applies the per-session limit from the runtime config key, read on every check. */
import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '../platform/src/platform/daemon/boot.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';

let home: string, work: string, daemon: BootedDaemon, config: ConfigManager;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'companion-limit-home-')); seedBenchmarkCache(home, 'goodvibes');
  work = mkdtempSync(join(tmpdir(), 'companion-limit-work-'));
  config = new ConfigManager({ workingDir: work, homeDir: home, surfaceRoot: 'goodvibes', ownsDaemonTier: true });
  daemon = await bootDaemon({ homeDirectory: home, workingDir: work, daemonHomeDir: join(home, 'daemon'), port: 0, host: '127.0.0.1', token: 'companion-limit-token', configManager: config });
});
afterAll(async () => { await daemon?.stop(); rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

test('a per-session limit set in config after boot is what the companion chat enforces', () => {
  const chat = (daemon.server as unknown as { companionChatManager: { rateLimiter: { check(session: string, client: string): void } } }).companionChatManager;
  config.set('runtime.companionChatLimiter.perSessionLimit', 1);
  chat.rateLimiter.check('limit-session', '');
  expect(() => chat.rateLimiter.check('limit-session', '')).toThrow(/rate limit/);
});
