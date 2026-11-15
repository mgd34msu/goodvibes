import { nativeWorkExecutionIdentitySchema } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-execution-client';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, type Stats } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { acquireCrossProcessLock, confirmFileDurable, writeJsonFileAtomic, } from '@goodvibes-jev/engine/platform/platform/state/durable-file-io';
import { nativeConversationIntakeCaptureRequestSchema, nativeConversationIntakeSourceRefSchema, type NativeConversationIntakeSourceRef, type NativeConversationIntakeCaptureRequest, } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-intake-client';
export const NATIVE_INTAKE_JOURNAL_MAX_RECORDS = 16;
export const NATIVE_INTAKE_JOURNAL_MAX_BYTES = 2 * 1024 * 1024;
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
export interface NativeIntakeJournalIO {
    readonly writeJsonFileAtomic: typeof writeJsonFileAtomic;
    readonly confirmFileDurable: typeof confirmFileDurable;
    readonly acquireCrossProcessLock: typeof acquireCrossProcessLock;
}
export class NativeIntakeJournalError extends Error {
    constructor(readonly code: 'invalid_binding' | 'invalid_command' | 'invalid_journal' | 'journal_limit' | 'conflict') {
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
const missing = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
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
    if (value.records.length > NATIVE_INTAKE_JOURNAL_MAX_RECORDS)
        throw new NativeIntakeJournalError('journal_limit');
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
const overCapacity = (file: JournalFile): boolean => file.records.length > NATIVE_INTAKE_JOURNAL_MAX_RECORDS
    || Buffer.byteLength(JSON.stringify(file), 'utf8') > NATIVE_INTAKE_JOURNAL_MAX_BYTES;
/**
 * Make room for the record just appended. A removed record can never be replayed (every POST first confirms its
 * exact record), so eviction drops only this client's recovery handle for that binding. That is safe only where
 * the host fences a second run itself: work already given to native execution (its immutable target is deduplicated
 * by the work receipt), and hosted inputs whose source the host has acknowledged (the host's turn journal holds the
 * claim). Each goes least recently saved first. A local turn's `dispatch` claim is the only fence against running
 * that turn twice, and nothing records that the turn finished, so a claimed record is never evicted: a later retry
 * of the same input would find no claim and dispatch again. A record with none of these may hold text the host never
 * captured and is never evicted either: the save fails with journal_limit instead.
 */
function evictForCapacity(file: JournalFile, heldByOtherProcess: (record: NativeIntakeJournalRecord) => boolean): void {
    const tiers: ReadonlyArray<(record: NativeIntakeJournalRecord) => boolean> = [
        record => record.execution !== undefined,
        // A hosted turn another live process of this client still owns is not ours to drop: that process would find
        // its binding gone and could neither confirm nor cancel the turn it is running.
        record => record.delivery === 'hosted' && record.hostedSource !== undefined && !heldByOtherProcess(record),
    ];
    for (const evictable of tiers) {
        // The last record is the one being saved and is never a candidate.
        for (let index = 0; index < file.records.length - 1 && overCapacity(file);) {
            if (evictable(file.records[index]!))
                file.records.splice(index, 1);
            else
                index += 1;
        }
    }
    if (overCapacity(file))
        throw new NativeIntakeJournalError('journal_limit');
}
/**
 * The process that last saved a hosted binding. Kept beside the journal, not in it, so the journal's record shape
 * (and every older build's reading of it) is unchanged. Evidence only: a live foreign owner withholds eviction; a
 * missing, unreadable or dead owner proves nothing and never blocks it.
 */
interface JournalOwner {
    readonly pid: number;
    /** Random per process; tells a restarted process that reused the pid from the original owner. */
    readonly instance: string;
    /** Machine and pid namespace the pid belongs to; a pid says nothing about a process elsewhere. Absent in entries written by older builds. */
    readonly host?: string | undefined;
}
const PROCESS_INSTANCE = randomUUID();
/** The same machine-and-namespace identity the hosted-turn journal records for its claim owners. */
const HOST_IDENTITY = (() => {
    let namespace = '';
    try {
        namespace = readlinkSync('/proc/self/ns/pid');
    }
    catch { /* not Linux, or not readable: the hostname alone */ }
    return `${hostname()}|${namespace}`;
})();
const OWNERS_MAX_BYTES = 64 * 1024;
const bindingKey = (binding: NativeIntakeJournalBinding): string => JSON.stringify(bindingKeys.map(key => binding[key]));
const processAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
};
function readOwners(path: string): Map<string, JournalOwner> {
    const owners = new Map<string, JournalOwner>();
    try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.size > OWNERS_MAX_BYTES)
            return owners;
        const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
        const table = (value as { version?: unknown, owners?: unknown } | null);
        if (table?.version !== 1 || !table.owners || typeof table.owners !== 'object' || Array.isArray(table.owners))
            return owners;
        for (const [key, owner] of Object.entries(table.owners)) {
            const entry = owner as { pid?: unknown, instance?: unknown, host?: unknown } | null;
            if (entry && Number.isSafeInteger(entry.pid) && (entry.pid as number) > 0 && typeof entry.instance === 'string' && entry.instance.length > 0 && entry.instance.length <= 200
                && (entry.host === undefined || (typeof entry.host === 'string' && entry.host.length > 0 && entry.host.length <= 512)))
                owners.set(key, { pid: entry.pid as number, instance: entry.instance, ...(entry.host !== undefined ? { host: entry.host } : {}) });
        }
    }
    catch {
        owners.clear();
    }
    return owners;
}
// An owner on another machine or pid namespace cannot be checked from here, so it counts as alive.
const heldElsewhere = (owner: JournalOwner | undefined): boolean => (owner !== undefined && owner.instance !== PROCESS_INSTANCE
    && (owner.host !== undefined && owner.host !== HOST_IDENTITY ? true : owner.pid !== process.pid && processAlive(owner.pid)));
/** Check existing ancestors as well as the final file; never adopt symlink-backed state. */
function assertDirectoryChain(path: string): void {
    for (let current = dirname(path);; current = dirname(current)) {
        try {
            const stat = lstatSync(current);
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw new NativeIntakeJournalError('invalid_journal');
        }
        catch (error) {
            if (!missing(error))
                throw error;
        }
        if (dirname(current) === current)
            break;
    }
}
function readFile(path: string, policy: NativeIntakeJournalPolicy): JournalFile {
    let stat: Stats;
    try {
        stat = lstatSync(path);
    }
    catch (error) {
        if (missing(error))
            return { version: 1, records: [] };
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink())
        throw new NativeIntakeJournalError('invalid_journal');
    if (stat.size > NATIVE_INTAKE_JOURNAL_MAX_BYTES)
        throw new NativeIntakeJournalError('journal_limit');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev)
            throw new NativeIntakeJournalError('invalid_journal');
        if (opened.size > NATIVE_INTAKE_JOURNAL_MAX_BYTES)
            throw new NativeIntakeJournalError('journal_limit');
        const bytes = new Uint8Array(NATIVE_INTAKE_JOURNAL_MAX_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
            const count = readSync(fd, bytes, length, bytes.length - length, length);
            if (!count)
                break;
            length += count;
        }
        if (length > NATIVE_INTAKE_JOURNAL_MAX_BYTES)
            throw new NativeIntakeJournalError('journal_limit');
        let value: unknown;
        try {
            value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
        }
        catch {
            throw new NativeIntakeJournalError('invalid_journal');
        }
        return validateFile(value, policy);
    }
    finally {
        closeSync(fd);
    }
}
/**
 * Host-owned, bounded restart journal with a shared durable implementation. Every mutation requires a strict lock
 * and durable publication. An AtomicWriteDurabilityError is deliberately allowed
 * to escape unchanged: published-indeterminate bytes must never be rolled back,
 * deleted, treated as absent or used for a POST without explicit confirmation.
 * There is no expiry, and an identity the host may never have captured is never evicted (see evictForCapacity).
 */
export class NativeConversationIntakeJournal {
    readonly path: string;
    private readonly io: NativeIntakeJournalIO;
    private readonly policy: NativeIntakeJournalPolicy;
    constructor(path: string, io: Partial<NativeIntakeJournalIO> = {}, policy: NativeIntakeJournalPolicy = { allowHosted: false, allowSelectedDiff: false }) {
        this.policy = Object.freeze({ allowHosted: policy.allowHosted === true, allowSelectedDiff: policy.allowSelectedDiff === true });
        this.path = resolve(path);
        this.io = { writeJsonFileAtomic, confirmFileDurable, acquireCrossProcessLock, ...io };
    }
    private async locked<T>(operation: () => T): Promise<T> {
        assertDirectoryChain(this.path);
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        const release = await this.io.acquireCrossProcessLock(`${this.path}.lock`, { strictOwnership: true });
        try {
            assertDirectoryChain(this.path);
            return operation();
        }
        finally {
            release();
        }
    }
    async read(binding: NativeIntakeJournalBinding): Promise<NativeIntakeJournalRecord | undefined> {
        const selected = copyBinding(binding);
        return this.locked(() => readFile(this.path, this.policy).records.find(record => sameBinding(record.binding, selected)));
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
        await this.locked(() => {
            const file = readFile(this.path, this.policy);
            const index = file.records.findIndex(existing => sameBinding(existing.binding, record.binding));
            const current = file.records[index];
            if ((current?.command.requestId ?? null) !== expectedRequestId)
                throw new NativeIntakeJournalError('conflict');
            if (current && current.command.requestId === record.command.requestId && (!sameCommand(current.command, record.command) || current.delivery !== record.delivery)) {
                throw new NativeIntakeJournalError('conflict');
            }
            const next = current?.command.requestId === record.command.requestId
                ? { ...record, ...(current.hostedSource ? { hostedSource: current.hostedSource } : {}), ...(current.dispatch ? { dispatch: current.dispatch } : {}), ...(current.execution ? { execution: current.execution } : {}) } : record;
            // Array order is least recently saved first, so eviction can prefer the stalest binding.
            if (index >= 0)
                file.records.splice(index, 1);
            file.records.push(next);
            const owners = readOwners(this.ownersPath);
            evictForCapacity(file, held => heldElsewhere(owners.get(bindingKey(held.binding))));
            this.io.writeJsonFileAtomic(this.path, file, { durable: true, mode: 0o600, indent: null, trailingNewline: false });
            if (next.delivery === 'hosted')
                this.recordOwner(file, next.binding, owners);
        });
    }
    private get ownersPath(): string {
        return `${this.path}.owners`;
    }
    /** Best effort after the record is durable: a missing owner only withholds later protection. */
    private recordOwner(file: JournalFile, binding: NativeIntakeJournalBinding, owners: Map<string, JournalOwner>): void {
        try {
            const kept = new Set(file.records.map(record => bindingKey(record.binding)));
            for (const key of [...owners.keys()])
                if (!kept.has(key))
                    owners.delete(key);
            owners.set(bindingKey(binding), { pid: process.pid, instance: PROCESS_INSTANCE, host: HOST_IDENTITY });
            // Deliberately not `this.io`: that seam governs the journal's own bytes.
            writeJsonFileAtomic(this.ownersPath, { version: 1, owners: Object.fromEntries(owners) }, { durable: false, mode: 0o600, indent: null, trailingNewline: false });
        }
        catch { /* the record stands; without an owner it can only be evicted, as before */ }
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
        await this.locked(() => {
            const file = readFile(this.path, this.policy);
            const index = file.records.findIndex(record => sameBinding(record.binding, selected));
            const current = file.records[index];
            if (!current || !sameCommand(current.command, expected) || current.delivery !== 'hosted' || current.dispatch)
                throw new NativeIntakeJournalError('conflict');
            if (current.hostedSource) {
                if (JSON.stringify(current.hostedSource) !== JSON.stringify(parsed.data))
                    throw new NativeIntakeJournalError('conflict');
                this.io.confirmFileDurable(this.path);
                return;
            }
            file.records[index] = { ...current, hostedSource: parsed.data };
            if (Buffer.byteLength(JSON.stringify(file), 'utf8') > NATIVE_INTAKE_JOURNAL_MAX_BYTES)
                throw new NativeIntakeJournalError('journal_limit');
            this.io.writeJsonFileAtomic(this.path, file, { durable: true, mode: 0o600, indent: null, trailingNewline: false });
        });
    }
    /** An ambiguous published claim is never cleared or replayed after restart. */
    async claimTurn(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest, sourceRevision: string): Promise<boolean> {
        const selected = copyBinding(binding);
        const expected = copyCommand(command, this.policy);
        if (!sourceRevision || sourceRevision.length > 200)
            throw new NativeIntakeJournalError('conflict');
        return this.locked(() => {
            const file = readFile(this.path, this.policy);
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
            if (Buffer.byteLength(JSON.stringify(file), 'utf8') > NATIVE_INTAKE_JOURNAL_MAX_BYTES)
                throw new NativeIntakeJournalError('journal_limit');
            this.io.writeJsonFileAtomic(this.path, file, { durable: true, mode: 0o600, indent: null, trailingNewline: false });
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
        await this.locked(() => {
            const file = readFile(this.path, this.policy);
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
            this.io.writeJsonFileAtomic(this.path, file, { durable: true, mode: 0o600, indent: null, trailingNewline: false });
        });
    }
    /**
     * Remove a record whose text was saved but never sent to the host. The caller must know no capture was
     * requested; a record that has dispatch, execution or hosted state is refused, never dropped.
     */
    async discardUncaptured(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest): Promise<void> {
        const selected = copyBinding(binding);
        const expected = copyCommand(command, this.policy);
        await this.locked(() => {
            const file = readFile(this.path, this.policy);
            const index = file.records.findIndex(record => sameBinding(record.binding, selected));
            const current = file.records[index];
            if (!current)
                return;
            if (!sameCommand(current.command, expected) || current.dispatch || current.execution || current.hostedSource)
                throw new NativeIntakeJournalError('conflict');
            file.records.splice(index, 1);
            this.io.writeJsonFileAtomic(this.path, file, { durable: true, mode: 0o600, indent: null, trailingNewline: false });
        });
    }
    /** Immutable target from the authenticated work receipt; never select a newer attempt. */
    async saveExecutionIntent(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest, intent: NativeIntakeExecutionIntent): Promise<void> {
        const selected = copyBinding(binding);
        const expected = copyCommand(command, this.policy);
        const captured = copyExecutionIntent(intent);
        await this.locked(() => {
            const file = readFile(this.path, this.policy);
            const index = file.records.findIndex(record => sameBinding(record.binding, selected));
            const current = file.records[index];
            if (!current || !sameCommand(current.command, expected) || current.dispatch)
                throw new NativeIntakeJournalError('conflict');
            if (current.execution) {
                if (JSON.stringify(current.execution) !== JSON.stringify(captured))
                    throw new NativeIntakeJournalError('conflict');
                this.io.confirmFileDurable(this.path);
                return;
            }
            file.records[index] = { ...current, execution: captured };
            if (Buffer.byteLength(JSON.stringify(file), 'utf8') > NATIVE_INTAKE_JOURNAL_MAX_BYTES)
                throw new NativeIntakeJournalError('journal_limit');
            this.io.writeJsonFileAtomic(this.path, file, { durable: true, mode: 0o600, indent: null, trailingNewline: false });
        });
    }
    /** Confirm exact visible intent and durable file/ancestry before any replay POST. */
    async confirm(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest): Promise<void> {
        const selected = copyBinding(binding);
        const expected = copyCommand(command, this.policy);
        await this.locked(() => {
            const current = readFile(this.path, this.policy).records.find(record => sameBinding(record.binding, selected));
            if (!current || !sameCommand(current.command, expected))
                throw new NativeIntakeJournalError('conflict');
            this.io.confirmFileDurable(this.path);
        });
    }
}
