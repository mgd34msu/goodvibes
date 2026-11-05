import { createNotificationFeedScope } from '@goodvibes-jev/engine/sdk/platform/runtime/notification-feed';
export * from '@goodvibes-jev/engine/sdk/platform/runtime/notification-feed';
export const getSharedNotificationFeed = createNotificationFeedScope();
