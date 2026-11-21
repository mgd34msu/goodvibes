/**
 * The owner inbox this Agent uses, for `/questions` and for the `query` tool of
 * its conversation and the agents it spawns: the home's one store, which the
 * daemon, the TUI and every other terminal open too, reached through the
 * connected host while the Agent has a credential for one (so its approvals are
 * listed and the owner's phone is pushed) and directly otherwise. A question is
 * recorded as asked by the live session; the owner's answer, given anywhere
 * (here, the TUI, the web UI, the phone), reaches the spawned agent that asked
 * it on its next model request while that agent runs, otherwise the session's
 * conversation: on its next model request while the session is open here,
 * otherwise when it is next opened (any resume path, headless included).
 * Deleting the session withdraws its open questions and marks its waiting
 * answers not deliverable.
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
} from '@goodvibes/engine/platform/platform/runtime/client';
import { OWNER_ASKER_SESSION_FILE_METADATA, handleOwnerDecisions } from '@goodvibes/engine/platform/platform/control-plane';
import { bridgeContractQuestionsToInbox, type ContractRunner } from '@goodvibes/engine/platform/platform/contract';
import { bridgeJevDecisionsToInbox, processJevDecisions, type JevDecisionUndo } from '@goodvibes/engine/platform/platform/permissions';
import { watchSessionAnswers, type SessionAnswerWatch } from '@goodvibes/engine/platform/platform/agents';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { SessionManager } from '@goodvibes/engine/platform/platform/sessions';
import { sessionIdentityFile, type SessionSurface } from '@goodvibes/engine/platform/platform/runtime/operations';
import type { OperatorMethodId, OperatorMethodInput } from '@goodvibes/engine/platform/contracts';
import { whenSessionOpens } from '@goodvibes/engine/terminal-shell/session-resume';
import { createConnectedHost, type ConnectedHost } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-client';
import { findSessionConversation, onSessionConversationChange } from '../conversation-rewind-port.ts';

export interface ConnectedHostInboxOptions {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
}

type UserPaths = { resolveUserPath(...segments: string[]): string };

/** What the question inbox needs from the runtime. */
export interface OwnerQuestionServices {
  readonly shellPaths: UserPaths;
  readonly sessionManager: Pick<SessionManager, 'onDeleted'>;
  /** Where this app keeps its sessions: a session's identity is its saved file there. */
  readonly surface: Pick<SessionSurface, 'sessionsDir'>;
  /** Restores the files of a call Jev let run, when the owner chooses undo in /decisions. */
  readonly fileUndoManager?: JevDecisionUndo | undefined;
  /** The contracts this app runs: their questions to the owner are put in the owner inbox. */
  readonly contractRunner?: Pick<ContractRunner, 'get' | 'list' | 'reply' | 'on'> | undefined;
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

/** The inbox `/questions` reads and answers: the connected host's when reachable, the home store directly otherwise. */
export function agentOwnerInbox(options: ConnectedHostInboxOptions & { readonly shellPaths: UserPaths }): OwnerInboxClient {
  const host = connectedHost(options);
  return routeOwnerInbox({
    daemon: connectedHostOwnerInbox(options, host),
    home: homeInboxClient(homeOwnerInbox(options.shellPaths), 'agent'),
    daemonReachable: () => hostReachable(host),
    // The connected host this Agent's daemon requests dial.
    daemonAddress: () => host.connection().baseUrl,
  });
}

const instances = new WeakMap<object, AnswerDeliveringInbox>();
const sessionWatches = new WeakMap<object, SessionAnswerWatch>();

/** The runtime's question inbox; `sessionId` is the live session, the owner of a spawned agent's questions too. */
export function agentOwnerQuestions(services: OwnerQuestionServices, options: ConnectedHostInboxOptions, sessionId: () => string | undefined): AnswerDeliveringInbox {
  const existing = instances.get(services);
  if (existing) return existing;
  const host = connectedHost(options);
  const daemon = connectedHostOwnerInbox(options, host);
  const home = homeOwnerInbox(services.shellPaths);
  const daemonReachable = (): boolean => hostReachable(host);
  const daemonAddress = (): string | undefined => host.connection().baseUrl;
  const inbox = withAnswerDelivery(
    routeOwnerInbox({ daemon, home: homeInboxClient(home, 'agent'), daemonReachable, daemonAddress }),
    {
      home,
      sessionWatch: () => sessionWatches.get(services),
      // The session's identity (app, project store and id), and what any process reads to tell a closed session from a deleted one.
      askerFacts: (id) => ({ [OWNER_ASKER_SESSION_FILE_METADATA]: sessionIdentityFile(services.surface, id) }),
      daemonReachable,
      daemonAddress,
      daemon,
      // Only for a question a host on another machine holds: its update stream while one is open.
      watch: async (onItem, onEnd) => {
        const connection = host.connection();
        const token = connection.token;
        if (token === null) return null;
        return await watchOwnerInboxUpdates({ baseUrl: connection.baseUrl, getAuthToken: () => token, onItem, onTerminate: onEnd });
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
  services: OwnerQuestionServices,
  options: ConnectedHostInboxOptions,
  conversation: Parameters<typeof watchSessionAnswers>[0],
  sessionId: () => string | undefined,
): () => void {
  // This process's sessions and agents read their answers from the home store (opened on first use).
  homeOwnerInbox(services.shellPaths);
  const watch = watchSessionAnswers(conversation, sessionId, (id) => sessionIdentityFile(services.surface, id));
  sessionWatches.set(services, watch);
  // A new or forked session takes the conversation's place: the mark that the old one is running goes at once.
  const stopFollowing = onSessionConversationChange(() => watch.refresh());
  const inbox = (): AnswerDeliveringInbox => agentOwnerQuestions(services, options, sessionId);
  const stopOpened = whenSessionOpens(conversation, (id) => inbox().openSession(id));
  const stopDeleted = services.sessionManager.onDeleted((id) => { void inbox().deleteSession(id); });
  // What Jev decides in this Agent's turns is listed in /decisions here, in the TUI and in the web UI; a choice on it is carried out here.
  const stopDecisions = bridgeJevDecisionsToInbox(processJevDecisions(), homeOwnerInbox(services.shellPaths),
    { surface: 'agent', handle: handleOwnerDecisions, undo: services.fileUndoManager });
  // What a contract this app runs asks its owner waits in the owner inbox too; an answer there is the contract's reply.
  const contracts = services.contractRunner;
  const stopContractQuestions = contracts
    ? bridgeContractQuestionsToInbox(contracts, (listener) => contracts.on(listener), homeOwnerInbox(services.shellPaths))
    : () => {};
  return () => {
    stopContractQuestions();
    stopDecisions();
    stopOpened();
    stopDeleted();
    stopFollowing();
    watch.dispose();
    if (sessionWatches.get(services) === watch) sessionWatches.delete(services);
  };
}
