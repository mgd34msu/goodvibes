/**
 * method-catalog-rewind.ts
 *
 * The rewind.plan + rewind.apply descriptors, the unified message-anchored
 * rewind that restores files (nearest workspace checkpoint), conversation
 * (truncate session state to the anchor), or both, reusing the platform's
 * existing history stores. rewind.plan is a read-only dry-run preview that
 * mints a single-use confirm token; rewind.apply is destructive and requires
 * that token, following the checkpoints.restore confirm idiom. rewind.undo
 * restores the pre-rewind conversation from the receipt's undo snapshot id.
 * ws-only invoke verbs (no REST binding). Handlers: routes/rewind.ts.
 */
import { methodDescriptor } from './method-catalog-shared.js';
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import { BOOLEAN_SCHEMA, STRING_LIST_SCHEMA, STRING_SCHEMA, nullableSchema, objectSchema } from './operator-contract-schemas-shared.js';
import {
  REWIND_PLAN_INPUT_SCHEMA,
  REWIND_PLAN_OUTPUT_SCHEMA,
  REWIND_APPLY_INPUT_SCHEMA,
  REWIND_APPLY_OUTPUT_SCHEMA,
  REWIND_CONVERSATION_HOST_REGISTER_INPUT_SCHEMA,
  REWIND_CONVERSATION_HOST_REGISTER_OUTPUT_SCHEMA,
  REWIND_CONVERSATION_HOST_RELEASE_INPUT_SCHEMA,
  REWIND_CONVERSATION_HOST_RELEASE_OUTPUT_SCHEMA,
  REWIND_CONVERSATION_HOSTS_LIST_INPUT_SCHEMA,
  REWIND_CONVERSATION_HOSTS_LIST_OUTPUT_SCHEMA,
  REWIND_CONVERSATION_REQUESTS_ANSWER_INPUT_SCHEMA,
  REWIND_CONVERSATION_REQUESTS_ANSWER_OUTPUT_SCHEMA,
  REWIND_CONVERSATION_REQUESTS_TAKE_INPUT_SCHEMA,
  REWIND_CONVERSATION_REQUESTS_TAKE_OUTPUT_SCHEMA,
} from './operator-contract-schemas-rewind.js';

const REWIND_UNDO_INPUT_SCHEMA = objectSchema(
  { sessionId: STRING_SCHEMA, undoSnapshotId: STRING_SCHEMA },
  ['sessionId', 'undoSnapshotId'],
);

const REWIND_UNDO_OUTPUT_SCHEMA = objectSchema(
  {
    undone: BOOLEAN_SCHEMA,
    sessionId: STRING_SCHEMA,
    undoSnapshotId: STRING_SCHEMA,
    refusal: nullableSchema(objectSchema(
      { code: STRING_SCHEMA, state: STRING_SCHEMA, reason: STRING_SCHEMA, next: STRING_LIST_SCHEMA },
      ['code', 'state', 'reason', 'next'],
    )),
  },
  ['undone', 'sessionId', 'undoSnapshotId', 'refusal'],
);

export const builtinGatewayRewindMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'rewind.plan',
    title: 'Preview a Unified Rewind',
    description:
      'Dry-run preview of a unified rewind to a session turn anchor: exactly what restoring files (the nearest workspace checkpoint), conversation (truncating session state to the anchor), or both would change, and a short-lived single-use confirm token authorizing the matching rewind.apply. Read-only, nothing is changed. A part with no store wired on this runtime is reported unavailable in a warning, never faked.',
    category: 'rewind',
    scopes: ['read:checkpoints'],
    transport: ['ws'],
    inputSchema: REWIND_PLAN_INPUT_SCHEMA,
    outputSchema: REWIND_PLAN_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'rewind.apply',
    title: 'Apply a Unified Rewind',
    description:
      'Apply a unified rewind to a session turn anchor, restoring files and/or conversation. DESTRUCTIVE: requires the confirmToken minted by rewind.plan (single-use, ~2 min), which is bound to the session, turn, scope and previewed checkpoint. Called without it, confirm:true included, it returns a non-error refusal (refused:true) naming rewind.plan, never a silent no-op; a bad token is a 400. Every apply records an undo point (the workspace restore takes a pre-restore safety checkpoint; the conversation store captures its pre-rewind snapshot) so the rewind is itself reversible, and returns a receipt whose `undo` block carries how to reverse it: checkpoints.restore with undo.files.restoreCheckpointId for the files, rewind.undo with undo.conversation.undoSnapshotId for the conversation. undo.conversation.expiresAfter states how long that undo point lasts, as the process holding the conversation keeps it (the newest 32 rewinds; on disk where that process keeps its sessions). Emits a REWIND_APPLIED receipt event.',
    category: 'rewind',
    scopes: ['write:checkpoints'],
    transport: ['ws'],
    dangerous: true,
    inputSchema: REWIND_APPLY_INPUT_SCHEMA,
    outputSchema: REWIND_APPLY_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'rewind.undo',
    title: 'Undo a Conversation Rewind',
    description:
      'Put a session\'s conversation back to how it was before a rewind, from the undo.conversation.undoSnapshotId of the rewind.apply receipt. The pre-rewind copy replaces the whole conversation, so the undo is refused while the conversation has newer messages than the rewind left it with. Answers undone:true, or undone:false with a refusal (code, state, reason, next) and nothing changed: the snapshot is gone (see the receipt\'s undo.conversation.expiresAfter), the conversation changed since, or the surface holding the conversation did not answer. A conversation a surface is hosting is restored by that surface, asked over its rewind.conversation.requests channel; one this daemon holds is restored here. Files are reversed separately with checkpoints.restore.',
    category: 'rewind',
    scopes: ['write:checkpoints'],
    transport: ['ws'],
    dangerous: true,
    inputSchema: REWIND_UNDO_INPUT_SCHEMA,
    outputSchema: REWIND_UNDO_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'rewind.conversation.host.register',
    title: 'Offer This Surface\'s Live Conversation for Rewind',
    description:
      'Register the conversation this surface is running for a session, so a conversation-scope rewind of it can actually be served. Only the process holding the messages can count or drop them: without this, rewind.plan for a session hosted anywhere but the daemon reports the conversation half unavailable, and files rewind is unaffected either way. Re-registering with the hostId returned here RENEWS the offer; registering without one claims the session and replaces whoever held it, answering that surface\'s outstanding requests as unavailable. The registration is a lease, not a reservation, it lapses unless the surface keeps taking its requests, and nothing about it survives a daemon restart, because a claim about a live process is worthless once the process on either end may be gone.',
    category: 'rewind',
    scopes: ['write:sessions'],
    transport: ['ws'],
    inputSchema: REWIND_CONVERSATION_HOST_REGISTER_INPUT_SCHEMA,
    outputSchema: REWIND_CONVERSATION_HOST_REGISTER_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'rewind.conversation.host.release',
    title: 'Withdraw a Conversation Rewind Offer',
    description:
      'Withdraw this surface\'s offer to serve a session\'s conversation, when the session ends, or the surface is going away. Outstanding requests put to it are answered unavailable rather than left to time out. Only the registered host may release its own session; anyone else is refused.',
    category: 'rewind',
    scopes: ['write:sessions'],
    transport: ['ws'],
    inputSchema: REWIND_CONVERSATION_HOST_RELEASE_INPUT_SCHEMA,
    outputSchema: REWIND_CONVERSATION_HOST_RELEASE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'rewind.conversation.hosts.list',
    title: 'List Conversation Rewind Hosts',
    description:
      'Which sessions have a surface offering their live conversation right now, how each surface names itself, and when its lease runs out. This is what makes "conversation rewind is unavailable for that session" checkable rather than something a person has to take on trust.',
    category: 'rewind',
    scopes: ['write:sessions'],
    transport: ['ws'],
    inputSchema: REWIND_CONVERSATION_HOSTS_LIST_INPUT_SCHEMA,
    outputSchema: REWIND_CONVERSATION_HOSTS_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'rewind.conversation.requests.take',
    title: 'Take Conversation Rewind Requests',
    description:
      'Collect the conversation questions waiting for this host, how many messages a rewind to an anchor would drop, a request to actually drop them, or a request to undo a rewind from its undoSnapshotId, and renew its lease, because a surface that is polling is a surface that is alive. With nothing waiting, pass waitMs to hold the call open until something arrives; an empty result is a normal answer, not an error. Answer each request with rewind.conversation.requests.answer before its expiresAt, or the caller waiting on it is told, honestly, that this surface did not answer in time.',
    category: 'rewind',
    scopes: ['write:sessions'],
    transport: ['ws'],
    inputSchema: REWIND_CONVERSATION_REQUESTS_TAKE_INPUT_SCHEMA,
    outputSchema: REWIND_CONVERSATION_REQUESTS_TAKE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'rewind.conversation.requests.answer',
    title: 'Answer a Conversation Rewind Request',
    description:
      'Report what this surface found or did. Which fields are expected follows from the REQUEST, which already says whether it was a preview, a rewind or an undo, an answer that restated that could only disagree with it, silently. For a preview: messagesToDrop and messagesRemaining. For a rewind: droppedMessages and the undoSnapshotId that restores them, optionally undoExpiresAfter saying how long this surface keeps it. For an undo: undone:true once the pre-rewind conversation is back. For any kind, a non-empty unavailableReason instead, which is the honest answer when the conversation is gone or this surface cannot serve it, and saying so beats staying silent, because silence becomes a timeout and a timed-out rewind cannot tell whether the messages were dropped; an undo refusal adds unavailableCode UNDO_POINT_GONE or CONVERSATION_CHANGED. Only the surface a request was put to may answer it.',
    category: 'rewind',
    scopes: ['write:sessions'],
    transport: ['ws'],
    inputSchema: REWIND_CONVERSATION_REQUESTS_ANSWER_INPUT_SCHEMA,
    outputSchema: REWIND_CONVERSATION_REQUESTS_ANSWER_OUTPUT_SCHEMA,
  }),
];
