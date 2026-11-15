/**
 * The conversation-message envelope: one statement of the wire shape for a
 * message published through the control-plane gateway (companion chat
 * streams, companion and ntfy follow-ups into a live conversation, the web UI).
 * The daemon routes and the platform both import it from here.
 */

/** Where an envelope's message came from. Each value names the code that produces it. */
export const CONVERSATION_MESSAGE_SOURCES = [
  /** A companion sent a message in its own chat session (companion-chat-manager.ts). */
  'companion-chat-user',
  /** The orchestrator replied in a companion chat session (companion-chat-manager.ts, companion-chat-turn-control.ts). */
  'companion-chat-assistant',
  /** A companion message routed into the owner's live conversation (daemon-api runtime-session-routes.ts). */
  'companion-followup',
  /** An ntfy message routed into the owner's live terminal conversation (adapters/ntfy). */
  'ntfy-chat',
] as const;

export type ConversationMessageSource = typeof CONVERSATION_MESSAGE_SOURCES[number];

/** An artifact attached to a conversation message, as the wire carries it. */
export interface ConversationMessageAttachment {
  readonly artifactId: string;
  readonly label?: string | undefined;
  readonly id: string;
  readonly kind: string;
  readonly mimeType: string;
  readonly filename?: string | undefined;
  readonly sizeBytes: number;
  readonly createdAt: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ConversationMessageEnvelope {
  readonly sessionId: string;
  readonly messageId: string;
  readonly body: string;
  readonly source: ConversationMessageSource;
  readonly timestamp: number;
  /** Artifacts attached to this conversation message. */
  readonly attachments?: readonly ConversationMessageAttachment[] | undefined;
  /** Optional metadata for tool info, model id, etc. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}
