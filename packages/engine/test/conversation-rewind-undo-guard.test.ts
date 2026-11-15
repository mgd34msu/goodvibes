import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { captureTurnAnchor, clearTurnAnchors, recordTurnAnchor } from '@goodvibes-jev/engine/platform/platform/rewind';
import { createConversationRewindPort, type RewindConversation } from '@goodvibes-jev/engine/terminal-shell/conversation-rewind-port';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const SESSION = 'undo-guard-session';

function conversation(count: number) {
  let messages = Array.from({ length: count }, (_, index) => `m${index}`);
  const port: RewindConversation = {
    getMessageCount: () => messages.length,
    toJSON: () => [...messages] as unknown as ReturnType<RewindConversation['toJSON']>,
    fromJSON(value) { messages = [...(value as unknown as string[])]; },
    rebuildHistory: () => {},
    removeMessagesAfter: (keep) => { messages = messages.slice(0, keep); },
  };
  return { port, replaceLast: (text: string) => { messages = [...messages.slice(0, -1), text]; }, add: (text: string) => { messages = [...messages, text]; } };
}

async function rewound() {
  const fixture = conversation(4);
  const port = createConversationRewindPort(() => fixture.port);
  recordTurnAnchor(SESSION, { turnId: 't', label: 'fixture', messageCount: 2, at: 1 });
  const { undoSnapshotId } = await port.rewind({ sessionId: SESSION, turnId: 't' });
  clearTurnAnchors(SESSION);
  return { fixture, port, undoSnapshotId };
}

test('an untouched conversation reports nothing newer since the rewind', async () => {
  const { port, undoSnapshotId } = await rewound();
  expect(port.messagesSinceRewind(undoSnapshotId)).toBe(0);
});

test('added messages are counted', async () => {
  const { fixture, port, undoSnapshotId } = await rewound();
  fixture.add('new');
  expect(port.messagesSinceRewind(undoSnapshotId)).toBe(1);
});

test('an edit that keeps the length is still reported as a change, so undo cannot overwrite it', async () => {
  const { fixture, port, undoSnapshotId } = await rewound();
  fixture.replaceLast('edited');
  const since = port.messagesSinceRewind(undoSnapshotId);
  expect(since).not.toBe(0);
  expect(since).not.toBeNull();
});

test('an unknown snapshot is null', async () => {
  const { port } = await rewound();
  expect(port.messagesSinceRewind('unknown')).toBeNull();
});

/** A conversation whose messages carry content, as toJSON returns them. */
function messageConversation(texts: string[]) {
  let messages = texts.map((content) => ({ role: 'assistant', content }));
  const port: RewindConversation = {
    getMessageCount: () => messages.length,
    toJSON: () => ({ messages: messages.map((m) => ({ ...m })) }) as unknown as ReturnType<RewindConversation['toJSON']>,
    fromJSON(value) { messages = [...(value as unknown as { messages: typeof messages }).messages]; },
    rebuildHistory: () => {},
    removeMessagesAfter: (keep) => { messages = messages.slice(0, keep); },
  };
  return { port, texts: () => messages.map((m) => m.content), set: (next: string[]) => { messages = next.map((content) => ({ role: 'assistant', content })); } };
}

test('after a compaction a turn is found by its last message, and one compacted away is refused, never cut at the old position', async () => {
  const fixture = messageConversation(['a', 'b', 'c', 'd', 'e', 'f']);
  const port = createConversationRewindPort(() => fixture.port);
  const at = (count: number) => captureTurnAnchor(`t${count}`, {
    getMessageCount: () => count,
    getLastUserMessage: () => null,
    getMessageAt: (index) => ({ role: 'assistant', content: fixture.texts()[index] }),
  }, count);
  recordTurnAnchor(SESSION, at(2));
  recordTurnAnchor(SESSION, at(5));
  // Compaction: the first four messages become one summary, positions renumber.
  fixture.set(['summary', 'e', 'f']);
  try {
    const gone = await port.preview({ sessionId: SESSION, turnId: 't2' });
    expect(gone.available).toBe(false);
    expect(gone.unavailableReason).toContain('compacted away');
    const moved = await port.preview({ sessionId: SESSION, turnId: 't5' });
    expect(moved).toEqual({ messagesToDrop: 1, messagesRemaining: 2 });
    const rewind = await port.rewind({ sessionId: SESSION, turnId: 't2' });
    expect(rewind.available).toBe(false);
    expect(fixture.texts()).toEqual(['summary', 'e', 'f']);
  } finally {
    clearTurnAnchors(SESSION);
  }
});

test('an undo snapshot written to disk still undoes the rewind after the process restarted', async () => {
  const undoDir = makeProjectTempDir('gv-rewind-undo');
  try {
    const fixture = messageConversation(['a', 'b', 'c', 'd']);
    recordTurnAnchor(SESSION, { turnId: 't', label: 'fixture', messageCount: 2, at: 1 });
    const { undoSnapshotId } = await createConversationRewindPort(() => fixture.port, { undoDir }).rewind({ sessionId: SESSION, turnId: 't' });
    expect(fixture.texts()).toEqual(['a', 'b']);
    // A new port in a new process holds nothing in memory; the file carries the undo.
    const restarted = createConversationRewindPort(() => fixture.port, { undoDir });
    expect(restarted.messagesSinceRewind(undoSnapshotId)).toBe(0);
    expect(restarted.restoreBefore(undoSnapshotId)).toBe(true);
    expect(fixture.texts()).toEqual(['a', 'b', 'c', 'd']);
  } finally {
    clearTurnAnchors(SESSION);
    rmSync(undoDir, { recursive: true, force: true });
  }
});
