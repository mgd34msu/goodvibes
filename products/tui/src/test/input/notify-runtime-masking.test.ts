import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerNotifyRuntimeCommands } from '../../input/commands/notify-runtime.ts';

const SECRET_URL = 'https://hooks.example.com/services/T000/B000/supersecrettoken';

describe('/notify list', () => {
  test('does not print the secret part of a webhook URL by default', async () => {
    const printed: string[] = [];
    const ctx = {
      print: (text: string) => { printed.push(text); },
      platform: {
        configManager: { getCategory: () => ({ webhookUrls: [SECRET_URL] }), mergeCategory: () => {} },
        webhookNotifier: { setUrls: () => {}, send: async () => {}, test: async () => [] },
      },
    } as unknown as CommandContext;
    const registry = new CommandRegistry();
    registerNotifyRuntimeCommands(registry);
    await registry.execute('notify', ['list'], ctx);
    expect(printed.join('\n')).toContain('hooks.example.com');
    expect(printed.join('\n')).not.toContain('supersecrettoken');
  });
});

describe('/notify test', () => {
  test('does not print the secret part of a webhook URL in the result lines', async () => {
    const printed: string[] = [];
    const ctx = {
      print: (text: string) => { printed.push(text); },
      platform: {
        configManager: { getCategory: () => ({ webhookUrls: [SECRET_URL, `${SECRET_URL}2`] }), mergeCategory: () => {} },
        webhookNotifier: {
          setUrls: () => {},
          send: async () => {},
          test: async () => [
            { url: SECRET_URL, ok: true },
            { url: `${SECRET_URL}2`, ok: false, error: 'HTTP 500' },
          ],
        },
      },
    } as unknown as CommandContext;
    const registry = new CommandRegistry();
    registerNotifyRuntimeCommands(registry);
    await registry.execute('notify', ['test', '--yes'], ctx);
    const out = printed.join('\n');
    expect(out).toContain('[ok] https://hooks.example.com');
    expect(out).toContain('[fail] https://hooks.example.com');
    expect(out).toContain('HTTP 500');
    expect(out).not.toContain('supersecrettoken');
  });
});
