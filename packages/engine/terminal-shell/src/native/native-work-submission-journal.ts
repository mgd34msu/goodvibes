import {
  BoundedJsonFile,
  type BoundedJsonFileIO,
} from '@goodvibes-jev/engine/platform/platform/state/durable-file-io';
import {
  nativeWorkSubmissionRequestSchema,
  type NativeWorkSubmissionRequest,
} from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-submission-client';

export const NATIVE_SUBMISSION_JOURNAL_MAX_RECORDS = 16;
export const NATIVE_SUBMISSION_JOURNAL_MAX_BYTES = 2 * 1024 * 1024;

/** The principal must come from this connection's live verified auth.current. */
export interface NativeSubmissionJournalBinding {
  readonly endpoint: string;
  readonly projectId: string;
  readonly workspace: string;
  readonly principalId: string;
}

export interface NativeSubmissionJournalRecord {
  readonly binding: NativeSubmissionJournalBinding;
  readonly command: NativeWorkSubmissionRequest;
}

export type NativeSubmissionJournalIO = BoundedJsonFileIO;

export class NativeSubmissionJournalError extends Error {
  constructor(readonly code: 'invalid_binding' | 'invalid_command' | 'invalid_journal' | 'journal_limit' | 'conflict') {
    super(`Native submission journal: ${code}`);
    this.name = 'NativeSubmissionJournalError';
  }
}

interface JournalFile { readonly version: 1; readonly records: NativeSubmissionJournalRecord[]; }
const bindingKeys = ['endpoint', 'projectId', 'workspace', 'principalId'] as const;
const ownKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
);

function copyBinding(value: unknown): NativeSubmissionJournalBinding {
  if (!ownKeys(value, bindingKeys) || !bindingKeys.every(key => typeof value[key] === 'string'
    && value[key].length > 0 && value[key].length <= 4096 && /\S/u.test(value[key]))) {
    throw new NativeSubmissionJournalError('invalid_binding');
  }
  const binding = value as unknown as NativeSubmissionJournalBinding;
  // Never persist credentials, bearer-bearing queries or fragments in an endpoint.
  let endpoint: URL;
  try { endpoint = new URL(binding.endpoint); } catch { throw new NativeSubmissionJournalError('invalid_binding'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new NativeSubmissionJournalError('invalid_binding');
  }
  return { endpoint: binding.endpoint, projectId: binding.projectId, workspace: binding.workspace, principalId: binding.principalId };
}

function copyCommand(value: unknown): NativeWorkSubmissionRequest {
  const parsed = nativeWorkSubmissionRequestSchema.safeParse(value);
  if (!parsed.success) throw new NativeSubmissionJournalError('invalid_command');
  return parsed.data;
}

/** The same host, project, workspace and principal. */
export const sameNativeSubmissionBinding = (left: NativeSubmissionJournalBinding, right: NativeSubmissionJournalBinding): boolean => (
  bindingKeys.every(key => left[key] === right[key])
);
/** The same request identity, revision and source. */
export const sameNativeSubmissionCommand = (left: NativeWorkSubmissionRequest, right: NativeWorkSubmissionRequest): boolean => (
  left.requestId === right.requestId && left.inputId === right.inputId && left.expectedRevision === right.expectedRevision
  && left.goal === right.goal && left.criteria.length === right.criteria.length
  && left.criteria.every((criterion, index) => criterion === right.criteria[index])
);

function validateFile(value: unknown): JournalFile {
  if (!ownKeys(value, ['version', 'records']) || value.version !== 1 || !Array.isArray(value.records)) {
    throw new NativeSubmissionJournalError('invalid_journal');
  }
  if (value.records.length > NATIVE_SUBMISSION_JOURNAL_MAX_RECORDS) throw new NativeSubmissionJournalError('journal_limit');
  const records: NativeSubmissionJournalRecord[] = [];
  for (const record of value.records) {
    if (!ownKeys(record, ['binding', 'command'])) throw new NativeSubmissionJournalError('invalid_journal');
    let parsed: NativeSubmissionJournalRecord;
    try { parsed = { binding: copyBinding(record.binding), command: copyCommand(record.command) }; }
    catch { throw new NativeSubmissionJournalError('invalid_journal'); }
    if (records.some(existing => sameNativeSubmissionBinding(existing.binding, parsed.binding))) throw new NativeSubmissionJournalError('invalid_journal');
    records.push(parsed);
  }
  return { version: 1, records };
}

/**
 * Product-owned, bounded restart journal. Every mutation requires a strict lock
 * and durable publication. An AtomicWriteDurabilityError is deliberately allowed
 * to escape unchanged: published-indeterminate bytes must never be rolled back,
 * deleted, treated as absent or used for a POST without explicit confirmation.
 * There is no expiry or eviction of unresolved identities; a record leaves only
 * through `remove`, once its submission has a validated receipt.
 */
export class NativeWorkSubmissionJournal {
  readonly path: string;
  private readonly file: BoundedJsonFile<JournalFile>;

  constructor(path: string, io: Partial<NativeSubmissionJournalIO> = {}) {
    this.file = new BoundedJsonFile<JournalFile>(path, {
      maxBytes: NATIVE_SUBMISSION_JOURNAL_MAX_BYTES, parse: validateFile, empty: () => ({ version: 1, records: [] }),
      invalid: () => new NativeSubmissionJournalError('invalid_journal'), limit: () => new NativeSubmissionJournalError('journal_limit'), io,
    });
    this.path = this.file.path;
  }

  async read(binding: NativeSubmissionJournalBinding): Promise<NativeSubmissionJournalRecord | undefined> {
    const selected = copyBinding(binding);
    return (await this.file.read()).records.find(record => sameNativeSubmissionBinding(record.binding, selected));
  }

  /** null means absent, never an unconditional overwrite. The write is durable when this returns. */
  async save(binding: NativeSubmissionJournalBinding, command: NativeWorkSubmissionRequest, expectedRequestId: string | null): Promise<void> {
    const record = { binding: copyBinding(binding), command: copyCommand(command) };
    if (expectedRequestId !== null && (typeof expectedRequestId !== 'string' || !expectedRequestId.length)) {
      throw new NativeSubmissionJournalError('conflict');
    }
    await this.file.update(file => {
      const index = file.records.findIndex(existing => sameNativeSubmissionBinding(existing.binding, record.binding));
      const current = file.records[index];
      if ((current?.command.requestId ?? null) !== expectedRequestId) throw new NativeSubmissionJournalError('conflict');
      if (current && current.command.requestId === record.command.requestId && !sameNativeSubmissionCommand(current.command, record.command)) {
        throw new NativeSubmissionJournalError('conflict');
      }
      if (index < 0) file.records.push(record); else file.records[index] = record;
      if (file.records.length > NATIVE_SUBMISSION_JOURNAL_MAX_RECORDS) throw new NativeSubmissionJournalError('journal_limit');
      return { next: file, value: undefined };
    });
  }

  /** Release a settled record so its slot can serve another binding. Only the exact requestId is removed. */
  async remove(binding: NativeSubmissionJournalBinding, requestId: string): Promise<void> {
    const selected = copyBinding(binding);
    if (typeof requestId !== 'string' || !requestId.length) throw new NativeSubmissionJournalError('conflict');
    await this.file.update(file => {
      const index = file.records.findIndex(existing => sameNativeSubmissionBinding(existing.binding, selected));
      if (index < 0) return { value: undefined };
      if (file.records[index]!.command.requestId !== requestId) throw new NativeSubmissionJournalError('conflict');
      file.records.splice(index, 1);
      return { next: file, value: undefined };
    });
  }

  /**
   * Confirm exact visible intent and durable bytes before replaying a record
   * this process did not just save (one recovered after a restart).
   */
  async confirm(binding: NativeSubmissionJournalBinding, command: NativeWorkSubmissionRequest): Promise<void> {
    const selected = copyBinding(binding);
    const expected = copyCommand(command);
    await this.file.confirm(file => {
      const current = file.records.find(record => sameNativeSubmissionBinding(record.binding, selected));
      if (!current || !sameNativeSubmissionCommand(current.command, expected)) throw new NativeSubmissionJournalError('conflict');
    });
  }
}
