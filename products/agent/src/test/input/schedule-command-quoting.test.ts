/**
 * A `/schedule` command typed in the composer is refused when its quoting is incomplete instead of
 * having the quote closed silently, which would give the schedule different words than were typed.
 */
import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { handleCommandModeToken } from '../../input/handler-command-route.ts';

function submit(prompt: string) {
  // The command declares that quoting is part of its grammar; the route reads that, not the name.
  const commandRegistry = new CommandRegistry();
  commandRegistry.register({ name: 'schedule', aliases: ['sched'], description: 'Schedules', strictArgs: true, handler: () => {} });
  const executed: Array<{ name: string; args: string[] }> = [];
  const printed: string[] = [];
  const context = {
    print: (text: string) => { printed.push(text); },
    executeCommand: async (name: string, args: string[]) => {
      executed.push({ name, args });
      return true;
    },
  } as unknown as CommandContext;
  const state = {
    commandMode: true,
    prompt,
    cursorPos: prompt.length,
    autocomplete: null,
    modalStack: ['command'],
    commandRegistry,
    commandContext: context,
    conversationManager: { log: () => {}, dismissSplash: () => {} } as never,
    requestRender: () => {},
    handleEscape: () => {},
    projectRoot: '/tmp/test',
    pasteRegistry: new Map(),
    imageRegistry: new Map(),
    nextPasteId: 1,
    nextImageId: 1,
    saveUndoState: () => {},
    ensureInputCursorVisible: () => {},
  };
  handleCommandModeToken(state, { type: 'key' as const, name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false });
  return { executed, printed };
}

describe('/schedule typed in the composer', () => {
  test('an unterminated quote is refused and nothing runs', async () => {
    const { executed, printed } = submit('/schedule remind --at 2026-06-01T09:00:00Z --message "call mom');
    await Promise.resolve();
    expect(printed.join('\n')).toContain('Not run');
    expect(executed).toEqual([]);
  });

  test('an empty quoted word is refused rather than dropped so the next word shifts into its place', async () => {
    const { executed, printed } = submit('/schedule remind --message "" --at 2026-06-01T09:00:00Z');
    await Promise.resolve();
    expect(printed.join('\n')).toContain('Not run');
    expect(executed).toEqual([]);
  });

  test('a well-quoted command runs with its words intact', async () => {
    const { executed } = submit('/schedule remind --message "call mom" --at 2026-06-01T09:00:00Z');
    await Promise.resolve();
    expect(executed).toEqual([{ name: 'schedule', args: ['remind', '--message', 'call mom', '--at', '2026-06-01T09:00:00Z'] }]);
  });

  test('other commands keep the shared parsing', async () => {
    const { executed } = submit('/help schedule');
    await Promise.resolve();
    expect(executed).toEqual([{ name: 'help', args: ['schedule'] }]);
  });
});
