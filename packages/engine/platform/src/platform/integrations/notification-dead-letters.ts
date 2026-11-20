/**
 * notification-dead-letters.ts, the failed-notification list as people and
 * operators see it, and how a notification is written into the dead-letter
 * file so it survives a restart.
 */
import { NotificationEnvelope, type NotificationPrivacyReader } from '../runtime/notification-envelope.js';
import { readNotificationsMetadataOnly } from '../runtime/notification-privacy.js';
import type { TargetChange } from '@goodvibes-jev/engine/errors';
import type { DeadLetterCodec, DeadLetterEntry, DeliveryOutcome } from './delivery.js';

/** One failed notification, as an operator or the owner sees it. */
export interface NotificationDeadLetter {
  readonly id: string;
  readonly channel: string;
  readonly event: string;
  /** What the notification says, in its metadata-only form. */
  readonly summary: string;
  readonly createdAt: number;
  readonly deadAt: number;
  readonly attempts: number;
  readonly finalError: string;
  readonly failureClass: 'retryable' | 'terminal';
  readonly status?: number | undefined;
}

/** The result of resending one failed notification. */
export interface NotificationReplayResult {
  readonly id: string;
  /**
   * `destination-changed`: the channel now posts somewhere other than where
   * the notification failed, so it was not sent and stays in the list; resend
   * with `toCurrent` to send it to the destination configured now.
   */
  readonly outcome: DeliveryOutcome | 'not-found' | 'destination-changed';
  /** With `destination-changed`: the destination it failed on and the one configured now. */
  readonly reason?: string | undefined;
  readonly changes?: readonly TargetChange[] | undefined;
}

/** How a resend treats a channel whose destination changed since the notification failed. */
export interface NotificationReplayOptions {
  /** Send to the destination configured now instead of refusing. */
  readonly toCurrent?: boolean | undefined;
}

/** A notifier whose failed notifications can be listed and resent. */
export interface NotificationDeadLetterSource {
  listDeadLetters(): readonly NotificationDeadLetter[];
  replayDeadLetters(ids?: readonly string[], options?: NotificationReplayOptions): Promise<readonly NotificationReplayResult[]>;
}

/**
 * What a failed notification keeps on disk: its text, and its metadata-only
 * form. The text is written only when the privacy setting permitted content
 * at the moment it failed; a resend re-checks the setting.
 */
interface StoredNotification {
  readonly text?: string;
  readonly metadata: string;
}

/** The dead-letter file format for queues of notification envelopes. */
export function notificationDeadLetterCodec(privacy: NotificationPrivacyReader | undefined): DeadLetterCodec<NotificationEnvelope | string> {
  return {
    encode(payload) {
      if (typeof payload === 'string') return undefined;
      const metadata = payload.describe();
      const restricted = readNotificationsMetadataOnly(() => privacy?.());
      const text = restricted ? undefined : payload.prepare().text;
      return text !== undefined && text !== metadata ? { text, metadata } : { metadata };
    },
    decode(value) {
      if (!value || typeof value !== 'object') return undefined;
      const stored = value as Partial<StoredNotification>;
      if (typeof stored.metadata !== 'string') return undefined;
      const restricted = readNotificationsMetadataOnly(() => privacy?.());
      if (restricted || typeof stored.text !== 'string') return NotificationEnvelope.legacy(stored.metadata, () => false);
      return NotificationEnvelope.legacy(stored.text, privacy);
    },
  };
}

/** Project dead-letter rows into what a person may see: no payload text beyond its metadata-only form, no target. */
export function describeDeadLetters<T>(
  entries: readonly DeadLetterEntry<T>[],
  summarize: (payload: T) => string,
): NotificationDeadLetter[] {
  return entries.map((entry) => ({
    id: entry.id,
    channel: entry.channel,
    event: entry.event,
    summary: summarize(entry.payload),
    createdAt: entry.createdAt,
    deadAt: entry.deadAt,
    attempts: entry.attempts,
    finalError: entry.finalError,
    failureClass: entry.failureClass,
    ...(entry.status !== undefined ? { status: entry.status } : {}),
  }));
}
