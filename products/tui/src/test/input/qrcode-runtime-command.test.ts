import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerQrcodeRuntimeCommands } from '../../input/commands/qrcode-runtime.ts';

function ctx(out: string[], opened: string[]): CommandContext {
  return {
    print: (m: string) => out.push(m),
    openModal: (n: string) => opened.push(n),
    workspace: { shellPaths: { homeDirectory: '/tmp' } },
  } as unknown as CommandContext;
}

describe('/qrcode command', () => {
  test('no args opens the pairing modal', async () => {
    const registry = new CommandRegistry();
    registerQrcodeRuntimeCommands(registry);
    const opened: string[] = [];
    await registry.execute('qrcode', [], ctx([], opened));
    expect(opened).toEqual(['pairing-modal']);
  });

  test('regenerate opens the pairing modal', async () => {
    const registry = new CommandRegistry();
    registerQrcodeRuntimeCommands(registry);
    const opened: string[] = [];
    await registry.execute('qrcode', ['regenerate'], ctx([], opened));
    expect(opened).toEqual(['pairing-modal']);
  });
});
