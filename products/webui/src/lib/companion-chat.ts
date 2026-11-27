import { asRecord, bestId, firstString, readPath } from './object';
import { accountKey } from './account-storage';

// Kept for the person signed in (account-storage.ts): another person's chats are never read here.
export const STORED_COMPANION_SESSIONS_KEY = 'goodvibes.webui.companionSessions' as const;
export const STORED_ACTIVE_COMPANION_SESSION_KEY = 'goodvibes.webui.activeCompanionSessionId' as const;
const MAX_STORED_COMPANION_SESSIONS = 100;

export interface LocalCompanionMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  deliveryState?: 'sent' | 'failed' | 'local' | 'cancelled' | 'queued' | 'unanswered';
  attachments?: readonly {
    artifactId: string;
    label?: string;
    filename?: string;
    mimeType?: string;
    sizeBytes?: number;
  }[];
}

export interface LocalCompanionSession {
  id: string;
  sessionId: string;
  kind: 'companion-chat';
  title: string;
  status: 'active';
  createdAt: number;
  updatedAt: number;
}

export function extractSessionId(value: unknown): string {
  const direct = firstString(value, ['sessionId', 'id']);
  if (direct) return direct;
  return firstString(readPath(value, ['session']), ['sessionId', 'id'])
    || firstString(readPath(value, ['data']), ['sessionId', 'id'])
    || bestId(value);
}

export function extractMessageId(value: unknown): string {
  return firstString(value, ['messageId', 'id'])
    || firstString(readPath(value, ['message']), ['messageId', 'id'])
    || bestId(value);
}

export function companionSessionFromDetail(value: unknown): unknown {
  const session = readPath(value, ['session']);
  return Object.keys(asRecord(session)).length ? session : value;
}

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function companionSessionsFromListResponse(value: unknown): unknown[] {
  const candidates = [
    value,
    readPath(value, ['sessions']),
    readPath(value, ['items']),
    readPath(value, ['data']),
    readPath(value, ['result']),
    readPath(value, ['result', 'sessions']),
    readPath(value, ['result', 'items']),
    readPath(value, ['result', 'data']),
    readPath(value, ['sessions', 'items']),
    readPath(value, ['sessions', 'data']),
    readPath(value, ['data', 'sessions']),
    readPath(value, ['data', 'items']),
    readPath(value, ['data', 'data']),
    readPath(value, ['payload', 'sessions']),
    readPath(value, ['payload', 'items']),
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.map(companionSessionFromDetail);
  }
  return [];
}

export function companionMessagesFromListResponse(value: unknown): unknown[] {
  const candidates = [
    value,
    readPath(value, ['messages']),
    readPath(value, ['items']),
    readPath(value, ['data']),
    readPath(value, ['result']),
    readPath(value, ['result', 'messages']),
    readPath(value, ['result', 'items']),
    readPath(value, ['result', 'data']),
    readPath(value, ['messages', 'items']),
    readPath(value, ['messages', 'data']),
    readPath(value, ['data', 'messages']),
    readPath(value, ['data', 'items']),
    readPath(value, ['data', 'data']),
    readPath(value, ['payload', 'messages']),
    readPath(value, ['payload', 'items']),
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

export function mergeCompanionSessions(
  localSessions: unknown[],
  fetchedSessions: unknown[],
): unknown[] {
  const byId = new Map<string, unknown>();
  for (const session of localSessions) {
    const id = extractSessionId(session);
    if (id) byId.set(id, session);
  }
  for (const session of fetchedSessions) {
    const id = extractSessionId(session);
    if (id) byId.set(id, session);
  }

  return [...byId.values()].sort((left, right) => {
    const leftUpdated = Number(asRecord(left).updatedAt ?? asRecord(left).createdAt ?? 0);
    const rightUpdated = Number(asRecord(right).updatedAt ?? asRecord(right).createdAt ?? 0);
    return rightUpdated - leftUpdated;
  });
}

export function readStoredCompanionSessions(): unknown[] {
  const storage = browserStorage();
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(accountKey(STORED_COMPANION_SESSIONS_KEY)) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeStoredCompanionSessions(sessions: unknown[]) {
  const storage = browserStorage();
  if (!storage) return;
  const persisted = mergeCompanionSessions([], sessions)
    .filter((session) => Boolean(extractSessionId(session)))
    .slice(0, MAX_STORED_COMPANION_SESSIONS);
  try {
    storage.setItem(accountKey(STORED_COMPANION_SESSIONS_KEY), JSON.stringify(persisted));
  } catch {
    // Best-effort cache only; daemon session storage remains the source of truth.
  }
}

export function readStoredActiveCompanionSessionId(): string {
  return browserStorage()?.getItem(accountKey(STORED_ACTIVE_COMPANION_SESSION_KEY)) ?? '';
}

export function writeStoredActiveCompanionSessionId(sessionId: string) {
  const storage = browserStorage();
  if (!storage) return;
  try {
    if (sessionId) storage.setItem(accountKey(STORED_ACTIVE_COMPANION_SESSION_KEY), sessionId);
    else storage.removeItem(accountKey(STORED_ACTIVE_COMPANION_SESSION_KEY));
  } catch {
    // Best-effort cache only; the current React state still owns the active view.
  }
}

/**
 * The daemon's messages, plus each local message the daemon does not list yet.
 * A local message is the daemon's message only by identity: the server id it
 * was accepted under, or the `clientMessageId` it was posted with, which the
 * daemon echoes on that message. Text is never compared: two sends of the
 * same words are two messages, and a pending or failed send stays visible.
 */
export function mergeCompanionMessages(
  fetchedMessages: unknown[],
  localMessages: LocalCompanionMessage[],
  sessionId: string,
): unknown[] {
  const rendered = [...fetchedMessages];
  const fetchedIds = new Set(fetchedMessages.map(extractMessageId).filter(Boolean));
  const fetchedClientIds = new Set(fetchedMessages.map((message) => firstString(message, ['clientMessageId'])).filter(Boolean));
  for (const message of localMessages) {
    if (message.sessionId !== sessionId) continue;
    if (fetchedIds.has(message.id) || fetchedClientIds.has(message.id)) continue;
    rendered.push(message);
  }
  return rendered;
}
