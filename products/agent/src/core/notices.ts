import { createNoticePublisher, type NoticeOptions } from '@goodvibes-jev/engine/terminal-shell/notice-publication';
import { runtimeEventOfNotice, runtimeEventKey } from '@goodvibes-jev/engine/platform/platform/runtime/bootstrap';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { delegatedTaskEventOfNotice } from './delegated-task-notices.ts';
import { getSharedNotificationFeed, type NotificationFeed } from './notifications-feed.ts';
export {
  noticeParts,
  type NoticeParts,
  type NoticeOptions,
  type NoticeSink,
} from '@goodvibes-jev/engine/terminal-shell/notice-publication';
const publish = createNoticePublisher({
  resolveEvent(text, provenance) {
    const event = delegatedTaskEventOfNotice(text) ?? runtimeEventOfNotice(text, provenance);
    return event ? { ...event, key: runtimeEventKey(event.type, provenance) } : undefined;
  },
});
export async function publishNotice(feed: NotificationFeed, text: string, options: NoticeOptions = {}): Promise<void> {
  publish(feed, text, options);
}
export function publishToSharedFeed(content: string, options: NoticeOptions & { readonly restored: boolean }): void {
  publishNotice(getSharedNotificationFeed(), content, options).catch((error: unknown) => {
    logger.warn('Notice publication failed', { error: summarizeError(error) });
  });
}
