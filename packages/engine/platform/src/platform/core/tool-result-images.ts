/**
 * The one place a conversation loop turns the pictures in its tool results
 * into model input: the main turn loop and worker agents both call it after
 * the round's results are recorded.
 */
import type { ContentPart } from '../providers/interface.js';
import type { ToolResult } from '../types/tools.js';
import { appendVerificationRuntimeMessage } from './verification/archive.js';

interface ImageConversation {
  addUserMessage(content: string | ContentPart[]): void;
  getMessageSnapshot(): readonly { readonly role: string; readonly content: unknown }[];
}

/**
 * Attach the round's tool-result images to the next request when the model
 * reads images; otherwise say, once, which pictures it was not shown, so it
 * neither assumes it saw them nor asks for them again. Host-made, so the
 * verifier, retry and undo skip it. No request is added.
 */
export function attachToolResultImages(conversation: ImageConversation, results: readonly ToolResult[], modelReadsImages: boolean): void {
  const images = results.flatMap((result) => result.images ?? []);
  if (images.length === 0) return;
  if (modelReadsImages) {
    const parts: ContentPart[] = [
      { type: 'text', text: '[Images from tool results]' },
      ...images.map((image): ContentPart => ({ type: 'image', data: image.base64, mediaType: image.mediaType })),
    ];
    appendVerificationRuntimeMessage<string | ContentPart[]>(conversation, parts);
    return;
  }
  const listed = images.map((image) => image.path).join(', ');
  appendVerificationRuntimeMessage<string | ContentPart[]>(conversation,
    `[Images from tool results were not shown: the current model does not accept images (${listed}). `
    + 'Describe them only from the tool text, or use a model that reads images.]');
}
