/**
 * The notifications.deadLetters.* descriptors: outbound notifications (Slack,
 * Discord, webhooks) that failed every attempt, listed and resent over the
 * wire. ws-only invoke verbs; handlers: routes/notification-dead-letters.ts,
 * registered by the daemon when its notifiers start.
 */
import {
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  methodDescriptor,
  objectSchema,
  type GatewayMethodDescriptor,
} from './method-catalog-shared.js';
import { enumSchema } from './operator-contract-schemas-shared.js';

const DEAD_LETTER_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  channel: STRING_SCHEMA,
  event: STRING_SCHEMA,
  summary: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  deadAt: NUMBER_SCHEMA,
  attempts: NUMBER_SCHEMA,
  finalError: STRING_SCHEMA,
  failureClass: enumSchema(['retryable', 'terminal']),
  status: NUMBER_SCHEMA,
}, ['id', 'channel', 'event', 'summary', 'createdAt', 'deadAt', 'attempts', 'finalError', 'failureClass']);

export const NOTIFICATION_DEAD_LETTERS_LIST_INPUT_SCHEMA = objectSchema({
  channel: STRING_SCHEMA,
});

export const NOTIFICATION_DEAD_LETTERS_LIST_OUTPUT_SCHEMA = objectSchema({
  entries: arraySchema(DEAD_LETTER_SCHEMA),
  total: NUMBER_SCHEMA,
}, ['entries', 'total']);

export const NOTIFICATION_DEAD_LETTERS_REPLAY_INPUT_SCHEMA = objectSchema({
  ids: arraySchema(STRING_SCHEMA),
});

export const NOTIFICATION_DEAD_LETTERS_REPLAY_OUTPUT_SCHEMA = objectSchema({
  results: arraySchema(objectSchema({
    id: STRING_SCHEMA,
    outcome: enumSchema(['delivered', 'retrying', 'dead_letter', 'not-found']),
  }, ['id', 'outcome'])),
  delivered: NUMBER_SCHEMA,
  retrying: NUMBER_SCHEMA,
  failed: NUMBER_SCHEMA,
  notFound: NUMBER_SCHEMA,
}, ['results', 'delivered', 'retrying', 'failed', 'notFound']);

export const builtinGatewayNotificationMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'notifications.deadLetters.list',
    title: 'List Failed Notifications',
    description: 'Outbound notifications (Slack, Discord, webhooks) that failed every attempt, oldest first. They are kept across restarts until resent. Each entry gives the channel, the event, what it said in metadata-only form, when it failed, the attempt count and the last error (HTTP status when there was one). Pass `channel` (slack, discord or webhook) to list one. Resend with notifications.deadLetters.replay.',
    category: 'deliveries',
    scopes: ['read:deliveries'],
    transport: ['ws'],
    inputSchema: NOTIFICATION_DEAD_LETTERS_LIST_INPUT_SCHEMA,
    outputSchema: NOTIFICATION_DEAD_LETTERS_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'notifications.deadLetters.replay',
    title: 'Resend Failed Notifications',
    description: 'Send failed notifications again: those named in `ids`, or all of them when `ids` is absent. Each is queued with a fresh retry budget; the result per id is delivered, retrying (still queued), dead_letter (failed again and back in the list) or not-found. A webhook notification is not sent to a URL that was removed since it failed.',
    category: 'deliveries',
    scopes: ['write:deliveries'],
    transport: ['ws'],
    inputSchema: NOTIFICATION_DEAD_LETTERS_REPLAY_INPUT_SCHEMA,
    outputSchema: NOTIFICATION_DEAD_LETTERS_REPLAY_OUTPUT_SCHEMA,
  }),
];
