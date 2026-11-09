import {
  createNoticePublisher,
  noticeParts as parts,
  type NoticeParts as PlatformNoticeParts,
  type NoticeOptions,
} from '@goodvibes-jev/engine/terminal-shell/notice-publication';
import { runtimeEventOfNotice, runtimeEventKey } from '@goodvibes-jev/engine/platform/platform/runtime/bootstrap';
import type { Notification } from '@goodvibes-jev/engine/platform/platform/runtime/ui';
import { delegatedTaskEventOfNotice } from './delegated-task-notices.ts';
import { getSharedNotificationFeed, type NotificationFeed } from './notifications-feed.ts';
export type { NoticeOptions, NoticeSink } from '@goodvibes-jev/engine/terminal-shell/notice-publication';
export interface NoticeParts extends PlatformNoticeParts {
  readonly level: Notification['level'];
}
export function noticeParts(text: string, severity?: 'error' | 'warning' | 'info'): NoticeParts {
  return { ...parts(text), level: severity === 'error' ? 'critical' : severity === 'warning' ? 'warning' : 'info' };
}
const publish = createNoticePublisher({
  severity: 'presentation',
  screenBeforeLocalPublication: false,
  retainOnDecorationError: true,
  resolveEvent(text, provenance) {
    const event = delegatedTaskEventOfNotice(text) ?? runtimeEventOfNotice(text, provenance);
    return event ? { ...event, key: runtimeEventKey(event.type, provenance) } : undefined;
  },
});
export async function publishNotice(feed: NotificationFeed, text: string, options: NoticeOptions = {}): Promise<void> {
  await publish(feed, text, options);
}
export function publishToSharedFeed(content: string, options: NoticeOptions & { readonly restored: boolean }): void {
  void publishNotice(getSharedNotificationFeed(), content, options);
}
