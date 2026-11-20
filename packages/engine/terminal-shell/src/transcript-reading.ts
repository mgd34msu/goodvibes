/** UI observation owned by the current conversation/session, never execution permission. */
import { JudgmentAuthorityRetiredError } from '@goodvibes/engine/errors';
import { TranscriptSourceChangedError, TranscriptReadingLifetime } from '@goodvibes/engine/platform/platform/core';
import type { ConversationManager } from '@goodvibes/engine/platform/platform/core';
export type TranscriptConversation = Pick<ConversationManager, 'getMessageSnapshot' | 'getTranscriptEventIndex'> & Partial<Pick<ConversationManager, 'revisionSource'>>;
export interface TranscriptCommandContext<Conversation extends TranscriptConversation = TranscriptConversation> {
    readonly session: {
        readonly sessionManager?: unknown;
        readonly conversationManager: Conversation;
        readonly runtime?: ({
            readonly sessionId?: unknown | undefined;
        } | null) | undefined;
    };
}
export const TRANSCRIPT_UNAVAILABLE = 'Transcript index is unavailable right now. Try again; your messages are unchanged.';
export function captureTranscriptSource<Conversation extends TranscriptConversation>(ctx: TranscriptCommandContext<Conversation>, signal?: AbortSignal | undefined) {
    const lifetime = new TranscriptReadingLifetime();
    const manager = ctx.session.sessionManager;
    const conversation = ctx.session.conversationManager;
    const runtime = ctx.session.runtime;
    const sessionId = runtime?.sessionId;
    // The conversation's revision is the one owner of "the history changed"; the session identity is compared by reference.
    const revision = conversation.revisionSource?.revision();
    const assertCurrent = () => {
        signal?.throwIfAborted();
        if (ctx.session.sessionManager !== manager || ctx.session.conversationManager !== conversation || ctx.session.runtime !== runtime || runtime?.sessionId !== sessionId || conversation.revisionSource?.revision() !== revision)
            throw new TranscriptSourceChangedError();
    };
    lifetime.retain(assertCurrent);
    return { conversation, assertCurrent, lifetime, signal, assertPublishable: () => lifetime.assertCurrent() };
}
export function transcriptReadingCanceled(error: unknown): boolean {
    return error instanceof TranscriptSourceChangedError || error instanceof JudgmentAuthorityRetiredError;
}
export type TranscriptIndex = Awaited<ReturnType<TranscriptConversation['getTranscriptEventIndex']>>;
export type TranscriptIndexReading =
    | { readonly index: TranscriptIndex; readonly failure?: undefined }
    | { readonly index: null; readonly failure: string };
/** The index is built by code from the messages (no model request), so a failure's own message is the reason to show. */
export function describeTranscriptReadFailure(error: unknown): string {
    const raw = error instanceof Error ? (error.message || error.name) : String(error);
    const reason = raw.replace(/\s+/g, ' ').trim().slice(0, 200) || 'no reason given';
    return `Transcript index could not be read: ${reason}. Your messages are unchanged; run the command again.`;
}
export async function readTranscriptIndexReading(ctx: TranscriptCommandContext, source = captureTranscriptSource(ctx)): Promise<TranscriptIndexReading> {
    try {
        const index = await source.conversation.getTranscriptEventIndex({ assertCurrent: source.assertCurrent, lifetime: source.lifetime, signal: source.signal });
        source.assertPublishable();
        return { index };
    }
    catch (error) {
        source.assertPublishable();
        if (transcriptReadingCanceled(error))
            throw error;
        return { index: null, failure: describeTranscriptReadFailure(error) };
    }
}
export async function readTranscriptIndex(ctx: TranscriptCommandContext, source = captureTranscriptSource(ctx)): Promise<TranscriptIndex | null> {
    return (await readTranscriptIndexReading(ctx, source)).index;
}
