import { createNotificationFeedScope } from '@goodvibes/engine/platform/platform/runtime/notification-feed';
export * from '@goodvibes/engine/platform/platform/runtime/notification-feed';
export const getSharedNotificationFeed = createNotificationFeedScope();
