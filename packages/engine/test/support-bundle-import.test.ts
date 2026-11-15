import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSupportBundleCommand } from '../terminal-shell/src/support-bundle-command.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const BUNDLE_TYPE = 'goodvibes-agent.support';

function fixture(commandArgs: string[], flags: { yes?: boolean } = {}) {
  const dir = makeProjectTempDir('support-bundle-import');
  const applied: [string, unknown][] = [];
  const configManager = {
    get: () => undefined,
    validateDynamic: (key: string, value: unknown) => {
      if (key === 'display.theme' && value === 'not-a-theme') throw new Error('Invalid value for display.theme: "not-a-theme"');
    },
  };
  const run = createSupportBundleCommand({
    schema: [{ key: 'display.theme' }, { key: 'ui.voiceEnabled' }, { key: 'permissions.mode' }] as never,
    createSecrets: () => ({ inspect: async () => ({}) }),
    withServices: (async () => { throw new Error('not used'); }) as never,
    providerRegistry: (() => { throw new Error('not used'); }) as never,
    classifyProvider: async () => ({}),
    servicePosture: (async () => ({ issues: [] })) as never,
    authPosture: () => ({}),
    packageVersion: () => '0.0.0',
    onboardingMarkerPath: () => '',
    applySetting: (_runtime, key, value) => { applied.push([key, value]); },
  }, {
    site: 'test', providerSite: 'test', packageName: 'test', bundleType: BUNDLE_TYPE, title: 'Bundle', commandBase: () => 'tool bundle',
    defaultFilename: 'b.json', detachConfig: false, time: String, invalidJsonSeparator: ': ', exportLabel: 'Bundle exported', issuesKey: 'issues',
  });
  const write = (bundle: unknown) => writeFileSync(join(dir, 'bundle.json'), JSON.stringify(bundle));
  const exec = () => run({
    workingDirectory: dir, homeDirectory: dir, configManager: configManager as never,
    cli: { commandArgs: ['import', 'bundle.json', ...commandArgs], binary: 'tool', flags },
  });
  return { applied, write, exec };
}
const good = (config: Record<string, unknown>) => ({ version: 2, type: BUNDLE_TYPE, config });

describe('bundle import', () => {
  test('one invalid value applies nothing and the output names the key', async () => {
    const f = fixture(['--yes']);
    f.write(good({ display: { theme: 'not-a-theme' }, ui: { voiceEnabled: true } }));
    const result = await f.exec();
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('display.theme');
    expect(result.output).toContain('Nothing was changed');
    expect(f.applied).toEqual([]);
  });

  test('without --yes it lists what would change and applies nothing', async () => {
    const f = fixture([]);
    f.write(good({ ui: { voiceEnabled: true } }));
    const result = await f.exec();
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('would set ui.voiceEnabled');
    expect(f.applied).toEqual([]);
  });

  test('with --yes every valid value is applied, from the flag or the argument list', async () => {
    const viaArg = fixture(['--yes']);
    viaArg.write(good({ ui: { voiceEnabled: true }, display: { theme: 'dark' } }));
    expect((await viaArg.exec()).exitCode).toBe(0);
    expect(viaArg.applied).toEqual([['display.theme', 'dark'], ['ui.voiceEnabled', true]]);
    const viaFlag = fixture([], { yes: true });
    viaFlag.write(good({ ui: { voiceEnabled: false } }));
    expect((await viaFlag.exec()).output).toContain('1 config value applied');
  });

  test('a bundle from another product or version is refused before anything is read', async () => {
    const foreign = fixture(['--yes']);
    foreign.write({ version: 2, type: 'goodvibes.support', config: { ui: { voiceEnabled: true } } });
    const refused = await foreign.exec();
    expect(refused.exitCode).toBe(1);
    expect(refused.output).toContain('goodvibes.support');
    expect(foreign.applied).toEqual([]);
    const newer = fixture(['--yes']);
    newer.write({ version: 3, type: BUNDLE_TYPE, config: { ui: { voiceEnabled: true } } });
    expect((await newer.exec()).output).toContain('version 3');
    expect(newer.applied).toEqual([]);
  });

  test('redacted values are skipped and counted', async () => {
    const f = fixture(['--yes']);
    f.write(good({ ui: { voiceEnabled: '<redacted>' }, display: { theme: 'dark' } }));
    const result = await f.exec();
    expect(f.applied).toEqual([['display.theme', 'dark']]);
    expect(result.output).toContain('1 redacted value skipped');
  });
});
