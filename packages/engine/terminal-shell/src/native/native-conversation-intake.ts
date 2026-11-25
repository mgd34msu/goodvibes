import { nativeHostedTurnLookupSchema } from '@goodvibes/engine/platform/platform/hosted-sessions/native-turn-client';
import { nativeHostedTurnLines, type NativeHostedTurnClient, type NativeHostedTurnLookup } from './native-hosted-turn.js';
import type { OperatorNativeWorkExecutionClient } from '@goodvibes/engine/platform/platform/workflow/work-ledger/native-execution-client';
import { nativeWorkExecutionLines, type NativeWorkExecutionState } from './native-work-execution.js';
import { nativeConversationExecutionIntent, sameNativeExecutionIntent, inspectNativeConversationExecution, dispatchNativeConversationExecution } from './native-conversation-execution.js';
import { nativeConversationIntakeCaptureRequestSchema, nativeConversationIntakeResultSchema, sameNativeConversationSource, type NativeConversationIntakeCaptureRequest, type NativeConversationIntakeResult, type NativeConversationIntakeSourceRef, type OperatorNativeConversationIntakeClient, type NativeConversationTurnPermit, } from '@goodvibes/engine/platform/platform/workflow/work-ledger/native-intake-client';
import type { NativeConversationInput } from './native-conversation-input.js';
import { NativeIntakeJournalError, type NativeIntakeJournalBinding, type NativeConversationIntakeJournal } from './native-conversation-intake-journal.js';
import { NativeHostSelectionChangedError } from './native-host-fetch.js';
/** Construction-owned product capabilities, never selected by a decision or tool argument. */
export interface NativeConversationIntakePolicy {
    readonly allowHosted: boolean;
    readonly allowSelectedDiff: boolean;
}
/**
 * The terminal app (`goodvibes`): selected-diff input, never hosted turns. One object for the
 * controls, the journal and headless runs, so a record one writes the others can always read.
 */
export const TUI_NATIVE_INTAKE_POLICY: NativeConversationIntakePolicy = Object.freeze({ allowHosted: false, allowSelectedDiff: true });
/** The Agent (`goodvibes-agent`): hosted turns, never selected-diff input. */
export const AGENT_NATIVE_INTAKE_POLICY: NativeConversationIntakePolicy = Object.freeze({ allowHosted: true, allowSelectedDiff: false });
export interface NativeConversationIntakeBinding {
    readonly client: OperatorNativeConversationIntakeClient;
    readonly execution: OperatorNativeWorkExecutionClient;
    readonly hostedTurn?: NativeHostedTurnClient | undefined;
    readonly readPrincipal: (signal: AbortSignal) => Promise<string>;
    readonly dispose: () => void;
}
export type NativeConversationIntakeSelection = {
    readonly available: false;
    readonly identity: string;
    readonly reason: string;
} | {
    readonly available: true;
    readonly identity: string;
    readonly endpoint: string;
    readonly projectId: string;
    readonly workspace: string;
    readonly journal: Pick<NativeConversationIntakeJournal, 'read' | 'save' | 'confirm' | 'claimTurn' | 'saveExecutionIntent'> & Partial<Pick<NativeConversationIntakeJournal, 'saveHostedSource' | 'path' | 'releaseTurnClaim' | 'discardUncaptured' | 'remove' | 'finishTurn'>>;
    readonly bind: () => NativeConversationIntakeBinding;
};
/** Non-secret reason a native operation failed, for scripts to branch on. */
export type NativeIntakeFailureCause = 'journal_conflict' | 'journal' | 'principal' | 'network' | 'schema' | 'host_changed' | 'unknown';
/** A failure whose cause the intake knows where it raised it; nothing reads its wording. */
export class NativeIntakeFailure extends Error {
    constructor(readonly failure: NativeIntakeFailureCause, message: string) {
        super(message);
        this.name = 'NativeIntakeFailure';
    }
}
/** Codes the host answers with when this credential is not a paired owner with the scopes the call needs. */
const PRINCIPAL_CODES: ReadonlySet<unknown> = new Set(['PAIRED_OWNER_REQUIRED', 'FORBIDDEN', 'UNAUTHORIZED']);
export function nativeIntakeFailureCause(error: unknown): NativeIntakeFailureCause {
    if (error instanceof NativeIntakeFailure)
        return error.failure;
    if (error instanceof NativeIntakeJournalError)
        return error.code === 'conflict' ? 'journal_conflict' : 'journal';
    if (error instanceof NativeHostSelectionChangedError)
        return 'host_changed';
    if (!(error instanceof Error))
        return 'unknown';
    const code = (error as { readonly code?: unknown }).code;
    const kind = (error as { readonly kind?: unknown }).kind;
    if (error.name === 'ZodError' || code === 'invalid_response' || kind === 'contract' || kind === 'protocol' || kind === 'validation')
        return 'schema';
    if (kind === 'auth' || PRINCIPAL_CODES.has(code))
        return 'principal';
    if (kind === 'network' || code === 'aborted' || error instanceof TypeError || error.name === 'TimeoutError' || error.name === 'AbortError')
        return 'network';
    return 'unknown';
}
/**
 * The host's own words when it answered a request with a definite refusal: a
 * 4xx it decided before recording anything (an unregistered workspace, a
 * missing scope, an invalid source). A timeout, a conflict with a stored
 * record or a rate limit is not definite: the input may exist on the host.
 */
const INDEFINITE_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 409, 425, 429]);
function definiteHostRefusal(error: unknown): string | undefined {
    if (!(error instanceof Error))
        return undefined;
    const status = (error as { readonly status?: unknown }).status;
    if (typeof status !== 'number' || status < 400 || status > 499 || INDEFINITE_CLIENT_STATUSES.has(status))
        return undefined;
    return error.message.trim() || `The host refused the input (${status}).`;
}
/** The one step that moves an earlier, unresolved input forward, decided from its recorded state. */
export type NativeIntakeNextStep = 'retry' | 'resume' | 'inspect' | 'cancel';
/** The answer when no message typed in this folder waits: not a failure to read. */
export const NO_TYPED_MESSAGE_WAITS = 'No message you typed in this folder waits for an answer.';
export interface NativeConversationIntakeState {
    readonly status: 'pending' | 'recorded' | 'unknown' | 'invalid' | 'unavailable';
    readonly message: string;
    /** Why a failed operation failed, as a code a script can branch on; set on `unknown`/`unavailable` states from a thrown error. */
    readonly cause?: NativeIntakeFailureCause | undefined;
    /** The one command that moves the earlier input forward (`/work intake-<step>`, `--intake-<step>`). */
    readonly nextStep?: NativeIntakeNextStep | undefined;
    /**
     * Set when a submit was refused before this call saved or sent anything: the submitted text was not
     * sent and may be handed back to the person. `request` then names the earlier input, not this one.
     */
    readonly notSent?: true | undefined;
    /** The message's identity and the words typed (what the Work place's Unanswered list shows it by). */
    readonly request?: Readonly<Pick<NativeConversationIntakeCaptureRequest, 'requestId' | 'inputId'> & Partial<Pick<NativeConversationIntakeCaptureRequest, 'text'>>> | undefined;
    readonly result?: NativeConversationIntakeResult | undefined;
    /** Durable local dispatch claim acquired by this call only, never get/status. */
    readonly turnReady?: boolean | undefined;
    readonly turnPermit?: NativeConversationTurnPermit | undefined;
    /**
     * Present with a permit. Give the claim back when the turn is known never to have started, so an explicit
     * intake-retry can dispatch it; resolves false when the claim stays (it then reads as possibly run).
     */
    readonly releaseTurnClaim?: (() => Promise<boolean>) | undefined;
    /**
     * Present with a permit. Call once the local turn has ended: its journal record has nothing left to fence and
     * is removed. Never throws; a record that cannot be removed now is removed by the next input's save.
     */
    readonly finishTurn?: (() => Promise<void>) | undefined;
    readonly execution?: NativeWorkExecutionState | undefined;
    readonly hostedTurn?: NativeHostedTurnLookup | undefined;
    /** Selection fence survives operation completion, never grants authority. */
    readonly hostedCurrent?: (() => boolean) | undefined;
}
export interface NativeConversationIntakeSubmitOptions {
    readonly delivery?: 'hosted' | undefined;
    readonly continuationSessionId?: string | undefined;
}
export type NativeConversationIntakeRequestIdentity = Readonly<Pick<NativeConversationIntakeCaptureRequest, 'requestId' | 'inputId'>>;
export interface NativeConversationIntakeActions {
    submit(source: NativeConversationInput, options?: NativeConversationIntakeSubmitOptions | undefined): Promise<NativeConversationIntakeState | undefined>;
    status(): Promise<NativeConversationIntakeState | undefined>;
    retry(): Promise<NativeConversationIntakeState | undefined>;
    resume(): Promise<NativeConversationIntakeState | undefined>;
    cancel(expected?: NativeConversationIntakeRequestIdentity | undefined): Promise<NativeConversationIntakeState | undefined>;
    /** Stop this in-flight operation only; never adopt a newer journal request. */
    stop?(): Promise<NativeConversationIntakeState | undefined>;
    close(): void;
}
type Mode = 'submit' | 'status' | 'retry' | 'resume' | 'cancel';
/** The step an intake operation is in; error classification reads it, so a typo here must not compile. */
type IntakePhase =
    | 'principal' | 'get' | 'capture' | 'admit' | 'resume' | 'cancel'
    | 'execution-status' | 'execution-dispatch'
    | `hosted-${'status' | 'start' | 'cancel'}`
    | 'journal-read' | 'journal-save' | 'journal-confirm' | 'journal-claim' | 'journal-execution' | 'journal-hosted-source' | 'journal-remove';
const isJournalPhase = (phase: IntakePhase): boolean => phase.startsWith('journal-');
const terminal = (result: NativeConversationIntakeResult) => ['turn', 'work', 'blocked', 'refused', 'cancelled'].includes(result.kind);
/** A hosted turn the host will not run again: completed, cancelled, or failed without a retry. */
const hostedTurnEnded = (turn: Exclude<NativeHostedTurnLookup, { kind: 'not-found' }>) => turn.state === 'completed' || turn.state === 'cancelled' || (turn.state === 'failed' && turn.failure?.retryable !== true);
const sameCommand = (left: NativeConversationIntakeCaptureRequest, right: NativeConversationIntakeCaptureRequest) => JSON.stringify(left) === JSON.stringify(right);
/** Persist exact input first. Interrupted processing requires an explicit resume. */
export class NativeConversationIntakeControls implements NativeConversationIntakeActions {
    private epoch = 0;
    private selectionLifetime = 0;
    private active: {
        readonly identity: string;
        readonly detach: () => void;
        request?: NativeConversationIntakeRequestIdentity | undefined;
    } | undefined;
    private retained: {
        readonly identity: string;
        readonly scope: NativeIntakeJournalBinding;
        readonly command: NativeConversationIntakeCaptureRequest;
        readonly delivery?: 'hosted' | undefined;
        persisted: boolean;
        readonly expectedRequestId: string | null;
    } | undefined;
    private readonly policy: NativeConversationIntakePolicy;
    constructor(private readonly select: () => NativeConversationIntakeSelection, private readonly newId: () => string = () => crypto.randomUUID(), policy: NativeConversationIntakePolicy = { allowHosted: false, allowSelectedDiff: false }) {
        this.policy = Object.freeze({ allowHosted: policy.allowHosted === true, allowSelectedDiff: policy.allowSelectedDiff === true });
    }
    private selection(): NativeConversationIntakeSelection {
        try {
            return this.select();
        }
        catch {
            return { available: false, identity: 'selection-error', reason: 'Native intake host or journal is unavailable.' };
        }
    }
    close(): void { ++this.selectionLifetime; ++this.epoch; this.active?.detach(); this.active = undefined; }
    submit(source: NativeConversationInput, options?: NativeConversationIntakeSubmitOptions | undefined) { return this.run('submit', structuredClone(source), options ? structuredClone(options) : undefined); }
    status() { return this.run('status'); }
    retry() { return this.run('retry'); }
    resume() { return this.run('resume'); }
    cancel(expected?: NativeConversationIntakeRequestIdentity | undefined) { return this.run('cancel', undefined, undefined, expected ? { ...expected } : undefined); }
    /** Process-local identity, established only after this submit's durable save. */
    currentRequest(): NativeConversationIntakeRequestIdentity | undefined {
        const selected = this.selection();
        return selected.available && this.active?.identity === selected.identity && this.active.request ? { ...this.active.request } : undefined;
    }
    stop(): Promise<NativeConversationIntakeState | undefined> {
        const expected = this.currentRequest();
        // Stop is not a selection change: unlike close(), it leaves selectionLifetime alone so a turn
        // already being observed keeps its selection fence and can still be cancelled.
        ++this.epoch;
        this.active?.detach();
        this.active = undefined;
        return expected ? this.cancel(expected) : Promise.resolve(undefined);
    }
    private async run(mode: Mode, source?: NativeConversationInput | undefined, options?: NativeConversationIntakeSubmitOptions | undefined, expected?: NativeConversationIntakeRequestIdentity | undefined): Promise<NativeConversationIntakeState | undefined> {
        const selected = this.selection();
        if (this.active) {
            if (!selected.available || selected.identity !== this.active.identity) {
                this.close();
                return;
            }
            if (mode === 'cancel') {
                if (expected && (!this.active.request || expected.inputId !== this.active.request.inputId || expected.requestId !== this.active.request.requestId))
                    return { status: 'invalid', message: 'Another message is being sent now, so the saved one was not dropped.' };
                this.close();
            }
            else
                return { status: 'pending', message: 'Your message is still being sent; nothing was sent twice.' };
        }
        if (!selected.available)
            return { status: 'unavailable', message: selected.reason };
        // Validate source before network access or identity allocation.
        if (source && ((!this.policy.allowHosted && options?.delivery !== undefined) || (options?.continuationSessionId !== undefined && options.delivery !== 'hosted')
            || (options?.delivery !== undefined && options.delivery !== 'hosted')
            || !nativeConversationIntakeCaptureRequestSchema.safeParse({ requestId: 'validation', inputId: 'validation', text: source.text, unsupportedSources: source.unsupportedSources, ...(options?.continuationSessionId !== undefined ? { continuation: { sessionId: options.continuationSessionId } } : {}) }).success)) {
            return { status: 'invalid', message: 'This message is too long, or names more than 100 files or attachments, to be sent whole.' };
        }
        const epoch = ++this.epoch;
        const lifetime = this.selectionLifetime;
        const controller = new AbortController();
        let binding: NativeConversationIntakeBinding | undefined;
        let disposed = false;
        let command: NativeConversationIntakeCaptureRequest | undefined;
        let phase = 'principal' as IntakePhase;
        let delivery: 'hosted' | undefined;
        let observedSource: NativeConversationIntakeSourceRef | undefined;
        const hostedCurrent = (): boolean => { const now = this.selection(); return lifetime === this.selectionLifetime && now.available && now.identity === selected.identity && now.projectId === selected.projectId && now.workspace === selected.workspace; };
        const current = (): boolean => {
            if (epoch !== this.epoch || controller.signal.aborted)
                return false;
            const now = this.selection();
            return now.available && now.identity === selected.identity;
        };
        const dispose = () => { if (!disposed && binding) {
            disposed = true;
            try {
                binding.dispose();
            }
            catch { }
        } };
        const detach = () => { controller.abort(); dispose(); };
        // Selection is checked at every await below; nothing polls it in between.
        this.active = { identity: selected.identity, detach };
        // The words typed travel with the identity, so the Work place's Unanswered list names the message by them.
        const request = () => command ? { requestId: command.requestId, inputId: command.inputId, text: command.text } : undefined;
        const validate = (result: NativeConversationIntakeResult): NativeConversationIntakeResult => {
            const parsed = nativeConversationIntakeResultSchema.parse(result);
            if (!command || parsed.projectId !== selected.projectId || parsed.requestId !== command.requestId || parsed.sourceRef.inputId !== command.inputId
                || parsed.sourceRef.continuation?.sessionId !== command.continuation?.sessionId
                || (!this.policy.allowSelectedDiff && (parsed.sourceRef.continuation?.selectedDiff !== undefined || command.continuation?.selectedDiff !== undefined))
                || JSON.stringify(parsed.sourceRef.continuation?.selectedDiff) !== JSON.stringify(command.continuation?.selectedDiff)
                || (observedSource && !sameNativeConversationSource(observedSource, parsed.sourceRef, parsed.kind))
                || (parsed.kind === 'turn' && parsed.text !== command.text) || (parsed.kind === 'work' && parsed.receipt.goal !== command.text))
                throw new Error('Native intake source identity mismatch');
            observedSource = structuredClone(parsed.sourceRef);
            return result;
        };
        try {
            binding = selected.bind();
            if (!current())
                return;
            const principalId = await binding.readPrincipal(controller.signal);
            if (!current())
                return;
            if (!principalId || principalId.length > 200)
                throw new NativeIntakeFailure('principal', 'Unsupported native principal');
            const scope: NativeIntakeJournalBinding = { endpoint: selected.endpoint, projectId: selected.projectId, workspace: selected.workspace, principalId };
            phase = 'journal-read';
            const stored = await selected.journal.read(scope);
            if (!current())
                return;
            const retained = this.retained;
            if (retained?.identity === selected.identity && JSON.stringify(retained.scope) === JSON.stringify(scope)) {
                if (stored?.command.requestId === retained.command.requestId && (!sameCommand(stored.command, retained.command) || stored.delivery !== retained.delivery))
                    throw new Error('Retained source changed');
                command = !retained.persisted ? retained.command : stored?.command ?? retained.command;
            }
            else
                command = stored?.command;
            delivery = retained?.identity === selected.identity && !retained.persisted && command && sameCommand(command, retained.command) ? retained.delivery : stored?.delivery;
            if (delivery === 'hosted' && !this.policy.allowHosted)
                throw new Error('Hosted delivery is unavailable on this surface');
            observedSource = stored?.command.requestId === command?.requestId ? stored?.hostedSource : undefined;
            if (mode !== 'submit')
                this.active!.request = request();
            if (expected && (!command || expected.inputId !== command.inputId || expected.requestId !== command.requestId))
                return { status: 'invalid', message: 'The retained input changed. The newer input was not cancelled.', request: request() };
            // A record this call wrote, or already confirmed, is not read back before the next POST.
            let confirmed = false;
            const confirm = async () => {
                if (confirmed)
                    return;
                phase = 'journal-confirm';
                await selected.journal.confirm(scope, command!);
                confirmed = true;
            };
            /**
             * The input is settled for this client: its record has nothing left to protect. A remove that
             * fails is said on the result and nothing else changes: the next input's save replaces the record.
             */
            let removeFailed = false;
            const settled = async () => {
                if (!selected.journal.remove || !command)
                    return;
                phase = 'journal-remove';
                try {
                    await selected.journal.remove(scope, command);
                }
                catch {
                    removeFailed = true;
                }
            };
            const preserveHostedSource = async () => {
                if (delivery !== 'hosted' || !observedSource)
                    return;
                if (!selected.journal.saveHostedSource)
                    throw new Error('Hosted intake requires a durable source identity');
                phase = 'journal-hosted-source';
                await selected.journal.saveHostedSource(scope, command!, observedSource);
            };
            const hosted = async (action: 'status' | 'request' | 'cancel', source: Extract<NativeConversationIntakeResult, {
                kind: 'turn';
            }>): Promise<NativeHostedTurnLookup> => {
                if (!binding?.hostedTurn || delivery !== 'hosted' || !command)
                    throw new NativeIntakeFailure('unknown', 'Native hosted delivery is unavailable');
                validate(source);
                const original = command;
                const target = { projectId: selected.projectId, inputId: original.inputId, sourceRevision: source.sourceRef.sourceRevision };
                const observe = async (operation: 'status' | 'start' | 'cancel') => {
                    if (!current())
                        throw new NativeIntakeFailure('host_changed', 'Native hosted intake detached');
                    phase = `hosted-${operation}`;
                    const found = nativeHostedTurnLookupSchema.parse(await binding!.hostedTurn![operation](target, { signal: controller.signal }));
                    if (!current())
                        throw new NativeIntakeFailure('host_changed', 'Native hosted intake detached');
                    if (!('kind' in found) && (found.projectId !== target.projectId || found.requestId !== original.requestId
                        || found.inputId !== target.inputId || found.sourceRevision !== target.sourceRevision
                        || (original.continuation && found.sessionId !== null && found.sessionId !== original.continuation.sessionId)))
                        throw new Error('Native hosted response differs from the original input');
                    return found;
                };
                if (action !== 'cancel') {
                    const found = await observe('status');
                    // A turn that failed before any effect is started again with the same input (the host allows it).
                    const restartable = !('kind' in found) && found.state === 'failed' && found.failure?.retryable === true;
                    if (action === 'status' || (!('kind' in found) && !restartable))
                        return found;
                }
                await preserveHostedSource();
                if (!current())
                    throw new NativeIntakeFailure('host_changed', 'Native hosted intake detached');
                await confirm();
                if (!current())
                    throw new NativeIntakeFailure('host_changed', 'Native hosted intake detached');
                return observe(action === 'cancel' ? 'cancel' : 'start');
            };
            let result: NativeConversationIntakeResult | undefined;
            let eligibleTurn = false;
            if (command) {
                phase = 'get';
                let found: Awaited<ReturnType<typeof binding.client.get>>;
                try {
                    found = await binding.client.get({ inputId: command.inputId }, { signal: controller.signal });
                }
                catch (error) {
                    const refused = definiteHostRefusal(error);
                    if (refused === undefined || !current())
                        throw error;
                    const principal = PRINCIPAL_CODES.has((error as { readonly code?: unknown }).code);
                    // The host refuses to look the saved message up (the workspace is not registered, say): it
                    // cannot admit or run it either, since admission is refused the same way. Dropping it is safe.
                    if (mode === 'cancel') {
                        await settled();
                        if (!current())
                            return;
                        if (this.retained?.command.requestId === command.requestId)
                            this.retained = undefined;
                        return { status: 'unavailable', ...(principal ? { cause: 'principal' as const } : {}), message: removeFailed
                                ? `The daemon refused to look up the earlier message, so it is not running: ${refused} Its saved copy could not be removed now; drop it again in Work, under Unanswered.`
                                : `The daemon refused to look up the earlier message, so it is not running: ${refused} Its saved copy was dropped.` };
                    }
                    return { status: 'unavailable', ...(principal ? { cause: 'principal' as const } : {}), request: request(), nextStep: 'cancel',
                        message: `The daemon refused this: ${refused} Your earlier message is still saved here; once that is fixed, try it again or drop it in Work, under Unanswered.${mode === 'submit' ? ' This new message was not sent.' : ''}`,
                        ...(mode === 'submit' ? { notSent: true as const } : {}) };
                }
                if (!current())
                    return;
                if (found.kind !== 'not-found')
                    result = validate(found);
            }
            let nextContinuation = options?.continuationSessionId;
            if (mode === 'submit' && command && result?.kind === 'turn') {
                if (delivery === 'hosted') {
                    const hostedTurn = await hosted('status', result);
                    if (!current())
                        return;
                    if (!('kind' in hostedTurn) && hostedTurn.state === 'failed' && hostedTurn.failure?.retryable === true)
                        return { status: 'recorded', message: `Your previous message failed on the daemon before changing anything${hostedTurn.failure?.summary ? ` (${hostedTurn.failure.summary})` : ''}. Try it again or drop it in Work, under Unanswered. This new message was not sent.`, request: request(), result, hostedTurn, hostedCurrent, nextStep: 'retry', notSent: true };
                    if ('kind' in hostedTurn || !hostedTurnEnded(hostedTurn))
                        return { status: 'recorded', message: 'Your previous message is still running on the daemon. Check it or drop it in Work, under Unanswered. This new message was not sent.', request: request(), result, hostedTurn, hostedCurrent, nextStep: 'inspect', notSent: true };
                    if (options?.delivery === 'hosted' && nextContinuation === undefined && hostedTurn.sessionId)
                        nextContinuation = hostedTurn.sessionId;
                }
                else if (options?.delivery === 'hosted')
                    return { status: 'unknown', message: 'Your previous message ran in this program and its end was never confirmed, so the daemon cannot take the next one. Check it in Work, under Unanswered. This new message was not sent.', request: request(), result, nextStep: 'inspect', notSent: true };
            }
            if (mode === 'submit' && command && result?.kind === 'work') {
                const intent = nativeConversationExecutionIntent(result.receipt);
                if (stored?.execution && !sameNativeExecutionIntent(stored.execution, intent))
                    throw new Error('Execution intent differs from recorded work');
                phase = 'execution-status';
                const execution = await inspectNativeConversationExecution(binding.execution, selected.projectId, intent, controller.signal);
                if (!current())
                    return;
                if (delivery !== options?.delivery && execution.snapshot && !['terminal', 'cancelled'].includes(execution.snapshot.recovery))
                    return { status: 'recorded', message: 'Your previous message became work that is still running. Follow it in Work; the next message can be sent once that work has ended. This new message was not sent.', request: request(), result, execution, nextStep: 'inspect', notSent: true };
                if (!execution.snapshot)
                    return { status: 'recorded', message: 'Your previous message became work whose start was never confirmed. Try it again in Work, under Unanswered, to start it, or drop the message there (the work stays in Work). This new message was not sent.', request: request(), result, execution, nextStep: 'retry', notSent: true };
            }
            const unsaved = !result && command !== undefined && retained !== undefined && !retained.persisted && sameCommand(command, retained.command) && stored?.command.requestId !== command.requestId;
            if (mode === 'submit') {
                if (command && (!result || !terminal(result))) {
                    const next = unresolvedNextStep(result);
                    return { status: 'unknown', message: unsaved
                            ? 'Your previous message was never saved and the daemon has no record of it. Try it again or drop it in Work, under Unanswered. This new message was not sent.'
                            : unresolvedMessage(next), request: request(), ...(result ? { result } : {}), nextStep: next, notSent: true };
                }
                command = nativeConversationIntakeCaptureRequestSchema.parse({ requestId: this.newId(), inputId: this.newId(), text: source!.text, unsupportedSources: source!.unsupportedSources, ...(nextContinuation !== undefined ? { continuation: { sessionId: nextContinuation } } : {}) });
                delivery = options?.delivery;
                observedSource = undefined;
                this.retained = { identity: selected.identity, scope, command: structuredClone(command), ...(delivery ? { delivery } : {}), persisted: false, expectedRequestId: stored?.command.requestId ?? null };
                phase = 'journal-save';
                await selected.journal.save(scope, command, stored?.command.requestId ?? null, delivery ? { delivery } : undefined);
                if (!current())
                    return;
                confirmed = true;
                this.retained.persisted = true;
                this.active!.request = request();
                result = undefined;
            }
            else if (!command)
                return { status: 'unavailable', message: NO_TYPED_MESSAGE_WAITS };
            if (!command)
                throw new Error('Missing original source');
            // A definite pre-publication failure can be repaired by explicit retry,
            // using the same command and original CAS predecessor. Published bytes
            // are confirmed in place; a competing durable identity is never replaced.
            if (mode === 'retry' && retained && !retained.persisted && sameCommand(command, retained.command)) {
                if (!stored || !sameCommand(stored.command, command)) {
                    phase = 'journal-save';
                    await selected.journal.save(scope, command, retained.expectedRequestId, retained.delivery ? { delivery: retained.delivery } : undefined);
                    if (!current())
                        return;
                    confirmed = true;
                }
                await confirm();
                if (!current())
                    return;
                retained.persisted = true;
            }
            if (!result && (mode === 'submit' || mode === 'retry')) {
                await confirm();
                if (!current())
                    return;
                phase = 'capture';
                let captured: NativeConversationIntakeResult;
                try {
                    captured = await binding.client.capture(command, { signal: controller.signal });
                }
                catch (error) {
                    const refused = definiteHostRefusal(error);
                    if (refused === undefined || !current())
                        throw error;
                    // Refused before the host recorded anything: there is nothing to retry, resume or cancel,
                    // so the record goes and the next input is not held behind this one.
                    await settled();
                    if (this.retained?.command.requestId === command.requestId)
                        this.retained = undefined;
                    // A 403 reads as an authentication failure by kind; only the principal codes say it is one.
                    const principal = PRINCIPAL_CODES.has((error as { readonly code?: unknown }).code);
                    return { status: 'unavailable', ...(principal ? { cause: 'principal' as const } : {}), request: request(),
                        message: `The daemon refused this message, so nothing was kept or run. ${refused}` };
                }
                result = validate(captured);
                if (!current())
                    return;
                eligibleTurn = result.kind === 'turn';
            }
            if (mode === 'cancel' && unsaved) {
                // Never saved and never captured, so nothing exists anywhere that could still run or be replayed.
                if (this.retained === retained)
                    this.retained = undefined;
                return { status: 'unavailable', message: 'The earlier message was never saved here and the daemon has no record of it. It was dropped and nothing ran; you can send a new message.' };
            }
            if (mode === 'cancel' && !result && retained && !retained.persisted && sameCommand(command, retained.command)
                && stored?.command.requestId === command.requestId && selected.journal.discardUncaptured) {
                // The save reported a durability failure after publishing its bytes, so the journal holds the text, but
                // no capture was ever requested (that waits for a confirmed save) and the host has no record of it.
                phase = 'journal-confirm';
                await selected.journal.discardUncaptured(scope, command);
                if (!current())
                    return;
                if (this.retained === retained)
                    this.retained = undefined;
                return { status: 'unavailable', message: 'The earlier message was saved here but never sent to the daemon. Its saved copy was dropped and nothing ran; you can send a new message.' };
            }
            if (!result && mode === 'cancel') {
                // The host has no record of it, so nothing ran and nothing can: a capture still on its
                // way would only be recorded, never admitted, since admission is a separate request
                // that only this saved copy could send. Dropping the saved copy ends it.
                await settled();
                if (!current())
                    return;
                if (this.retained?.command.requestId === command.requestId)
                    this.retained = undefined;
                return { status: 'unavailable', message: removeFailed
                        ? 'The earlier message never reached the daemon, so nothing ran, but its saved copy could not be removed now. Drop it again in Work, under Unanswered.'
                        : 'The earlier message never reached the daemon, so nothing ran. Its saved copy was dropped; you can send a new message.' };
            }
            if (!result)
                return { status: 'unknown', message: 'The daemon has no record of the earlier message, so nothing ran. Try it again or drop it in Work, under Unanswered.', request: request(), nextStep: 'retry' };
            if (mode !== 'status') {
                await preserveHostedSource();
                if (!current())
                    return;
            }
            const transition = { inputId: command.inputId, sourceRevision: result.sourceRef.sourceRevision };
            if (result.kind === 'captured' && (mode === 'submit' || mode === 'retry')) {
                await confirm();
                if (!current())
                    return;
                phase = 'admit';
                result = validate(await binding.client.admit(transition, { signal: controller.signal }));
                if (!current())
                    return;
                eligibleTurn = result.kind === 'turn';
            }
            else if (mode === 'resume' && (result.kind === 'processing' || result.kind === 'captured')) {
                await confirm();
                if (!current())
                    return;
                phase = 'resume';
                result = validate(await binding.client.resume(transition, { signal: controller.signal }));
                if (!current())
                    return;
                eligibleTurn = result.kind === 'turn';
            }
            else if (mode === 'cancel' && !terminal(result)) {
                await confirm();
                if (!current())
                    return;
                phase = 'cancel';
                result = validate(await binding.client.cancel(transition, { signal: controller.signal }));
                if (!current())
                    return;
            }
            // Lookup cannot authorize a local turn. Explicit recovery may request the
            // same immutable terminal response, provided no dispatch was claimed.
            if (delivery !== 'hosted' && result.kind === 'turn' && !eligibleTurn && (mode === 'retry' || mode === 'resume') && !stored?.dispatch) {
                await confirm();
                if (!current())
                    return;
                phase = 'resume';
                result = validate(await binding.client.resume(transition, { signal: controller.signal }));
                if (!current())
                    return;
                eligibleTurn = result.kind === 'turn';
            }
            let turnReady = false;
            const claimedCommand = command;
            const claimedRevision = result.sourceRef.sourceRevision;
            const releaseClaim = async (): Promise<boolean> => {
                if (!selected.journal.releaseTurnClaim)
                    return false;
                try {
                    await selected.journal.releaseTurnClaim(scope, claimedCommand, claimedRevision);
                    return true;
                }
                catch {
                    return false;
                }
            };
            if (delivery !== 'hosted' && result.kind === 'turn' && eligibleTurn && mode !== 'status' && mode !== 'cancel') {
                phase = 'journal-claim';
                turnReady = await selected.journal.claimTurn(scope, command, result.sourceRef.sourceRevision);
                if (!current()) {
                    // Detached after the claim and before any permit was handed out: nothing ran.
                    if (turnReady)
                        await releaseClaim();
                    return;
                }
            }
            let hostedTurn: NativeHostedTurnLookup | undefined;
            if (result.kind === 'turn' && delivery === 'hosted') {
                hostedTurn = await hosted(mode === 'status' ? 'status' : mode === 'cancel' ? 'cancel' : 'request', result);
                if (!current())
                    return;
                // A hosted turn that ended is the host's to show; nothing here can run it again. A retryable
                // failure keeps its record for /work intake-retry until the person drops it.
                if (!('kind' in hostedTurn) && (hostedTurnEnded(hostedTurn) || (mode === 'cancel' && hostedTurn.state === 'failed'))) {
                    await settled();
                    if (!current())
                        return;
                }
            }
            else if (result.kind === 'blocked' || result.kind === 'refused' || result.kind === 'cancelled') {
                // The host holds a terminal answer: nothing is left to resume, retry or dispatch from here.
                await settled();
                if (!current())
                    return;
            }
            let execution: NativeWorkExecutionState | undefined;
            if (result.kind === 'work') {
                const intent = nativeConversationExecutionIntent(result.receipt);
                const existing = stored?.command.requestId === command.requestId ? stored.execution : undefined;
                if (existing && !sameNativeExecutionIntent(existing, intent))
                    throw new Error('Execution intent differs from recorded work');
                if (mode === 'submit' || mode === 'retry' || mode === 'resume') {
                    phase = 'journal-execution';
                    await selected.journal.saveExecutionIntent(scope, command, intent);
                    if (!current())
                        return;
                    phase = 'execution-dispatch';
                    execution = await dispatchNativeConversationExecution(binding.execution, selected.projectId, intent, controller.signal);
                    if (!current())
                        return;
                    // The work receipt exists and its execution was requested: the host owns it from here (/work).
                    await settled();
                    if (!current())
                        return;
                }
                else {
                    phase = 'execution-status';
                    execution = await inspectNativeConversationExecution(binding.execution, selected.projectId, intent, controller.signal);
                    if (!current())
                        return;
                    // Work is never cancelled from intake: dropping the message drops only its record, and the
                    // work stays in the ledger, where /work starts or cancels it.
                    if (mode === 'cancel') {
                        await settled();
                        if (!current())
                            return;
                    }
                }
            }
            const turnPermit = turnReady ? binding.client.bindTurn(result) : undefined;
            const finishTurn = async (): Promise<void> => {
                try {
                    await selected.journal.finishTurn?.(scope, claimedCommand, claimedRevision);
                }
                catch { /* the next save under this binding replaces the record */ }
            };
            const message = mode === 'cancel' && result.kind === 'work'
                ? 'This message already became work, so the work was not stopped; the message was dropped and the work stays in Work, where it can be started or stopped.'
                : hostedTurn ? 'The daemon took your message as part of the conversation and answers it there.' : describeResult(result, turnReady, Boolean(stored?.dispatch));
            return { status: 'recorded', message: removeFailed ? `${message} Its saved copy could not be removed now; the next message replaces it.` : message, request: request(), result, ...(hostedTurn ? { hostedTurn, hostedCurrent } : {}), ...(execution ? { execution } : {}), ...(turnReady ? { turnReady: true, turnPermit, releaseTurnClaim: releaseClaim, finishTurn } : {}) };
        }
        catch (error) {
            if (!current())
                return;
            const cause = nativeIntakeFailureCause(error);
            return { status: command ? 'unknown' : 'unavailable', cause, request: request(), message: isJournalPhase(phase)
                    ? 'Your message could not be saved on this computer, so nothing more was sent. What was saved before is kept.'
                    : !command && cause === 'principal'
                    ? 'This terminal is not paired with the daemon, so nothing was sent to it. Pair it in Devices and network to use it.'
                    : !command && (cause === 'network' || cause === 'host_changed')
                    ? 'The daemon could not be reached, so nothing was sent to it.'
                    : !command
                    ? `The daemon's answer could not be used (${cause}), so nothing was sent to it.`
                    : 'Whether the daemon took your message is not known; it may already have. Check it in Work, under Unanswered, before trying it again.',
                ...(command ? { nextStep: 'inspect' as const } : {}) };
        }
        finally {
            dispose();
            if (epoch === this.epoch)
                this.active = undefined;
        }
    }
}
/** Which one command moves an earlier input forward: the host's record of it decides. */
function unresolvedNextStep(result: NativeConversationIntakeResult | undefined): NativeIntakeNextStep {
    if (!result || result.kind === 'captured')
        return 'retry';
    if (result.kind === 'processing')
        return 'resume';
    return 'inspect';
}
function unresolvedMessage(next: NativeIntakeNextStep): string {
    switch (next) {
        case 'retry': return 'Your previous message was saved but the daemon never finished taking it. Try it again or drop it in Work, under Unanswered. This new message was not sent.';
        case 'resume': return 'Your previous message was interrupted while the daemon was taking it. Go on with it or drop it in Work, under Unanswered. This new message was not sent.';
        case 'cancel': return 'Your previous message cannot go on. Drop it in Work, under Unanswered. This new message was not sent.';
        case 'inspect': return 'Your previous message has no answer yet. Check it or drop it in Work, under Unanswered. This new message was not sent.';
    }
}
/**
 * True for an input the host accepted as a conversation turn (this process runs it, or the host
 * runs it and this surface shows it): nothing in it needs the person, so its bookkeeping lines
 * (identifiers, recorded decision) belong in the activity feed, not the conversation.
 */
export function nativeConversationIntakeAccepted(state: NativeConversationIntakeState | undefined): boolean {
    if (!state || state.status !== 'recorded' || state.notSent || state.result?.kind !== 'turn')
        return false;
    if (state.turnReady)
        return true;
    const hosted = state.hostedTurn;
    return hosted !== undefined && !('kind' in hosted) && hosted.state !== 'recovery-required' && hosted.state !== 'failed';
}
function describeResult(result: NativeConversationIntakeResult, turnReady: boolean, dispatched: boolean): string {
    switch (result.kind) {
        case 'captured': return 'The daemon has your message but has not taken it yet. Try it again in Work, under Unanswered.';
        case 'processing': return 'The daemon is still taking your message. Check it or go on with it in Work, under Unanswered.';
        case 'turn': return turnReady ? 'Your message is answered here, in the conversation.' : dispatched ? 'This message may already have been answered, so it is not sent again. Look at the conversation before sending a new message.' : 'The daemon took your message as part of the conversation, but it was not answered yet. Try it again in Work, under Unanswered.';
        case 'blocked': return `Your message was not taken: ${result.reason}. Nothing changed; send a new message.`;
        case 'refused': return `Your message was refused: ${result.reason}. It cannot become work.`;
        case 'cancelled': return 'Your message was dropped. Nothing was run.';
        case 'work': return 'Your message became a piece of work: it is in Work.';
    }
}
export function nativeConversationIntakeLines(state: NativeConversationIntakeState | undefined): string[] {
    if (!state)
        return ['The daemon or this folder changed while your message was sent, so its answer was set aside. Nothing was run from it.'];
    const lines = [state.message];
    if (state.hostedTurn)
        lines.push(...nativeHostedTurnLines(state.hostedTurn));
    if (state.execution)
        lines.push(...nativeWorkExecutionLines(state.execution));
    return lines.map(line => line.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' '));
}
