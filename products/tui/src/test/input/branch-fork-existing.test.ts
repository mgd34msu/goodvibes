import { describe, expect, test } from 'bun:test';
import { ConversationManager } from '../../core/conversation.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerBranchRuntimeCommands } from '../../input/commands/branch-runtime.ts';

describe('/merge', () => {
  test('a diverged branch is refused with the reason, not reported as missing', async () => {
    const conversationManager = new ConversationManager();
    conversationManager.addUserMessage('base');
    const mainName = conversationManager.getCurrentBranch();
    conversationManager.forkBranch('side');
    conversationManager.addUserMessage('main grows');
    conversationManager.switchBranch('side');
    conversationManager.addUserMessage('side grows');
    const registry = new CommandRegistry();
    registerBranchRuntimeCommands(registry);
    const printed: string[] = [];
    const ctx = { print: (text: string) => { printed.push(text); }, renderRequest: () => {}, session: { conversationManager } } as unknown as CommandContext;

    expect(conversationManager.checkBranchMerge(mainName)).toBe('diverged');
    await registry.get('merge')!.handler([mainName], ctx);
    expect(printed.at(-1)).toContain('both changed after the fork, so it was not merged');
    expect(printed.at(-1)).not.toContain('not found');

    await registry.get('merge')!.handler(['nope'], ctx);
    expect(printed.at(-1)).toContain('not found');
  });
});

describe('/fork', () => {
  test('a name that already exists is refused and the saved branch is not replaced', async () => {
    const conversationManager = new ConversationManager();
    conversationManager.addUserMessage('first');
    const registry = new CommandRegistry();
    registerBranchRuntimeCommands(registry);
    const printed: string[] = [];
    const ctx = { print: (text: string) => { printed.push(text); }, session: { conversationManager } } as unknown as CommandContext;

    await registry.get('fork')!.handler(['keep'], ctx);
    expect(printed.at(-1)).toContain('Forked conversation as "keep" (1 message)');

    conversationManager.addUserMessage('second');
    await registry.get('fork')!.handler(['keep'], ctx);
    expect(printed.at(-1)).toBe('Branch "keep" already exists; it was not replaced. Pick another name or switch to it with /branch keep.');
    expect(conversationManager.listBranches().find((branch) => branch.name === 'keep')?.messageCount).toBe(1);
  });
});
