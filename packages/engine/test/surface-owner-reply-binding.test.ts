/**
 * A purchase notice goes out by surface kind, so the chat the owner answers in
 * can have no bound route. The reply that says their answer was set aside must
 * still have somewhere to go.
 */
import { expect, test } from 'bun:test';
import { ownerReplyBinding } from '../platform/src/platform/daemon/surface-actions.ts';
import type { AutomationRouteBinding } from '../platform/src/platform/automation/routes.ts';

const bound = (over: Partial<AutomationRouteBinding>): AutomationRouteBinding => ({
  id: 'route-1', kind: 'channel', surfaceKind: 'telegram', surfaceId: 'telegram', externalId: '42', channelId: '42',
  lastSeenAt: 1, createdAt: 1, updatedAt: 1, metadata: {}, ...over,
});

test('a route already bound for the chat is used as it is', () => {
  const route = bound({});
  expect(ownerReplyBinding([bound({ id: 'other', channelId: '7', externalId: '7' }), route], { surface: 'telegram', channelId: '42', threadId: undefined })).toBe(route);
});

test('a chat with no bound route gets a one-off binding addressed to that chat and thread', () => {
  const made = ownerReplyBinding([], { surface: 'telegram', channelId: '42', threadId: 't9' });
  expect(made).toMatchObject({ surfaceKind: 'telegram', channelId: '42', externalId: '42', threadId: 't9', kind: 'thread' });
});

test('a message with no chat id has nowhere to be answered', () => {
  expect(ownerReplyBinding([], { surface: 'telegram', channelId: undefined, threadId: undefined })).toBeUndefined();
});
