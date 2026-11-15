import { describe, expect, test } from 'bun:test';
import { NotificationFeed } from '../platform/src/platform/runtime/notifications/feed.ts';

const decision = { target: 'panel_only', reasonCode: 'allowed' } as const;

describe('NotificationFeed folding', () => {
  test('an update that raises the severity of an entry already seen is unread again', () => {
    const feed = new NotificationFeed();
    feed.record({ id: 'n1', title: 'Agent', domain: 'agents', level: 'info', timestamp: 10 }, decision, 'evt-1');
    feed.markAllSeen();
    expect(feed.unreadCount()).toBe(0);

    feed.recordNotice({ domain: 'agents', title: 'Agent', level: 'critical', body: 'it failed', timestamp: 20, eventKey: 'evt-1' });

    expect(feed.unreadCount()).toBe(1);
    expect(feed.list()).toHaveLength(1);
  });

  test('a repeat that changes nothing leaves a seen entry seen', () => {
    const feed = new NotificationFeed();
    feed.record({ id: 'n1', title: 'Agent', domain: 'agents', level: 'info', timestamp: 10 }, decision, 'evt-1');
    feed.markAllSeen();

    feed.record({ id: 'n2', title: 'Agent', domain: 'agents', level: 'info', timestamp: 30 }, decision, 'evt-1');

    expect(feed.unreadCount()).toBe(0);
  });

  test('a notice folds into the entry its event already made', () => {
    const feed = new NotificationFeed();
    feed.record({ id: 'n1', title: 'Agent', domain: 'agents', level: 'warning', timestamp: 10 }, decision, 'evt-1');

    feed.recordNotice({ domain: 'agents', title: 'Agent', level: 'info', body: 'detail', timestamp: 11, eventKey: 'evt-1' });

    expect(feed.list()).toHaveLength(1);
    expect(feed.list()[0]!.body).toBe('detail');
  });

  test('a listener that throws does not stop the others or the record call', () => {
    const feed = new NotificationFeed();
    let reached = 0;
    feed.subscribe(() => { throw new Error('repaint failed'); });
    feed.subscribe(() => { reached += 1; });

    expect(() => feed.record({ id: 'n1', title: 'T', domain: 'tools', level: 'info', timestamp: 1 }, decision)).not.toThrow();
    expect(reached).toBe(1);
  });

  test('clearing the feed forgets what was seen', () => {
    const feed = new NotificationFeed();
    feed.record({ id: 'n1', title: 'T', domain: 'tools', level: 'info', timestamp: 50 }, decision);
    feed.markAllSeen();
    feed.clear();

    feed.record({ id: 'n2', title: 'T', domain: 'tools', level: 'info', timestamp: 5 }, decision);
    expect(feed.unreadCount()).toBe(1);
  });
});
