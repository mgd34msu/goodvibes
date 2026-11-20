/**
 * The notifications.deadLetters.* descriptors: outbound notifications (Slack,
 * Discord, webhooks) that failed every attempt, listed and resent over the
 * wire. ws-only invoke verbs; handlers: routes/notification-dead-letters.ts,
 * registered by the daemon when its notifiers start.
 */
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  methodDescriptor,
  objectSchema,
  type GatewayMethodDescriptor,
} from './method-catalog-shared.js';
import { IDEMPOTENCY_KEY_REPLAY } from './idempotent-replay.js';
import { enumSchema, nullableSchema } from './operator-contract-schemas-shared.js';

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
  /** Send a notification whose channel now posts somewhere else to the destination configured now. */
  toCurrent: BOOLEAN_SCHEMA,
});

const TARGET_CHANGE_SCHEMA = objectSchema({
  field: STRING_SCHEMA,
  was: STRING_SCHEMA,
  now: nullableSchema(STRING_SCHEMA),
}, ['field', 'was', 'now']);

export const NOTIFICATION_DEAD_LETTERS_REPLAY_OUTPUT_SCHEMA = objectSchema({
  results: arraySchema(objectSchema({
    id: STRING_SCHEMA,
    outcome: enumSchema(['delivered', 'retrying', 'dead_letter', 'not-found', 'destination-changed']),
    reason: STRING_SCHEMA,
    changes: arraySchema(TARGET_CHANGE_SCHEMA),
  }, ['id', 'outcome'])),
  delivered: NUMBER_SCHEMA,
  retrying: NUMBER_SCHEMA,
  failed: NUMBER_SCHEMA,
  notFound: NUMBER_SCHEMA,
  destinationChanged: NUMBER_SCHEMA,
}, ['results', 'delivered', 'retrying', 'failed', 'notFound', 'destinationChanged']);

export const builtinGatewayNotificationMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'notifications.deadLetters.list',
    title: 'List Failed Notifications',
    description: 'Outbound notifications (Slack, Discord, webhooks) that failed every attempt, oldest first. They are kept across restarts until resent. Each entry gives the channel, the event, what it said in metadata-only form, when it failed, the attempt count and the last error (HTTP status when there was one). Pass `channel` (slack, discord or webhook) to list one. Resend with notifications.deadLetters.replay.',
    category: 'deliveries',
    effects: ['deliveries.read'],
    transport: ['ws'],
    inputSchema: NOTIFICATION_DEAD_LETTERS_LIST_INPUT_SCHEMA,
    outputSchema: NOTIFICATION_DEAD_LETTERS_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'notifications.deadLetters.replay',
    replay: IDEMPOTENCY_KEY_REPLAY,
    title: 'Resend Failed Notifications',
    description: 'Send failed notifications again: those named in `ids`, or all of them when `ids` is absent. Each is queued with a fresh retry budget; the result per id is delivered, retrying (still queued), dead_letter (failed again and back in the list), not-found, or destination-changed: the Slack or Discord channel now posts somewhere other than where the notification failed (another webhook, another default channel, or none), so it was not sent and stays in the list, with `reason` and `changes` naming the old and new destination. Pass toCurrent: true to send those to the destination configured now. A webhook notification is not sent to a URL that was removed since it failed. A queued retry is likewise never sent to a destination that changed while it waited: it ends in the list with the reason.',
    category: 'deliveries',
    effects: ['deliveries.write'],
    transport: ['ws'],
    inputSchema: NOTIFICATION_DEAD_LETTERS_REPLAY_INPUT_SCHEMA,
    outputSchema: NOTIFICATION_DEAD_LETTERS_REPLAY_OUTPUT_SCHEMA,
  }),
];
