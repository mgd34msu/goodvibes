import { expect, test } from 'bun:test';
import * as webhookHttp from '@goodvibes-jev/engine/platform/platform/utils';
import { makeTestWebhookNotifier, useTestWebhookNotifications } from './notification-transport.ts';

useTestWebhookNotifications();

const isSpied = (): boolean => 'mock' in webhookHttp.postToPublicWebhook;

test('building a notifier substitutes the HTTP boundary', () => {
  makeTestWebhookNotifier();
  expect(isSpied()).toBe(true);
});

test('the next test in the file finds the HTTP boundary restored', () => {
  expect(isSpied()).toBe(false);
});
