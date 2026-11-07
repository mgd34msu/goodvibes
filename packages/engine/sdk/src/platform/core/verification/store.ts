import { appendFileSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { captureOwnedJson, snapshotJudgmentEvidence } from '../../gate/judgment-input.js';
import type { VerificationReceipt, VerificationSource, VerificationSourceInput } from './types.js';
import { issueVerificationId, issueVerificationSource } from './source.js';
import type { VerificationArchive } from './archive.js';
import { VerificationHeldError } from './types.js';
type SourceIndex = VerificationReceipt & { readonly representation: 'source-index' };
type QualifiedEvidence = VerificationReceipt & { readonly representation: 'jev-qualified' };
type RetainedReceipt = SourceIndex | QualifiedEvidence;

/** One private append-only journal per session, with deduplicated source chunks
 * and proposal records. Disk records never carry reusable approval authority. */
export class VerificationStore {
  readonly sources = new Map<string, VerificationSource>();
  readonly proposals = new Map<string, string>();
  // Only native kind/reference metadata selects a slot. Its value is the
  // already-retained complete source, never a second text cache or text key.
  private readonly latestSources = new Map<VerificationSource['kind'], Map<string, VerificationSource>>();
  private readonly latestReceipts = new Map<'index' | 'evidence', Map<string, RetainedReceipt>>();
  private readonly proposalRevisions = new Map<string, { readonly value: unknown; readonly revision: string }>();
  private readonly written = new Map<string, unknown>();
  private readonly histories = new Map<string, VerificationArchive['histories'][number]>();
  private readonly historyKeys = new WeakMap<object, string>();
  private readonly path: string | undefined;
  private readonly root: string | undefined;
  archive: VerificationArchive | undefined;
  readonly archives = new Map<string, VerificationArchive>();
  constructor(root?: string, sessionId?: string) {
    if (!root || !sessionId) return;
    if (!isAbsolute(root) || !/^[A-Za-z0-9_:-]+$/.test(sessionId)) throw new Error('Invalid verification journal location');
    // Native daemon sessions use namespaced IDs. Encode their colon so the
    // same identity has a portable filename; legacy session names stay exact.
    this.path = join(resolve(root), '.goodvibes', 'verification', `${encodeURIComponent(sessionId)}.jsonl`);
    this.root = resolve(root);
    try {
      this.assertDirectories();
      if (lstatSync(this.path).isSymbolicLink()) throw new Error('Verification journal is a symbolic link');
      for (const line of readFileSync(this.path, 'utf8').split('\n')) {
        if (!line) continue;
        let record: unknown; try { record = JSON.parse(line); } catch { continue; }
        // Admissible bytes and matching local identities are still untrusted
        // proposals: every restored record needs a current Jev qualification.
        try { record = snapshotJudgmentEvidence(record); }
        catch {
          // JSON parsing has already produced inert data. An unreadable latest
          // position must not resurrect an earlier branch's message authority.
          if (record && typeof record === 'object' && (record as { kind?: unknown }).kind === 'archive')
            throw new VerificationHeldError('unadmitted archived provenance');
          continue;
        }
        const value = record as { kind?: unknown; key?: unknown; value?: unknown };
        if (typeof value.key !== 'string') continue;
        if (value.kind === 'proposal' && typeof value.value === 'string') this.proposals.set(value.key, value.value);
        if (value.kind === 'source' && value.value && typeof value.value === 'object') {
          const source = value.value as VerificationSource;
          if (typeof source.id === 'string' && typeof source.reference === 'string' && typeof source.text === 'string'
            && ['instruction', 'observation', 'answer'].includes(source.kind)) {
            this.sources.set(source.id, source);
            this.rememberLatestSource(source);
          }
        }
        if ((value.kind === 'index' || value.kind === 'evidence') && value.value && typeof value.value === 'object') {
          const index = value.value as RetainedReceipt;
          const prefix = value.kind === 'index' ? 'index-' : 'e-';
          const representation = value.kind === 'index' ? 'source-index' : 'jev-qualified';
          if (typeof index.id === 'string' && index.id.startsWith(prefix) && index.id === value.key && index.representation === representation
            && Array.isArray(index.children) && index.children.every(id => typeof id === 'string')
            && Array.isArray(index.sourceIds) && index.sourceIds.every(id => typeof id === 'string')) {
            const entries = this.latestReceipts.get(value.kind) ?? new Map<string, RetainedReceipt>();
            entries.set(this.receiptSlot(index), index); this.latestReceipts.set(value.kind, entries);
          }
        }
        if (value.kind === 'history' && value.value && typeof value.value === 'object') {
          const history = value.value as VerificationArchive['histories'][number];
          if (Array.isArray(history.messages)) {
            this.histories.set(value.key, history); this.historyKeys.set(history, value.key);
          }
        }
        if (value.kind === 'archive' && value.value && typeof value.value === 'object') {
          const entry = value.value as VerificationArchive;
          if (Array.isArray(entry.derived) && entry.derived.every(pair => Array.isArray(pair) && Number.isSafeInteger(pair[0]) && typeof pair[1] === 'string')) {
            if (entry.runtimeMessages !== undefined && (!Array.isArray(entry.runtimeMessages)
              || entry.runtimeMessages.some(pair => !Array.isArray(pair) || !Number.isSafeInteger(pair[0]) || pair[0] < 0 || typeof pair[1] !== 'string')))
              throw new VerificationHeldError('invalid runtime message provenance');
            if (entry.messageRecords !== undefined && (!Array.isArray(entry.messageRecords)
              || entry.messageRecords.some(record => !record || typeof record !== 'object' || Array.isArray(record)
                || typeof record.id !== 'string' || !record.id || record.id.length > 256 || Object.keys(record).length !== 2
                || ('message' in record ? !record.message || typeof record.message !== 'object' || Array.isArray(record.message)
                  : !('contentCommitment' in record) || typeof record.contentCommitment !== 'string' || !/^[a-p]{64}$/.test(record.contentCommitment)))
              || new Set(entry.messageRecords.map(record => record.id)).size !== entry.messageRecords.length))
              throw new VerificationHeldError('invalid archived message records');
            const recordedMessages = new Set(entry.messageRecords?.map(record => record.id));
            if ([...entry.derived, ...(entry.runtimeMessages ?? [])].some(([, id]) => id.startsWith('message-') && !recordedMessages.has(id)))
              throw new VerificationHeldError('missing archived message record');
            if (Array.isArray(entry.histories)) for (const history of entry.histories) if (history && Array.isArray(history.messages)) {
              const key = issueVerificationId('history');
              this.histories.set(key, history); this.historyKeys.set(history, key);
            }
            const metadata = value.value as { historyKeys?: string[]; branch?: string };
            if (Array.isArray(metadata.historyKeys) && metadata.historyKeys.some(key => typeof key !== 'string' || !this.histories.has(key))) throw new VerificationHeldError('missing archived original source');
            this.archive = { branch: typeof metadata.branch === 'string' ? metadata.branch : 'main',
              histories: Array.isArray(metadata.historyKeys) ? metadata.historyKeys.flatMap(key => this.histories.get(key) ?? [])
                : Array.isArray(entry.histories) ? entry.histories : [...this.histories.values()], derived: entry.derived,
              ...(entry.runtimeMessages ? { runtimeMessages: entry.runtimeMessages } : {}),
              ...(entry.messageRecords ? { messageRecords: entry.messageRecords } : {}) };
            this.archives.set(this.archive.branch!, this.archive);
          }
        }
        if (value.kind === 'source' || value.kind === 'proposal' || value.kind === 'history' || value.kind === 'index' || value.kind === 'evidence') {
          this.written.set(JSON.stringify([value.kind, value.key]), value.value);
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private assertDirectories(): void {
    if (!this.root) return;
    for (const path of [join(this.root, '.goodvibes'), join(this.root, '.goodvibes', 'verification')]) {
      try { if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error('Verification directory must be an ordinary directory'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  private append<T>(kind: 'source' | 'proposal' | 'archive' | 'history' | 'index' | 'evidence', key: string, value: T): T {
    let record: { readonly kind: typeof kind; readonly key: string; readonly value: T };
    try { record = snapshotJudgmentEvidence({ kind, key, value }) as typeof record; }
    catch (error) { throw new VerificationHeldError('generated verification record admission', { cause: error }); }
    const slot = JSON.stringify([kind, key]);
    if (kind !== 'archive' && this.written.has(slot) && isDeepStrictEqual(this.written.get(slot), record.value)) {
      return this.written.get(slot) as T;
    }
    if (this.path) {
      try {
      const directory = dirname(this.path);
      this.assertDirectories();
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (lstatSync(directory).isSymbolicLink()) throw new Error('Verification journal directory is a symbolic link');
      const fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      // A leading delimiter isolates a torn last record after abrupt exit.
      try {
        appendFileSync(fd, '\n' + JSON.stringify(record) + '\n');
        if (kind === 'archive') fsyncSync(fd);
      } finally { closeSync(fd); }
      } catch (error) { throw new VerificationHeldError('verification journal storage', { cause: error }); }
    }
    if (kind !== 'archive') this.written.set(slot, record.value);
    return record.value;
  }
  private rememberLatestSource(source: VerificationSource): void {
    const kind = this.latestSources.get(source.kind) ?? new Map<string, VerificationSource>();
    kind.set(source.reference, source); this.latestSources.set(source.kind, kind);
  }
  /** Reuse only the complete unchanged native record, including execution and
   * original-source links. Restored IDs are opaque; reading never rehashes text.
   * Restored sources still require current semantic qualification.
   */
  retainSource(source: VerificationSourceInput): VerificationSource {
    const snapshot = captureOwnedJson(source) as VerificationSourceInput;
    const previous = this.latestSources.get(snapshot.kind)?.get(snapshot.reference);
    if (previous && this.sources.get(previous.id) === previous) {
      const { id: _id, ...value } = previous;
      if (isDeepStrictEqual(captureOwnedJson(value), snapshot)) return previous;
    }
    return this.rememberSource(issueVerificationSource(snapshot));
  }
  rememberSource(source: VerificationSource): VerificationSource {
    const retained = this.append('source', source.id, source);
    this.sources.set(source.id, retained);
    this.rememberLatestSource(retained);
    return retained;
  }
  private receiptSlot(index: Pick<VerificationReceipt, 'children' | 'sourceIds'>): string {
    const members = index.children.length ? index.children : index.sourceIds;
    return JSON.stringify([index.children.length ? 'branch' : 'leaf', members.length, members[0] ?? null, members.at(-1) ?? null]);
  }
  /** An index names retained sources; its previews never establish their facts.
   * Persist native index IDs so restart does not regenerate retrieval identities.
   */
  retainIndex(index: Omit<VerificationReceipt, 'id'> & { readonly representation: 'source-index' }): VerificationReceipt {
    return this.retainReceipt('index', index);
  }
  /** Historical metadata is not approval. The caller qualifies a new summary
   * against current originals before retaining its complete native record.
   */
  retainEvidence(evidence: Omit<VerificationReceipt, 'id'> & { readonly representation: 'jev-qualified' }): VerificationReceipt {
    return this.retainReceipt('evidence', evidence);
  }
  private retainReceipt(kind: 'index' | 'evidence', receipt: Omit<RetainedReceipt, 'id'>): RetainedReceipt {
    const snapshot = captureOwnedJson(receipt) as Omit<RetainedReceipt, 'id'>;
    const slot = this.receiptSlot(snapshot), entries = this.latestReceipts.get(kind) ?? new Map<string, RetainedReceipt>();
    const previous = entries.get(slot);
    if (previous) {
      const { id: _id, ...value } = previous;
      if (isDeepStrictEqual(captureOwnedJson(value), snapshot)) return previous;
    }
    const id = issueVerificationId(kind === 'index' ? 'index' : 'e');
    const retained = this.append(kind, id, { ...snapshot, id }) as RetainedReceipt;
    entries.set(slot, retained); this.latestReceipts.set(kind, entries);
    return retained;
  }
  /** Live qualification cache identity for the complete admitted proposal.
   * One current value per proposal slot; no source text enters a Map key.
   * This identity never survives restart or restores semantic approval.
   */
  retainProposalRevision(key: string, proposed: unknown): string {
    const snapshot = captureOwnedJson(proposed), previous = this.proposalRevisions.get(key);
    if (previous && isDeepStrictEqual(previous.value, snapshot)) return previous.revision;
    const revision = issueVerificationId('proposal');
    this.proposalRevisions.set(key, { value: snapshot, revision });
    return revision;
  }
  rememberProposal(key: string, proposal: string): void {
    this.proposals.set(key, this.append('proposal', key, proposal));
  }
  rememberArchive(value: VerificationArchive): void {
    const branch = value.branch ?? 'main', previous = this.archives.get(branch);
    const keys = value.histories.map((history, index) => {
      // Histories already belong to this append-only archive. Reuse their
      // actual persisted identity, including identities read from older rows.
      // A reconstructed value can reuse only the exact previous branch slot.
      const before = previous?.histories[index];
      let key = this.historyKeys.get(history);
      if (key !== undefined && !isDeepStrictEqual(this.histories.get(key), history)) key = undefined;
      if (key === undefined && before && isDeepStrictEqual(before, history)) key = this.historyKeys.get(before);
      key ??= issueVerificationId('history');
      const existing = this.histories.get(key);
      const retained = existing && this.written.has(JSON.stringify(['history', key])) ? existing : this.append('history', key, history);
      this.histories.set(key, retained);
      this.historyKeys.set(history, key); this.historyKeys.set(retained, key);
      return key;
    });
    const position = { branch, historyKeys: keys, derived: value.derived,
      ...(value.runtimeMessages?.length ? { runtimeMessages: value.runtimeMessages } : {}),
      ...(value.messageRecords?.length ? { messageRecords: value.messageRecords } : {}) };
    if (!previous || !isDeepStrictEqual(previous.derived, value.derived)
      || !isDeepStrictEqual(previous.runtimeMessages ?? [], value.runtimeMessages ?? [])
      || !isDeepStrictEqual(previous.messageRecords ?? [], value.messageRecords ?? [])
      || !isDeepStrictEqual(previous.histories.map(history => this.historyKeys.get(history)), keys))
      this.append('archive', branch, position);
    const metadata = captureOwnedJson({ branch, derived: value.derived,
      ...(value.runtimeMessages ? { runtimeMessages: value.runtimeMessages } : {}),
      ...(value.messageRecords ? { messageRecords: value.messageRecords } : {}) }) as Omit<VerificationArchive, 'histories'>;
    const retained = Object.freeze({ ...metadata, histories: Object.freeze(keys.map(key => this.histories.get(key)!)) });
    this.archive = retained; this.archives.set(branch, retained);
  }
}
