/**
 * attachment-limits.ts, the limits every message attachment keeps (a chat
 * message's and a native request's), in a module with no dependencies so the
 * browser-safe native request wire can use the same number.
 */

/** Files one message may carry. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

/** What a model is shown of an attachment: these facts, and its content when it is small text or an image. */
export interface AttachmentFacts {
  readonly artifactId: string;
  readonly label?: string | undefined;
  readonly filename?: string | undefined;
  readonly mimeType: string;
  readonly sizeBytes: number;
}
