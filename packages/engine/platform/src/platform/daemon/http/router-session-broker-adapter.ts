/**
 * router-session-broker-adapter.ts
 *
 * Hands the real `SharedSessionBroker` to the runtime routes under the
 * `sessionBroker` contract daemon-api declares. Every input the routes pass is
 * typed there (surface kinds, session kinds, input states, routing and
 * execution intent are checked by the route), so each call is the broker's own
 * method with no cast: a broker input that changes fails to compile here.
 * Only `bindAgent` and `completeAgent` are wrapped, because the contract
 * answers them with nothing.
 */
import type { SharedSessionBroker } from '../../control-plane/index.js';
import type { DaemonRuntimeRouteContext } from './runtime-route-types.js';

export function buildRouterSessionBrokerAdapter(
  sessionBroker: SharedSessionBroker,
): DaemonRuntimeRouteContext['sessionBroker'] {
  return {
    start: () => sessionBroker.start(),
    submitMessage: (input) => sessionBroker.submitMessage(input),
    steerMessage: (input) => sessionBroker.steerMessage(input),
    followUpMessage: (input) => sessionBroker.followUpMessage(input),
    bindAgent: async (sessionId, agentId, inputId) => {
      await sessionBroker.bindAgent(sessionId, agentId, inputId);
    },
    createSession: (input) => sessionBroker.createSession(input),
    register: (input) => sessionBroker.register(input),
    getSession: (sessionId) => sessionBroker.getSession(sessionId),
    getMessages: (sessionId, limit, offset) => sessionBroker.getMessages(sessionId, limit, offset),
    getInputs: (sessionId, limit) => sessionBroker.getInputs(sessionId, limit),
    getInputsSince: (sessionId, options) => sessionBroker.getInputsSince(sessionId, options),
    markInputDelivered: (sessionId, inputId, options) => sessionBroker.markInputDelivered(sessionId, inputId, options),
    closeSession: (sessionId) => sessionBroker.closeSession(sessionId),
    reopenSession: (sessionId) => sessionBroker.reopenSession(sessionId),
    detachParticipant: (sessionId, surfaceId) => sessionBroker.detachParticipant(sessionId, surfaceId),
    deleteSession: (sessionId) => sessionBroker.deleteSession(sessionId),
    cancelInput: (sessionId, inputId) => sessionBroker.cancelInput(sessionId, inputId),
    failInput: (sessionId, inputId, error) => sessionBroker.failInput(sessionId, inputId, error),
    completeAgent: async (sessionId, agentId, message, meta) => {
      await sessionBroker.completeAgent(sessionId, agentId, message, meta);
    },
    appendCompanionMessage: (sessionId, input) =>
      sessionBroker.appendCompanionMessage(sessionId, input),
  };
}
