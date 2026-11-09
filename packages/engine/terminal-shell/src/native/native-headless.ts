import { createNativeHostFetch } from './native-host-fetch.js';
import { realpathSync } from 'node:fs';
import { createOperatorApiClient } from '@goodvibes-jev/engine/operator-client';
import { getOperatorWorkLedgerProject, nativeWorkExecutionSnapshotSchema } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-execution-client';
import { nativeConversationIntakeResultSchema } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-intake-client';
import { NativeConversationIntakeControls, type NativeConversationIntakeSelection, type NativeConversationIntakeState, type NativeConversationIntakePolicy } from './native-conversation-intake.js';
import { NativeConversationIntakeJournal, type NativeIntakeJournalRecord } from './native-conversation-intake-journal.js';
import { createNativeConversationIntakeBinding } from './native-conversation-intake-host.js';
import { captureNativeConversationInput } from './native-conversation-input.js';
import { createNativeSubmissionIdentity, type NativeSubmissionHost, type NativeHostIdentityFormat } from './native-work-submission-host.js';
import type { NativeHeadlessMode } from './native-headless-options.js';
export type NativeHeadlessHost = (NativeSubmissionHost & {
    readonly journalPath: string;
}) | {
    readonly reason: string;
};
export interface NativeHeadlessTurnResult {
    readonly exitCode: number;
    readonly response: string;
    readonly error?: string | undefined;
    readonly stopReason: string;
    readonly sessionId?: string | undefined;
    readonly model?: string | undefined;
    readonly provider?: string | undefined;
    readonly events?: number | undefined;
}
export interface NativeHeadlessResult extends NativeHeadlessTurnResult {
    readonly native?: NativeConversationIntakeState | undefined;
}
export interface NativeHeadlessOptions {
    readonly mode: NativeHeadlessMode;
    readonly prompt?: string | undefined;
    readonly resolveHost: () => NativeHeadlessHost;
    readonly signal: AbortSignal;
    readonly runTurn: (state: NativeConversationIntakeState, signal: AbortSignal) => Promise<NativeHeadlessTurnResult>;
    /** Injection retains the same controls/journal protocol without a network host. */
    readonly select?: (() => NativeConversationIntakeSelection) | undefined;
}
const unavailable = (message: string): NativeConversationIntakeState => ({ status: 'unavailable', message });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** No runtime bootstrap, model, local fallback, token mint or daemon start precedes native admission. */
export async function executeNativeHeadless(options: NativeHeadlessOptions, policy: NativeConversationIntakePolicy = { allowHosted: false, allowSelectedDiff: false }, identityFormat: NativeHostIdentityFormat = 'credential'): Promise<NativeHeadlessResult> {
    const identityOwner = createNativeSubmissionIdentity(identityFormat);
    const nativeSubmissionIdentity = identityOwner.identify;
    const capabilities = Object.freeze({ allowHosted: policy.allowHosted === true, allowSelectedDiff: policy.allowSelectedDiff === true });
    if (options.mode === 'submit' && (options.prompt === undefined || !/\S/u.test(options.prompt))) {
        return { exitCode: 2, response: '', error: 'A complete original prompt is required.', stopReason: 'invalid-input' };
    }
    if (options.mode !== 'submit' && options.prompt !== undefined)
        return { exitCode: 2, response: '', error: 'Recovery uses the original journal input; do not supply a replacement prompt.', stopReason: 'invalid-input' };
    let selection: (() => NativeConversationIntakeSelection) | undefined = options.select;
    let controls: NativeConversationIntakeControls | undefined;
    type CancellationTarget = {
        readonly identity: string;
        readonly record: NativeIntakeJournalRecord;
    };
    let owned: CancellationTarget | undefined;
    let observed: CancellationTarget | undefined;
    let cancellation: Promise<NativeConversationIntakeState | undefined> | undefined;
    let state: NativeConversationIntakeState | undefined;
    let inTurn = false;
    const cancelled = (): NativeHeadlessResult => ({ exitCode: 130, response: '', stopReason: 'cancelled',
        error: 'Local invocation cancelled. Inspect native intake status to establish the server outcome.', ...(state ? { native: state } : {}) });
    const cancelOwned = async (owner = owned): Promise<NativeConversationIntakeState | undefined> => {
        if (!owner || !selection)
            return;
        let binding: ReturnType<Extract<NativeConversationIntakeSelection, {
            available: true;
        }>['bind']> | undefined;
        try {
            const now = selection();
            if (!now.available || now.identity !== owner.identity)
                return;
            binding = now.bind();
            const signal = AbortSignal.timeout(5000);
            const principal = await binding.readPrincipal(signal);
            if (principal !== owner.record.binding.principalId)
                return;
            const stored = await now.journal.read(owner.record.binding);
            if (!stored || !same(stored.command, owner.record.command))
                return;
            await now.journal.confirm(owner.record.binding, owner.record.command);
            const current = selection();
            if (!current.available || current.identity !== owner.identity)
                return;
            const found = await binding.client.get({ inputId: owner.record.command.inputId }, { signal });
            if (found.kind === 'not-found')
                return;
            const result = nativeConversationIntakeResultSchema.parse(found);
            if (result.requestId !== owner.record.command.requestId || result.sourceRef.inputId !== owner.record.command.inputId || result.projectId !== now.projectId)
                return;
            // Recheck after network lookup: a replacement journal/host cannot inherit cancellation.
            await now.journal.confirm(owner.record.binding, owner.record.command);
            const latest = selection();
            if (!latest.available || latest.identity !== owner.identity)
                return;
            if (result.kind === 'work' && stored.execution) {
                // Only the exact durable intent can be cancelled; signal cancellation also requires invocation ownership.
                const intent = stored.execution;
                if (result.receipt.goal !== owner.record.command.text || result.receipt.workId !== intent.target.workId || result.receipt.attemptId !== intent.target.attemptId
                    || result.receipt.source.sourceRevision !== intent.sourceRevision || !same(result.receipt.expectedRevision, intent.target.expectedRevision))
                    return;
                const snapshot = nativeWorkExecutionSnapshotSchema.parse(await binding.execution.cancel(intent.target, { signal }));
                if (snapshot.projectId !== now.projectId || snapshot.workId !== intent.target.workId || snapshot.attemptId !== intent.target.attemptId)
                    return;
                return { status: 'recorded', message: 'Cancellation response recorded for the exact saved native attempt.', result,
                    execution: { action: 'cancel', workId: intent.target.workId, busy: false, message: 'Inspect the returned state to establish cancellation.', snapshot } };
            }
            if (result.kind !== 'captured' && result.kind !== 'processing')
                return;
            const final = await binding.client.cancel({ inputId: result.sourceRef.inputId, sourceRevision: result.sourceRef.sourceRevision }, { signal });
            if (final.projectId !== now.projectId || final.requestId !== owner.record.command.requestId || final.sourceRef.inputId !== owner.record.command.inputId)
                return;
            return { status: 'recorded', message: 'Cancellation response recorded for the invocation-owned original input.', result: final };
        }
        catch {
            return;
        }
        finally {
            try {
                binding?.dispose();
            }
            catch { }
        }
    };
    const onAbort = () => {
        controls?.close();
        // An older input merely observed by submit/status is never owned by this invocation.
        if (!inTurn && options.mode === 'submit' && owned && !cancellation)
            cancellation = cancelOwned();
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    try {
        if (options.signal.aborted)
            return cancelled();
        if (!selection) {
            const host = options.resolveHost();
            if ('reason' in host)
                return resultForState(unavailable(host.reason), options.mode);
            const before = nativeSubmissionIdentity(host, '');
            const currentHost = () => { const current = options.resolveHost(); return !('reason' in current) && nativeSubmissionIdentity(current, '') === before; };
            const discovery = new AbortController();
            const operator = createOperatorApiClient({ baseUrl: host.baseUrl, authToken: host.token, fetchImpl: createNativeHostFetch({ current: () => !options.signal.aborted && !discovery.signal.aborted && currentHost() }) });
            const guard = () => { try {
                if (!currentHost())
                    discovery.abort();
            }
            catch {
                discovery.abort();
            } };
            const timer = setInterval(guard, 100);
            timer.unref?.();
            let projectId: string;
            try {
                guard();
                projectId = await getOperatorWorkLedgerProject(operator, { signal: AbortSignal.any([options.signal, discovery.signal, AbortSignal.timeout(5000)]) });
            }
            finally {
                clearInterval(timer);
                operator.dispose();
            }
            if (options.signal.aborted)
                return cancelled();
            if (!currentHost())
                return resultForState(unavailable('Native host selection changed.'), options.mode);
            const identity = nativeSubmissionIdentity(host, projectId);
            const journal = new NativeConversationIntakeJournal(host.journalPath, {}, capabilities);
            selection = () => currentHost() ? { available: true, identity, endpoint: host.baseUrl, projectId,
                workspace: realpathSync(host.workspace), journal, bind: () => createNativeConversationIntakeBinding(host, projectId, currentHost, capabilities) }
                : { available: false, identity: 'changed', reason: 'Native host selection changed.' };
        }
        const readSelection = selection;
        controls = new NativeConversationIntakeControls(() => {
            const selected = readSelection();
            if (!selected.available)
                return selected;
            const journal = selected.journal;
            return { ...selected, journal: {
                    async read(binding) {
                        const record = await journal.read(binding);
                        observed = record ? { identity: selected.identity, record: structuredClone(record) } : undefined;
                        return record;
                    }, confirm: (binding, command) => journal.confirm(binding, command),
                    claimTurn: (binding, command, revision) => journal.claimTurn(binding, command, revision),
                    saveExecutionIntent: (binding, command, intent) => journal.saveExecutionIntent(binding, command, intent),
                    async save(binding, command, expected) {
                        await journal.save(binding, command, expected);
                        // Ownership starts at proven durable publication, not principal lookup or old-input discovery.
                        owned = { identity: selected.identity, record: { binding: structuredClone(binding), command: structuredClone(command) } };
                    },
                } };
        }, undefined, capabilities);
        if (options.signal.aborted)
            return cancelled();
        state = options.mode === 'submit' ? await controls.submit(captureNativeConversationInput(options.prompt!)) : await controls[options.mode]();
        if (options.signal.aborted) {
            state = await cancellation ?? state;
            return cancelled();
        }
        if (options.mode === 'cancel' && state?.result?.kind === 'work') {
            const cancelledWork = await cancelOwned(observed);
            if (options.signal.aborted)
                return cancelled();
            if (!cancelledWork)
                return { exitCode: 3, response: '', error: 'Native work cancellation could not be confirmed. The saved target is unchanged; inspect --intake-status.', stopReason: 'native-unknown', native: state };
            return resultForState(cancelledWork, options.mode);
        }
        if (state?.turnReady && state.turnPermit && state.result?.kind === 'turn') {
            inTurn = true;
            const turn = await options.runTurn(state, options.signal);
            // runTurn also awaits shutdown: a signal during cleanup still belongs to this invocation.
            return { ...turn, exitCode: options.signal.aborted ? 130 : turn.exitCode, native: state };
        }
        return resultForState(state, options.mode);
    }
    catch {
        if (options.signal.aborted) {
            state = await cancellation ?? state;
            return cancelled();
        }
        if (!controls)
            return resultForState(unavailable('Native host or authenticated project is unavailable. No input was captured.'), options.mode);
        return { exitCode: 3, response: '', error: 'Native outcome is unknown or unavailable. Inspect --intake-status before explicit recovery.', stopReason: 'native-unknown', ...(state ? { native: state } : {}) };
    }
    finally {
        options.signal.removeEventListener('abort', onAbort);
        controls?.close();
        identityOwner.clear();
    }
}
function resultForState(state: NativeConversationIntakeState | undefined, mode: NativeHeadlessMode): NativeHeadlessResult {
    const result = state?.result;
    let exitCode = state?.status === 'invalid' ? 2 : state?.status === 'unavailable' ? 1 : 3;
    if (state?.status === 'recorded' && result) {
        if (mode === 'status')
            exitCode = 0;
        else if (result.kind === 'blocked' || result.kind === 'refused')
            exitCode = 1;
        else if (result.kind === 'cancelled')
            exitCode = 130;
        else if (result.kind === 'work' && state.execution?.snapshot)
            exitCode = 0;
    }
    return { exitCode, response: state?.message ?? '', stopReason: `native-${result?.kind ?? state?.status ?? 'detached'}`, ...(state ? { native: state } : {}) };
}
export function writeNativeHeadlessResult(result: NativeHeadlessResult, format: string, stdout: (line: string) => void, alwaysNativeType = false): void {
    const { exitCode, native, ...turn } = result;
    // Capabilities remain process-local. Never spread the state containing its permit.
    const state = native ? { status: native.status, message: native.message, request: native.request, result: native.result, execution: native.execution } : undefined;
    if (format === 'json' || format === 'stream-json')
        stdout(JSON.stringify({ ...(format === 'stream-json' ? { type: alwaysNativeType || state ? 'NATIVE_INTAKE_RESULT' : 'TURN_RESULT' } : {}), ok: exitCode === 0, ...turn, ...(state ? { native: state } : {}) }));
    else
        stdout([result.response, result.error, state?.execution?.message].filter(Boolean).join('\n'));
}
