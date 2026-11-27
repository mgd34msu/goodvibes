import { createNativeHostFetch } from './native-host-fetch.js';
import { inProjectFolder } from './native-project-folder.js';
import { realpathSync, writeSync } from 'node:fs';
import { createOperatorApiClient } from '@goodvibes/engine/operator-client';
import { getOperatorWorkLedgerProject, nativeWorkExecutionSnapshotSchema } from '@goodvibes/engine/platform/platform/workflow/work-ledger/native-execution-client';
import { nativeConversationIntakeResultSchema } from '@goodvibes/engine/platform/platform/workflow/work-ledger/native-intake-client';
import { NativeConversationIntakeControls, nativeIntakeFailureCause, type NativeIntakeFailureCause, type NativeConversationIntakeSelection, type NativeConversationIntakeState, type NativeConversationIntakePolicy } from './native-conversation-intake.js';
import { NativeConversationIntakeJournal, type NativeIntakeJournalRecord } from './native-conversation-intake-journal.js';
import { createNativeConversationIntakeBinding } from './native-conversation-intake-host.js';
import { captureNativeConversationInput } from './native-conversation-input.js';
import { createNativeSubmissionIdentity, type NativeSubmissionHost, type NativeHostIdentityFormat } from './native-work-submission-host.js';
import type { NativeHeadlessMode } from './native-headless-options.js';
import { HEADLESS_SCHEMA_VERSION, type HeadlessUsage } from './headless-turn-events.js';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import type { DecisionModelUse } from '@goodvibes/engine/errors';
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
    /** The sign-in that answered last, for a provider with more than one (OpenAI: `subscription` or `api-key`). */
    readonly signIn?: string | undefined;
    readonly events?: number | undefined;
    readonly usage?: HeadlessUsage | undefined;
    /** Set on failures: `outcome-unknown` means the host may have acted, `unavailable` that nothing was sent. */
    readonly kind?: 'outcome-unknown' | 'unavailable' | undefined;
    readonly cause?: NativeHeadlessFailureCause | undefined;
    /** Set when the resumed session was restored from a crash snapshot before the first request. */
    readonly recovery?: HeadlessSessionRecovery | undefined;
    /** Set when the run was refused before it started: what is true, why, and what to do. */
    readonly refusal?: { readonly code: string; readonly state: string; readonly reason: string; readonly next: readonly string[] } | undefined;
    /** Set when no decision model was in use for the run: none set, switched off, or the set one failing. */
    readonly decisionModel?: DecisionModelUse | undefined;
    /**
     * Calls held for the owner during the run: not run, and the rest of the work went on without them. Just vibes holds
     * what it does not run; in any other mode a call the mode puts to the owner while nobody in the run can answer it
     * (no --answer-permissions) is held the same way. Run again with --answer-permissions (or approve them in Waiting
     * for you) to decide each one.
     */
    readonly heldForOwner?: readonly { readonly id: string; readonly tool: string; readonly summary: string; readonly reason: string }[] | undefined;
}
/** What a resumed headless run restored from its session's crash snapshot, as the final frame and the `SESSION_RECOVERED` frame carry it. */
export interface HeadlessSessionRecovery {
    readonly sessionId: string;
    readonly applied: boolean;
    /** Why nothing was applied: `no-snapshot`, `unusable-snapshot` or `apply-failed`. */
    readonly refusal?: string | undefined;
    /** When the snapshot was written, ISO 8601. */
    readonly snapshotAt: string;
    /** True while the snapshot file is still on disk. */
    readonly snapshotKept: boolean;
    readonly messages: number;
    readonly turns: number;
    /** The turn the process stopped inside: its prompt (masked, bounded), tool results it had, tool calls recorded as interrupted, whether a reply was cut off. */
    readonly interruptedTurn?: {
        readonly prompt: string;
        readonly toolResults: number;
        readonly interruptedToolCalls: readonly { readonly callId: string; readonly tool: string }[];
        /** The model's reply was still arriving: its text is kept and marked cut off. */
        readonly partialReply: boolean;
    } | undefined;
    /** What could not be brought back, one line each. */
    readonly lost: readonly string[];
}
export type NativeHeadlessFailureCause = NativeIntakeFailureCause;
export function nativeHeadlessFailureCause(error: unknown): NativeHeadlessFailureCause {
    return nativeIntakeFailureCause(error);
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
            // The host fetch asks currentHost() around its request, so a changed selection stops discovery there.
            const operator = createOperatorApiClient({ baseUrl: host.baseUrl, authToken: host.token, fetchImpl: createNativeHostFetch({ current: () => !options.signal.aborted && currentHost() }) });
            let projectId: string;
            try {
                // The project of this program's folder, whatever folder the daemon runs in.
                projectId = await getOperatorWorkLedgerProject({ invoke: inProjectFolder(operator.invoke.bind(operator), host.workspace) }, { signal: AbortSignal.any([options.signal, AbortSignal.timeout(5000)]) });
            }
            finally {
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
                    // Settling an input (refused by the host, dropped, or its turn never started) goes to the same
                    // file the interactive app reads, so no stale record holds the next message back.
                    ...(journal.remove ? { remove: journal.remove.bind(journal) } : {}),
                    ...(journal.releaseTurnClaim ? { releaseTurnClaim: journal.releaseTurnClaim.bind(journal) } : {}),
                    // A turn that ran settles its record as the interactive app does, so no claim or record is left behind.
                    ...(journal.finishTurn ? { finishTurn: journal.finishTurn.bind(journal) } : {}),
                    ...(journal.discardUncaptured ? { discardUncaptured: journal.discardUncaptured.bind(journal) } : {}),
                    saveExecutionIntent: (binding, command, intent) => journal.saveExecutionIntent(binding, command, intent),
                    // A hosted reply needs its durable source identity recorded, as in the interactive app.
                    ...(journal.saveHostedSource ? { saveHostedSource: journal.saveHostedSource.bind(journal) } : {}),
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
                return { exitCode: 3, response: '', error: 'Native work cancellation could not be confirmed. The saved target is unchanged; inspect --intake-status.', stopReason: 'native-unknown', kind: 'outcome-unknown', cause: 'unknown', native: state };
            return resultForState(cancelledWork, options.mode);
        }
        if (state?.turnReady && state.turnPermit && state.result?.kind === 'turn') {
            inTurn = true;
            const turn = await options.runTurn(state, options.signal);
            // The turn ended (whatever its exit): its intake record has nothing left to fence.
            await state.finishTurn?.();
            // runTurn also awaits shutdown: a signal during cleanup still belongs to this invocation.
            return { ...turn, exitCode: options.signal.aborted ? 130 : turn.exitCode, native: state };
        }
        return resultForState(state, options.mode);
    }
    catch (error) {
        if (options.signal.aborted) {
            state = await cancellation ?? state;
            return cancelled();
        }
        // The host admitted the turn and it failed here, in this process: the outcome is known (it failed),
        // so say why and close its intake record rather than reporting an unknown host outcome.
        if (inTurn && state?.turnPermit) {
            try {
                await state.finishTurn?.();
            }
            catch { /* the next save under this binding replaces the record */ }
            return { exitCode: 1, response: '', error: `The turn failed in this process: ${summarizeError(error)}`, stopReason: 'unexpected_error', native: state };
        }
        const cause = nativeHeadlessFailureCause(error);
        if (!controls)
            return { ...resultForState(unavailable('Native host or authenticated project is unavailable. No input was captured.'), options.mode), cause };
        return { exitCode: 3, response: '', error: `Native outcome is unknown or unavailable (${cause}). Inspect --intake-status before explicit recovery.`, stopReason: 'native-unknown', kind: 'outcome-unknown', cause, ...(state ? { native: state } : {}) };
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
    const kind = exitCode === 3 ? 'outcome-unknown' : state?.status === 'unavailable' ? 'unavailable' : undefined;
    return { exitCode, response: state?.message ?? '', stopReason: `native-${result?.kind ?? state?.status ?? 'detached'}`, ...(kind ? { kind } : {}), ...(state?.cause ? { cause: state.cause } : {}), ...(state ? { native: state } : {}) };
}
/** Headless callers cannot type slash commands: name the equivalent `run` flag instead. */
export function headlessRecoveryText(text: string): string {
    return text
        .replace(/(?<![-\w])(?:\/work )?intake-(status|retry|resume|cancel)\b/g, '--intake-$1')
        .replace(/(?<![-\w])\/work intake(?![-\w])/g, '--intake-status')
        // A screen's words name the Work place's Unanswered list; a script settles the message with the run flags.
        .replace(/in Work, under Unanswered/g, 'with --intake-status, --intake-retry, --intake-resume or --intake-cancel');
}
// Synchronous so the line lands before the caller's process.exit; a pipe that refuses a sync write falls back.
const writeStderrLine = (line: string): void => {
    try {
        writeSync(2, `${line}\n`);
    }
    catch {
        process.stderr.write(`${line}\n`);
    }
};
export function writeNativeHeadlessResult(result: NativeHeadlessResult, format: string, stdout: (line: string) => void, alwaysNativeType = false, stderr: (line: string) => void = writeStderrLine): void {
    const { exitCode, native, decisionModel: use, ...turn } = result;
    // Whenever no decision model was in use (none set, switched off, or the set one failing), say so on
    // stderr and in the JSON diagnostics; the exit code stays what the work earned.
    const diagnostics = use === undefined || use.inUse ? undefined : { decisionModel: { inUse: false, policy: use.policy, reason: use.reason, line: use.line,
        ...(use.failure ? { failure: { model: use.failure.model, what: use.failure.what, nextStep: use.failure.nextStep } } : {}) } };
    if (diagnostics)
        stderr(diagnostics.decisionModel.line);
    // A model turn's answer (the run reached a session) is printed as the model gave it; only
    // product-written text (intake messages and recovery lines) names the `run` flags.
    const response = turn.sessionId === undefined ? headlessRecoveryText(turn.response) : turn.response;
    const error = turn.error === undefined ? undefined : headlessRecoveryText(turn.error);
    const execution = native?.execution ? { ...native.execution, message: headlessRecoveryText(native.execution.message) } : undefined;
    // Capabilities remain process-local. Never spread the state containing its permit.
    // nextStep names the one flag that moves an earlier input forward (--intake-<nextStep>); notSent says this
    // invocation's own text was not sent; hostedTurn carries a hosted reply's state and failure.
    const state = native ? { status: native.status, message: headlessRecoveryText(native.message), ...(native.cause ? { cause: native.cause } : {}), request: native.request, result: native.result, execution,
        ...(native.nextStep ? { nextStep: native.nextStep } : {}), ...(native.notSent ? { notSent: true } : {}), ...(native.hostedTurn ? { hostedTurn: native.hostedTurn } : {}) } : undefined;
    if (format === 'json' || format === 'stream-json') {
        // sessionId and usage are always present (null before a model turn) so every final frame has one shape.
        stdout(JSON.stringify({ ...(format === 'stream-json' ? { type: alwaysNativeType || state ? 'NATIVE_INTAKE_RESULT' : 'TURN_RESULT' } : {}), schemaVersion: HEADLESS_SCHEMA_VERSION, ok: exitCode === 0,
            ...turn, response, error, sessionId: turn.sessionId ?? null, usage: turn.usage ?? null, ...(state ? { native: state } : {}), ...(diagnostics ? { diagnostics } : {}) }));
        return;
    }
    // A failure that never reached a model turn is diagnostic text; a turn's answer stays on stdout.
    const diagnostic = exitCode !== 0 && turn.sessionId === undefined;
    const out = (diagnostic ? [] : [response, execution?.message]).filter(Boolean);
    const held = turn.heldForOwner?.length
        ? [`Held for you (not run): ${turn.heldForOwner.map((call) => `${call.id} ${call.tool}: ${headlessRecoveryText(call.reason)}`).join('; ')}`]
        : [];
    const err = (diagnostic ? [response, error, execution?.message] : [error, ...held]).filter(Boolean);
    if (out.length)
        stdout(out.join('\n'));
    if (err.length)
        stderr(err.join('\n'));
}
/**
 * Run under `--timeout`: the deadline aborts the same signal Ctrl-C does, and a
 * run that ended because of it reports exit 124 and stopReason `timeout`.
 */
export async function runWithHeadlessTimeout(signal: AbortSignal, timeoutMs: number | undefined, run: (signal: AbortSignal) => Promise<NativeHeadlessResult>): Promise<NativeHeadlessResult> {
    if (timeoutMs === undefined)
        return run(signal);
    const deadline = new AbortController();
    // Referenced: it is what the run waits on when nothing else is, and an
    // unreferenced one leaves Bun ticking a full core under the entry's top-level await.
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    try {
        const result = await run(AbortSignal.any([signal, deadline.signal]));
        if (!deadline.signal.aborted || signal.aborted || result.exitCode !== 130)
            return result;
        const seconds = Number((timeoutMs / 1000).toFixed(3));
        return { ...result, exitCode: 124, stopReason: 'timeout', error: [`Stopped after --timeout ${seconds}s.`, result.error].filter(Boolean).join(' ') };
    }
    finally {
        clearTimeout(timer);
    }
}
