/**
 * The notifications.deadLetters.* descriptors: outbound notifications (Slack,
 * Discord, webhooks) that failed every attempt, listed and resent over the
 * wire. ws-only invoke verbs; handlers: routes/notification-dead-letters.ts,
 * registered by the daemon when its notifiers start.
 */
import {
  BOOLEAN_SCHEMA,
  JSON_OBJECT_SCHEMA,
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

export const NOTIFICATIONS_SEND_METHOD_ID = 'notifications.send';

export const NOTIFICATIONS_SEND_INPUT_SCHEMA = objectSchema({
  kind: enumSchema(['turn', 'approval', 'budget', 'text']),
  /** The notice's facts (turn-notification.ts): what the daemon's notifier words, under "metadata only" as set now. */
  facts: JSON_OBJECT_SCHEMA,
  /** A notice in words (`kind: 'text'`, the model's notify tool): sent once, as the words or, under "metadata only", as a notice without them. */
  text: STRING_SCHEMA,
  /** The program event it reports (`turn.completed`, `AGENT_FAILED`, ...), named in the failed list. */
  event: STRING_SCHEMA,
  program: enumSchema(['tui', 'agent']),
}, ['kind']);

export const NOTIFICATIONS_SEND_OUTPUT_SCHEMA = objectSchema({
  attempted: NUMBER_SCHEMA,
  delivered: NUMBER_SCHEMA,
  failed: NUMBER_SCHEMA,
  /** Whether the words went out (false while "metadata only" is on). */
  textSent: BOOLEAN_SCHEMA,
  results: arraySchema(objectSchema({
    ok: BOOLEAN_SCHEMA,
    error: STRING_SCHEMA,
    status: NUMBER_SCHEMA,
    outcome: STRING_SCHEMA,
  }, ['ok'])),
  /** Slack and Discord (a typed notice only): the channels it went to, and how many did not take it (in the failed list). */
  chat: objectSchema({ attempted: NUMBER_SCHEMA, failed: NUMBER_SCHEMA }, ['attempted', 'failed']),
}, ['attempted', 'delivered', 'failed']);

export const builtinGatewayNotificationMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: NOTIFICATIONS_SEND_METHOD_ID,
    // Sent again, the notice goes out again.
    repeat: 'unsafe',
    title: 'Send a Program Notice',
    description: 'A terminal program (the terminal app, the Agent) sends a notice of its own event (a turn that ended, an approval waiting, a budget reached, an agent that failed, or the model\'s own words through its notify tool) to the daemon\'s one list of webhook addresses (notifications.webhookUrls) and, for a turn, approval or budget notice, to the Slack and Discord channels the daemon posts notifications to. Facts are worded by the daemon under "metadata only" as it is set now. A typed notice is queued and retried; one that fails every attempt is kept in the daemon\'s failed notifications (notifications.deadLetters.list). A text notice is one attempt, reported per address. No address is returned.',
    category: 'deliveries',
    effects: ['deliveries.write'],
    transport: ['ws'],
    inputSchema: NOTIFICATIONS_SEND_INPUT_SCHEMA,
    outputSchema: NOTIFICATIONS_SEND_OUTPUT_SCHEMA,
  }),
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
