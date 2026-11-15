/**
 * Branch merges, forks and the undo stack keep each branch's history its own.
 */
import { describe, expect, test } from 'bun:test';
import { ConversationManager } from '../platform/src/platform/core/conversation.ts';
import { appendVerificationRuntimeMessage } from '../platform/src/platform/core/verification/archive.ts';

function texts(conversation: ConversationManager): string[] {
  return conversation.getMessageSnapshot().map((message) => String(message.content));
}

function conversationWith(...turns: string[]): ConversationManager {
  const conversation = new ConversationManager();
  for (const turn of turns) {
    conversation.addUserMessage(turn);
    conversation.addAssistantMessage(`re: ${turn}`);
  }
  return conversation;
}

describe('mergeBranch', () => {
  test('appends the branch messages that follow the shared history', () => {
    const conversation = conversationWith('one');
    conversation.forkBranch('side');
    conversation.switchBranch('side');
    conversation.addUserMessage('two');
    conversation.addAssistantMessage('re: two');
    conversation.switchBranch('main');

    expect(conversation.checkBranchMerge('side')).toBe('ok');
    expect(conversation.mergeBranch('side')).toBe(true);
    expect(texts(conversation)).toEqual(['one', 're: one', 'two', 're: two']);
  });

  test('refuses to splice a branch whose history diverged from the current one', () => {
    const conversation = conversationWith('one');
    conversation.forkBranch('side');
    conversation.switchBranch('side');
    conversation.addUserMessage('branch work');
    conversation.addAssistantMessage('re: branch work');
    conversation.switchBranch('main');
    conversation.addUserMessage('main work');
    conversation.addAssistantMessage('re: main work');
    const before = texts(conversation);

    expect(conversation.checkBranchMerge('side')).toBe('diverged');
    expect(conversation.mergeBranch('side')).toBe(false);
    expect(texts(conversation)).toEqual(before);
  });

  test('an unknown branch is reported as not found', () => {
    const conversation = conversationWith('one');
    expect(conversation.checkBranchMerge('nope')).toBe('not-found');
    expect(conversation.mergeBranch('nope')).toBe(false);
  });

  test('a branch with nothing new merges as a no-op', () => {
    const conversation = conversationWith('one');
    conversation.forkBranch('side');
    conversation.addUserMessage('two');
    expect(conversation.mergeBranch('side')).toBe(true);
    expect(texts(conversation)).toEqual(['one', 're: one', 'two']);
  });
});

describe('forkBranch', () => {
  test('keeps an existing branch and lets the caller tell it was not re-forked', () => {
    const conversation = conversationWith('one');
    conversation.forkBranch('saved');
    conversation.addUserMessage('two');

    expect(conversation.hasBranch('saved')).toBe(true);
    expect(conversation.forkBranch('saved')).toBe('saved');
    conversation.switchBranch('saved');
    expect(texts(conversation)).toEqual(['one', 're: one']);
    expect(conversation.hasBranch('missing')).toBe(false);
  });
});

describe('undo and redo', () => {
  test('a turn undone on one branch is not redone onto another', () => {
    const conversation = conversationWith('one', 'two');
    conversation.forkBranch('alt');
    conversation.undo();
    conversation.switchBranch('alt');

    expect(conversation.redo()).toBe(false);
    expect(texts(conversation)).toEqual(['one', 're: one', 'two', 're: two']);
  });

  test('redo still restores the undone turn on the same branch', () => {
    const conversation = conversationWith('one', 'two');
    conversation.undo();
    expect(conversation.redo()).toBe(true);
    expect(texts(conversation)).toEqual(['one', 're: one', 'two', 're: two']);
  });

  test('a turn undone before the history was rewritten by compaction cannot be redone onto it', () => {
    const conversation = conversationWith('one', 'two');
    conversation.undo();
    conversation.replaceMessagesForLLM([{ role: 'user', content: 'compacted handoff' }]);

    expect(conversation.redo()).toBe(false);
    expect(texts(conversation)).toEqual(['compacted handoff']);
  });
});

describe('host-made user-role messages', () => {
  function turnWithToolImage(): ConversationManager {
    const conversation = new ConversationManager();
    conversation.addUserMessage('look at the screenshot');
    conversation.addAssistantMessage('reading it');
    appendVerificationRuntimeMessage(conversation, 'tool result image');
    conversation.addAssistantMessage('it shows a chart');
    return conversation;
  }

  test('the person\'s own request is the last user message and one undo removes the whole turn', () => {
    const conversation = turnWithToolImage();
    expect(conversation.getLastUserMessage()).toBe('look at the screenshot');
    expect(conversation.undo()).toBe(true);
    expect(conversation.getMessageCount()).toBe(0);
    expect(conversation.undo()).toBe(false);
  });

  test('redo restores the whole turn including the host-made message', () => {
    const conversation = turnWithToolImage();
    conversation.undo();
    expect(conversation.redo()).toBe(true);
    expect(texts(conversation)).toEqual(['look at the screenshot', 'reading it', 'tool result image', 'it shows a chart']);
    expect(conversation.getLastUserMessage()).toBe('look at the screenshot');
  });
});
