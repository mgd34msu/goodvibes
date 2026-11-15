import { readRefusal } from '@goodvibes-jev/engine/errors';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonVerbCaller } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerQrcodeRuntimeCommands } from '../../input/commands/qrcode-runtime.ts';
import { mintAgentDevicePairing } from '../../agent/device-pairing.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const HOST_TOKEN = 'connected-host-operator-token';

function fakeHost(answer: unknown): { readonly verbs: DaemonVerbCaller; readonly calls: { readonly method: string; readonly input: unknown }[] } {
  const calls: { method: string; input: unknown }[] = [];
  return {
    calls,
    verbs: {
      probe: () => ({ available: true }),
      invoke: async <T,>(method: string, input?: unknown): Promise<T> => {
        calls.push({ method, input });
        return answer as T;
      },
    },
  };
}

describe('device pairing from the Agent', () => {
  test('mints a named device token on the host and shows its link, never the host credential', async () => {
    const { verbs, calls } = fakeHost({
      token: { id: 'tok-1', name: 'phone', token: 'device-token-1', createdAt: 1 },
      offers: [{ kind: 'push' }],
      fragment: '#pair=device-token-1',
      deepLink: 'https://host.example/#pair=device-token-1',
    });
    const outcome = await mintAgentDevicePairing(verbs, { name: 'phone' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('pairing.handoff.create');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.link).toBe('https://host.example/#pair=device-token-1');
    expect(outcome.tokenName).toBe('phone');
    expect(outcome.text).not.toContain(HOST_TOKEN);
  });

  test('an unreachable host mints nothing and says what to do', async () => {
    const outcome = await mintAgentDevicePairing({
      probe: () => ({ available: false, reason: 'no connected host is configured' }),
      invoke: async () => { throw new Error('not reached'); },
    });
    expect(outcome.ok).toBe(false);
  });
});

describe('qrcode runtime command model invocation', () => {
  test('a model-invoked command mints nothing and prints no credential', async () => {
    const registry = new CommandRegistry();
    registerQrcodeRuntimeCommands(registry);
    const root = makeProjectTempDir('goodvibes-agent-qrcode-model');
    const tokenDir = join(root, '.goodvibes', 'daemon');
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(join(tokenDir, 'operator-tokens.json'), JSON.stringify({ token: HOST_TOKEN }));
    const out: string[] = [];
    const ctx = {
      print: (text: string) => { out.push(text); },
      platform: { configManager: new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, workingDir: root, homeDir: root }) },
      workspace: { shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }) },
      invokedByModel: true,
    } as unknown as CommandContext;

    const refused = await Promise.resolve().then(() => registry.get('qrcode')!.handler([], ctx)).then(() => undefined, (error: unknown) => error);

    expect(readRefusal(refused)?.code).toBe('OWNER_ONLY_COMMAND');
    expect(out.join('\n')).not.toContain(HOST_TOKEN);
  });
});
