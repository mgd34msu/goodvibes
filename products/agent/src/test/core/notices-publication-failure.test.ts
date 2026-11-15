import { describe, expect, spyOn, test } from 'bun:test';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { publishToSharedFeed } from '../../core/notices.ts';
import { getSharedNotificationFeed } from '../../core/notifications-feed.ts';

describe('publishToSharedFeed', () => {
  test('a publication that rejects is logged instead of escaping as an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    const feed = getSharedNotificationFeed();
    const capture = spyOn(feed, 'recordNotice').mockImplementation(() => { throw new Error('feed retired'); });
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      publishToSharedFeed('[Agents] a notice', { restored: false });
      // Let the rejected promise settle on the microtask queue and the unhandled-rejection check run.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(warn).toHaveBeenCalledWith('Notice publication failed', expect.objectContaining({ error: expect.stringContaining('feed retired') }));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      capture.mockRestore();
      warn.mockRestore();
    }
  });
});
