/**
 * A notification the router holds back from the screen (quiet while typing) is
 * still something that happened. It must reach the history.
 */
import { describe, expect, test } from 'bun:test';
import { createNotificationDispatcher } from '../../runtime/notification-dispatch.ts';
import { NotificationFeed } from '../../views/notifications-feed.ts';
import { configGetStub } from '../helpers/config-manager-stub.ts';

describe('suppressed notifications', () => {
  test('a warning held back while the owner types is recorded in the history with its reason', () => {
    const feed = new NotificationFeed();
    const dispatcher = createNotificationDispatcher({ get: configGetStub() }, feed);
    dispatcher.router.setQuietWhileTyping(true);

    const decision = dispatcher.dispatch({ id: 'n1', domain: 'agents', level: 'warning', title: 'Agent failed', timestamp: 1000 });

    expect(decision.suppressed).toBe('quiet_while_typing');
    expect(feed.list()).toMatchObject([{ title: 'Agent failed', domain: 'agents', level: 'warning', reasonCode: 'quiet_while_typing' }]);
  });
});
