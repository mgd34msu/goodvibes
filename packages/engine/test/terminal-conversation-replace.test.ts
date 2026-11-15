import { describe, expect, test } from 'bun:test';
import { TerminalConversationManager } from '../terminal-shell/src/terminal-conversation.js';

function conversation(): TerminalConversationManager {
  // Rendering is not exercised, so the presentation's renderer is never called.
  return new TerminalConversationManager(() => 80, undefined, { renderer: {} as never, paragraphSpacing: false, streamThrottleMs: 0, stickySplash: false });
}
function fill(conv: TerminalConversationManager, turns: number): void {
  for (let i = 0; i < turns; i++) {
    conv.addUserMessage(`question ${i}`);
    conv.addAssistantMessage(`answer ${i}`);
  }
}

describe('replacing the messages drops state keyed by message index', () => {
  test('compaction clears fold decisions that would land on a different turn', () => {
    const conv = conversation();
    fill(conv, 6);
    conv.setCollapsed('turn_10', true);
    conv.setCollapsed('bead_c:10:0', false);
    conv.setCollapsed('msg_3', true);
    expect(conv.workTree.foldState().map(([key]) => key).sort()).toEqual(['bead_c:10:0', 'turn_10']);
    conv.replaceMessagesForLLM([{ role: 'user', content: 'summary' }, { role: 'assistant', content: 'ok' }]);
    expect(conv.workTree.foldState()).toEqual([]);
    // Keys the work tree does not own are not touched.
    expect((conv as unknown as { collapseState: Map<string, boolean> }).collapseState.get('msg_3')).toBe(true);
  });

  test('compaction tells the session to save the now-empty fold state', () => {
    const conv = conversation();
    fill(conv, 2);
    let saves = 0;
    conv.workTree.onFoldChange(() => { saves++; });
    conv.replaceMessagesForLLM([{ role: 'user', content: 'summary' }]);
    expect(saves).toBe(1);
  });

  test('restoring a conversation clears folds from the one it replaces', () => {
    const conv = conversation();
    fill(conv, 3);
    conv.setCollapsed('turn_4', true);
    conv.fromJSON({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] });
    expect(conv.workTree.foldState()).toEqual([]);
  });

  test('a cleared display does not hide a shorter replacement', () => {
    const conv = conversation();
    fill(conv, 20);
    conv.clearDisplay();
    conv.replaceMessagesForLLM([{ role: 'user', content: 'summary' }]);
    expect((conv as unknown as { _displayFromMessageIndex: number })._displayFromMessageIndex).toBe(0);
  });
});

describe('switching branches drops state keyed by message index', () => {
  test('folds and message kinds from the branch left do not land on the other branch', () => {
    const conv = conversation();
    fill(conv, 3);
    conv.forkBranch('other');
    fill(conv, 2);
    conv.addTypedSystemMessage('contract note', 'contract');
    conv.setCollapsed('turn_4', true);
    conv.setCollapsed('bead_c:4:0', true);
    expect(conv.workTree.foldState().length).toBe(2);
    expect((conv as unknown as { messageKindRegistry: Map<number, string> }).messageKindRegistry.size).toBe(1);
    expect(conv.switchBranch('other')).toBe(true);
    expect(conv.workTree.foldState()).toEqual([]);
    expect((conv as unknown as { messageKindRegistry: Map<number, string> }).messageKindRegistry.size).toBe(0);
  });

  test('compaction clears message kinds recorded for the old indices', () => {
    const conv = conversation();
    fill(conv, 2);
    conv.addTypedSystemMessage('contract note', 'contract');
    conv.replaceMessagesForLLM([{ role: 'user', content: 'summary' }]);
    expect((conv as unknown as { messageKindRegistry: Map<number, string> }).messageKindRegistry.size).toBe(0);
  });
});

describe('fold keys', () => {
  test('the live fold state holds only keys the saved sidecar can also hold', () => {
    const conv = conversation();
    conv.setCollapsed('turn_2', true);
    conv.setCollapsed('lane_a b', true);
    conv.setCollapsed('turn_', true);
    expect(conv.workTree.foldState()).toEqual([['turn_2', true]]);
  });
});

describe('restoring a long saved conversation', () => {
  test('copies the history once however many messages it holds', () => {
    const conv = conversation();
    conv.setNoticeSink(() => undefined);
    const messages = Array.from({ length: 200 }, (_, i) => ({ role: 'system' as const, content: `notice ${i}` }));
    let snapshots = 0;
    const original = conv.getMessageSnapshot.bind(conv);
    conv.getMessageSnapshot = () => { snapshots++; return original(); };
    conv.fromJSON({ messages });
    expect(snapshots).toBe(1);
  });

  test('copies nothing when no notice sink is installed', () => {
    const conv = conversation();
    let snapshots = 0;
    const original = conv.getMessageSnapshot.bind(conv);
    conv.getMessageSnapshot = () => { snapshots++; return original(); };
    conv.fromJSON({ messages: Array.from({ length: 50 }, (_, i) => ({ role: 'system' as const, content: `notice ${i}` })) });
    expect(snapshots).toBe(0);
  });

  test('checking that a notice is still current does not copy the history', () => {
    const conv = conversation();
    const checks: Array<() => void> = [];
    conv.setNoticeSink((_content, context) => { checks.push(context.assertCurrent); });
    fill(conv, 5);
    conv.addSystemMessage('note');
    let snapshots = 0;
    const original = conv.getMessageSnapshot.bind(conv);
    conv.getMessageSnapshot = () => { snapshots++; return original(); };
    expect(checks.length).toBe(1);
    checks[0]!();
    checks[0]!();
    expect(snapshots).toBe(0);
  });

  test('adding a system message does not copy the history to learn its index', () => {
    const conv = conversation();
    fill(conv, 5);
    let snapshots = 0;
    const original = conv.getMessageSnapshot.bind(conv);
    conv.getMessageSnapshot = () => { snapshots++; return original(); };
    conv.addSystemMessage('note');
    expect(snapshots).toBe(0);
  });
});
