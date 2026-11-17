/**
 * The owner inbox as a terminal app (TUI, Agent, a headless run) holds it: the
 * home's one store (control-plane/question-store.ts), opened directly, and the
 * daemon's inbox over the `inbox.*` verbs when a daemon is reachable.
 *
 * The daemon keeps its items in the same store, so the two are one inbox, not
 * two copies: a question asked here with no daemon running is in the daemon's
 * list once it starts, and an answer given anywhere is read here on the next
 * look. While a daemon is reachable, lists and answers go through it, so its
 * approvals are listed, the owner's phone is pushed and the web UI updates; an
 * item only this store holds (asked while a daemon on another machine was out
 * of reach) is read and answered here.
 */
import {
  createOwnerInbox,
  isOwnerDecisionHandledHere,
  type OwnerAnswer,
  type OwnerAnswerDeliveryReport,
  type OwnerAnswerOutcome,
  type OwnerInbox,
  type OwnerInboxListFilter,
  type OwnerItem,
} from '../../control-plane/owner-inbox.js';
import { ownerInboxStorePath } from '../../control-plane/question-store.js';
import { terminalSessionPresence } from '../../control-plane/owner-session-presence.js';
import { ownerAnswerReader, useOwnerAnswerReader } from '../../agents/agent-inlets.js';
import type { OwnerInboxClient } from './owner-inbox-client.js';

type UserPaths = { resolveUserPath(...segments: string[]): string };

const homeInboxes = new Map<string, OwnerInbox>();

/**
 * The home's one inbox store, as this process reads it: one instance per
 * process, which is also where this process's sessions and agents read their
 * answers (agents/agent-inlets.ts). Opening the store waits for first use.
 */
export function homeOwnerInbox(shellPaths: UserPaths): OwnerInbox {
  const path = ownerInboxStorePath(shellPaths);
  let inbox = homeInboxes.get(path);
  if (!inbox) {
    inbox = createOwnerInbox({ questionsPath: path, presence: [terminalSessionPresence()] });
    homeInboxes.set(path, inbox);
  }
  if (!ownerAnswerReader()) useOwnerAnswerReader(inbox);
  return inbox;
}

/** The home store with the wire client's calls; an answer typed here is recorded from `surface` ("tui", "agent"). */
export function homeInboxClient(inbox: OwnerInbox, surface: string): OwnerInboxClient {
  const by = { actor: 'owner', surface };
  return {
    list: async (filter?: OwnerInboxListFilter) => inbox.listNow(filter),
    find: async (id: string) => inbox.get(id),
    answer: async (id: string, answer: OwnerAnswer) => await inbox.answer(id, answer, by),
    post: async (item) => inbox.postNow(item),
    withdraw: async (id: string, reason?: string) => inbox.withdraw(id, reason ?? 'no longer needed'),
    reportDelivery: async (id: string, report: OwnerAnswerDeliveryReport) => inbox.reportDelivery(id, report),
  };
}

function newestFirst(a: OwnerItem, b: OwnerItem): number {
  return (b.closedAt ?? b.createdAt) - (a.closedAt ?? a.createdAt) || a.id.localeCompare(b.id);
}

/**
 * One inbox over the daemon's and the home store. `daemonReachable` is the
 * terminal's own reading of its daemon connection (no request is sent to
 * learn it). A list shows each item once.
 */
export function routeOwnerInbox(options: {
  readonly daemon: OwnerInboxClient;
  readonly home: OwnerInboxClient;
  readonly daemonReachable: () => boolean;
}): OwnerInboxClient {
  const { daemon, home } = options;
  // The daemon first, so its pushes and live updates follow. Only an item the daemon does not know (asked here
  // while a daemon on another machine was out of reach, or a daemon that stopped answering) goes to the home
  // store; a refusal from a daemon that holds the item stands.
  const either = async (id: string, call: (inbox: OwnerInboxClient) => Promise<OwnerAnswerOutcome>): Promise<OwnerAnswerOutcome> => {
    if (!options.daemonReachable()) return await call(home);
    try {
      return await call(daemon);
    } catch (error) {
      const known = await daemon.find(id).catch(() => undefined);
      if (known === undefined && (await home.find(id)) !== undefined) return await call(home);
      throw error;
    }
  };
  return {
    async list(filter: OwnerInboxListFilter = {}) {
      if (!options.daemonReachable()) return await home.list(filter);
      let remote: readonly OwnerItem[];
      try {
        remote = await daemon.list(filter);
      } catch {
        // The daemon went away between the probe and the call; the store it keeps is read here.
        return await home.list(filter);
      }
      const seen = new Set(remote.map((item) => item.id));
      const onlyHere = (await home.list(filter)).filter((item) => !seen.has(item.id));
      if (onlyHere.length === 0) return remote;
      const merged = [...remote, ...onlyHere].sort(newestFirst);
      return filter.limit !== undefined && merged.length > filter.limit ? merged.slice(0, filter.limit) : merged;
    },
    async find(id: string) {
      if (!options.daemonReachable()) return await home.find(id);
      return (await daemon.find(id).catch(() => undefined)) ?? await home.find(id);
    },
    async answer(id: string, answer: OwnerAnswer) {
      // A decision this process's gate made is carried out here, where its session and rules are.
      const local = await home.find(id);
      if (local?.kind === 'decision' && isOwnerDecisionHandledHere(local.key)) return await home.answer(id, answer);
      return await either(id, (inbox) => inbox.answer(id, answer));
    },
    async post(item) {
      return await (options.daemonReachable() ? daemon : home).post(item);
    },
    withdraw: (id: string, reason?: string) => either(id, (inbox) => inbox.withdraw(id, reason)),
    reportDelivery: (id: string, report: OwnerAnswerDeliveryReport) => either(id, (inbox) => inbox.reportDelivery(id, report)),
  };
}
