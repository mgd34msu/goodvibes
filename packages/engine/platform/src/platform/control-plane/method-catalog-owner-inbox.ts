/**
 * The inbox.* descriptors: the owner inbox over the wire. ws-only invoke verbs
 * (no REST binding); handlers: routes/owner-inbox.ts.
 */
import { methodDescriptor, type GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  OWNER_INBOX_ANSWER_INPUT_SCHEMA,
  OWNER_INBOX_ANSWER_OUTPUT_SCHEMA,
  OWNER_INBOX_LIST_INPUT_SCHEMA,
  OWNER_INBOX_LIST_OUTPUT_SCHEMA,
  OWNER_INBOX_POST_INPUT_SCHEMA,
  OWNER_INBOX_POST_OUTPUT_SCHEMA,
  OWNER_INBOX_WITHDRAW_INPUT_SCHEMA,
  OWNER_INBOX_WITHDRAW_OUTPUT_SCHEMA,
} from './operator-contract-schemas-owner-inbox.js';

export const builtinGatewayOwnerInboxMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'inbox.list',
    title: 'List Owner Inbox',
    description: 'Everything waiting on the owner in one list, newest first: permission asks (kind approval), questions agents left, channel claims, purchase windows and queued actions. `status` is open (default), closed or all; pass `itemId` to read one item wherever it ranks. `revision` moves on every change, so a surface can tell whether its copy is current by comparing one number.',
    category: 'approvals',
    scopes: ['read:approvals'],
    transport: ['ws'],
    inputSchema: OWNER_INBOX_LIST_INPUT_SCHEMA,
    outputSchema: OWNER_INBOX_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'inbox.answer',
    title: 'Answer Owner Inbox Item',
    description: 'Answer one open inbox item with one of its `options`, or with `text` when it has none (text may also accompany an option). An approval answered approve or deny is decided through the approval broker exactly as approvals.approve/deny would. The first answer wins: a later one, or an answer to a withdrawn or expired item, returns `applied: false` with a `refusal` naming who answered and from where (still 200, so a raced answer does not fail). Who answered is taken from the authenticated caller.',
    category: 'approvals',
    access: 'admin',
    scopes: ['write:approvals'],
    transport: ['ws'],
    inputSchema: OWNER_INBOX_ANSWER_INPUT_SCHEMA,
    outputSchema: OWNER_INBOX_ANSWER_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'inbox.post',
    title: 'Post to Owner Inbox',
    description: 'Leave the owner a question or a queued action from a process that is not the daemon (an agent in a terminal app). Returns at once; the asker carries on and reads the answer later with inbox.list (`itemId`). A post under a `key` that already has an open item returns that item with `created: false`, so a retried post never asks twice. Permission asks are raised with approvals.raise; claims and purchase windows are posted by the daemon itself.',
    category: 'approvals',
    scopes: ['write:approvals'],
    transport: ['ws'],
    inputSchema: OWNER_INBOX_POST_INPUT_SCHEMA,
    outputSchema: OWNER_INBOX_POST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'inbox.withdraw',
    title: 'Withdraw Owner Inbox Item',
    description: 'Take back an open item this caller posted, because the answer is no longer needed. Only the principal that posted an item may withdraw it. An item that is no longer open returns `applied: false` with a `refusal`.',
    category: 'approvals',
    scopes: ['write:approvals'],
    transport: ['ws'],
    inputSchema: OWNER_INBOX_WITHDRAW_INPUT_SCHEMA,
    outputSchema: OWNER_INBOX_WITHDRAW_OUTPUT_SCHEMA,
  }),
];
