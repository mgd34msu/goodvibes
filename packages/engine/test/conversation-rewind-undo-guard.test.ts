import { expect, test } from 'bun:test';
import { clearTurnAnchors, recordTurnAnchor } from '@goodvibes-jev/engine/platform/platform/rewind';
import { createConversationRewindPort, type RewindConversation } from '@goodvibes-jev/engine/terminal-shell/conversation-rewind-port';

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
