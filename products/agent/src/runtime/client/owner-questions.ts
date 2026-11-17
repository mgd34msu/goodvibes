/**
 * The owner inbox this Agent uses, for `/questions` and for the `query` tool of
 * its conversation and the agents it spawns: the connected host's when it has a
 * credential for one, the Agent's own (a file under its user directory) when it
 * has none. A question is recorded as asked by the live session; the owner's
 * answer, given anywhere (here, the web UI, the phone), reaches the spawned
 * agent that asked it on its next model request while that agent runs,
 * otherwise the session's conversation: at once while the session is open here,
 * otherwise when it is next opened (any resume path, headless included).
 * Deleting the session withdraws its open questions and marks its waiting
 * answers not deliverable. One question inbox per runtime, so the main
 * conversation and its spawned agents share one answer stream, opened only
 * while one of their questions is open.
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
import type { OperatorMethodId, OperatorMethodInput } from '@goodvibes-jev/engine/platform/contracts';
import { whenSessionOpens } from '@goodvibes-jev/engine/terminal-shell/session-resume';
import { createConnectedHost, type ConnectedHost } from '../../agent/connected-host-client.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { findSessionConversation } from '../conversation-rewind-port.ts';

export interface ConnectedHostInboxOptions {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
}

type UserPaths = { resolveUserPath(...segments: string[]): string };

/** What the question inbox needs from the runtime. */
export interface OwnerQuestionServices {
  readonly shellPaths: UserPaths;
  readonly sessionManager: Pick<SessionManager, 'has' | 'getMeta' | 'onDeleted'>;
}

function connectedHost(options: ConnectedHostInboxOptions): ConnectedHost {
  return createConnectedHost({ configManager: options.configManager, homeDirectory: options.homeDirectory });
}

function hostReachable(host: ConnectedHost): boolean {
  return host.connection().token !== null;
}

/** The owner inbox over the connected host's `inbox.*` verbs. */
export function connectedHostOwnerInbox(options: ConnectedHostInboxOptions, host: ConnectedHost = connectedHost(options)): OwnerInboxClient {
  return createOwnerInboxClient({
    probe: () => {
      const connection = host.connection();
      return connection.token !== null
        ? { available: true }
        : { available: false, reason: connection.unavailable?.reason ?? `no credential for the host at ${connection.baseUrl}` };
    },
    invoke: <T = unknown>(methodId: string, input?: unknown) =>
      host.invoke(methodId as OperatorMethodId, (input ?? {}) as OperatorMethodInput<OperatorMethodId>) as Promise<T>,
  });
}

// Set by wireOwnerQuestionSessions once the runtime knows its live session and session store.
let presence: OwnerSessionPresenceProbe = () => ({ state: 'closed' });

/** A session is open here when it is the live one, saved when the store has it, gone otherwise. */
function agentSessionPresence(sessions: Pick<SessionManager, 'has' | 'getMeta'>, liveSessionId: () => string | undefined): OwnerSessionPresenceProbe {
  return (sessionId): OwnerSessionPresence => {
    if (sessionId === liveSessionId()) return { state: 'attached' };
    if (!sessions.has(sessionId)) return { state: 'gone' };
    const title = sessions.getMeta(sessionId)?.title?.trim();
    return { state: 'closed', ...(title ? { title } : {}) };
  };
}

/** The Agent's own inbox file, used when it has no connected host. */
function localInbox(shellPaths: UserPaths): LocalOwnerInbox {
  return localOwnerInbox({
    questionsPath: shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'owner-inbox.jsonl'),
    sessionPresence: (id) => presence(id),
    surface: 'agent',
  });
}

/** The inbox `/questions` reads and answers: the connected host's when reachable, the Agent's own otherwise. */
export function agentOwnerInbox(options: ConnectedHostInboxOptions & { readonly shellPaths: UserPaths }): OwnerInboxClient {
  const host = connectedHost(options);
  return routeOwnerInbox({
    daemon: connectedHostOwnerInbox(options, host),
    local: localInbox(options.shellPaths),
    daemonReachable: () => hostReachable(host),
  });
}

const instances = new WeakMap<object, AnswerDeliveringInbox>();

/** The runtime's question inbox; `sessionId` is the live session, the owner of a spawned agent's questions too. */
export function agentOwnerQuestions(services: OwnerQuestionServices, options: ConnectedHostInboxOptions, sessionId: () => string | undefined): AnswerDeliveringInbox {
  const existing = instances.get(services);
  if (existing) return existing;
  const host = connectedHost(options);
  const local = localInbox(services.shellPaths);
  const inbox = withAnswerDelivery(
    routeOwnerInbox({ daemon: connectedHostOwnerInbox(options, host), local, daemonReachable: () => hostReachable(host) }),
    {
      watch: async (onItem, onEnd) => {
        // The local inbox answers in this process; the host's arrive on its update stream.
        const stopLocal = local.subscribe(onItem);
        const connection = host.connection();
        const token = connection.token;
        const remote = token !== null
          ? await watchOwnerInboxUpdates({
            baseUrl: connection.baseUrl,
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
export function wireOwnerQuestionSessions(
  services: OwnerQuestionServices,
  options: ConnectedHostInboxOptions,
  conversation: object,
  sessionId: () => string | undefined,
): () => void {
  presence = agentSessionPresence(services.sessionManager, sessionId);
  const inbox = (): AnswerDeliveringInbox => agentOwnerQuestions(services, options, sessionId);
  const stopOpened = whenSessionOpens(conversation, (id) => inbox().openSession(id));
  const stopDeleted = services.sessionManager.onDeleted((id) => { void inbox().deleteSession(id); });
  return () => { stopOpened(); stopDeleted(); };
}
