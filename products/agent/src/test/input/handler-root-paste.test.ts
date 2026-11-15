import { expect, test } from 'bun:test';
import { InfiniteBuffer, SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import { InputHandler } from '../../input/handler.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { join } from 'node:path';
import { KeybindingsManager } from '../../input/keybindings.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { runHarnessKeybinding } from '../../tools/agent-harness-keybinding-metadata.ts';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';

async function wiredHandler(context: CommandContext): Promise<InputHandler> {
  const history = new InfiniteBuffer();
  const input = new InputHandler(() => {}, new SelectionManager(), () => 0, () => 20, () => history, () => {}, () => {}, await createDefaultUiRuntimeServices());
  input.setContentWidth(40);
  input.setCommandRegistry(new CommandRegistry(), context);
  return input;
}

function rootContext(): CommandContext {
  const keybindingsManager = new KeybindingsManager({ configPath: join(makeProjectTempDir('gv-root-paste'), 'keybindings.json') });
  return { renderRequest: () => {}, workspace: { keybindingsManager }, print: () => {} } as unknown as CommandContext;
}

test('run_keybinding paste through the root command context edits the composer', async () => {
  const context = rootContext();
  const input = await wiredHandler(context);
  input.clipboardSource = { pasteImageFromClipboard: () => null, pasteFromClipboard: () => 'pasted words' };
  const result = await runHarnessKeybinding(context as never, { actionId: 'paste' });
  expect(result.status).toBe('executed');
  expect(input.prompt).toContain('pasted words');
});

test('an empty clipboard through the root context is reported as not pasted, not unavailable', async () => {
  const context = rootContext();
  const input = await wiredHandler(context);
  input.clipboardSource = { pasteImageFromClipboard: () => null, pasteFromClipboard: () => '' };
  const result = await runHarnessKeybinding(context as never, { actionId: 'paste' });
  expect(result.status).toBe('not_pasted');
  expect(input.prompt).toBe('');
});
