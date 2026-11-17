/**
 * The owner inbox this terminal uses, for `/questions`, the `query` tool of its
 * conversation and the agents it spawns: the daemon's when one is reachable, the
 * terminal's own (a file under its user directory) when there is none. A
 * question is recorded as asked by the live session; the owner's answer, given
 * anywhere (here, the web UI, the phone), reaches the spawned agent that asked
 * it on its next model request while that agent runs, otherwise the session's
 * conversation: at once while the session is open here, otherwise when it is
 * next opened (any resume path, headless included). Deleting the session
 * withdraws its open questions and marks its waiting answers not deliverable.
 * One question inbox per runtime, so the main conversation and its spawned
 * agents share one answer stream, opened only while one of their questions is open.
 */
import {
  createOwnerInboxClient,
  localOwnerInbox,
  routeOwnerInbox,
  watchOwnerInboxUpdates,
  withAnswerDelivery,
  type AnswerDeliveringInbox,
  type LocalOwnerInbox,
  type OwnerInboxClient,
} from '@goodvibes-jev/engine/platform/platform/runtime/client';
import type { OwnerSessionPresence, OwnerSessionPresenceProbe } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import { whenSessionOpens } from '@goodvibes-jev/engine/terminal-shell/session-resume';
import type { RuntimeServices } from '../services.ts';
import { findSessionConversation } from '../conversation-rewind-port.ts';
import { createDaemonVerbCaller, resolveDaemonEndpoint } from './operator-endpoint.ts';

/** The terminal's own inbox file, used when no daemon is reachable. */
function localInboxPath(shellPaths: { resolveUserPath(...segments: string[]): string }): string {
  return shellPaths.resolveUserPath('tui', 'owner-inbox.jsonl');
}

// Set by wireOwnerQuestionSessions once the runtime knows its live session and session store.
let presence: OwnerSessionPresenceProbe = () => ({ state: 'closed' });

/** A session is open here when it is the live one, saved when the store has it, gone otherwise. */
function terminalSessionPresence(sessions: Pick<SessionManager, 'has' | 'getMeta'>, liveSessionId: () => string | undefined): OwnerSessionPresenceProbe {
  return (sessionId): OwnerSessionPresence => {
    if (sessionId === liveSessionId()) return { state: 'attached' };
    if (!sessions.has(sessionId)) return { state: 'gone' };
    const title = sessions.getMeta(sessionId)?.title?.trim();
    return { state: 'closed', ...(title ? { title } : {}) };
  };
}

function localInbox(shellPaths: { resolveUserPath(...segments: string[]): string }): LocalOwnerInbox {
  return localOwnerInbox({ questionsPath: localInboxPath(shellPaths), sessionPresence: (id) => presence(id), surface: 'tui' });
}

/** The inbox `/questions` reads and answers: the daemon's when reachable, this terminal's own otherwise. */
export function terminalOwnerInbox(deps: {
  readonly configManager: ConfigManager;
  readonly homeDirectory: () => string;
  readonly shellPaths: { resolveUserPath(...segments: string[]): string };
}): OwnerInboxClient {
  const verbs = createDaemonVerbCaller({ configManager: deps.configManager, homeDirectory: deps.homeDirectory });
  return routeOwnerInbox({
    daemon: createOwnerInboxClient(verbs),
    local: localInbox(deps.shellPaths),
    daemonReachable: () => verbs.probe().available,
  });
}

const instances = new WeakMap<RuntimeServices, AnswerDeliveringInbox>();

/** The runtime's question inbox; `sessionId` is the live session, the owner of a spawned agent's questions too. */
export function terminalOwnerQuestions(services: RuntimeServices, sessionId: () => string | undefined): AnswerDeliveringInbox {
  const existing = instances.get(services);
  if (existing) return existing;
  const homeDirectory = (): string => services.shellPaths.homeDirectory;
  const verbs = createDaemonVerbCaller({ configManager: services.configManager, homeDirectory });
  const local = localInbox(services.shellPaths);
  const inbox = withAnswerDelivery(
    routeOwnerInbox({ daemon: createOwnerInboxClient(verbs), local, daemonReachable: () => verbs.probe().available }),
    {
      watch: async (onItem, onEnd) => {
        // The local inbox answers in this process; the daemon's arrive on its update stream.
        const stopLocal = local.subscribe(onItem);
        const endpoint = resolveDaemonEndpoint({ configManager: services.configManager, homeDirectory });
        const token = endpoint.available ? endpoint.token : null;
        const remote = endpoint.available
          ? await watchOwnerInboxUpdates({
            baseUrl: endpoint.baseUrl,
            getAuthToken: () => token,
            onItem,
            onTerminate: () => { stopLocal(); onEnd(); },
          })
          : null;
        return { close: () => { stopLocal(); remote?.close(); } };
      },
      hostFor: (id) => (id ? findSessionConversation(id)?.hostInstructions : undefined),
      sessionId,
    },
  );
  instances.set(services, inbox);
  return inbox;
}

/**
 * Hand a session what waited for it when it is opened into `conversation`, and
 * settle its questions when it is deleted. Called once at bootstrap; returns
 * the function that undoes it.
 */
export function wireOwnerQuestionSessions(services: RuntimeServices, conversation: object, sessionId: () => string | undefined): () => void {
  presence = terminalSessionPresence(services.sessionManager, sessionId);
  const inbox = (): AnswerDeliveringInbox => terminalOwnerQuestions(services, sessionId);
  const stopOpened = whenSessionOpens(conversation, (id) => inbox().openSession(id));
  const stopDeleted = services.sessionManager.onDeleted((id) => { void inbox().deleteSession(id); });
  return () => { stopOpened(); stopDeleted(); };
}
