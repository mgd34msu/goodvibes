/**
 * Wire schemas for the owner inbox (inbox.list / inbox.answer / inbox.post /
 * inbox.withdraw / inbox.delivery): one list of what waits on the owner,
 * approvals included.
 */
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  objectSchema,
} from './method-catalog-shared.js';
import { METADATA_SCHEMA, enumSchema } from './operator-contract-schemas-shared.js';

export const OWNER_ITEM_KIND_SCHEMA = enumSchema(['approval', 'question', 'claim', 'purchase', 'queued-action']);
const POSTABLE_OWNER_ITEM_KIND_SCHEMA = enumSchema(['question', 'queued-action']);
const OWNER_ITEM_STATUS_SCHEMA = enumSchema(['open', 'answered', 'withdrawn', 'expired']);

const OWNER_ANSWER_SCHEMA = objectSchema({
  option: STRING_SCHEMA,
  text: STRING_SCHEMA,
});

const OWNER_ANSWER_SOURCE_SCHEMA = objectSchema({
  actor: STRING_SCHEMA,
  surface: STRING_SCHEMA,
}, ['actor', 'surface']);

const REFUSAL_SCHEMA = objectSchema({
  code: STRING_SCHEMA,
  state: STRING_SCHEMA,
  reason: STRING_SCHEMA,
  next: arraySchema(STRING_SCHEMA),
  retryable: BOOLEAN_SCHEMA,
  retryAfterMs: NUMBER_SCHEMA,
  status: NUMBER_SCHEMA,
}, ['code', 'state', 'reason', 'next', 'retryable']);

/** What became of an answer: delivered to its asker, waiting for the asking session to open, or not deliverable (with why). */
const OWNER_ANSWER_DELIVERY_SCHEMA = objectSchema({
  state: enumSchema(['delivered', 'waiting', 'undeliverable']),
  to: STRING_SCHEMA,
  reason: STRING_SCHEMA,
}, ['state', 'to']);

export const OWNER_ITEM_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  kind: OWNER_ITEM_KIND_SCHEMA,
  status: OWNER_ITEM_STATUS_SCHEMA,
  sessionId: STRING_SCHEMA,
  title: STRING_SCHEMA,
  detail: STRING_SCHEMA,
  options: arraySchema(STRING_SCHEMA),
  askedBy: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  expiresAt: NUMBER_SCHEMA,
  answer: OWNER_ANSWER_SCHEMA,
  answeredBy: OWNER_ANSWER_SOURCE_SCHEMA,
  closedAt: NUMBER_SCHEMA,
  withdrawnReason: STRING_SCHEMA,
  key: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
  delivery: OWNER_ANSWER_DELIVERY_SCHEMA,
}, ['id', 'kind', 'status', 'title', 'detail', 'options', 'createdAt']);

export const OWNER_INBOX_LIST_INPUT_SCHEMA = objectSchema({
  itemId: STRING_SCHEMA,
  status: enumSchema(['open', 'closed', 'all']),
  kinds: arraySchema(OWNER_ITEM_KIND_SCHEMA),
  sessionId: STRING_SCHEMA,
  limit: NUMBER_SCHEMA,
});
export const OWNER_INBOX_LIST_OUTPUT_SCHEMA = objectSchema({
  items: arraySchema(OWNER_ITEM_SCHEMA),
  revision: NUMBER_SCHEMA,
}, ['items', 'revision']);

export const OWNER_INBOX_ANSWER_INPUT_SCHEMA = objectSchema({
  itemId: STRING_SCHEMA,
  option: STRING_SCHEMA,
  text: STRING_SCHEMA,
}, ['itemId']);
export const OWNER_INBOX_ANSWER_OUTPUT_SCHEMA = objectSchema({
  applied: BOOLEAN_SCHEMA,
  item: OWNER_ITEM_SCHEMA,
  delivery: OWNER_ANSWER_DELIVERY_SCHEMA,
  refusal: REFUSAL_SCHEMA,
}, ['applied']);

export const OWNER_INBOX_POST_INPUT_SCHEMA = objectSchema({
  kind: POSTABLE_OWNER_ITEM_KIND_SCHEMA,
  title: STRING_SCHEMA,
  detail: STRING_SCHEMA,
  options: arraySchema(STRING_SCHEMA),
  sessionId: STRING_SCHEMA,
  askedBy: STRING_SCHEMA,
  key: STRING_SCHEMA,
  expiresAt: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['kind', 'title']);
export const OWNER_INBOX_POST_OUTPUT_SCHEMA = objectSchema({
  created: BOOLEAN_SCHEMA,
  item: OWNER_ITEM_SCHEMA,
}, ['created', 'item']);

export const OWNER_INBOX_WITHDRAW_INPUT_SCHEMA = objectSchema({
  itemId: STRING_SCHEMA,
  reason: STRING_SCHEMA,
}, ['itemId']);
export const OWNER_INBOX_WITHDRAW_OUTPUT_SCHEMA = OWNER_INBOX_ANSWER_OUTPUT_SCHEMA;

export const OWNER_INBOX_DELIVERY_INPUT_SCHEMA = objectSchema({
  itemId: STRING_SCHEMA,
  state: enumSchema(['delivered', 'undeliverable']),
  reason: STRING_SCHEMA,
}, ['itemId', 'state']);
export const OWNER_INBOX_DELIVERY_OUTPUT_SCHEMA = OWNER_INBOX_ANSWER_OUTPUT_SCHEMA;
