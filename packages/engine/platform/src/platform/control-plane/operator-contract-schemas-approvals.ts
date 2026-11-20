/**
 * Wire schemas for the shared approval broker's operator surface: the
 * approval record/snapshot shapes and the approvals.* action inputs/outputs.
 * The decision fields (rememberTier / reason / modifiedArgs) travel over
 * HTTP into the same broker resolution the in-process path uses.
 */
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  objectSchema,
} from './method-catalog-shared.js';
import {
  METADATA_SCHEMA,
  TOOL_ARGUMENTS_SCHEMA,
  enumSchema,
  nullableSchema,
} from './operator-contract-schemas-shared.js';
import {
  PERMISSION_MODE_SCHEMA,
  PERMISSION_PROMPT_DECISION_SCHEMA,
  PERMISSION_PROMPT_REQUEST_SCHEMA,
  PERMISSION_REMEMBER_TIER_SCHEMA,
  PERMISSION_RUNTIME_DECISION_SCHEMA,
} from './operator-contract-schemas-permissions.js';
import { SHARED_APPROVAL_DISPOSITIONS } from './approval-disposition.js';

/** Provenance belongs to the stored record, not the legacy awaited prompt result. */
export const SHARED_APPROVAL_DECISION_SCHEMA = objectSchema({
  ...(PERMISSION_PROMPT_DECISION_SCHEMA['properties'] as Record<string, Record<string, unknown>>),
  disposition: enumSchema(SHARED_APPROVAL_DISPOSITIONS),
  /** On an approval: the digest of the arguments the call runs with (modified or its own). */
  argsDigest: STRING_SCHEMA,
}, ['approved']);

const APPROVAL_STATUS_SCHEMA = enumSchema(['pending', 'claimed', 'approved', 'denied', 'cancelled', 'expired']);

const SHARED_APPROVAL_AUDIT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  action: enumSchema(['created', 'claimed', 'approved', 'denied', 'cancelled', 'expired', 'updated']),
  actor: STRING_SCHEMA,
  actorSurface: STRING_SCHEMA,
  // The node the actor reached; absent for the broker's own moves on the home node.
  actorNode: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  note: STRING_SCHEMA,
}, ['id', 'action', 'actor', 'createdAt']);

const APPROVAL_CAUSE_SCHEMA = enumSchema([
  'requester-left', 'requester-restarted', 'cancelled-by-actor', 'owner-decision-stale', 'deadline', 'deadline-while-down', 'remembered-rule',
]);

// Who waits for the answer: an in-process waiter (answered in the step that
// records it), surfaces that raised it over approvals.raise (each holds it
// until it releases the hold), or a requester that reads the record itself.
const APPROVAL_REQUESTER_SCHEMA = objectSchema({
  kind: enumSchema(['in-process', 'wire', 'record-reader']),
  holds: arraySchema(objectSchema({ id: STRING_SCHEMA, releasedAt: NUMBER_SCHEMA }, ['id'])),
}, ['kind']);

const APPROVAL_ACTION_NAMES = ['claim', 'approve', 'deny', 'amend', 'cancel'] as const;

// The reading (approval-lifecycle.ts readApproval), computed for the caller:
// what is waiting, on whom, until when, what the caller may do now, how it was
// decided or ended, and whether the requester received the decision. `work`
// says whether the approved work ran is not reported by the approval.
export const APPROVAL_READING_SCHEMA = objectSchema({
  ref: objectSchema({ node: STRING_SCHEMA, id: STRING_SCHEMA }, ['node', 'id']),
  revision: NUMBER_SCHEMA,
  sequence: NUMBER_SCHEMA,
  phase: enumSchema(['waiting', 'decided', 'ended']),
  status: APPROVAL_STATUS_SCHEMA,
  reason: enumSchema([
    'waiting-for-approver', 'waiting-for-owner', 'claimed-by-you', 'claimed-by-other',
    'approved', 'denied', 'amended', 'remembered-approved', 'remembered-denied',
    'cancelled-requester-left', 'cancelled-requester-restarted', 'cancelled-by-actor', 'cancelled-owner-decision-stale',
    'expired', 'expired-while-down',
  ]),
  waitingOn: objectSchema({
    who: enumSchema(['owner', 'approver']),
    claimedBy: STRING_SCHEMA,
    homeNode: STRING_SCHEMA,
    homeReachable: BOOLEAN_SCHEMA,
  }, ['who', 'homeNode', 'homeReachable']),
  deadline: objectSchema({ expiresAt: NUMBER_SCHEMA, remainingMs: NUMBER_SCHEMA }, ['expiresAt', 'remainingMs']),
  allowedActions: arraySchema(enumSchema(APPROVAL_ACTION_NAMES)),
  refusedActions: arraySchema(objectSchema({ action: enumSchema(APPROVAL_ACTION_NAMES), code: STRING_SCHEMA, reason: STRING_SCHEMA }, ['action', 'code', 'reason'])),
  decision: objectSchema({
    disposition: enumSchema(SHARED_APPROVAL_DISPOSITIONS),
    by: STRING_SCHEMA,
    surface: STRING_SCHEMA,
    node: STRING_SCHEMA,
    at: NUMBER_SCHEMA,
    cause: APPROVAL_CAUSE_SCHEMA,
  }, ['disposition', 'by', 'surface', 'node', 'at']),
  receipt: objectSchema({
    state: enumSchema(['delivered', 'waiting', 'undeliverable', 'requester-reads-record', 'not-applicable']),
    reason: STRING_SCHEMA,
  }, ['state']),
  requester: objectSchema({
    kind: enumSchema(['in-process', 'wire', 'record-reader']),
    principal: STRING_SCHEMA,
    surface: STRING_SCHEMA,
    mine: BOOLEAN_SCHEMA,
  }, ['kind', 'mine']),
  work: objectSchema({ state: enumSchema(['not-reported']), callId: STRING_SCHEMA, sessionId: STRING_SCHEMA }, ['state', 'callId']),
  next: arraySchema(objectSchema({ move: enumSchema(['wait', 'decide', 'refresh', 'raise-again', 'nothing']), text: STRING_SCHEMA }, ['move', 'text'])),
}, ['ref', 'revision', 'sequence', 'phase', 'status', 'reason', 'allowedActions', 'refusedActions', 'receipt', 'requester', 'work', 'next']);

// Why an approval action was not applied: a stable code (APPROVAL_SETTLED,
// APPROVAL_CHANGED, APPROVAL_EXPIRED, OWNER_DECISION_REQUIRED, ILLEGAL_TRANSITION,
// UNKNOWN_APPROVAL), the state it is in, why, and what to do next.
export const APPROVAL_REFUSAL_SCHEMA = objectSchema({
  code: STRING_SCHEMA,
  state: STRING_SCHEMA,
  reason: STRING_SCHEMA,
  next: arraySchema(STRING_SCHEMA),
  retryable: BOOLEAN_SCHEMA,
  retryAfterMs: NUMBER_SCHEMA,
  status: NUMBER_SCHEMA,
}, ['code', 'state', 'reason', 'next', 'retryable']);

const SHARED_APPROVAL_RECORD_PROPERTIES = {
  id: STRING_SCHEMA,
  callId: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  routeId: STRING_SCHEMA,
  status: APPROVAL_STATUS_SCHEMA,
  request: PERMISSION_PROMPT_REQUEST_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  claimedBy: STRING_SCHEMA,
  claimedAt: NUMBER_SCHEMA,
  resolvedAt: NUMBER_SCHEMA,
  resolvedBy: STRING_SCHEMA,
  decision: SHARED_APPROVAL_DECISION_SCHEMA,
  // When a raise carried `timeoutMs`, the moment the ask expires if nobody has
  // answered (approval-broker-raise.ts stamps it). Declared here because the
  // record schema is closed: without it, `approvals.list` fails RESPONSE
  // validation for any ask that has one, and a client that asked for the list
  // gets a contract error instead of the pending asks. That is not theoretical
  //, a daemon-hosted run's workspace-trust question is raised with a timeout,
  // so the first hosted ask made every surface's approvals list unreadable.
  expiresAt: NUMBER_SCHEMA,
  // 1 when raised, +1 on a claim, a decision or an end (never on a note or a hold): an action sends it as `expectedRevision`.
  revision: NUMBER_SCHEMA,
  // 1 when raised, +1 on every write of the record, notes and holds included: update frames are ordered by it.
  sequence: NUMBER_SCHEMA,
  // The node whose broker owns and decides the record: the daemon's cluster node id.
  homeNode: STRING_SCHEMA,
  requester: APPROVAL_REQUESTER_SCHEMA,
  // Why it ended when no decision ended it (cancelled, expired), or that a remembered rule settled it.
  cause: APPROVAL_CAUSE_SCHEMA,
  metadata: METADATA_SCHEMA,
  audit: arraySchema(SHARED_APPROVAL_AUDIT_SCHEMA),
};
const SHARED_APPROVAL_RECORD_REQUIRED = ['id', 'callId', 'status', 'request', 'createdAt', 'updatedAt', 'revision', 'sequence', 'homeNode', 'requester', 'metadata', 'audit'];

export const SHARED_APPROVAL_RECORD_SCHEMA = objectSchema(SHARED_APPROVAL_RECORD_PROPERTIES, SHARED_APPROVAL_RECORD_REQUIRED);

// A listed record carries its reading for the caller beside its own fields; the reading is not stored.
const APPROVAL_LIST_ROW_SCHEMA = objectSchema({ ...SHARED_APPROVAL_RECORD_PROPERTIES, reading: APPROVAL_READING_SCHEMA },
  [...SHARED_APPROVAL_RECORD_REQUIRED, 'reading']);

export const APPROVAL_SNAPSHOT_SCHEMA = objectSchema({
  awaitingDecision: BOOLEAN_SCHEMA,
  mode: PERMISSION_MODE_SCHEMA,
  lastDecision: PERMISSION_RUNTIME_DECISION_SCHEMA,
  approvalCount: NUMBER_SCHEMA,
  denialCount: NUMBER_SCHEMA,
  promptCount: NUMBER_SCHEMA,
  totalChecks: NUMBER_SCHEMA,
  approvals: arraySchema(APPROVAL_LIST_ROW_SCHEMA),
}, ['awaitingDecision', 'mode', 'approvalCount', 'denialCount', 'promptCount', 'totalChecks', 'approvals'], { additionalProperties: true });

// Every action names the revision of the approval the caller showed or read;
// a stale one is refused with APPROVAL_CHANGED and the current reading.
const EXPECTED_REVISION_SCHEMA = NUMBER_SCHEMA;

export const APPROVAL_ACTION_INPUT_SCHEMA = objectSchema({
  approvalId: STRING_SCHEMA,
  expectedRevision: EXPECTED_REVISION_SCHEMA,
  note: STRING_SCHEMA,
  remember: BOOLEAN_SCHEMA,
}, ['approvalId', 'expectedRevision'], { additionalProperties: false });

// approvals.cancel adds `release`: a surface that raised the ask giving up its
// own claim on it. The record is cancelled only when no other surface that
// raised the same ask is still waiting.
// `expectedRevision` is required for a cancel and not needed for a release.
export const APPROVAL_CANCEL_INPUT_SCHEMA = objectSchema({
  approvalId: STRING_SCHEMA,
  expectedRevision: EXPECTED_REVISION_SCHEMA,
  note: STRING_SCHEMA,
  remember: BOOLEAN_SCHEMA,
  release: BOOLEAN_SCHEMA,
  holdId: STRING_SCHEMA,
}, ['approvalId'], { additionalProperties: false });

// approvals.deny carries the full decision reach: rememberTier ("always deny
// this...") and the user's free-text reason, which rides the structured
// declined result so the model adapts instead of guessing.
export const APPROVAL_DENY_INPUT_SCHEMA = objectSchema({
  approvalId: STRING_SCHEMA,
  expectedRevision: EXPECTED_REVISION_SCHEMA,
  disposition: enumSchema(['denied', 'amended']),
  note: STRING_SCHEMA,
  remember: BOOLEAN_SCHEMA,
  rememberTier: PERMISSION_REMEMBER_TIER_SCHEMA,
  reason: STRING_SCHEMA,
}, ['approvalId', 'expectedRevision'], { additionalProperties: false });

// approvals.approve additionally accepts an optional per-hunk selection. Absent
// selectedHunks = approve the whole request (exact back-compat). When present,
// the broker filters the edit-tool `edits` array to those indices server-side
// so TUI and webui produce identical modified-edit args; an out-of-range index
// or a non-edit approval is a 400. rememberTier generalizes the decision
// (and sweeps queued asks it covers); modifiedArgs carries an
// argument-modifying approval (e.g. the typed answer to a command's terminal
// prompt) to the waiting call, selectedHunks, when present, supersedes it.
export const APPROVAL_APPROVE_INPUT_SCHEMA = objectSchema({
  approvalId: STRING_SCHEMA,
  expectedRevision: EXPECTED_REVISION_SCHEMA,
  disposition: enumSchema(['approved']),
  note: STRING_SCHEMA,
  remember: BOOLEAN_SCHEMA,
  selectedHunks: arraySchema(NUMBER_SCHEMA),
  rememberTier: PERMISSION_REMEMBER_TIER_SCHEMA,
  reason: STRING_SCHEMA,
  modifiedArgs: TOOL_ARGUMENTS_SCHEMA,
}, ['approvalId', 'expectedRevision'], { additionalProperties: false });

// What the broker actually recorded on the resolved decision, derived from
// the returned record, never echoed from the request, so a surface can report
// "tier recorded / reason stored / answer delivered" without claiming
// optimistically (an already-resolved approval keeps its original decision).
export const APPROVAL_RECORDED_DECISION_SCHEMA = objectSchema({
  approved: BOOLEAN_SCHEMA,
  rememberTier: nullableSchema(PERMISSION_REMEMBER_TIER_SCHEMA),
  reasonStored: BOOLEAN_SCHEMA,
  modifiedArgsDelivered: BOOLEAN_SCHEMA,
}, ['approved', 'rememberTier', 'reasonStored', 'modifiedArgsDelivered'], { additionalProperties: false });

// `applied` is false when this call changed nothing as asked: the approval had
// already ended (APPROVAL_SETTLED), it moved since the caller read it
// (APPROVAL_CHANGED), its deadline passed (APPROVAL_EXPIRED, and it is now
// expired), or it needs the owner's own decision (OWNER_DECISION_REQUIRED).
// The response is still 200 with the record and the caller's reading as they
// are now, so a raced or stale action is shown again in place, not failed.
export const APPROVAL_ACTION_OUTPUT_SCHEMA = objectSchema({
  applied: BOOLEAN_SCHEMA,
  approval: SHARED_APPROVAL_RECORD_SCHEMA,
  reading: APPROVAL_READING_SCHEMA,
  refusal: APPROVAL_REFUSAL_SCHEMA,
  recorded: APPROVAL_RECORDED_DECISION_SCHEMA,
}, ['applied', 'approval', 'reading']);

// approvals.raise, a surface CREATING an ask in the shared broker, which no
// verb could do before (list/claim/approve/deny/cancel could only act on asks
// the daemon's own in-process callers had raised). `request` is the same ask
// object every surface already renders. `waitMs` is an optional bounded inline
// wait for callers that want one round trip; the decision's real channel is the
// `approval-update` event, and a wait that runs out returns the still-pending
// record rather than an error.
export const APPROVAL_RAISE_INPUT_SCHEMA = objectSchema({
  request: PERMISSION_PROMPT_REQUEST_SCHEMA,
  sessionId: STRING_SCHEMA,
  routeId: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
  timeoutMs: NUMBER_SCHEMA,
  waitMs: NUMBER_SCHEMA,
}, ['request'], { additionalProperties: false });

// `coalesced` says the ask attached to an identical one already in flight, so
// the returned record is older than this call and only one prompt exists.
// `decided` is true only when a decision genuinely landed inside waitMs, a
// wait that ran out reports false with the record still pending, never a
// decision nobody made.
export const APPROVAL_RAISE_OUTPUT_SCHEMA = objectSchema({
  // The id to watch on the approval-update event; always present.
  approvalId: STRING_SCHEMA,
  // The record, present when the caller may read it (it holds read:approvals; the ask is always its own).
  approval: SHARED_APPROVAL_RECORD_SCHEMA,
  // With the record: its reading for the raiser.
  reading: APPROVAL_READING_SCHEMA,
  coalesced: BOOLEAN_SCHEMA,
  decided: BOOLEAN_SCHEMA,
  // Pass back on approvals.cancel with `release: true` so a retried release does not give up another surface's hold.
  holdId: STRING_SCHEMA,
}, ['approvalId', 'coalesced', 'decided'], { additionalProperties: false });
