import { nativeWorkExecutionIdentitySchema } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-execution-client';
import { BoundedJsonFile, type BoundedJsonFileIO, type BoundedJsonFileTransaction } from '@goodvibes-jev/engine/platform/platform/state/durable-file-io';
import { nativeConversationIntakeCaptureRequestSchema, nativeConversationIntakeSourceRefSchema, type NativeConversationIntakeSourceRef, type NativeConversationIntakeCaptureRequest, } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-intake-client';
/**
 * A sanity bound on the file, not a capacity: the journal holds only inputs in
 * flight (one per host, project, workspace and principal), each bounded by the
 * capture schema, so a file this large is not one this journal wrote.
 */
export const NATIVE_INTAKE_JOURNAL_MAX_BYTES = 16 * 1024 * 1024;
/** The principal must come from this connection's live verified auth.current. */
export interface NativeIntakeJournalBinding {
    readonly endpoint: string;
    readonly projectId: string;
    readonly workspace: string;
    readonly principalId: string;
}
import type { NativeIntakeExecutionIntent } from './types.js';
export type { NativeIntakeExecutionIntent } from './types.js';
/** Captured by the product host; journal contents cannot widen this policy. */
export interface NativeIntakeJournalPolicy {
    readonly allowHosted: boolean;
    readonly allowSelectedDiff: boolean;
}
export interface NativeIntakeJournalOptions {
    readonly delivery?: 'hosted' | undefined;
}
export interface NativeIntakeJournalRecord {
    readonly binding: NativeIntakeJournalBinding;
    readonly command: NativeConversationIntakeCaptureRequest;
    readonly delivery?: 'hosted' | undefined;
    /** First authoritative source identity, never refreshed during recovery. */
    readonly hostedSource?: NativeConversationIntakeSourceRef | undefined;
    readonly dispatch?: {
        readonly sourceRevision: string;
    } | undefined;
    readonly execution?: NativeIntakeExecutionIntent | undefined;
}
export type NativeIntakeJournalIO = BoundedJsonFileIO;
export class NativeIntakeJournalError extends Error {
    constructor(readonly code: 'invalid_binding' | 'invalid_command' | 'invalid_journal' | 'conflict') {
        super(`Native intake journal: ${code}`);
        this.name = 'NativeIntakeJournalError';
    }
}
interface JournalFile {
    readonly version: 1;
    readonly records: NativeIntakeJournalRecord[];
}
const bindingKeys = ['endpoint', 'projectId', 'workspace', 'principalId'] as const;
const ownKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => (!!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
function copyBinding(value: unknown): NativeIntakeJournalBinding {
    if (!ownKeys(value, bindingKeys) || !bindingKeys.every(key => typeof value[key] === 'string'
        && value[key].length > 0 && value[key].length <= 4096 && /\S/u.test(value[key]))) {
        throw new NativeIntakeJournalError('invalid_binding');
    }
    const binding = value as unknown as NativeIntakeJournalBinding;
    // Never persist credentials, bearer-bearing queries or fragments in an endpoint.
    let endpoint: URL;
    try {
        endpoint = new URL(binding.endpoint);
    }
    catch {
        throw new NativeIntakeJournalError('invalid_binding');
    }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new NativeIntakeJournalError('invalid_binding');
    }
    return { endpoint: binding.endpoint, projectId: binding.projectId, workspace: binding.workspace, principalId: binding.principalId };
}
function copyCommand(value: unknown, policy: NativeIntakeJournalPolicy): NativeConversationIntakeCaptureRequest {
    const parsed = nativeConversationIntakeCaptureRequestSchema.safeParse(value);
    if (!parsed.success || (!policy.allowSelectedDiff && parsed.data.continuation?.selectedDiff !== undefined))
        throw new NativeIntakeJournalError('invalid_command');
    return parsed.data;
}
const sameBinding = (left: NativeIntakeJournalBinding, right: NativeIntakeJournalBinding): boolean => (bindingKeys.every(key => left[key] === right[key]));
const sameCommand = (left: NativeConversationIntakeCaptureRequest, right: NativeConversationIntakeCaptureRequest): boolean => (JSON.stringify(left) === JSON.stringify(right));
function copyExecutionIntent(value: unknown): NativeIntakeExecutionIntent {
    if (!ownKeys(value, ['sourceRevision', 'target']) || typeof value.sourceRevision !== 'string' || !value.sourceRevision.length || value.sourceRevision.length > 200)
        throw new NativeIntakeJournalError('invalid_command');
    const target = nativeWorkExecutionIdentitySchema.safeParse(value.target);
    if (!target.success)
        throw new NativeIntakeJournalError('invalid_command');
    return { sourceRevision: value.sourceRevision, target: target.data };
}
function validateFile(value: unknown, policy: NativeIntakeJournalPolicy): JournalFile {
    if (!ownKeys(value, ['version', 'records']) || value.version !== 1 || !Array.isArray(value.records)) {
        throw new NativeIntakeJournalError('invalid_journal');
    }
    const records: NativeIntakeJournalRecord[] = [];
    for (const record of value.records) {
        if (!record || typeof record !== 'object' || Array.isArray(record)
            || !Object.hasOwn(record, 'binding') || !Object.hasOwn(record, 'command')
            || Object.keys(record).some(key => !(policy.allowHosted ? ['binding', 'command', 'delivery', 'hostedSource', 'dispatch', 'execution'] : ['binding', 'command', 'dispatch', 'execution']).includes(key)))
            throw new NativeIntakeJournalError('invalid_journal');
        const value = record as Record<string, unknown>;
        if (Object.hasOwn(value, 'delivery') && value.delivery !== 'hosted')
            throw new NativeIntakeJournalError('invalid_journal');
        let parsed: NativeIntakeJournalRecord;
        try {
            parsed = { binding: copyBinding(value.binding), command: copyCommand(value.command, policy), ...(value.delivery === 'hosted' ? { delivery: 'hosted' as const } : {}) };
        }
        catch {
            throw new NativeIntakeJournalError('invalid_journal');
        }
        if ('hostedSource' in record) {
            const source = nativeConversationIntakeSourceRefSchema.safeParse(record.hostedSource);
            if (parsed.delivery !== 'hosted' || !source.success || (!policy.allowSelectedDiff && source.data.continuation?.selectedDiff !== undefined) || source.data.inputId !== parsed.command.inputId
                || source.data.continuation?.sessionId !== parsed.command.continuation?.sessionId)
                throw new NativeIntakeJournalError('invalid_journal');
            parsed = { ...parsed, hostedSource: source.data };
        }
        if ('dispatch' in record) {
            if (!ownKeys(record.dispatch, ['sourceRevision']) || typeof record.dispatch.sourceRevision !== 'string' || !record.dispatch.sourceRevision.length || record.dispatch.sourceRevision.length > 200)
                throw new NativeIntakeJournalError('invalid_journal');
            parsed = { ...parsed, dispatch: { sourceRevision: record.dispatch.sourceRevision } };
        }
        if ('execution' in record) {
            try {
                parsed = { ...parsed, execution: copyExecutionIntent(record.execution) };
            }
            catch {
                throw new NativeIntakeJournalError('invalid_journal');
            }
        }
        if ((parsed.dispatch && (parsed.execution || parsed.delivery === 'hosted')) || (policy.allowHosted && parsed.command.continuation && parsed.delivery !== 'hosted'))
            throw new NativeIntakeJournalError('invalid_journal');
        if (records.some(existing => sameBinding(existing.binding, parsed.binding)))
            throw new NativeIntakeJournalError('invalid_journal');
        records.push(parsed);
    }
    return { version: 1, records };
}
/**
 * The inputs in flight, one per host, project, workspace and principal. A record
 * exists from submit until nothing more depends on this client: the host has a
 * terminal answer (blocked, refused, cancelled), the work receipt exists and its
 * execution was requested, the hosted turn is terminal, or the local turn this
 * client dispatched has finished. Then it is removed. Every mutation takes the
 * file's lock and publishes durably. An AtomicWriteDurabilityError escapes
 * unchanged: published-indeterminate bytes are never rolled back, treated as
 * absent or used for a POST without explicit confirmation.
 */
export class NativeConversationIntakeJournal {
    readonly path: string;
    private readonly policy: NativeIntakeJournalPolicy;
    private readonly file: BoundedJsonFile<JournalFile>;
    constructor(path: string, io: Partial<NativeIntakeJournalIO> = {}, policy: NativeIntakeJournalPolicy = { allowHosted: false, allowSelectedDiff: false }) {
        this.policy = Object.freeze({ allowHosted: policy.allowHosted === true, allowSelectedDiff: policy.allowSelectedDiff === true });
        this.file = new BoundedJsonFile<JournalFile>(path, {
            maxBytes: NATIVE_INTAKE_JOURNAL_MAX_BYTES, parse: value => validateFile(value, this.policy), empty: () => ({ version: 1, records: [] }),
            invalid: () => new NativeIntakeJournalError('invalid_journal'), limit: () => new NativeIntakeJournalError('invalid_journal'), io,
        });
        this.path = this.file.path;
    }
    private locked<T>(operation: (journal: BoundedJsonFileTransaction<JournalFile>) => T): Promise<T> {
        return this.file.transact(operation);
    }
    async read(binding: NativeIntakeJournalBinding): Promise<NativeIntakeJournalRecord | undefined> {
        const selected = copyBinding(binding);
        return (await this.file.read()).records.find(record => sameBinding(record.binding, selected));
    }
    /** null means absent, never an unconditional overwrite. */
    async save(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest, expectedRequestId: string | null, options: NativeIntakeJournalOptions = {}): Promise<void> {
        if ((!this.policy.allowHosted && options.delivery !== undefined) || Object.keys(options).some(key => key !== 'delivery') || (options.delivery !== undefined && options.delivery !== 'hosted'))
            throw new NativeIntakeJournalError('invalid_command');
        const record: NativeIntakeJournalRecord = { binding: copyBinding(binding), command: copyCommand(command, this.policy), ...(options.delivery ? { delivery: options.delivery } : {}) };
        if (this.policy.allowHosted && record.command.continuation && record.delivery !== 'hosted')
            throw new NativeIntakeJournalError('invalid_command');
        if (expectedRequestId !== null && (typeof expectedRequestId !== 'string' || !expectedRequestId.length)) {
            throw new NativeIntakeJournalError('conflict');
        }
        await this.locked(journal => {
            const file = journal.read();
            const index = file.records.findIndex(existing => sameBinding(existing.binding, record.binding));
            const current = file.records[index];
            if ((current?.command.requestId ?? null) !== expectedRequestId)
                throw new NativeIntakeJournalError('conflict');
            if (current && current.command.requestId === record.command.requestId && (!sameCommand(current.command, record.command) || current.delivery !== record.delivery)) {
                throw new NativeIntakeJournalError('conflict');
            }
            const next = current?.command.requestId === record.command.requestId
                ? { ...record, ...(current.hostedSource ? { hostedSource: current.hostedSource } : {}), ...(current.dispatch ? { dispatch: current.dispatch } : {}), ...(current.execution ? { execution: current.execution } : {}) } : record;
            if (index >= 0)
                file.records[index] = next;
            else
                file.records.push(next);
            journal.write(file);
        });
    }
    /**
     * The input is settled: remove its record. Only the exact command is
     * removed; a newer input saved under the same binding stays. Absent is done.
     */
    async remove(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest): Promise<void> {
        const selected = copyBinding(binding);
        const expected = copyCommand(command, this.policy);
        await this.locked(journal => {
            const file = journal.read();
            const index = file.records.findIndex(record => sameBinding(record.binding, selected));
            const current = file.records[index];
            if (!current || current.command.requestId !== expected.requestId)
                return;
            if (!sameCommand(current.command, expected))
                throw new NativeIntakeJournalError('conflict');
            file.records.splice(index, 1);
            journal.write(file);
        });
    }
    /**
     * The local turn this client dispatched under its claim has finished: the
     * claim has nothing left to fence, so the record goes. A record whose claim
     * was given back (the turn never started) is kept for an explicit retry.
     */
    async finishTurn(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest, sourceRevision: string): Promise<void> {
        const selected = copyBinding(binding);
        const expected = copyCommand(command, this.policy);
        await this.locked(journal => {
            const file = journal.read();
            const index = file.records.findIndex(record => sameBinding(record.binding, selected));
            const current = file.records[index];
            if (!current || current.command.requestId !== expected.requestId || current.dispatch?.sourceRevision !== sourceRevision)
                return;
            file.records.splice(index, 1);
            journal.write(file);
        });
    }
    /** Record the first authenticated source identity before hosted mutations. */
    async saveHostedSource(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest, source: NativeConversationIntakeSourceRef): Promise<void> {
        if (!this.policy.allowHosted)
            throw new NativeIntakeJournalError('conflict');
        const selected = copyBinding(binding);
        const expected = copyCommand(command, this.policy);
        const parsed = nativeConversationIntakeSourceRefSchema.safeParse(source);
        if (!parsed.success || (!this.policy.allowSelectedDiff && parsed.data.continuation?.selectedDiff !== undefined) || parsed.data.inputId !== expected.inputId || parsed.data.continuation?.sessionId !== expected.continuation?.sessionId)
            throw new NativeIntakeJournalError('conflict');
        await this.locked(journal => {
            const file = journal.read();
            const index = file.records.findIndex(record => sameBinding(record.binding, selected));
            const current = file.records[index];
            if (!current || !sameCommand(current.command, expected) || current.delivery !== 'hosted' || current.dispatch)
                throw new NativeIntakeJournalError('conflict');
            if (current.hostedSource) {
                if (JSON.stringify(current.hostedSource) !== JSON.stringify(parsed.data))
                    throw new NativeIntakeJournalError('conflict');
                journal.confirm();
                return;
            }
            file.records[index] = { ...current, hostedSource: parsed.data };
            journal.write(file);
        });
    }
    /** An ambiguous published claim is never cleared or replayed after restart. */
    async claimTurn(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest, sourceRevision: string): Promise<boolean> {
        const selected = copyBinding(binding);
        const expected = copyCommand(command, this.policy);
        if (!sourceRevision || sourceRevision.length > 200)
            throw new NativeIntakeJournalError('conflict');
        return this.locked(journal => {
            const file = journal.read();
            const index = file.records.findIndex(record => sameBinding(record.binding, selected));
            const current = file.records[index];
            if (!current || !sameCommand(current.command, expected))
                throw new NativeIntakeJournalError('conflict');
            if (current.execution || current.delivery === 'hosted')
                throw new NativeIntakeJournalError('conflict');
            if (current.dispatch) {
                if (current.dispatch.sourceRevision !== sourceRevision)
                    throw new NativeIntakeJournalError('conflict');
                return false;
            }
            file.records[index] = { ...current, dispatch: { sourceRevision } };
            journal.write(file);
            return true;
        });
    }
    /**
     * Undo this process's own claim for a turn that is known never to have started, so an explicit retry may
     * dispatch it. Only for a caller that still holds the unused permit; once a turn could have begun, the claim
     * is the only fence against running it twice and must stay.
     */
    async releaseTurnClaim(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest, sourceRevision: string): Promise<void> {
        const selected = copyBinding(binding);
        const expected = copyCommand(command, this.policy);
        await this.locked(journal => {
            const file = journal.read();
            const index = file.records.findIndex(record => sameBinding(record.binding, selected));
            const current = file.records[index];
            if (!current || !sameCommand(current.command, expected))
                throw new NativeIntakeJournalError('conflict');
            if (!current.dispatch)
                return;
            if (current.dispatch.sourceRevision !== sourceRevision)
                throw new NativeIntakeJournalError('conflict');
            const { dispatch: _claim, ...unclaimed } = current;
            file.records[index] = unclaimed;
            journal.write(file);
        });
    }
    /**
     * Remove a record whose text was saved but never sent to the host. The caller must know no capture was
     * requested; a record that has dispatch, execution or hosted state is refused, never dropped.
     */
    async discardUncaptured(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest): Promise<void> {
        const selected = copyBinding(binding);
        const expected = copyCommand(command, this.policy);
        await this.locked(journal => {
            const file = journal.read();
            const index = file.records.findIndex(record => sameBinding(record.binding, selected));
            const current = file.records[index];
            if (!current)
                return;
            if (!sameCommand(current.command, expected) || current.dispatch || current.execution || current.hostedSource)
                throw new NativeIntakeJournalError('conflict');
            file.records.splice(index, 1);
            journal.write(file);
        });
    }
    /** Immutable target from the authenticated work receipt; never select a newer attempt. */
    async saveExecutionIntent(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest, intent: NativeIntakeExecutionIntent): Promise<void> {
        const selected = copyBinding(binding);
        const expected = copyCommand(command, this.policy);
        const captured = copyExecutionIntent(intent);
        await this.locked(journal => {
            const file = journal.read();
            const index = file.records.findIndex(record => sameBinding(record.binding, selected));
            const current = file.records[index];
            if (!current || !sameCommand(current.command, expected) || current.dispatch)
                throw new NativeIntakeJournalError('conflict');
            if (current.execution) {
                if (JSON.stringify(current.execution) !== JSON.stringify(captured))
                    throw new NativeIntakeJournalError('conflict');
                journal.confirm();
                return;
            }
            file.records[index] = { ...current, execution: captured };
            journal.write(file);
        });
    }
    /** Confirm exact visible intent and durable file/ancestry before any replay POST. */
    async confirm(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest): Promise<void> {
        const selected = copyBinding(binding);
        const expected = copyCommand(command, this.policy);
        await this.locked(journal => {
            const current = journal.read().records.find(record => sameBinding(record.binding, selected));
            if (!current || !sameCommand(current.command, expected))
                throw new NativeIntakeJournalError('conflict');
            journal.confirm();
        });
    }
}
