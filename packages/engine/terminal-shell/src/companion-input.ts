import type { SessionEvent } from '@goodvibes-jev/engine/platform/events/session';
import type { OrchestratorUserInputOptions } from '@goodvibes-jev/engine/platform/platform/core';
export type CompanionMessagePayload = Extract<SessionEvent, { type: 'COMPANION_MESSAGE_RECEIVED' }>;
export function companionMessageToOrchestratorInputOptions(payload: CompanionMessagePayload): OrchestratorUserInputOptions {
  const metadata = payload.metadata;
  const surface = typeof metadata?.surface === 'string' ? metadata.surface : undefined;
  const topic = typeof metadata?.topic === 'string' ? metadata.topic : undefined;

  return {
    origin: {
      source: payload.source,
      messageId: payload.messageId,
      ...(surface ? { surface } : {}),
      ...(topic ? { topic } : {}),
      ...(metadata ? { metadata } : {}),
    },
  };
}
