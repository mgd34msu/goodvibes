/**
 * The owner inbox this terminal uses, for `/questions`, the `query` tool of its
 * conversation and the agents it spawns: the home's one store, which the
 * daemon, the Agent and every other terminal open too, reached through the
 * daemon while one is reachable (so its approvals are listed and the owner's
 * phone is pushed) and directly otherwise. A question is recorded as asked by
 * the live session; the owner's answer, given anywhere (here, the Agent, the
 * web UI, the phone), reaches the spawned agent that asked it on its next model
 * request while that agent runs, otherwise the session's conversation: on its
 * next model request while the session is open here, otherwise when it is next
 * opened (any resume path, headless included). Deleting the session withdraws
 * its open questions and marks its waiting answers not deliverable.
 */
import {
  createOwnerInboxClient,
  homeInboxClient,
  homeOwnerInbox,
  routeOwnerInbox,
  watchOwnerInboxUpdates,
  withAnswerDelivery,
  type AnswerDeliveringInbox,
  type OwnerInboxClient,
} from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { OWNER_ASKER_SESSION_FILE_METADATA } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { watchSessionAnswers, type SessionAnswerWatch } from '@goodvibes-jev/engine/platform/platform/agents';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { whenSessionOpens } from '@goodvibes-jev/engine/terminal-shell/session-resume';
import type { RuntimeServices } from '../services.ts';
import { findSessionConversation, onSessionConversationChange } from '../conversation-rewind-port.ts';
import { createDaemonVerbCaller, resolveDaemonEndpoint } from './operator-endpoint.ts';

/** The inbox `/questions` reads and answers: the daemon's when reachable, the home store directly otherwise. */
export function terminalOwnerInbox(deps: {
  readonly configManager: ConfigManager;
  readonly homeDirectory: () => string;
  readonly shellPaths: { resolveUserPath(...segments: string[]): string };
}): OwnerInboxClient {
  const verbs = createDaemonVerbCaller({ configManager: deps.configManager, homeDirectory: deps.homeDirectory });
  return routeOwnerInbox({
    daemon: createOwnerInboxClient(verbs),
    home: homeInboxClient(homeOwnerInbox(deps.shellPaths), 'tui'),
    daemonReachable: () => verbs.probe().available,
  });
}

const instances = new WeakMap<RuntimeServices, AnswerDeliveringInbox>();
const sessionWatches = new WeakMap<RuntimeServices, SessionAnswerWatch>();

/** The runtime's question inbox; `sessionId` is the live session, the owner of a spawned agent's questions too. */
export function terminalOwnerQuestions(services: RuntimeServices, sessionId: () => string | undefined): AnswerDeliveringInbox {
  const existing = instances.get(services);
  if (existing) return existing;
  const homeDirectory = (): string => services.shellPaths.homeDirectory;
  const verbs = createDaemonVerbCaller({ configManager: services.configManager, homeDirectory });
  const daemon = createOwnerInboxClient(verbs);
  const home = homeOwnerInbox(services.shellPaths);
  const daemonReachable = (): boolean => verbs.probe().available;
  const inbox = withAnswerDelivery(
    routeOwnerInbox({ daemon, home: homeInboxClient(home, 'tui'), daemonReachable }),
    {
      home,
      sessionWatch: () => sessionWatches.get(services),
      // What any process reads to tell a closed session (its saved file is there) from a deleted one.
      askerFacts: (id) => ({ [OWNER_ASKER_SESSION_FILE_METADATA]: services.sessionManager.filePathFor(id) }),
      daemonReachable,
      daemon,
      // Only for a question a daemon on another machine holds: its update stream while one is open.
      watch: async (onItem, onEnd) => {
        const endpoint = resolveDaemonEndpoint({ configManager: services.configManager, homeDirectory });
        if (!endpoint.available) return null;
        const token = endpoint.token;
        return await watchOwnerInboxUpdates({ baseUrl: endpoint.baseUrl, getAuthToken: () => token, onItem, onTerminate: onEnd });
      },
      hostFor: (id) => (id ? findSessionConversation(id)?.hostInstructions : undefined),
      sessionId,
    },
  );
  instances.set(services, inbox);
  return inbox;
}

/**
 * Take the owner's answers into `conversation` before each model request, hand
 * a session what waited for it when it is opened, and settle its questions when
 * it is deleted. Called once at bootstrap; returns the function that undoes it.
 */
export function wireOwnerQuestionSessions(
  services: RuntimeServices,
  conversation: Parameters<typeof watchSessionAnswers>[0],
  sessionId: () => string | undefined,
): () => void {
  // This process's sessions and agents read their answers from the home store (opened on first use).
  homeOwnerInbox(services.shellPaths);
  const watch = watchSessionAnswers(conversation, sessionId);
  sessionWatches.set(services, watch);
  // A new or forked session takes the conversation's place: the mark that the old one is running goes at once.
  const stopFollowing = onSessionConversationChange(() => watch.refresh());
  const inbox = (): AnswerDeliveringInbox => terminalOwnerQuestions(services, sessionId);
  const stopOpened = whenSessionOpens(conversation, (id) => inbox().openSession(id));
  const stopDeleted = services.sessionManager.onDeleted((id) => { void inbox().deleteSession(id); });
  return () => {
    stopOpened();
    stopDeleted();
    stopFollowing();
    watch.dispose();
    if (sessionWatches.get(services) === watch) sessionWatches.delete(services);
  };
}
