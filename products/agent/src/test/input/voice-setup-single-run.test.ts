import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerExperienceRuntimeCommands } from '../../input/commands/experience-runtime.ts';

function installResult() {
  return {
    provisioned: true,
    platform: 'linux',
    tts: { engine: 'piper', state: 'provisioned', binaryPath: '/managed/piper', modelPath: '/managed/voice.onnx' },
    stt: { engine: 'whisper.cpp', state: 'unsupported-platform', reason: 'no bundle' },
    components: [{ id: 'piper-engine', state: 'installed', bytes: 1 }],
    configured: { set: [], skipped: [] },
  };
}

describe('/voice setup --yes while an install is running', () => {
  test('a second request does not start another install, and a later one after it finishes does', async () => {
    const registry = new CommandRegistry();
    registerExperienceRuntimeCommands(registry);
    const command = registry.get('voice')!;
    const out: string[] = [];
    let installs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const voiceSetup = {
      status: () => ({}),
      install: async () => {
        installs += 1;
        if (installs === 1) await gate;
        return installResult();
      },
    };
    const context = {
      print: (text: string) => { out.push(text); },
      platform: { configManager: { get: () => null }, voiceSetup },
      workspace: { shellPaths: { resolveWorkspacePath: (p: string) => p } },
      session: { runtime: { sessionId: 'test' } },
      clients: {},
    } as unknown as CommandContext;

    await command.handler(['setup', '--yes'], context);
    await command.handler(['setup', '--yes'], context);
    expect(installs).toBe(1);
    expect(out.join('\n')).toContain('already running');

    release();
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(out.join('\n')).toContain('Managed Local-Voice Setup');

    await command.handler(['setup', '--yes'], context);
    expect(installs).toBe(2);
  });

  test('wake setup is single-flight the same way', async () => {
    const registry = new CommandRegistry();
    registerExperienceRuntimeCommands(registry);
    const command = registry.get('voice')!;
    const out: string[] = [];
    let provisions = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const voiceSetup = {
      wakeStatus: () => ({ vadReady: false }),
      wakeProvision: async () => { provisions += 1; await gate; throw new Error('download failed'); },
    };
    const context = {
      print: (text: string) => { out.push(text); },
      platform: { configManager: { get: () => undefined }, voiceSetup },
      workspace: { shellPaths: { resolveWorkspacePath: (p: string) => p } },
      session: { runtime: { sessionId: 'test' } },
      clients: {},
    } as unknown as CommandContext;

    await command.handler(['wake', 'setup', '--yes'], context);
    await command.handler(['wake', 'setup', '--yes'], context);
    expect(provisions).toBe(1);
    expect(out.join('\n')).toContain('already running');
    release();
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(out.join('\n')).toContain('provisioning failed: download failed');
    await command.handler(['wake', 'setup', '--yes'], context);
    expect(provisions).toBe(2);
  });
});
