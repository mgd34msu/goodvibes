import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { createShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { getSettingsControlPlaneSnapshot } from '@goodvibes-jev/engine/platform/platform/runtime/settings';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerManagedRuntimeCommands } from '../../input/commands/managed-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const configs: ConfigManager[] = [];
let previous: ReturnType<typeof installJudgmentPort>;
afterEach(() => { installJudgmentPort(previous); for (const config of configs.splice(0)) config.stopWatchingConfigFiles(); });
function fixture() {
  const root = makeProjectTempDir('gv-managed-async');
  const config = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, homeDir: root, configDir: join(root, 'config') }); configs.push(config);
  const before = config.get('display.lineNumbers'); const after: 'off' | 'all' = before === 'all' ? 'off' : 'all';
  const path = join(root, 'managed.json'); writeFileSync(path, JSON.stringify({ version: 1, exportedAt: 1, profileName: 'synthetic', settings: { 'display.lineNumbers': after } }));
  const lines: string[] = [];
  const registry = new CommandRegistry(); registerManagedRuntimeCommands(registry);
  const context = { print: (text: string) => lines.push(text), platform: { configManager: config }, workspace: { shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }), profileManager: {} }, session: { runtime: {} } } as unknown as CommandContext;
  return { config, before, after, lines, path, registry, context, run: (action: string, extra?: string, otherPath?: string) => registry.get('managed')!.handler([action, otherPath ?? path, ...(extra ? [extra] : [])], context) };
}
function delayedRisk() {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void; const started = new Promise<void>(resolve => { requested = resolve; });
  const base = fakePort((name, question) => { if (name !== 'risk') throw new Error('unexpected reading'); return choiceAnswer(question, 'low', 0.99); }).port;
  previous = installJudgmentPort({ ...base, ask: async request => { requested(); await gate; return base.ask(request); } });
  return { release, started };
}
describe('managed settings await public readers', () => {
  test('apply waits for the actual staging judgment before any configuration change or success receipt', async () => {
    const f = fixture(); const delayed = delayedRisk();
    const running = f.run('apply'); await delayed.started;
    expect(f.config.get('display.lineNumbers')).toBe(f.before);
    expect(f.lines).toEqual([]);
    expect(getSettingsControlPlaneSnapshot(f.config).stagedManagedBundle).toBeUndefined();
    delayed.release(); await running;
    expect(f.config.get('display.lineNumbers')).toBe(f.after);
    expect(f.lines.join('\n')).toContain('1 changes');
    expect(f.lines.join('\n')).not.toContain('undefined');
  });
  test('a rejected staging judgment neither applies settings nor prints success', async () => {
    const f = fixture(); const base = fakePort(() => { throw new Error('synthetic unavailable'); }).port;
    previous = installJudgmentPort(base);
    await f.run('apply');
    expect(f.config.get('display.lineNumbers')).toBe(f.before);
    expect(f.lines.join('\n')).toContain('synthetic unavailable');
    expect(f.lines.join('\n')).not.toContain('applied');
    expect(getSettingsControlPlaneSnapshot(f.config).stagedManagedBundle).toBeUndefined();
  });
  test('a bundle that is not known to be low risk is staged for review, and applies only with --yes', async () => {
    const f = fixture();
    const base = fakePort((name, question) => { if (name !== 'risk') throw new Error('unexpected reading'); return choiceAnswer(question, 'high', 0.99); }).port;
    previous = installJudgmentPort(base);
    await f.run('apply');
    expect(f.config.get('display.lineNumbers')).toBe(f.before);
    expect(f.lines.join('\n')).toContain('nothing was applied');
    expect(getSettingsControlPlaneSnapshot(f.config).stagedManagedBundle?.risk).toBe('high');
    f.lines.length = 0;
    await f.run('apply', '--yes');
    expect(f.config.get('display.lineNumbers')).toBe(f.after);
    expect(f.lines.join('\n')).toContain('risk=high');
  });
  test('a file that is not a bundle is refused in one line and nothing throws', async () => {
    const f = fixture();
    writeFileSync(f.path, '{}');
    for (const action of ['inspect', 'stage', 'apply']) {
      f.lines.length = 0;
      await f.run(action);
      expect(f.lines.join('\n')).toContain(`/managed ${action} failed: Unsupported managed settings bundle`);
    }
    writeFileSync(f.path, 'not json');
    f.lines.length = 0;
    await f.run('inspect');
    expect(f.lines.join('\n')).toContain('is not valid JSON');
    f.lines.length = 0;
    await f.run('inspect', undefined, join(f.path, '..', 'missing.json'));
    expect(f.lines.join('\n')).toContain('Cannot read');
  });
  test('lock rejects a key that does not exist, and an unknown subcommand never reads its argument as a file', async () => {
    const f = fixture();
    await f.registry.get('managed')!.handler(['lock', 'no.such.key', 'ops', 'because'], f.context);
    expect(f.lines.join('\n')).toContain('No lock was recorded');
    f.lines.length = 0;
    await f.registry.get('managed')!.handler(['foo', 'does-not-exist.json'], f.context);
    expect(f.lines.join('\n')).toContain('Usage: /managed');
    expect(f.lines.join('\n')).not.toContain('Cannot read');
  });
});
describe('managed bundle ignored keys', () => {
  test('stage and apply name the unknown keys that were not staged', async () => {
    const f = fixture();
    previous = installJudgmentPort(fakePort((name, question) => { if (name !== 'risk') throw new Error('unexpected reading'); return choiceAnswer(question, 'low', 0.99); }).port);
    writeFileSync(f.path, JSON.stringify({ version: 1, exportedAt: 1, profileName: 'synthetic', settings: { 'display.lineNumbers': f.after, 'no.such.key': 1 } }));
    await f.run('stage');
    expect(f.lines.join('\n')).toContain('Ignored unknown keys (not staged): no.such.key');
    f.lines.length = 0;
    await f.run('apply');
    expect(f.lines.join('\n')).toContain('Ignored unknown keys (not staged): no.such.key');
    expect(f.config.get('display.lineNumbers')).toBe(f.after);
  });
});
