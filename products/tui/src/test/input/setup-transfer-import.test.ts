import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { createShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerLocalSetupCommands } from '../../input/commands/local-setup.ts';
import { buildSetupTransferBundle, type SetupReviewSnapshot } from '../../input/commands/local-setup-transfer.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const configs: ConfigManager[] = [];
afterEach(() => { for (const config of configs.splice(0)) config.stopWatchingConfigFiles(); });

function fixture() {
  const root = makeProjectTempDir('gv-setup-transfer');
  const config = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, homeDir: root, configDir: join(root, 'config') });
  configs.push(config);
  const lines: string[] = [];
  const registry = new CommandRegistry();
  registerLocalSetupCommands(registry);
  const context = {
    print: (text: string) => lines.push(text),
    platform: { configManager: config },
    workspace: { shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }) },
  } as unknown as CommandContext;
  const write = (name: string, body: unknown) => {
    const path = join(root, name);
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
    return path;
  };
  const run = (...args: string[]) => registry.get('setup')!.handler(['transfer', 'import', ...args], context);
  return { root, config, lines, write, run, context, text: () => lines.join('\n') };
}

const REVIEW = {} as unknown as SetupReviewSnapshot;

describe('/setup transfer import', () => {
  test('a bundle with an unknown schemaVersion changes nothing', async () => {
    const f = fixture();
    const before = f.config.get('display.stream');
    const path = f.write('b.json', { schemaVersion: 'v9', exportedAt: 1, startupReview: {}, config: { 'display.stream': !before } });
    await f.run(path, '--yes');
    expect(f.config.get('display.stream')).toBe(before);
    expect(f.text()).toContain('unsupported schemaVersion');
  });

  test('one invalid setting refuses the whole bundle and names the key; no earlier key is applied', async () => {
    const f = fixture();
    const stream = f.config.get('display.stream');
    const path = f.write('b.json', {
      schemaVersion: 'v1', exportedAt: 1, startupReview: {},
      config: { 'display.stream': !stream, 'display.lineNumbers': 'not-a-real-value' },
    });
    await f.run(path, '--yes');
    expect(f.config.get('display.stream')).toBe(stream);
    expect(f.text()).toContain('display.lineNumbers');
    expect(f.text()).toContain('nothing was imported');
  });

  test('a bundle without a config object is refused instead of throwing', async () => {
    const f = fixture();
    await f.run(f.write('b.json', { schemaVersion: 'v1' }), '--yes');
    expect(f.text()).toContain('no "config" object');
  });

  test('without --yes it previews the changes and applies none', async () => {
    const f = fixture();
    const stream = f.config.get('display.stream');
    const path = f.write('b.json', { schemaVersion: 'v1', exportedAt: 1, startupReview: {}, config: { 'display.stream': !stream } });
    await f.run(path);
    expect(f.config.get('display.stream')).toBe(stream);
    expect(f.text()).toContain('nothing was changed yet');
    expect(f.text()).toContain('display.stream');
    expect(f.text()).toContain('--yes');
  });

  test('with --yes it applies the changed settings and reports the count', async () => {
    const f = fixture();
    const stream = f.config.get('display.stream');
    const path = f.write('b.json', { schemaVersion: 'v1', exportedAt: 1, startupReview: {}, config: { 'display.stream': !stream, 'no.such.key': 1 } });
    await f.run(path, '--yes');
    expect(f.config.get('display.stream')).toBe(!stream);
    expect(f.text()).toContain('1 setting(s) changed');
    expect(f.text()).toContain('no.such.key');
  });

  test('a write that fails midway restores the settings already written', async () => {
    const f = fixture();
    const stream = f.config.get('display.stream');
    const showThinking = f.config.get('display.showThinking');
    const path = f.write('b.json', {
      schemaVersion: 'v1', exportedAt: 1, startupReview: {},
      config: { 'display.stream': !stream, 'display.showThinking': !showThinking },
    });
    const realSet = f.config.setDynamic.bind(f.config);
    let calls = 0;
    f.config.setDynamic = ((key: never, value: never, options?: never) => {
      calls += 1;
      if (calls === 2) throw new Error('disk full');
      return realSet(key, value, options);
    }) as typeof f.config.setDynamic;
    await f.run(path, '--yes');
    expect(f.config.get('display.stream')).toBe(stream);
    expect(f.config.get('display.showThinking')).toBe(showThinking);
    expect(f.text()).toContain('disk full');
    expect(f.text()).toContain('restored');
  });

  test('a file that cannot be written puts the settings and the files already replaced back', async () => {
    const f = fixture();
    const stream = f.config.get('display.stream');
    const shellPaths = createShellPathService({ workingDirectory: f.root, homeDirectory: f.root });
    const servicesPath = shellPaths.resolveProjectPath('tui', 'services.json');
    // A directory where skills.json must be written makes the last file fail after services.json was replaced.
    const skillsPath = shellPaths.resolveProjectPath('tui', 'ecosystem', 'skills.json');
    mkdirSync(join(servicesPath, '..'), { recursive: true });
    writeFileSync(servicesPath, '{"old":true}');
    mkdirSync(skillsPath, { recursive: true });
    const path = f.write('b.json', {
      schemaVersion: 'v1', exportedAt: 1, startupReview: {},
      config: { 'display.stream': !stream },
      services: { a: 1 },
      ecosystem: { skills: { new: true } },
    });
    await f.run(path, '--yes');
    expect(f.config.get('display.stream')).toBe(stream);
    expect(readFileSync(servicesPath, 'utf-8')).toBe('{"old":true}');
    expect(f.text()).toContain('Settings were restored');
    expect(f.text()).not.toContain('Imported setup transfer bundle');
  });

  test('export carries only settings that differ from their defaults', () => {
    const f = fixture();
    f.config.setDynamic('display.showThinking', !f.config.get('display.showThinking'));
    const bundle = buildSetupTransferBundle(f.context, REVIEW);
    expect(Object.keys(bundle.config)).toContain('display.showThinking');
    expect(Object.keys(bundle.config)).not.toContain('display.stream');
  });
});
