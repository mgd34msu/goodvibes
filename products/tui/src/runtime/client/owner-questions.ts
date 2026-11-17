/**
 * The owner inbox the `query` tool asks in, for this terminal's conversation and
 * the agents it spawns: questions go to the daemon's inbox, and an answer the
 * owner gives anywhere (here, the web UI, the phone) reaches the spawned agent
 * that asked it on its next model request while that agent runs, and otherwise
 * the asking conversation's next model request. One instance per runtime, so the main
 * conversation and its spawned agents share one answer stream, opened only
 * while one of their questions is open.
 */
import {
  createOwnerInboxClient,
  questionClosedText,
  watchOwnerInboxUpdates,
  withAnswerDelivery,
} from '@goodvibes-jev/engine/platform/platform/runtime/client';
import type { QuestionInbox } from '@goodvibes-jev/engine/platform/platform/tools';
import type { RuntimeServices } from '../services.ts';
import { findSessionConversation } from '../conversation-rewind-port.ts';
import { createDaemonVerbCaller, resolveDaemonEndpoint } from './operator-endpoint.ts';

const instances = new WeakMap<RuntimeServices, QuestionInbox>();

/** The runtime's question inbox; `sessionId` is the live session, the owner of a spawned agent's questions too. */
export function terminalOwnerQuestions(services: RuntimeServices, sessionId: () => string | undefined): QuestionInbox {
  const existing = instances.get(services);
  if (existing) return existing;
  const homeDirectory = (): string => services.shellPaths.homeDirectory;
  const inbox = withAnswerDelivery(
    createOwnerInboxClient(createDaemonVerbCaller({ configManager: services.configManager, homeDirectory })),
    {
      watch: async (onItem, onEnd) => {
        const endpoint = resolveDaemonEndpoint({ configManager: services.configManager, homeDirectory });
        if (!endpoint.available) return null;
        const token = endpoint.token;
        return await watchOwnerInboxUpdates({ baseUrl: endpoint.baseUrl, getAuthToken: () => token, onItem, onTerminate: onEnd });
      },
      deliver: (item) => {
        const conversation = item.sessionId ? findSessionConversation(item.sessionId) : undefined;
        conversation?.hostInstructions.set('replay', questionClosedText(item), { once: true, append: true });
      },
      sessionId,
    },
  );
  instances.set(services, inbox);
  return inbox;
}
