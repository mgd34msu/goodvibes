/** UI observation owned by the current conversation/session, never execution permission. */
import { JudgmentAuthorityRetiredError } from '@goodvibes-jev/engine/errors';
import { TranscriptSourceChangedError, TranscriptReadingLifetime } from '@goodvibes-jev/engine/platform/platform/core';
import type { ConversationManager } from '@goodvibes-jev/engine/platform/platform/core';
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
export async function readTranscriptIndex(ctx: TranscriptCommandContext, source = captureTranscriptSource(ctx)) {
    try {
        const index = await source.conversation.getTranscriptEventIndex({ assertCurrent: source.assertCurrent, lifetime: source.lifetime, signal: source.signal });
        source.assertPublishable();
        return index;
    }
    catch (error) {
        source.assertPublishable();
        if (transcriptReadingCanceled(error))
            throw error;
        // Neither provider errors nor transcript content are echoed into a display.
        return null;
    }
}
