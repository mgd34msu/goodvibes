/**
 * The connected host's owner inbox, for `/questions` and for the `query` tool
 * of this Agent's conversation and the agents it spawns. An answer the owner
 * gives anywhere (here, the web UI, the phone) reaches the spawned agent that
 * asked it on its next model request while that agent runs, and otherwise the
 * asking conversation's next model request. One question inbox per runtime, so the
 * main conversation and its spawned agents share one answer stream, opened
 * only while one of their questions is open.
 */
import {
  createOwnerInboxClient,
  questionClosedText,
  watchOwnerInboxUpdates,
  withAnswerDelivery,
  type OwnerInboxClient,
} from '@goodvibes-jev/engine/platform/platform/runtime/client';
import type { QuestionInbox } from '@goodvibes-jev/engine/platform/platform/tools';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { OperatorMethodId, OperatorMethodInput } from '@goodvibes-jev/engine/platform/contracts';
import { createConnectedHost, type ConnectedHost } from '../../agent/connected-host-client.ts';
import { findSessionConversation } from '../conversation-rewind-port.ts';

export interface ConnectedHostInboxOptions {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
}

function connectedHost(options: ConnectedHostInboxOptions): ConnectedHost {
  return createConnectedHost({ configManager: options.configManager, homeDirectory: options.homeDirectory });
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

const instances = new WeakMap<object, QuestionInbox>();

/** The runtime's question inbox; `sessionId` is the live session, the owner of a spawned agent's questions too. */
export function agentOwnerQuestions(runtime: object, options: ConnectedHostInboxOptions, sessionId: () => string | undefined): QuestionInbox {
  const existing = instances.get(runtime);
  if (existing) return existing;
  const host = connectedHost(options);
  const inbox = withAnswerDelivery(connectedHostOwnerInbox(options, host), {
    watch: async (onItem, onEnd) => {
      const connection = host.connection();
      const token = connection.token;
      if (token === null) return null;
      return await watchOwnerInboxUpdates({ baseUrl: connection.baseUrl, getAuthToken: () => token, onItem, onTerminate: onEnd });
    },
    deliver: (item) => {
      const conversation = item.sessionId ? findSessionConversation(item.sessionId) : undefined;
      conversation?.hostInstructions.set('replay', questionClosedText(item), { once: true, append: true });
    },
    sessionId,
  });
  instances.set(runtime, inbox);
  return inbox;
}
