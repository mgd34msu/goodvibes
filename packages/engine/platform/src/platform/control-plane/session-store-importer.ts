/**
 * session-store-importer.ts
 *
 * Boot-time migration that folds every pre-existing session store into the ONE
 * home-scoped durable broker store. Each session is folded ONCE: its id goes
 * into a small ledger beside the store, and a session already in the store or
 * in the ledger is never taken from a source again. So a session deleted from
 * the store stays deleted although a source (a terminal's local store, the
 * companion directory) still holds it, and a boot with nothing new to fold
 * writes nothing. The store itself is never its own source.
 *
 * Sources folded in (the one-broker session-spine effort, see CHANGELOG 1.0.0):
 *  1. Companion chat files, ~/.goodvibes/companion-chat/sessions/*.json
 *     (home-scoped, projectless → project 'unknown'); INCLUDING closed sessions.
 *  2. Per-project broker stores, <root>/.goodvibes/<surface>/control-plane/
 *     sessions.json (the old project-scoped store path), read with the broker
 *     store's own loader: the session index plus each session's log, or the
 *     older whole-store snapshot; stamped project = <root>.
 *  3. The stale agent-fork store, same broker-store shape under its surface.
 *
 * No session is dropped (closed included); deletion remains the GC's job. Corrupt
 * or partial files are logged and skipped per-file, the run never aborts.
 *
 * The sources are not retired here: the project stores are still the local
 * session stores of the terminal apps, and the companion directory is the
 * companion chat's own persistence.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PersistentStore } from '../state/persistent-store.js';
import { CompanionChatPersistence } from '../companion/companion-chat-persistence.js';
import { defaultSessionsDir } from '../companion/companion-chat-persistence.js';
import { sortInputs, sortMessages } from './session-broker-state.js';
import { SessionBrokerFileStorage, type SessionBrokerLoadResult, type SessionBrokerStateView } from './session-broker-store.js';
import type {
  SharedSessionMessage,
  SharedSessionRecord,
} from './session-types.js';
import type { SharedSessionInputRecord } from './session-intents.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** A legacy store to fold into the home store. */
export interface LegacySessionSource {
  /** 'broker-store' = a broker session store (index and per-session logs, or a whole-store snapshot); 'companion-dir' = a dir of PersistedChatSession files. */
  readonly kind: 'broker-store' | 'companion-dir';
  /** File path (broker-store) or directory path (companion-dir). */
  readonly path: string;
  /** Project to stamp on records that carry no explicit project. Companion sources default to 'unknown'. */
  readonly project?: string | undefined;
}

export interface ImportLegacySessionsResult {
  /** Total sessions in the home store after the import. */
  readonly total: number;
  /** Sessions newly added by this run (0 on an idempotent re-run). */
  readonly imported: number;
  /** Sources that did not exist on disk (skipped, not an error). */
  readonly missingSources: readonly string[];
  /** Files that failed to parse and were skipped (set aside or left in place, never deleted). */
  readonly skippedFiles: readonly string[];
}

interface MergeState {
  readonly sessions: Map<string, SharedSessionRecord>;
  readonly messages: Map<string, SharedSessionMessage>;
  readonly inputs: Map<string, SharedSessionInputRecord>;
  /** Session ids folded by any earlier run (and by this one, as it goes). */
  readonly folded: Set<string>;
  /** Session ids this run added. */
  readonly added: Set<string>;
}

/** The ids already folded, beside the store: `<store>.folded.json`. */
type FoldedSessionLedger = {
  readonly version: 1;
  readonly sessionIds: readonly string[];
};

function foldedLedgerPath(homeStorePath: string): string {
  return `${homeStorePath.replace(/\.json$/, '')}.folded.json`;
}

/** Raised when the home store exists but cannot be read, so it is never overwritten. */
export class HomeSessionStoreUnreadableError extends Error {
  constructor(readonly storePath: string, cause: unknown) {
    super(
      `The home session store ${storePath} could not be read (${summarizeError(cause)}). `
      + 'It was left untouched and no legacy session was folded into it. '
      + 'Repair or move that file aside, then start again.',
      { cause },
    );
    this.name = 'HomeSessionStoreUnreadableError';
  }
}

/**
 * Discover the legacy stores reachable from a single project root plus the
 * home-scoped companion directory. Scans <projectRoot>/.goodvibes/<surface>/
 * control-plane/sessions.json across every surface subdir (tui, goodvibes,
 * agent, …). The home store itself is never returned as a source.
 */
export function discoverLegacySessionSources(input: {
  readonly projectRoot: string;
  readonly companionSessionsDir?: string | undefined;
}): LegacySessionSource[] {
  const sources: LegacySessionSource[] = [];
  const companionDir = input.companionSessionsDir ?? defaultSessionsDir();
  sources.push({ kind: 'companion-dir', path: companionDir, project: 'unknown' });

  const goodvibesRoot = join(input.projectRoot, '.goodvibes');
  let surfaceDirs: string[] = [];
  try {
    surfaceDirs = existsSync(goodvibesRoot)
      ? readdirSync(goodvibesRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : [];
  } catch (error) {
    logger.warn('[session-import] failed to scan project .goodvibes root', {
      root: goodvibesRoot,
      error: summarizeError(error),
    });
  }
  for (const surface of surfaceDirs) {
    const storePath = join(goodvibesRoot, surface, 'control-plane', 'sessions.json');
    if (existsSync(storePath)) {
      sources.push({ kind: 'broker-store', path: storePath, project: input.projectRoot });
    }
  }
  return sources;
}

/**
 * Fold every source into the home store at `homeStorePath`, once per session.
 * A source session is added when the store does not hold it and no earlier run
 * folded it (the ledger); its messages and inputs come with it. The home store
 * is read and written through the broker's own storage (the session index plus
 * one log per session): an added session is one new log and one index write,
 * the sessions already there are not rewritten, their counts stay what their
 * logs state, and entries the index set aside are carried forward. A store in
 * the older whole-store shape is moved to that layout by the same read, as the
 * broker would move it. Nothing is written when nothing was added, and the
 * ledger only when it gained an id. The first run after the ledger existed
 * folds as before, so nothing a source holds is lost; from then on a session
 * deleted from the store stays deleted.
 *
 * @throws HomeSessionStoreUnreadableError when the home store cannot be read.
 *         Nothing is folded then, and callers that retire a source after a
 *         successful fold must see that the fold did not happen.
 */
export async function importLegacySessionStores(input: {
  readonly homeStorePath: string;
  readonly sources: readonly LegacySessionSource[];
}): Promise<ImportLegacySessionsResult> {
  const homeStore = new SessionBrokerFileStorage(input.homeStorePath);
  try {
    return await foldIntoHomeStore(homeStore, input);
  } finally {
    homeStore.close();
  }
}

async function foldIntoHomeStore(
  homeStore: SessionBrokerFileStorage,
  input: { readonly homeStorePath: string; readonly sources: readonly LegacySessionSource[] },
): Promise<ImportLegacySessionsResult> {
  const existing = await loadHomeStore(homeStore, input.homeStorePath);
  const ledgerPath = foldedLedgerPath(input.homeStorePath);
  const ledgerStore = new PersistentStore<FoldedSessionLedger>(ledgerPath);
  const ledger = await loadFoldedLedger(ledgerStore, ledgerPath);
  // Only added sessions bring messages and inputs; those of sessions already in the store stay in their logs.
  const state: MergeState = {
    sessions: new Map(existing.sessions),
    messages: new Map(),
    inputs: new Map(),
    folded: new Set(ledger?.sessionIds ?? []),
    added: new Set(),
  };

  const missingSources: string[] = [];
  const skippedFiles: string[] = [];
  const live = resolve(input.homeStorePath);

  for (const source of input.sources) {
    if (source.kind === 'broker-store' && resolve(source.path) === live) continue;
    if (!existsSync(source.path)) {
      missingSources.push(source.path);
      continue;
    }
    if (source.kind === 'companion-dir') {
      await mergeCompanionDir(state, source, skippedFiles);
    } else {
      await mergeBrokerStore(state, source, skippedFiles);
    }
  }

  // Only a change is written: a boot with nothing new leaves the store alone.
  if (state.added.size > 0) await homeStore.write(addedSessionsView(state), new Set(state.added), true);
  if (ledger === null || state.folded.size !== ledger.sessionIds.length) {
    await ledgerStore.persist({ version: 1, sessionIds: [...state.folded].sort() });
  }
  return {
    total: state.sessions.size,
    imported: state.added.size,
    missingSources,
    skippedFiles,
  };
}

/**
 * The folded-session ledger, or null when there is none yet. An unreadable
 * ledger is reported like an unreadable store: guessing it empty would bring
 * every deleted session back.
 */
async function loadFoldedLedger(store: PersistentStore<FoldedSessionLedger>, path: string): Promise<FoldedSessionLedger | null> {
  let loaded: FoldedSessionLedger | null;
  try {
    loaded = await store.load();
  } catch (error) {
    throw new HomeSessionStoreUnreadableError(path, error);
  }
  if (loaded === null) return null;
  if (loaded.version !== 1 || !Array.isArray(loaded.sessionIds) || loaded.sessionIds.some((id) => typeof id !== 'string')) {
    throw new HomeSessionStoreUnreadableError(path, new Error('the folded-session ledger has an unrecognized shape'));
  }
  return loaded;
}

async function loadHomeStore(store: SessionBrokerFileStorage, storePath: string): Promise<SessionBrokerLoadResult> {
  try {
    return await store.load();
  } catch (error) {
    logger.warn('[session-import] home store failed to load; leaving it untouched', {
      path: storePath,
      error: summarizeError(error),
    });
    throw new HomeSessionStoreUnreadableError(storePath, error);
  }
}

async function mergeBrokerStore(
  state: MergeState,
  source: LegacySessionSource,
  skippedFiles: string[],
): Promise<void> {
  // Read with the broker store's own loader, the one that wrote it: a project
  // store is a session index plus one log per session, and a reader of the
  // index alone would see every session with no messages and no inputs.
  const storage = new SessionBrokerFileStorage(source.path);
  let loaded: SessionBrokerLoadResult;
  try {
    loaded = await storage.load();
  } catch (error) {
    storage.close();
    logger.warn('[session-import] broker store failed to load; skipping', {
      path: source.path,
      error: summarizeError(error),
    });
    skippedFiles.push(source.path);
    return;
  }
  try {
    for (const record of loaded.sessions.values()) {
      const stamped = record.project === 'unknown' && source.project
        ? { ...record, project: source.project }
        : record;
      // Only a session this run adds needs its history; any other is only recorded as folded.
      const adding = state.added.has(stamped.id) || (!state.folded.has(stamped.id) && !state.sessions.has(stamped.id));
      if (!adding) {
        foldSession(state, stamped);
        continue;
      }
      let messages: readonly SharedSessionMessage[] = loaded.messages.get(stamped.id) ?? [];
      let inputs: readonly SharedSessionInputRecord[] = loaded.inputs.get(stamped.id) ?? [];
      if (loaded.deferred.has(stamped.id)) {
        try {
          ({ messages, inputs } = storage.loadSession(stamped.id));
        } catch (error) {
          // Not folded: the session is taken, with its history, on a later start.
          logger.warn('[session-import] a session log failed to load; the session is left for the next start', {
            path: source.path,
            sessionId: stamped.id,
            error: summarizeError(error),
          });
          skippedFiles.push(`${source.path} (session ${stamped.id})`);
          continue;
        }
      }
      // Folded only now that its messages and inputs are in hand.
      if (!foldSession(state, stamped)) continue;
      for (const message of messages) if (!state.messages.has(message.id)) state.messages.set(message.id, message);
      for (const inputRecord of inputs) if (!state.inputs.has(inputRecord.id)) state.inputs.set(inputRecord.id, inputRecord);
    }
  } finally {
    storage.close();
  }
}

async function mergeCompanionDir(
  state: MergeState,
  source: LegacySessionSource,
  skippedFiles: string[],
): Promise<void> {
  const persistence = new CompanionChatPersistence(source.path);
  // Only a chat this run may add needs its transcript; any other is only recorded as folded.
  const stored = await persistence.loadAll({
    transcriptFor: (meta) => state.added.has(meta.id) || (!state.folded.has(meta.id) && !state.sessions.has(meta.id)),
  });
  for (const { meta, messages } of stored) {
    const converted = companionMessagesToShared(meta.id, messages);
    if (!foldSession(state, companionSessionToShared(meta, converted, source.project ?? 'unknown'))) continue;
    for (const message of converted) if (!state.messages.has(message.id)) state.messages.set(message.id, message);
  }
  // loadAll sets aside or skips files it cannot use; name them so the result
  // does not under-report.
  for (const rejected of persistence.rejectedOnLoad()) skippedFiles.push(join(source.path, rejected.file));
}

/**
 * Take a source session when it was never folded before and the store does
 * not hold it. Within one run two sources may both hold a new session; the
 * newer copy wins and participants are unioned. Returns true when the session
 * is one this run is adding.
 */
function foldSession(state: MergeState, incoming: SharedSessionRecord): boolean {
  if (state.added.has(incoming.id)) {
    const current = state.sessions.get(incoming.id)!;
    if (incoming.updatedAt >= current.updatedAt) {
      state.sessions.set(incoming.id, { ...incoming, participants: mergeParticipants(current, incoming) });
    }
    return true;
  }
  if (state.folded.has(incoming.id)) return false;
  // Recorded either way, so a later delete of this session sticks.
  state.folded.add(incoming.id);
  if (state.sessions.has(incoming.id)) return false;
  state.sessions.set(incoming.id, incoming);
  state.added.add(incoming.id);
  return true;
}

function mergeParticipants(
  current: SharedSessionRecord,
  incoming: SharedSessionRecord,
): SharedSessionRecord['participants'] {
  const byId = new Map<string, SharedSessionRecord['participants'][number]>();
  for (const p of current.participants) byId.set(`${p.surfaceKind}:${p.surfaceId}:${p.userId ?? ''}`, p);
  for (const p of incoming.participants) byId.set(`${p.surfaceKind}:${p.surfaceId}:${p.userId ?? ''}`, p);
  return [...byId.values()];
}

function companionSessionToShared(
  meta: {
    readonly id: string;
    readonly title: string;
    readonly status: 'active' | 'closed';
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly closedAt: number | null;
  },
  messages: readonly SharedSessionMessage[],
  project: string,
): SharedSessionRecord {
  const lastMessageAt = messages.reduce<number | undefined>(
    (latest, m) => (latest === undefined || m.createdAt > latest ? m.createdAt : latest),
    undefined,
  );
  return {
    id: meta.id,
    kind: 'companion-chat',
    project,
    title: meta.title.trim().length > 0 ? meta.title : `Session ${meta.id}`,
    status: meta.status,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
    ...(meta.closedAt != null ? { closedAt: meta.closedAt } : {}),
    lastActivityAt: meta.updatedAt,
    messageCount: messages.length,
    pendingInputCount: 0,
    routeIds: [],
    surfaceKinds: ['companion'],
    participants: [{ surfaceKind: 'companion', surfaceId: meta.id, lastSeenAt: meta.updatedAt }],
    metadata: {},
  };
}

function companionMessagesToShared(
  sessionId: string,
  messages: readonly { readonly id: string; readonly role: 'user' | 'assistant'; readonly content: string; readonly createdAt: number }[],
): SharedSessionMessage[] {
  return messages.map((message) => ({
    id: message.id,
    sessionId,
    role: message.role,
    body: message.content,
    createdAt: message.createdAt,
    surfaceKind: 'companion',
    surfaceId: sessionId,
    metadata: {},
  }));
}

/**
 * What the home store's writer is handed: every session the index lists (it
 * rewrites the index whole), and the messages and inputs of the added ones,
 * which become each one's new log.
 */
function addedSessionsView(state: MergeState): SessionBrokerStateView {
  const sessions = new Map(state.sessions);
  const grouped = <T extends { readonly sessionId: string }>(records: Iterable<T>): Map<string, T[]> => {
    const bySession = new Map<string, T[]>();
    for (const record of records) {
      if (!state.added.has(record.sessionId)) continue;
      const bucket = bySession.get(record.sessionId);
      if (bucket) bucket.push(record); else bySession.set(record.sessionId, [record]);
    }
    return bySession;
  };
  const messages = new Map<string, readonly SharedSessionMessage[]>(
    [...grouped(state.messages.values())].map(([id, bucket]) => [id, sortMessages(bucket)]),
  );
  const inputs = new Map<string, readonly SharedSessionInputRecord[]>(
    [...grouped(state.inputs.values())].map(([id, bucket]) => [id, sortInputs(bucket)]),
  );
  // The winning record's own count can be lower than the bodies unioned from
  // other sources; the count must never claim fewer messages than are stored.
  for (const id of state.added) {
    const record = sessions.get(id);
    const stored = messages.get(id)?.length ?? 0;
    if (record && stored > record.messageCount) sessions.set(id, { ...record, messageCount: stored });
  }
  return {
    sessions,
    messages,
    inputs,
    peekMessages: (sessionId) => messages.get(sessionId),
    peekInputs: (sessionId) => inputs.get(sessionId),
  };
}
