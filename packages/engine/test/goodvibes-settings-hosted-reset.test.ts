/**
 * In a hosted turn, resetting a client-owned setting resets it in the
 * originating surface's store, never in the host's own store.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { createGoodVibesSettingsTool } from '../platform/src/platform/tools/goodvibes-runtime/index.js';
import { useConfigReadings } from './_helpers/config-readings.ts';

useConfigReadings({});
const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

test('reset of a client-owned key in a hosted turn leaves the host store alone', async () => {
  const h = mkdtempSync(join(tmpdir(), 'gv-hosted-reset-')); roots.push(h);
  const agentStore = join(h, '.goodvibes', 'agent', 'settings.json');
  mkdirSync(join(h, '.goodvibes', 'agent'), { recursive: true });
  writeFileSync(agentStore, JSON.stringify({ voice: { wake: { enabled: true } } }));
  const host = new ConfigManager({ homeDir: h, surfaceRoot: 'tui' });
  host.set('voice.wake.enabled', true);
  const tool = createGoodVibesSettingsTool({
    configManager: host,
    configRouting: { hostsDaemon: true, daemonHomeDir: h, readRuntimeRecord: () => null,
      clientOwnedStore: { surface: 'agent', settingsPath: agentStore } },
  });
  const result = await tool.execute({ mode: 'reset', key: 'voice.wake.enabled', confirm: true });
  expect(result.success).toBe(true);
  expect(host.get('voice.wake.enabled')).toBe(true);
  const agent = JSON.parse(readFileSync(agentStore, 'utf8')) as { voice: { wake: { enabled: boolean } } };
  expect(agent.voice.wake.enabled).toBe(false);
  expect(JSON.parse(result.output ?? '{}').persistedTo).toBe(agentStore);
});
