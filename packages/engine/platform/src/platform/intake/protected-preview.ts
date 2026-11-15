import { types as nodeTypes } from 'node:util';
import type { ProtectedSourceOwner, SourceScreeningHold } from '../security/source-screening/types.js';
import { JudgmentInputError } from '../gate/judgment-input.js';
import { digestSender, normalizeWhitespace, stripMarkup } from './text-normalization.js';

export interface ProtectedInboxPreviewInput {
  readonly senderId: string;
  readonly channelId: string;
  readonly subject: string;
  readonly text: string;
}
export interface ProtectedInboxPreviewFields {
  readonly fromDigest: string;
  readonly subjectPreview: string;
  readonly bodyPreview: string;
}
/**
 * What screening decided about one message:
 * - `mapped`: screened previews, safe to store and show.
 * - `withheld`: screening held this message for a reason that belongs to the
 *   message itself (it could not be settled, the model's answer about it was
 *   malformed, or it holds protected input). It is published as withheld with
 *   no preview, and progress passes it, so one message cannot stop an inbox.
 * - `unavailable`: screening could not run now (route down, cancelled, busy,
 *   at capacity, settings changed). Nothing about the message is known; the
 *   poll keeps what it already screened and the next poll starts here.
 */
export type ProtectedInboxPreview =
  | { readonly status: 'mapped'; readonly fields: ProtectedInboxPreviewFields }
  | { readonly status: 'withheld'; readonly fields: ProtectedInboxPreviewFields }
  | { readonly status: 'unavailable' };

/** Holds that are a property of the message's text, not of the route that screens it. */
const MESSAGE_HOLDS: ReadonlySet<SourceScreeningHold> = new Set(['unsettled', 'malformed', 'protected-input']);
export const WITHHELD_PREVIEW_TEXT = 'Withheld by privacy screening. Open it in the app it came from to read it.';

/** Display bounds only; never cut half of a Unicode scalar. */
function prefix(text: string, limit: number): string {
  let end = Math.min(text.length, limit);
  if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff
    && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
  return text.slice(0, end);
}

const UNAVAILABLE: ProtectedInboxPreview = Object.freeze({ status: 'unavailable' });

/**
 * Slack/Discord mapper over an explicitly protected local route. Both raw
 * originals and deterministic display candidates are screened before clipping;
 * content is never replaced with raw text. The sender digest is computed from
 * the provider's sender id, which is not screened content.
 */
export function createProtectedInboxMapper(owner: ProtectedSourceOwner): (
  input: ProtectedInboxPreviewInput, signal?: AbortSignal,
) => Promise<ProtectedInboxPreview> {
  return async (input, signal) => {
    if (signal?.aborted) return UNAVAILABLE;
    let source: ReturnType<ProtectedSourceOwner['capture']>;
    let captured: ProtectedInboxPreviewInput;
    try {
      // Provider IDs remain local protocol data, never model input or authority.
      if (!input || typeof input !== 'object' || nodeTypes.isProxy(input) || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return UNAVAILABLE;
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const keys = ['senderId', 'channelId', 'subject', 'text'] as const;
      if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !descriptors[key]
        || !('value' in descriptors[key]) || typeof descriptors[key].value !== 'string')) return UNAVAILABLE;
      captured = Object.freeze(Object.fromEntries(keys.map(key => [key, descriptors[key].value]))) as unknown as ProtectedInboxPreviewInput;
      if (!captured.senderId || captured.senderId.length > 200 || !captured.channelId || captured.channelId.length > 200) return UNAVAILABLE;
    } catch { return UNAVAILABLE; }
    const withheld = (): ProtectedInboxPreview => Object.freeze({ status: 'withheld', fields: Object.freeze({
      fromDigest: digestSender(captured.senderId), subjectPreview: captured.subject ? 'Withheld message' : '', bodyPreview: WITHHELD_PREVIEW_TEXT }) });
    try {
      source = owner.capture([captured.subject, captured.text,
        normalizeWhitespace(stripMarkup(captured.subject)), normalizeWhitespace(stripMarkup(captured.text))]);
    } catch (error) {
      // Text the screening owner refuses to take is about the message; anything else is the route.
      return error instanceof JudgmentInputError ? withheld() : UNAVAILABLE;
    }
    let releasing: Promise<void> | undefined;
    const release = () => releasing ??= owner.release(source);
    const abort = () => { void release().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const result = await owner.screen(source);
      if (signal?.aborted) return UNAVAILABLE;
      if (result.status !== 'settled') return MESSAGE_HOLDS.has(result.reason) ? withheld() : UNAVAILABLE;
      const parts = owner.project(result.receipt);
      const fields = Object.freeze({ fromDigest: digestSender(captured.senderId),
        subjectPreview: prefix(parts[2]!, 200), bodyPreview: prefix(parts[3]!, 500) });
      if (signal?.aborted) return UNAVAILABLE;
      return Object.freeze({ status: 'mapped', fields });
    } catch { return UNAVAILABLE; }
    finally { signal?.removeEventListener('abort', abort); await release(); }
  };
}
