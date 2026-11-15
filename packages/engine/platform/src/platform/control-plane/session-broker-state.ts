import {
  SHARED_SESSION_INPUT_INTENTS,
  SHARED_SESSION_INPUT_STATES,
  isDelegatedSessionInput,
  sharedSessionInputLifecycle,
  type SharedSessionInputRecord,
} from './session-intents.js';
import type { SharedSessionStoreSnapshot } from './session-broker-helpers.js';
import type { SharedSessionMessage, SharedSessionParticipant, SharedSessionRecord } from './session-types.js';
import { isRecord } from '../utils/record-coerce.js';
import { isSettableGatePresetName } from '../gate/presets.js';

const SESSION_KINDS = new Set<SharedSessionRecord['kind']>(['tui', 'agent', 'webui', 'companion-task', 'companion-chat', 'automation', 'channel', 'acp', 'hosted']);
const SESSION_STATUSES = new Set<SharedSessionRecord['status']>(['active', 'closed']);
const MESSAGE_ROLES = new Set<SharedSessionMessage['role']>(['user', 'assistant', 'system']);


function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function throwInvalidSessionSnapshot(): never {
  throw new Error('Shared session store snapshot is invalid.');
}

function validateOptionalString(value: unknown): void {
  if (value !== undefined && typeof value !== 'string') throwInvalidSessionSnapshot();
}

function validateOptionalNumber(value: unknown): void {
  if (value !== undefined && !isFiniteNumber(value)) throwInvalidSessionSnapshot();
}

function hasSessionRecordPayload(value: Record<string, unknown>): boolean {
  return [
    'kind',
    'title',
    'status',
    'createdAt',
    'updatedAt',
    'lastActivityAt',
    'messageCount',
    'pendingInputCount',
    'lastMessageAt',
    'closedAt',
    'activeAgentId',
    'lastAgentId',
    'lastError',
    'routeIds',
    'surfaceKinds',
    'participants',
    'metadata',
  ].some((key) => value[key] !== undefined);
}

function normalizeSessionParticipant(value: unknown): SharedSessionParticipant {
  if (
    !isRecord(value)
    || typeof value['surfaceKind'] !== 'string'
    || typeof value['surfaceId'] !== 'string'
  ) {
    throwInvalidSessionSnapshot();
  }
  const lastSeenAt = isFiniteNumber(value['lastSeenAt']) ? value['lastSeenAt'] : Date.now();
  const externalId = typeof value['externalId'] === 'string' ? value['externalId'] : undefined;
  const userId = typeof value['userId'] === 'string' ? value['userId'] : undefined;
  const displayName = typeof value['displayName'] === 'string' ? value['displayName'] : undefined;
  const routeId = typeof value['routeId'] === 'string' ? value['routeId'] : undefined;
  return {
    surfaceKind: value['surfaceKind'] as SharedSessionParticipant['surfaceKind'],
    surfaceId: value['surfaceId'],
    ...(externalId ? { externalId } : {}),
    ...(userId ? { userId } : {}),
    ...(displayName ? { displayName } : {}),
    ...(routeId ? { routeId } : {}),
    lastSeenAt,
  };
}

function normalizeSessionRecord(
  value: unknown,
  messages: readonly SharedSessionMessage[],
  inputs: readonly SharedSessionInputRecord[],
): SharedSessionRecord {
  if (
    !isRecord(value)
    || typeof value['id'] !== 'string'
    || !hasSessionRecordPayload(value)
  ) {
    throwInvalidSessionSnapshot();
  }
  if (value['kind'] !== undefined && (typeof value['kind'] !== 'string' || !SESSION_KINDS.has(value['kind'] as SharedSessionRecord['kind']))) {
    throwInvalidSessionSnapshot();
  }
  if (value['status'] !== undefined && (typeof value['status'] !== 'string' || !SESSION_STATUSES.has(value['status'] as SharedSessionRecord['status']))) {
    throwInvalidSessionSnapshot();
  }
  validateOptionalNumber(value['createdAt']);
  validateOptionalNumber(value['updatedAt']);
  validateOptionalNumber(value['lastActivityAt']);
  validateOptionalNumber(value['messageCount']);
  validateOptionalNumber(value['retainedMessageCount']);
  validateOptionalNumber(value['pendingInputCount']);
  validateOptionalNumber(value['lastMessageAt']);
  validateOptionalNumber(value['closedAt']);
  validateOptionalString(value['activeAgentId']);
  validateOptionalString(value['lastAgentId']);
  validateOptionalString(value['lastError']);
  const channelPermissionMode = value['channelPermissionMode'];
  validateOptionalNumber(value['channelPermissionModeRevision']);
  const channelPermissionModeRevision = value['channelPermissionModeRevision'];
  if (channelPermissionModeRevision !== undefined && (typeof channelPermissionModeRevision !== 'number'
    || !Number.isSafeInteger(channelPermissionModeRevision) || channelPermissionModeRevision < 0)) throwInvalidSessionSnapshot();
  if (channelPermissionMode !== undefined && (typeof channelPermissionMode !== 'string' || !isSettableGatePresetName(channelPermissionMode))) {
    throwInvalidSessionSnapshot();
  }
  if (value['routeIds'] !== undefined && !isStringArray(value['routeIds'])) throwInvalidSessionSnapshot();
  if (value['surfaceKinds'] !== undefined && !isStringArray(value['surfaceKinds'])) throwInvalidSessionSnapshot();
  if (value['participants'] !== undefined && !Array.isArray(value['participants'])) throwInvalidSessionSnapshot();
  if (value['metadata'] !== undefined && !isRecord(value['metadata'])) throwInvalidSessionSnapshot();

  const now = Date.now();
  const id = value['id'];
  const participants = (value['participants'] ?? []).map(normalizeSessionParticipant);
  const routeIds = isStringArray(value['routeIds']) ? [...new Set(value['routeIds'])] : [];
  const surfaceKinds = isStringArray(value['surfaceKinds'])
    ? [...new Set(value['surfaceKinds'])] as SharedSessionRecord['surfaceKinds']
    : [...new Set(participants.map((participant) => participant.surfaceKind))];
  const latestMessageAt = messages.reduce<number | undefined>(
    (latest, message) => latest === undefined || message.createdAt > latest ? message.createdAt : latest,
    undefined,
  );
  const latestInputAt = inputs.reduce<number | undefined>(
    (latest, input) => latest === undefined || input.updatedAt > latest ? input.updatedAt : latest,
    undefined,
  );
  const createdAt = isFiniteNumber(value['createdAt'])
    ? value['createdAt']
    : isFiniteNumber(value['updatedAt'])
      ? value['updatedAt']
      : now;
  const updatedAt = isFiniteNumber(value['updatedAt']) ? value['updatedAt'] : createdAt;
  const lastMessageAt = isFiniteNumber(value['lastMessageAt']) ? value['lastMessageAt'] : latestMessageAt;
  const lastActivityAt = isFiniteNumber(value['lastActivityAt'])
    ? value['lastActivityAt']
    : Math.max(updatedAt, lastMessageAt ?? 0, latestInputAt ?? 0);
  const activeAgentId = typeof value['activeAgentId'] === 'string' ? value['activeAgentId'] : undefined;
  const lastAgentId = typeof value['lastAgentId'] === 'string' ? value['lastAgentId'] : undefined;
  const lastError = typeof value['lastError'] === 'string' ? value['lastError'] : undefined;
  const closedAt = isFiniteNumber(value['closedAt']) ? value['closedAt'] : undefined;
  return {
    id,
    ...(channelPermissionMode === undefined ? {} : { channelPermissionMode }),
    ...(typeof channelPermissionModeRevision === 'number' ? { channelPermissionModeRevision } : {}),
    kind: typeof value['kind'] === 'string' && SESSION_KINDS.has(value['kind'] as SharedSessionRecord['kind'])
      ? value['kind'] as SharedSessionRecord['kind']
      : 'tui',
    project: typeof value['project'] === 'string' && value['project'].length > 0 ? value['project'] : 'unknown',
    title: typeof value['title'] === 'string' && value['title'].trim().length > 0 ? value['title'] : `Session ${id}`,
    status: typeof value['status'] === 'string' && SESSION_STATUSES.has(value['status'] as SharedSessionRecord['status'])
      ? value['status'] as SharedSessionRecord['status']
      : 'active',
    createdAt,
    updatedAt,
    ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
    ...(closedAt !== undefined ? { closedAt } : {}),
    lastActivityAt,
    messageCount: Math.max(isFiniteNumber(value['messageCount']) ? value['messageCount'] : 0, messages.length),
    ...(isFiniteNumber(value['retainedMessageCount']) && value['retainedMessageCount'] < Math.max(isFiniteNumber(value['messageCount']) ? value['messageCount'] : 0, messages.length)
      ? { retainedMessageCount: value['retainedMessageCount'] }
      : {}),
    pendingInputCount: Math.max(isFiniteNumber(value['pendingInputCount']) ? value['pendingInputCount'] : 0, countPendingSessionInputs(inputs)),
    routeIds,
    surfaceKinds,
    participants,
    ...(activeAgentId ? { activeAgentId } : {}),
    ...(lastAgentId ? { lastAgentId } : {}),
    ...(lastError ? { lastError } : {}),
    metadata: isRecord(value['metadata']) ? value['metadata'] : {},
  };
}

function normalizeSessionMessage(value: unknown): SharedSessionMessage {
  if (
    !isRecord(value)
    || typeof value['id'] !== 'string'
    || typeof value['sessionId'] !== 'string'
    || typeof value['role'] !== 'string'
    || !MESSAGE_ROLES.has(value['role'] as SharedSessionMessage['role'])
    || typeof value['body'] !== 'string'
    || !isFiniteNumber(value['createdAt'])
  ) {
    throwInvalidSessionSnapshot();
  }
  if (value['metadata'] !== undefined && !isRecord(value['metadata'])) throwInvalidSessionSnapshot();
  validateOptionalString(value['surfaceKind']);
  validateOptionalString(value['surfaceId']);
  validateOptionalString(value['routeId']);
  validateOptionalString(value['agentId']);
  validateOptionalString(value['userId']);
  validateOptionalString(value['displayName']);
  const surfaceKind = typeof value['surfaceKind'] === 'string' ? value['surfaceKind'] as SharedSessionMessage['surfaceKind'] : undefined;
  const surfaceId = typeof value['surfaceId'] === 'string' ? value['surfaceId'] : undefined;
  const routeId = typeof value['routeId'] === 'string' ? value['routeId'] : undefined;
  const agentId = typeof value['agentId'] === 'string' ? value['agentId'] : undefined;
  const userId = typeof value['userId'] === 'string' ? value['userId'] : undefined;
  const displayName = typeof value['displayName'] === 'string' ? value['displayName'] : undefined;
  return {
    id: value['id'],
    sessionId: value['sessionId'],
    role: value['role'] as SharedSessionMessage['role'],
    body: value['body'],
    createdAt: value['createdAt'],
    ...(surfaceKind ? { surfaceKind } : {}),
    ...(surfaceId ? { surfaceId } : {}),
    ...(routeId ? { routeId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(userId ? { userId } : {}),
    ...(displayName ? { displayName } : {}),
    metadata: isRecord(value['metadata']) ? value['metadata'] : {},
  };
}

function normalizeSessionInput(value: unknown): SharedSessionInputRecord {
  if (
    !isRecord(value)
    || typeof value['id'] !== 'string'
    || typeof value['sessionId'] !== 'string'
    || typeof value['intent'] !== 'string'
    || !SHARED_SESSION_INPUT_INTENTS.includes(value['intent'] as SharedSessionInputRecord['intent'])
    || typeof value['state'] !== 'string'
    || !SHARED_SESSION_INPUT_STATES.includes(value['state'] as SharedSessionInputRecord['state'])
    || typeof value['correlationId'] !== 'string'
    || typeof value['body'] !== 'string'
    || !isFiniteNumber(value['createdAt'])
    || !isFiniteNumber(value['updatedAt'])
  ) {
    throwInvalidSessionSnapshot();
  }
  if (value['metadata'] !== undefined && !isRecord(value['metadata'])) throwInvalidSessionSnapshot();
  validateOptionalString(value['causationId']);
  validateOptionalString(value['routeId']);
  validateOptionalString(value['surfaceKind']);
  validateOptionalString(value['surfaceId']);
  validateOptionalString(value['externalId']);
  validateOptionalString(value['threadId']);
  validateOptionalString(value['userId']);
  validateOptionalString(value['displayName']);
  validateOptionalString(value['activeAgentId']);
  validateOptionalString(value['error']);
  if (value['routing'] !== undefined && !isRecord(value['routing'])) throwInvalidSessionSnapshot();
  const causationId = typeof value['causationId'] === 'string' ? value['causationId'] : undefined;
  const routeId = typeof value['routeId'] === 'string' ? value['routeId'] : undefined;
  const surfaceKind = typeof value['surfaceKind'] === 'string' ? value['surfaceKind'] as SharedSessionInputRecord['surfaceKind'] : undefined;
  const surfaceId = typeof value['surfaceId'] === 'string' ? value['surfaceId'] : undefined;
  const externalId = typeof value['externalId'] === 'string' ? value['externalId'] : undefined;
  const threadId = typeof value['threadId'] === 'string' ? value['threadId'] : undefined;
  const userId = typeof value['userId'] === 'string' ? value['userId'] : undefined;
  const displayName = typeof value['displayName'] === 'string' ? value['displayName'] : undefined;
  const activeAgentId = typeof value['activeAgentId'] === 'string' ? value['activeAgentId'] : undefined;
  const error = typeof value['error'] === 'string' ? value['error'] : undefined;
  return {
    id: value['id'],
    sessionId: value['sessionId'],
    intent: value['intent'] as SharedSessionInputRecord['intent'],
    state: value['state'] as SharedSessionInputRecord['state'],
    correlationId: value['correlationId'],
    ...(causationId ? { causationId } : {}),
    body: value['body'],
    createdAt: value['createdAt'],
    updatedAt: value['updatedAt'],
    ...(routeId ? { routeId } : {}),
    ...(surfaceKind ? { surfaceKind } : {}),
    ...(surfaceId ? { surfaceId } : {}),
    ...(externalId ? { externalId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(userId ? { userId } : {}),
    ...(displayName ? { displayName } : {}),
    ...(activeAgentId ? { activeAgentId } : {}),
    metadata: isRecord(value['metadata']) ? value['metadata'] : {},
    ...(isRecord(value['routing']) ? { routing: value['routing'] as SharedSessionInputRecord['routing'] } : {}),
    ...(error ? { error } : {}),
  };
}

export function sortSessions(records: Iterable<SharedSessionRecord>): SharedSessionRecord[] {
  return [...records].sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
}

export function sortMessages(records: Iterable<SharedSessionMessage>): SharedSessionMessage[] {
  return [...records].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function sortInputs(records: Iterable<SharedSessionInputRecord>): SharedSessionInputRecord[] {
  return [...records].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** A stored session, message or input this build cannot read: kept on disk untouched and named, never fatal. */
export interface SetAsideSessionEntry {
  readonly kind: 'session' | 'message' | 'input';
  readonly id: string;
  readonly reason: string;
}

/** Why one stored entry does not read, in the store's own terms, for the operator who repairs it. */
function describeUnreadable(kind: SetAsideSessionEntry['kind'], value: unknown): string {
  if (!isRecord(value)) return 'it is not an object';
  if (kind === 'session') {
    if (typeof value['kind'] === 'string' && !SESSION_KINDS.has(value['kind'] as SharedSessionRecord['kind'])) return `its kind '${value['kind']}' is not one this build knows`;
    if (typeof value['status'] === 'string' && !SESSION_STATUSES.has(value['status'] as SharedSessionRecord['status'])) return `its status '${value['status']}' is not one this build knows`;
  }
  if (kind === 'message' && typeof value['role'] === 'string' && !MESSAGE_ROLES.has(value['role'] as SharedSessionMessage['role'])) return `its role '${value['role']}' is not one this build knows`;
  if (kind === 'input') {
    if (typeof value['intent'] === 'string' && !SHARED_SESSION_INPUT_INTENTS.includes(value['intent'] as SharedSessionInputRecord['intent'])) return `its intent '${value['intent']}' is not one this build knows`;
    if (typeof value['state'] === 'string' && !SHARED_SESSION_INPUT_STATES.includes(value['state'] as SharedSessionInputRecord['state'])) return `its state '${value['state']}' is not one this build knows`;
  }
  return 'a field is missing or has the wrong type';
}

function entryId(value: unknown, index: number): string {
  return isRecord(value) && typeof value['id'] === 'string' ? value['id'] : `#${index}`;
}

/** Read one stored message, or null and the reason when this build cannot. */
export function readStoredSessionMessage(value: unknown, index: number, setAside: SetAsideSessionEntry[]): SharedSessionMessage | null {
  try { return normalizeSessionMessage(value); } catch {
    setAside.push({ kind: 'message', id: entryId(value, index), reason: describeUnreadable('message', value) });
    return null;
  }
}

/** Read one stored input, or null and the reason when this build cannot. */
export function readStoredSessionInput(value: unknown, index: number, setAside: SetAsideSessionEntry[]): SharedSessionInputRecord | null {
  try { return normalizeSessionInput(value); } catch {
    setAside.push({ kind: 'input', id: entryId(value, index), reason: describeUnreadable('input', value) });
    return null;
  }
}

/** Read one stored session record against its messages and inputs, or null and the reason when this build cannot. */
export function readStoredSessionRecord(
  value: unknown,
  index: number,
  messages: readonly SharedSessionMessage[],
  inputs: readonly SharedSessionInputRecord[],
  setAside: SetAsideSessionEntry[],
): SharedSessionRecord | null {
  try { return normalizeSessionRecord(value, messages, inputs); } catch {
    setAside.push({ kind: 'session', id: entryId(value, index), reason: describeUnreadable('session', value) });
    return null;
  }
}

/** The session index the per-session store writes: records only, messages and inputs live in each session's log. */
export const SESSION_INDEX_VERSION = 2;

export function isSessionIndexDocument(value: unknown): value is { readonly version: number; readonly sessions: readonly unknown[]; readonly setAside?: readonly unknown[] } {
  return isRecord(value) && value['version'] === SESSION_INDEX_VERSION && Array.isArray(value['sessions']);
}

/**
 * Read a whole store, strictly: one entry this build cannot read refuses the
 * whole read. For callers that rewrite what they read (the legacy importer),
 * where carrying an unread entry forward is impossible and dropping it would
 * lose it. A per-session index reads as its records with no messages or
 * inputs, which stay in each session's log.
 */
export function loadSessionBrokerState(snapshot: SharedSessionStoreSnapshot | null | undefined): {
  readonly sessions: Map<string, SharedSessionRecord>;
  readonly messages: Map<string, SharedSessionMessage[]>;
  readonly inputs: Map<string, SharedSessionInputRecord[]>;
} {
  const read = readSessionBrokerSnapshot(isSessionIndexDocument(snapshot)
    ? { sessions: snapshot.sessions as SharedSessionRecord[], messages: [], inputs: [] }
    : snapshot);
  const first = read.setAside[0];
  if (first) {
    throw new Error(`Shared session store snapshot is invalid: ${first.kind} '${first.id}' cannot be read (${first.reason}). Repair or remove that entry in the sessions store file.`);
  }
  return read;
}

/**
 * Read a whole store, per entry: a session, message or input this build cannot
 * read is set aside (returned in `setAside` with its id and why, and in
 * `unreadable` verbatim so the writer can carry it forward untouched) while
 * every other entry loads.
 */
export function readSessionBrokerSnapshot(snapshot: SharedSessionStoreSnapshot | null | undefined): {
  readonly sessions: Map<string, SharedSessionRecord>;
  readonly messages: Map<string, SharedSessionMessage[]>;
  readonly inputs: Map<string, SharedSessionInputRecord[]>;
  readonly setAside: readonly SetAsideSessionEntry[];
  readonly unreadable: { readonly sessions: readonly unknown[]; readonly messages: readonly unknown[]; readonly inputs: readonly unknown[] };
} {
  if (snapshot) {
    if (!isRecord(snapshot) || !Array.isArray(snapshot.sessions) || !Array.isArray(snapshot.messages) || !Array.isArray(snapshot.inputs)) {
      throwInvalidSessionSnapshot();
    }
  }
  const setAside: SetAsideSessionEntry[] = [];
  const unreadable = { sessions: [] as unknown[], messages: [] as unknown[], inputs: [] as unknown[] };
  const sessions = new Map<string, SharedSessionRecord>();
  const messages = new Map<string, SharedSessionMessage[]>();
  const inputs = new Map<string, SharedSessionInputRecord[]>();
  for (const [index, message] of (snapshot?.messages ?? []).entries()) {
    const normalized = readStoredSessionMessage(message, index, setAside);
    if (!normalized) { unreadable.messages.push(message); continue; }
    const bucket = messages.get(normalized.sessionId) ?? [];
    bucket.push(normalized);
    messages.set(normalized.sessionId, bucket);
  }
  for (const [index, input] of (snapshot?.inputs ?? []).entries()) {
    const normalized = readStoredSessionInput(input, index, setAside);
    if (!normalized) { unreadable.inputs.push(input); continue; }
    const bucket = inputs.get(normalized.sessionId) ?? [];
    bucket.push(normalized);
    inputs.set(normalized.sessionId, bucket);
  }
  for (const [sessionId, bucket] of messages.entries()) {
    messages.set(sessionId, sortMessages(bucket));
  }
  for (const [sessionId, bucket] of inputs.entries()) {
    inputs.set(sessionId, sortInputs(bucket));
  }
  for (const [index, session] of (snapshot?.sessions ?? []).entries()) {
    const id = isRecord(session) && typeof session.id === 'string' ? session.id : undefined;
    const normalized = readStoredSessionRecord(session, index, messages.get(id ?? '') ?? [], inputs.get(id ?? '') ?? [], setAside);
    if (!normalized) { unreadable.sessions.push(session); continue; }
    sessions.set(normalized.id, normalized);
  }
  return { sessions, messages, inputs, setAside, unreadable };
}

/**
 * Build the durable snapshot with a PER-SESSION message cap.
 *
 * `maxPersistedMessagesPerSession` bounds each session's retained bodies
 * independently, NOT the flattened total. The old global slice-after-flatten
 * behaviour silently dropped whole sessions' transcripts (the oldest ones) once
 * the combined message count crossed the cap, while `messageCount` stayed
 * inflated. Capping per session keeps every session's most recent bodies and,
 * when a session IS truncated, stamps `retainedMessageCount` so the loss is
 * honest rather than silent (see {@link SharedSessionRecord.retainedMessageCount}).
 */
export function createSessionBrokerSnapshot(
  state: {
    readonly sessions: ReadonlyMap<string, SharedSessionRecord>;
    readonly messages: ReadonlyMap<string, readonly SharedSessionMessage[]>;
    readonly inputs: ReadonlyMap<string, readonly SharedSessionInputRecord[]>;
  },
  maxPersistedMessagesPerSession: number,
): SharedSessionStoreSnapshot {
  const cap = Math.max(1, maxPersistedMessagesPerSession);
  const cappedMessages: SharedSessionMessage[] = [];
  const retainedBySession = new Map<string, number>();
  for (const [sessionId, bucket] of state.messages.entries()) {
    const retained = sortMessages(bucket).slice(-cap);
    for (const message of retained) cappedMessages.push(message);
    retainedBySession.set(sessionId, retained.length);
  }
  const inputs = [...state.inputs.values()].flatMap((bucket) => bucket);
  const sessions = sortSessions(state.sessions.values()).map((session) => {
    const retained = retainedBySession.get(session.id) ?? 0;
    if (retained < session.messageCount) {
      return { ...session, retainedMessageCount: retained };
    }
    // Nothing pruned, drop any stale marker so the common case carries none.
    if (session.retainedMessageCount !== undefined) {
      const { retainedMessageCount: _drop, ...rest } = session;
      return rest;
    }
    return session;
  });
  return {
    sessions,
    messages: sortMessages(cappedMessages),
    inputs: sortInputs(inputs),
  };
}

export function upsertSessionParticipant(
  participants: readonly SharedSessionParticipant[],
  participant: SharedSessionParticipant,
): SharedSessionParticipant[] {
  const participantId = buildSessionParticipantId(participant);
  return [
    ...participants.filter((existing) => buildSessionParticipantId(existing) !== participantId),
    participant,
  ];
}

/** The error a boot reconcile stamps on a row it cancelled; a surface's later completion report may revive it. */
export const BOOT_RECONCILE_CANCEL_REASON = 'daemon restart, agent state unknown';

/** A delegated row whose host-process binding died with the previous process. */
export const BOOT_DELEGATED_CANCEL_REASON = 'daemon restart, the held external message can no longer be reviewed; ask the sender to send it again';

/**
 * Boot-time reconciliation of a freshly-loaded broker state (mutates in place):
 * cancels inputs stuck in `spawned`/`delivered` from a prior run (agent state is
 * unknown after a restart), cancels queued delegated rows (their source binding
 * is process-local, so nothing can ever complete them), and clears stale
 * `activeAgentId` on every session. Ordinary queued rows are kept: a surface
 * legitimately collects them after a restart.
 * Returns the set of session ids whose input buckets changed so the caller can
 * refresh their pending counts.
 */
export function reconcileSessionBrokerBoot(
  sessions: Map<string, SharedSessionRecord>,
  inputs: Map<string, SharedSessionInputRecord[]>,
): Set<string> {
  const changed = new Set<string>();
  for (const [sessionId, bucket] of inputs.entries()) {
    for (let i = 0; i < bucket.length; i++) {
      const entry = bucket[i]!;
      if (!sharedSessionInputLifecycle.can(entry.state, 'cancelled')) continue;
      if (entry.state === 'spawned' || entry.state === 'delivered') {
        bucket[i] = { ...entry, state: 'cancelled', updatedAt: Date.now(), error: BOOT_RECONCILE_CANCEL_REASON };
        changed.add(sessionId);
      } else if (entry.state === 'queued' && isDelegatedSessionInput(entry)) {
        bucket[i] = { ...entry, state: 'cancelled', updatedAt: Date.now(), error: BOOT_DELEGATED_CANCEL_REASON };
        changed.add(sessionId);
      }
    }
  }
  for (const [sessionId, session] of sessions.entries()) {
    if (session.activeAgentId) {
      sessions.set(sessionId, { ...session, activeAgentId: undefined, updatedAt: Date.now() });
    }
  }
  return changed;
}

export function countPendingSessionInputs(records: readonly SharedSessionInputRecord[]): number {
  return records.filter((entry) =>
    entry.state === 'queued' || entry.state === 'delivered' || entry.state === 'spawned'
  ).length;
}

function buildSessionParticipantId(participant: SharedSessionParticipant): string {
  return `${participant.surfaceKind}:${participant.surfaceId}:${participant.externalId ?? ''}:${participant.userId ?? ''}`;
}
