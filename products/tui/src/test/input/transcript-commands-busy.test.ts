/**
 * /undo, /redo, /branch <name> and /merge replace or rewrite the transcript a
 * running turn is still appending to. While a turn runs they refuse, name the
 * state, and say what to do instead.
 */
import { describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { registerSessionContentCommands } from '../../input/commands/session-content.ts';
import { registerBranchRuntimeCommands } from '../../input/commands/branch-runtime.ts';

function setup(generating: boolean) {
  const conversation = new ConversationManager(() => 80);
  conversation.fromJSON({ messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' }] as never[], title: 'Working title', titleSource: 'auto' as never });
  conversation.rebuildHistory();
  conversation.forkBranch('saved');
  const printed: string[] = [];
  const ctx = {
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    isGenerating: () => generating,
    session: { conversationManager: conversation },
  } as unknown as CommandContext;
  const registry = new CommandRegistry();
  registerSessionContentCommands(registry);
  registerBranchRuntimeCommands(registry);
  return { conversation, printed, ctx, registry };
}

describe('transcript-changing commands while a turn runs', () => {
  for (const [name, args] of [['undo', []], ['redo', []], ['branch', ['saved']], ['merge', ['saved']]] as const) {
    test(`/${name} refuses and leaves the transcript untouched`, async () => {
      const f = setup(true);
      const before = JSON.stringify(f.conversation.getMessageSnapshot());
      await f.registry.execute(name, [...args], f.ctx);
      expect(f.printed.join('\n')).toContain('A turn is still running. Stop it with Esc or let it finish');
      expect(JSON.stringify(f.conversation.getMessageSnapshot())).toBe(before);
    });
  }

  test('/undo still works once the turn has ended', async () => {
    const f = setup(false);
    await f.registry.execute('undo', [], f.ctx);
    expect(f.printed.join('\n')).toContain('Last turn undone');
  });
});
