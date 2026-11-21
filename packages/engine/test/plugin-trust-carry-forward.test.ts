// Proves: A plugin whose files changed after the owner trusted it keeps its trust tier and runs trusted, or the trust the owner gave under 3.4.0 is lost on upgrade.
// Red when: The trust digest stops covering every file of the plugin, so a replaced module under lib/ keeps the tier, or a 3.4.0 record of an unchanged plugin is not carried forward at start-up.
/**
 * 3.4.0 bound a plugin's trust to its manifest and entry file; 3.4.1 binds it
 * to every file in the plugin's folder. A record 3.4.0 wrote for a plugin that
 * is unchanged is carried forward at the first start; one whose entry changed
 * since it was trusted, and an untrusted record, are not. After that, a change
 * to any file of the carried plugin (a module under lib/) drops it to
 * untrusted. The real PluginManager and loader over a temp plugins folder and
 * a trust file in the form 3.4.0 wrote; no plugin is enabled, so none is run.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PluginManager } from '../platform/src/platform/plugins/manager.ts';
import type { PluginLoaderDeps } from '../platform/src/platform/plugins/loader.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const ENTRY = 'export function init() {}\n';
/**
 * The digests 3.4.0's `pluginContentDigest` gave (manifest plus entry file),
 * written down as 3.4.0 stored them: alpha and gamma as they are on disk,
 * beta's entry as it was before it was changed (`return undefined;` in init).
 */
const DIGEST_340 = {
  alpha: 'y35B3riB8wyItHNqTPC6QgAHLV392U36E2qvkipzeCY',
  betaBeforeChange: '6GYIilz3Pcw4VzoUywNPDm__2WLmZQPUxyIWZgW4PqM',
  gamma: 'bB1Evwe7oi7eCH1P1c8_Md5INMQONJaFYnxpJc_qyLI',
};

test('trust given under 3.4.0 is carried forward only for an unchanged plugin, and any changed file of it then drops it to untrusted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-plugin-trust-'));
  dirs.push(root);
  const home = join(root, 'home');
  const goodvibes = join(home, '.goodvibes');
  const pluginsDir = join(goodvibes, 'plugins');
  const trustFile = join(goodvibes, 'plugin-trust.json');
  const pluginDir = (name: string) => resolve(pluginsDir, name);
  for (const name of ['alpha', 'beta', 'gamma']) {
    mkdirSync(join(pluginDir(name), 'lib'), { recursive: true });
    writeFileSync(join(pluginDir(name), 'manifest.json'), JSON.stringify({ name, version: '1.0.0', description: 'fixture', main: 'index.js' }));
    writeFileSync(join(pluginDir(name), 'index.js'), ENTRY);
    writeFileSync(join(pluginDir(name), 'lib', 'util.js'), 'export const value = 1;\n');
  }
  const stored = {
    alpha: { pluginName: 'alpha', tier: 'trusted', updatedAt: 1_700_000_000_000, grantedBy: 'operator', boundDir: pluginDir('alpha'), contentDigest: DIGEST_340.alpha },
    beta: { pluginName: 'beta', tier: 'trusted', updatedAt: 1_700_000_000_000, grantedBy: 'operator', boundDir: pluginDir('beta'), contentDigest: DIGEST_340.betaBeforeChange },
    gamma: { pluginName: 'gamma', tier: 'untrusted', updatedAt: 1_700_000_000_000, grantedBy: 'operator', boundDir: pluginDir('gamma'), contentDigest: DIGEST_340.gamma },
  };
  writeFileSync(trustFile, JSON.stringify(stored));

  const start = async (): Promise<PluginManager> => {
    const manager = new PluginManager({
      pathOptions: { cwd: join(root, 'project'), homeDir: home },
      stateFilePath: join(goodvibes, 'tui', 'plugins.json'),
      trustFilePath: trustFile,
    });
    // No plugin is enabled, so nothing is loaded and the loader's registries are never reached.
    await manager.init({} as PluginLoaderDeps);
    return manager;
  };
  const tiers = (manager: PluginManager) => Object.fromEntries(manager.list().map((status) => [status.name, status.trustTier]));

  const first = await start();
  const afterUpgrade = JSON.parse(readFileSync(trustFile, 'utf-8')) as typeof stored;
  expect({
    tiers: tiers(first),
    alphaKept: { tier: afterUpgrade.alpha.tier, updatedAt: afterUpgrade.alpha.updatedAt },
    beta: afterUpgrade.beta,
    gamma: afterUpgrade.gamma,
  }).toEqual({
    tiers: { alpha: 'trusted', beta: 'untrusted', gamma: 'untrusted' },
    alphaKept: { tier: 'trusted', updatedAt: stored.alpha.updatedAt },
    beta: stored.beta,
    gamma: stored.gamma,
  });
  await first.close();

  // A module the entry imports is replaced; manifest and entry are as they were.
  writeFileSync(join(pluginDir('alpha'), 'lib', 'util.js'), 'export const value = 2;\n');
  const second = await start();
  expect(tiers(second)).toEqual({ alpha: 'untrusted', beta: 'untrusted', gamma: 'untrusted' });
  await second.close();
});
