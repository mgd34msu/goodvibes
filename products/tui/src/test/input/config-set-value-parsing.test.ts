import { describe, expect, test } from 'bun:test';
import { parseConfigValueText } from '@goodvibes-jev/engine/terminal-shell';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerConfigCommand } from '../../input/commands/config.ts';

async function setText(raw: string): Promise<unknown> {
  const written: unknown[] = [];
  const ctx = {
    print: () => {},
    platform: {
      configManager: {
        get: () => undefined,
        setDynamic: (_key: string, value: unknown) => { written.push(value); },
      },
    },
  } as unknown as CommandContext;
  const registry = new CommandRegistry();
  registerConfigCommand(registry);
  await registry.execute('config', ['set', 'display.example', ...raw.split(' ')], ctx);
  return written[0];
}

describe('/config set stores what --config key=value and the daemon store', () => {
  for (const raw of ['0x10', 'null', '[1]', '{"a":1}', 'true', '5', 'plain text']) {
    test(`"${raw}"`, async () => {
      expect(await setText(raw)).toEqual(parseConfigValueText(raw));
    });
  }

  test('null and structured values are stored as such, not as their text', async () => {
    expect(await setText('null')).toBeNull();
    expect(await setText('[1]')).toEqual([1]);
    expect(await setText('0x10')).toBe('0x10');
  });
});
