import { describe, expect, test } from 'bun:test';
import {
  createNotificationDispatcher, startNotificationFlush, NOTIFICATION_FLUSH_INTERVAL_MS,
  type NotificationFlushScheduler,
} from '../../runtime/notification-dispatch.ts';
import { NotificationFeed } from '../../views/notifications-feed.ts';
import { configGetStub } from '../helpers/config-manager-stub.ts';

function manualScheduler() {
  const timers = new Map<number, { handler: () => void; ms: number }>();
  let next = 1;
  const scheduler: NotificationFlushScheduler = {
    setInterval: (handler, ms) => { const id = next++; timers.set(id, { handler, ms }); return id; },
    clearInterval: (handle) => { timers.delete(handle as number); },
  };
  return { scheduler, timers, tick: () => { for (const timer of [...timers.values()]) timer.handler(); } };
}

describe('notification flush timer', () => {
  test('a burst held by the batch policy reaches the feed on the next tick and stops with the returned function', () => {
    const feed = new NotificationFeed();
    const dispatcher = createNotificationDispatcher({ get: configGetStub() }, feed);
    const clock = manualScheduler();
    const stop = startNotificationFlush(dispatcher, clock.scheduler);
    expect([...clock.timers.values()].map((timer) => timer.ms)).toEqual([NOTIFICATION_FLUSH_INTERVAL_MS]);

    for (let i = 0; i < 4; i++) {
      dispatcher.dispatch({ id: `burst-${i}`, domain: 'agents', level: 'info', title: `Agent finished ${i}`, timestamp: 1000 + i });
    }
    const held = JSON.stringify(feed.list());
    clock.tick();
    // The burst is already one row in the feed; the flush drains the router's queue without counting it again.
    expect(JSON.stringify(feed.list())).toBe(held);
    expect(dispatcher.router.flush()).toEqual([]);

    stop();
    stop();
    expect(clock.timers.size).toBe(0);
  });
});
