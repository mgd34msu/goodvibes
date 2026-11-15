/**
 * A command typed in the composer gets a clipboard paste bound to that composer, so `/paste`
 * and `run_keybinding paste` edit the prompt the owner is looking at.
 */
import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { handleCommandModeToken } from '../../input/handler-command-route.ts';

describe('clipboard paste from a composer command', () => {
  test('inserts the clipboard text into the prompt and moves the cursor past it', async () => {
    const registry = new CommandRegistry();
    let pastedKind: string | undefined;
    registry.register({
      name: 'paste',
      description: 'paste',
      handler: (_args, ctx) => {
        pastedKind = ctx.pasteFromClipboard?.().kind;
      },
    });
    const context = { print: () => {}, workspace: {} } as unknown as CommandContext;
    const state = {
      commandMode: true,
      prompt: '/paste',
      cursorPos: 6,
      autocomplete: null,
      modalStack: ['command'],
      commandRegistry: registry,
      commandContext: context,
      conversationManager: { log: () => {}, dismissSplash: () => {} } as never,
      requestRender: () => {},
      handleEscape: () => {},
      projectRoot: '/tmp/test',
      pasteRegistry: new Map<string, string>(),
      imageRegistry: new Map<string, { data: string; mediaType: string }>(),
      nextPasteId: 1,
      nextImageId: 1,
      saveUndoState: () => {},
      ensureInputCursorVisible: () => {},
      clipboard: { pasteImageFromClipboard: () => null, pasteFromClipboard: () => 'hello from the clipboard' },
    };
    handleCommandModeToken(state, { type: 'key' as const, name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(pastedKind).toBe('text');
    expect(state.prompt).toContain('hello from the clipboard');
  });
});
