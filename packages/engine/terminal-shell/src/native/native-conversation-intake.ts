import { nativeHostedTurnLookupSchema } from '@goodvibes-jev/engine/platform/platform/hosted-sessions/native-turn-client';
import { nativeHostedTurnLines, type NativeHostedTurnClient, type NativeHostedTurnLookup } from './native-hosted-turn.js';
import type { OperatorNativeWorkExecutionClient } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-execution-client';
import { nativeWorkExecutionLines, type NativeWorkExecutionState } from './native-work-execution.js';
import { nativeConversationExecutionIntent, sameNativeExecutionIntent, inspectNativeConversationExecution, dispatchNativeConversationExecution } from './native-conversation-execution.js';
import { nativeConversationIntakeCaptureRequestSchema, nativeConversationIntakeResultSchema, sameNativeConversationSource, type NativeConversationIntakeCaptureRequest, type NativeConversationIntakeResult, type NativeConversationIntakeSourceRef, type OperatorNativeConversationIntakeClient, type NativeConversationTurnPermit, } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-intake-client';
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
/** The one step that moves an earlier, unresolved input forward, decided from its recorded state. */
export type NativeIntakeNextStep = 'retry' | 'resume' | 'inspect' | 'cancel';
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
    readonly request?: Readonly<Pick<NativeConversationIntakeCaptureRequest, 'requestId' | 'inputId'>> | undefined;
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
                    return { status: 'invalid', message: 'Another input is active. The retained input was not detached or cancelled.' };
                this.close();
            }
            else
                return { status: 'pending', message: 'Native intake is already pending. No second input or dispatch was created.' };
        }
        if (!selected.available)
            return { status: 'unavailable', message: selected.reason };
        // Validate source before network access or identity allocation.
        if (source && ((!this.policy.allowHosted && options?.delivery !== undefined) || (options?.continuationSessionId !== undefined && options.delivery !== 'hosted')
            || (options?.delivery !== undefined && options.delivery !== 'hosted')
            || !nativeConversationIntakeCaptureRequestSchema.safeParse({ requestId: 'validation', inputId: 'validation', text: source.text, unsupportedSources: source.unsupportedSources, ...(options?.continuationSessionId !== undefined ? { continuation: { sessionId: options.continuationSessionId } } : {}) }).success)) {
            return { status: 'invalid', message: 'Native intake requires complete bounded original text and at most 100 source references.' };
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
        const request = () => command ? { requestId: command.requestId, inputId: command.inputId } : undefined;
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
            /** The input is settled for this client: its record has nothing left to protect. */
            const settled = async () => {
                if (!selected.journal.remove || !command)
                    return;
                phase = 'journal-remove';
                await selected.journal.remove(scope, command);
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
                    if (action === 'status' || !('kind' in found))
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
                const found = await binding.client.get({ inputId: command.inputId }, { signal: controller.signal });
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
                    if ('kind' in hostedTurn || !['completed', 'cancelled'].includes(hostedTurn.state))
                        return { status: 'recorded', message: 'Your previous message is still running on the host. Check it with /work intake-status, or stop it with /work intake-cancel. This new message was not sent.', request: request(), result, hostedTurn, hostedCurrent, nextStep: 'inspect', notSent: true };
                    if (options?.delivery === 'hosted' && nextContinuation === undefined && hostedTurn.sessionId)
                        nextContinuation = hostedTurn.sessionId;
                }
                else if (options?.delivery === 'hosted')
                    return { status: 'unknown', message: 'Your previous message ran in this process and its end was never confirmed, so the host cannot take the next one. Check it with /work intake-status. This new message was not sent.', request: request(), result, nextStep: 'inspect', notSent: true };
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
                    return { status: 'recorded', message: 'Your previous message became work that is still running. Follow it in /work; the next message can be sent once that work has ended. This new message was not sent.', request: request(), result, execution, nextStep: 'inspect', notSent: true };
                if (!execution.snapshot)
                    return { status: 'recorded', message: 'Your previous message became work whose start was never confirmed. Start it with /work intake-retry. This new message was not sent.', request: request(), result, execution, nextStep: 'retry', notSent: true };
            }
            const unsaved = !result && command !== undefined && retained !== undefined && !retained.persisted && sameCommand(command, retained.command) && stored?.command.requestId !== command.requestId;
            if (mode === 'submit') {
                if (command && (!result || !terminal(result))) {
                    const next = unresolvedNextStep(result);
                    return { status: 'unknown', message: unsaved
                            ? 'Your previous message was never saved and the host has no record of it. Send it with /work intake-retry, or drop it with /work intake-cancel. This new message was not sent.'
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
                return { status: 'unavailable', message: 'No retained ordinary input exists for this host, project, workspace and verified principal.' };
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
                result = validate(await binding.client.capture(command, { signal: controller.signal }));
                if (!current())
                    return;
                eligibleTurn = result.kind === 'turn';
            }
            if (mode === 'cancel' && unsaved) {
                // Never saved and never captured, so nothing exists anywhere that could still run or be replayed.
                if (this.retained === retained)
                    this.retained = undefined;
                return { status: 'unavailable', message: 'The earlier input was never saved to the intake journal and the host has no record of it. It was discarded and nothing ran; submit a new input.' };
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
                return { status: 'unavailable', message: 'The earlier input was written to the intake journal but never sent to the host. It was removed from the journal and nothing ran; submit a new input.' };
            }
            if (!result)
                return { status: 'unknown', message: 'Original input was not found at this lookup. Only intake-retry may replay its exact durable capture.', request: request() };
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
                // A hosted turn that finished or was cancelled is the host's to show; nothing here can run it again.
                if (!('kind' in hostedTurn) && ['completed', 'cancelled'].includes(hostedTurn.state)) {
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
                }
            }
            const turnPermit = turnReady ? binding.client.bindTurn(result) : undefined;
            const finishTurn = async (): Promise<void> => {
                try {
                    await selected.journal.finishTurn?.(scope, claimedCommand, claimedRevision);
                }
                catch { /* the next save under this binding replaces the record */ }
            };
            return { status: 'recorded', message: hostedTurn ? (result.sourceRef.classic ? 'Owner-authorized Classic conversation recorded for host-owned delivery; no decision-model receipt.' : 'Native conversational decision recorded for host-owned delivery.') : describeResult(result, turnReady, Boolean(stored?.dispatch)), request: request(), result, ...(hostedTurn ? { hostedTurn, hostedCurrent } : {}), ...(execution ? { execution } : {}), ...(turnReady ? { turnReady: true, turnPermit, releaseTurnClaim: releaseClaim, finishTurn } : {}) };
        }
        catch (error) {
            if (!current())
                return;
            const cause = nativeIntakeFailureCause(error);
            return { status: command ? 'unknown' : 'unavailable', cause, request: request(), message: phase === 'journal-remove'
                    ? 'The input is settled on the host, but its journal record could not be removed now. Nothing else was sent; the next input replaces it.'
                    : isJournalPhase(phase)
                    ? 'The durable intake journal could not be confirmed. No further request or ordinary turn was sent. The visible original input and dispatch claim are preserved.'
                    : !command && cause === 'principal'
                    ? 'This terminal is not paired with the connected host, so nothing was sent to it. Pair it (/setup pair in the Agent, /host pair in the terminal app) to use it.'
                    : !command && (cause === 'network' || cause === 'host_changed')
                    ? 'The connected host could not be reached, so nothing was sent to it.'
                    : !command
                    ? `The connected host's answer could not be used (${cause}), so nothing was sent to it.`
                    : 'Native intake outcome is unknown or unavailable. Inspect /work intake-status before retrying the same input; an interrupted request may already have taken effect.',
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
        case 'retry': return 'Your previous message was saved but its admission never finished. Send it with /work intake-retry, or drop it with /work intake-cancel. This new message was not sent.';
        case 'resume': return 'Your previous message was interrupted while the host was admitting it. Continue it with /work intake-resume, or drop it with /work intake-cancel. This new message was not sent.';
        case 'cancel': return 'Your previous message cannot continue. Drop it with /work intake-cancel. This new message was not sent.';
        case 'inspect': return 'Your previous message has not settled. Check it with /work intake-status, or drop it with /work intake-cancel. This new message was not sent.';
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
        case 'captured': return 'Original text is durably captured. Use /work intake-retry to request admission.';
        case 'processing': return `Native intake is ${result.stage}. Use /work intake-status to inspect or intake-resume for explicit recovery.`;
        case 'turn': return turnReady ? result.sourceRef.classic ? 'Owner-authorized Classic conversation recorded; original turn dispatch claimed without a decision-model receipt.' : `Native ${result.route} decision recorded; original turn dispatch claimed.` : dispatched ? 'Recovery required: this original turn already has a durable dispatch claim and may have run. Inspect the conversation before submitting a new input; it will not be automatically replayed.' : result.sourceRef.classic ? 'Classic conversation is recorded. This lookup did not dispatch it. Use /work intake-retry for explicit recovery.' : 'Native conversational decision is recorded. This lookup did not dispatch it. Use /work intake-retry for explicit recovery.';
        case 'blocked': return `Native intake blocked: ${result.reason}. This input is unchanged; submit a new complete input to proceed.`;
        case 'refused': return `Native intake refused: ${result.reason}. This input cannot be retried into new work.`;
        case 'cancelled': return 'Native intake cancelled. No ordinary turn or work execution was started.';
        case 'work': return 'Native work admission recorded against the original source. Execution status is shown separately.';
    }
}
export function nativeConversationIntakeLines(state: NativeConversationIntakeState | undefined): string[] {
    if (!state)
        return ['Native intake detached because its host, credentials or workspace changed. No stale turn was dispatched.'];
    const lines = [state.message];
    if (state.request)
        lines.push(`requestId ${state.request.requestId} · inputId ${state.request.inputId}`);
    if (state.result?.kind === 'work') {
        const receipt = state.result.receipt;
        lines.push(`Native target: work ${receipt.workId} · attempt ${receipt.attemptId} · ledger revision ${receipt.ledgerRevision}`, `Inspect /work for native status and explicit recovery controls. Source ${receipt.source.sourceId} revision ${receipt.source.sourceRevision}.`);
    }
    if (state.hostedTurn)
        lines.push(...nativeHostedTurnLines(state.hostedTurn));
    if (state.execution)
        lines.push(...nativeWorkExecutionLines(state.execution));
    return lines.map(line => line.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' '));
}
