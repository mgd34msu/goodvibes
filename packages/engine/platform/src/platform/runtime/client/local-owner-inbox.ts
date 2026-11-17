/**
 * The owner inbox of a terminal app with no daemon to reach, and the one inbox
 * a terminal uses whether a daemon is there or not.
 *
 * With no daemon, the terminal keeps the same inbox (control-plane/owner-inbox.ts)
 * in its own file: the `query` tool asks there, `/questions` answers there, and
 * an answer goes back to the asking session by the same rule as the daemon's:
 * at once when that session is the one open here, otherwise when it is next
 * opened, and not at all (said so) when it was deleted. The file is created by
 * the first question and never read before it exists.
 *
 * {@link routeOwnerInbox} puts the two together: questions go to the daemon
 * when one is reachable and to the local inbox otherwise; a list shows both; an
 * answer, withdrawal or delivery report goes to whichever holds the item.
 */
import { existsSync } from 'node:fs';
import { refusal } from '@goodvibes-jev/engine/errors';
import {
  createOwnerInbox,
  type OwnerAnswer,
  type OwnerAnswerDeliveryReport,
  type OwnerAnswerOutcome,
  type OwnerInbox,
  type OwnerInboxListFilter,
  type OwnerInboxListener,
  type OwnerItem,
  type OwnerSessionPresenceProbe,
} from '../../control-plane/owner-inbox.js';
import type { OwnerInboxClient } from './owner-inbox-client.js';

/** The local inbox: the wire client's calls, plus what the router and the update watch need. */
export interface LocalOwnerInbox extends OwnerInboxClient {
  /** True when this inbox holds the item (never opens a file that does not exist). */
  holds(id: string): boolean;
  /** True once the inbox file exists, i.e. a question was ever asked here. */
  inUse(): boolean;
  /** Changes to its items, in process. Does not open the file. */
  subscribe(listener: OwnerInboxListener): () => void;
}

export interface LocalOwnerInboxOptions {
  /** The inbox file, under the terminal app's own user directory. */
  readonly questionsPath: string;
  /** Whether a session is the one open in this terminal, saved, or deleted. */
  readonly sessionPresence: OwnerSessionPresenceProbe;
  /** The surface an answer typed here is recorded from ("tui", "agent"). */
  readonly surface: string;
}

interface LocalInstance {
  readonly inbox: LocalOwnerInbox;
  usePresence(probe: OwnerSessionPresenceProbe): void;
}

const instances = new Map<string, LocalInstance>();

function notHeld(id: string): OwnerAnswerOutcome {
  return {
    applied: false,
    refusal: refusal({
      code: 'NOT_FOUND',
      state: 'not in the inbox',
      reason: `No inbox item has the id ${id}.`,
      next: ['List the inbox again and answer an id it shows.'],
      status: 404,
    }),
  };
}

function createLocalInstance(options: LocalOwnerInboxOptions): LocalInstance {
  let presence = options.sessionPresence;
  let owner: OwnerInbox | null = null;
  const listeners = new Set<OwnerInboxListener>();
  const open = (): OwnerInbox => {
    if (owner) return owner;
    const created = createOwnerInbox({ questionsPath: options.questionsPath, sessionPresence: (id) => presence(id) });
    created.subscribe((item) => { for (const listener of [...listeners]) listener(item); });
    owner = created;
    return created;
  };
  // Reads never create the file: with no question ever asked here there is nothing to read.
  const opened = (): OwnerInbox | null => owner ?? (existsSync(options.questionsPath) ? open() : null);
  const by = { actor: 'owner', surface: options.surface };
  const inbox: LocalOwnerInbox = {
    holds: (id) => opened()?.get(id) !== undefined,
    inUse: () => opened() !== null,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async list(filter: OwnerInboxListFilter = {}) {
      return opened()?.listNow(filter) ?? [];
    },
    async find(id: string) {
      return opened()?.get(id);
    },
    async answer(id: string, answer: OwnerAnswer) {
      const held = opened();
      return held ? await held.answer(id, answer, by) : notHeld(id);
    },
    async post(item) {
      return open().postNow(item);
    },
    async withdraw(id: string, reason?: string) {
      const held = opened();
      return held ? held.withdraw(id, reason ?? 'no longer needed') : notHeld(id);
    },
    async reportDelivery(id: string, report: OwnerAnswerDeliveryReport) {
      const held = opened();
      return held ? held.reportDelivery(id, report) : notHeld(id);
    },
  };
  return { inbox, usePresence: (probe) => { presence = probe; } };
}

/**
 * The local inbox over `questionsPath`. One instance per file per process, so
 * the query tool and `/questions` read the same items; the latest presence
 * probe given is the one used.
 */
export function localOwnerInbox(options: LocalOwnerInboxOptions): LocalOwnerInbox {
  const existing = instances.get(options.questionsPath);
  if (existing) {
    existing.usePresence(options.sessionPresence);
    return existing.inbox;
  }
  const created = createLocalInstance(options);
  instances.set(options.questionsPath, created);
  return created.inbox;
}

function newestFirst(a: OwnerItem, b: OwnerItem): number {
  return (b.closedAt ?? b.createdAt) - (a.closedAt ?? a.createdAt) || a.id.localeCompare(b.id);
}

/**
 * One inbox over the daemon's and the local one. `daemonReachable` is the
 * terminal's own reading of its daemon connection (no request is sent to learn it).
 */
export function routeOwnerInbox(options: {
  readonly daemon: OwnerInboxClient;
  readonly local: LocalOwnerInbox;
  readonly daemonReachable: () => boolean;
}): OwnerInboxClient {
  const { daemon, local } = options;
  const holder = (id: string): OwnerInboxClient => (local.holds(id) || !options.daemonReachable() ? local : daemon);
  return {
    async list(filter: OwnerInboxListFilter = {}) {
      if (!options.daemonReachable()) return await local.list(filter);
      const remote = await daemon.list(filter);
      if (!local.inUse()) return remote;
      const merged = [...remote, ...await local.list(filter)].sort(newestFirst);
      return filter.limit !== undefined && merged.length > filter.limit ? merged.slice(0, filter.limit) : merged;
    },
    async find(id: string) {
      return await holder(id).find(id);
    },
    async answer(id: string, answer: OwnerAnswer) {
      return await holder(id).answer(id, answer);
    },
    async post(item) {
      return await (options.daemonReachable() ? daemon : local).post(item);
    },
    async withdraw(id: string, reason?: string) {
      return await holder(id).withdraw(id, reason);
    },
    async reportDelivery(id: string, report: OwnerAnswerDeliveryReport) {
      return await holder(id).reportDelivery(id, report);
    },
  };
}
