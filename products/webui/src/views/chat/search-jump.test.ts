/**
 * search-jump.test.ts, pins the search jump-to-message wiring behind
 * ChatView's onSelect handler and its scroll-trigger effect.
 *
 * The bug this covers: src/views/ChatView.tsx used to destructure only
 * `{ sessionId }` off ChatSearch's onSelect payload (src/views/chat/ChatSearch.tsx),
 * silently dropping messageId even for message-content results, clicking a
 * search hit switched session but never jumped to the message. Session-level
 * results legitimately carry messageId '' and must never arm a jump.
 */
import { describe, expect, test } from 'bun:test';
import { resolveScrollTarget, isScrollTargetReady, isScrollTargetStale, findMessageElement } from './search-jump';
import type { LineageNode } from './lineage';
import type { ChatMessage } from './types';

function node(id: string, priorMessages: ChatMessage[] = []): LineageNode {
  return { message: { id, role: 'user', content: id } as ChatMessage, priorMessages };
}

describe('resolveScrollTarget: the pass-through the bug dropped', () => {
  test('a message-content result (non-empty messageId) is forwarded as a scroll target', () => {
    expect(resolveScrollTarget({ sessionId: 'session-1', messageId: 'msg-1' })).toEqual({
      sessionId: 'session-1',
      messageId: 'msg-1',
    });
  });

  test('a session-level result (messageId "") never arms a scroll target', () => {
    expect(resolveScrollTarget({ sessionId: 'session-1', messageId: '' })).toBeNull();
  });
});

describe('isScrollTargetReady: the async-load guard', () => {
  const nodes = [node('msg-1'), node('msg-2')];

  test('no pending target is never ready', () => {
    expect(isScrollTargetReady(null, 'session-1', nodes)).toBe(false);
  });

  test('not ready while the active session has not caught up to the target session yet (session switch still in flight)', () => {
    const target = { sessionId: 'session-2', messageId: 'msg-1' };
    expect(isScrollTargetReady(target, 'session-1', nodes)).toBe(false);
  });

  test('not ready while the target message has not loaded yet, even in the right session (messages fetch still in flight)', () => {
    const target = { sessionId: 'session-1', messageId: 'msg-does-not-exist-yet' };
    expect(isScrollTargetReady(target, 'session-1', nodes)).toBe(false);
  });

  test('ready once the right session is active and the target message is loaded', () => {
    const target = { sessionId: 'session-1', messageId: 'msg-2' };
    expect(isScrollTargetReady(target, 'session-1', nodes)).toBe(true);
  });

  test('never ready for a message that only exists as retained/superseded history, nothing is rendered to scroll to', () => {
    const supersededMessage = { id: 'msg-old', role: 'user', content: 'old' } as ChatMessage;
    const nodesWithHistory = [node('msg-1', [supersededMessage])];
    const target = { sessionId: 'session-1', messageId: 'msg-old' };
    expect(isScrollTargetReady(target, 'session-1', nodesWithHistory)).toBe(false);
  });
});

describe('findMessageElement: the DOM lookup', () => {
  // Mirrors MessageList: the scroll container holds a column wrapper, and the
  // message articles are that wrapper's children, not the container's.
  function buildContainer(ids: string[]): HTMLDivElement {
    const container = document.createElement('div');
    container.className = 'messages';
    const column = document.createElement('div');
    column.className = 'chat-column';
    container.appendChild(column);
    for (const id of ids) {
      const article = document.createElement('article');
      article.setAttribute('data-message-id', id);
      column.appendChild(article);
    }
    return container;
  }

  test('returns undefined when the container is null/undefined', () => {
    expect(findMessageElement(null, 'msg-1')).toBeUndefined();
    expect(findMessageElement(undefined, 'msg-1')).toBeUndefined();
  });

  test('returns undefined when no message matches the id', () => {
    const container = buildContainer(['msg-1', 'msg-2']);
    expect(findMessageElement(container, 'msg-3')).toBeUndefined();
  });

  test('returns the matching article nested under the column wrapper', () => {
    const container = buildContainer(['msg-1', 'msg-2', 'msg-3']);
    const found = findMessageElement(container, 'msg-2');
    expect(found?.getAttribute('data-message-id')).toBe('msg-2');
  });

  test('finds ids that need selector escaping', () => {
    const container = buildContainer(['a"b', 'c:d']);
    expect(findMessageElement(container, 'a"b')?.getAttribute('data-message-id')).toBe('a"b');
    expect(findMessageElement(container, 'c:d')?.getAttribute('data-message-id')).toBe('c:d');
  });
});

describe('isScrollTargetStale: a target that can never be reached is dropped', () => {
  const nodes = [node('msg-1')];
  const target = { sessionId: 'session-1', messageId: 'msg-1' };

  test('no target is never stale', () => {
    expect(isScrollTargetStale(null, 'session-1', true, true, nodes)).toBe(false);
  });

  test('waiting for the session switch is not stale until the target session has been shown', () => {
    expect(isScrollTargetStale(target, 'session-2', false, false, nodes)).toBe(false);
  });

  test('stale once the operator leaves the target session', () => {
    expect(isScrollTargetStale(target, 'session-2', true, true, nodes)).toBe(true);
  });

  test('not stale while the target session is still loading', () => {
    expect(isScrollTargetStale({ ...target, messageId: 'msg-9' }, 'session-1', true, false, nodes)).toBe(false);
  });

  test('stale when the session loaded and the message is only retained history', () => {
    const withHistory = [node('msg-1', [{ id: 'msg-old', role: 'user', content: 'old' } as ChatMessage])];
    expect(isScrollTargetStale({ ...target, messageId: 'msg-old' }, 'session-1', true, true, withHistory)).toBe(true);
  });

  test('not stale once the message is present', () => {
    expect(isScrollTargetStale(target, 'session-1', true, true, nodes)).toBe(false);
  });
});
