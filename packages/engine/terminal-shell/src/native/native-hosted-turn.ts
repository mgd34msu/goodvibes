import type { GatePresetName } from '@goodvibes/engine/platform/platform/gate/presets';
import type { OperatorRemoteClient } from '@goodvibes/engine/operator-client';
import { nativeHostedTurnLookupSchema, nativeHostedTurnRequestSchema, nativeHostedTurnStartRequestSchema, type NativeHostedTurnLookup, type NativeHostedTurnRequest, type NativeHostedTurnStartRequest, } from '@goodvibes/engine/platform/platform/hosted-sessions/native-turn-client';
export type { NativeHostedTurnLookup, NativeHostedTurnRequest, NativeHostedTurnStartRequest };
export interface NativeHostedTurnClient {
    status(target: NativeHostedTurnRequest, options?: {
        readonly signal?: AbortSignal | undefined;
    } | undefined): Promise<NativeHostedTurnLookup>;
    start(target: NativeHostedTurnStartRequest, options?: {
        readonly signal?: AbortSignal | undefined;
    } | undefined): Promise<NativeHostedTurnLookup>;
    cancel(target: NativeHostedTurnRequest, options?: {
        readonly signal?: AbortSignal | undefined;
    } | undefined): Promise<NativeHostedTurnLookup>;
}
/** Host-owned source identity only. The daemon owns the turn permit and dispatch claim. */
export function createNativeHostedTurnClient(operator: Pick<OperatorRemoteClient, 'invoke'>, projectId: string, readMode?: (() => GatePresetName) | undefined): NativeHostedTurnClient {
    const run = async (action: 'status' | 'start' | 'cancel', target: NativeHostedTurnRequest, options: {
        readonly signal?: AbortSignal | undefined;
    } = {}): Promise<NativeHostedTurnLookup> => {
        const request = action === 'start' ? nativeHostedTurnStartRequestSchema.parse({ ...target, ...(readMode ? { permissionMode: readMode() } : {}) }) : nativeHostedTurnRequestSchema.parse(target);
        if (request.projectId !== projectId)
            throw new Error('Native hosted turn project changed');
        options.signal?.throwIfAborted();
        const found = nativeHostedTurnLookupSchema.parse(await operator.invoke<unknown>(action === 'start' ? 'workLedger.turn.startAgent' : `workLedger.turn.${action}`, request, options));
        options.signal?.throwIfAborted();
        if (!('kind' in found) && (found.projectId !== request.projectId || found.inputId !== request.inputId || found.sourceRevision !== request.sourceRevision)) {
            throw new Error('Native hosted turn source changed');
        }
        return found;
    };
    return Object.freeze({
        status: (target: NativeHostedTurnRequest, options?: {
            readonly signal?: AbortSignal | undefined;
        } | undefined) => run('status', target, options),
        start: (target: NativeHostedTurnStartRequest, options?: {
            readonly signal?: AbortSignal | undefined;
        } | undefined) => run('start', target, options),
        cancel: (target: NativeHostedTurnRequest, options?: {
            readonly signal?: AbortSignal | undefined;
        } | undefined) => run('cancel', target, options),
    });
}
export function nativeHostedTurnLines(result: NativeHostedTurnLookup): string[] {
    if ('kind' in result)
        return ['The daemon has not started answering your message. Try it again in Work, under Unanswered.'];
    const words: Readonly<Record<string, string>> = { 'recovery-required': 'stopped halfway', cancelled: 'stopped', failed: 'failed' };
    const lines = [`The daemon's answer to your message: ${words[result.state] ?? result.state.replace(/-/g, ' ')}.`];
    if (result.state === 'recovery-required')
        lines.push('Look at the conversation on the daemon; your message is not sent again, since it may already have been answered.');
    if (result.state === 'cancelled')
        lines.push('What it had already done is kept.');
    if (result.state === 'failed') {
        if (result.failure)
            lines.push(`What failed: ${result.failure.summary}`);
        lines.push(result.failure?.retryable
            ? 'Nothing was changed. Try the same message again or drop it in Work, under Unanswered.'
            : 'It will not be run again. Send a new message to continue; the session takes the next one.');
    }
    return lines;
}
