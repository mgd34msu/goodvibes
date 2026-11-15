import type { WorkLedgerReadSnapshot } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger';
import type { OperatorNativeWorkSubmissionClient, NativeWorkSubmissionRequest, NativeWorkSubmissionReceipt } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-submission-client';
import { NATIVE_SUBMISSION_MAX_BYTES, NativeWorkSourceError, readNativeWorkSourceFile, validateNativeWorkSource, type NativeWorkSource } from './native-work-submission-source.js';
import type { NativeSubmissionJournalBinding, NativeSubmissionJournalRecord, NativeWorkSubmissionJournal } from './native-work-submission-journal.js';
import { sameNativeSubmissionBinding as sameBinding, sameNativeSubmissionCommand as sameCommand } from './native-work-submission-journal.js';

export interface NativeWorkSubmissionBinding {
  readonly client: OperatorNativeWorkSubmissionClient;
  /** Verified live paired principal from the authenticated host, never a token hash. */
  readonly readPrincipal: (signal: AbortSignal) => Promise<string>;
  readonly readSnapshot: () => Promise<WorkLedgerReadSnapshot>;
  readonly dispose: () => void;
}
export type NativeWorkSubmissionSelection =
  | { readonly available: false; readonly identity: string; readonly reason: string }
  | { readonly available: true; readonly identity: string; readonly endpoint: string; readonly projectId: string; readonly workspace: string;
      readonly journal: Pick<NativeWorkSubmissionJournal, 'read' | 'save' | 'confirm'> & Partial<Pick<NativeWorkSubmissionJournal, 'remove' | 'path' | 'list'>>; readonly bind: () => NativeWorkSubmissionBinding };
export interface NativeWorkSubmissionState {
  readonly status: 'pending' | 'submitted' | 'not-found' | 'discarded' | 'unknown' | 'conflict' | 'invalid' | 'unavailable';
  readonly message: string;
  readonly request?: Readonly<Pick<NativeWorkSubmissionRequest, 'requestId' | 'inputId' | 'expectedRevision'>> | undefined;
  readonly receipt?: NativeWorkSubmissionReceipt;
  readonly replayed?: boolean;
}
export interface NativeWorkSubmissionActions {
  submitFile(path: string): Promise<NativeWorkSubmissionState | undefined>;
  status(): Promise<NativeWorkSubmissionState | undefined>;
  retry(): Promise<NativeWorkSubmissionState | undefined>;
  /**
   * Drop this workspace's unresolved submission: one lookup first. When the host has it, its
   * receipt is reported and the record released as by status; otherwise the record is removed
   * and nothing is sent.
   */
  discard(): Promise<NativeWorkSubmissionState | undefined>;
  close(): void;
}
const requestIdentity = (command: NativeWorkSubmissionRequest): Pick<NativeWorkSubmissionRequest, 'requestId' | 'inputId' | 'expectedRevision'> => ({
  requestId: command.requestId, inputId: command.inputId, expectedRevision: command.expectedRevision,
});
const freezeCommand = (command: NativeWorkSubmissionRequest): NativeWorkSubmissionRequest => {
  const captured = { ...command, criteria: [...command.criteria] }; Object.freeze(captured.criteria); return Object.freeze(captured);
};
interface Draft extends NativeSubmissionJournalRecord {
  readonly identity: string;
  outcome: 'unknown' | 'submitted' | 'conflict';
}
type Mode = 'submit' | 'status' | 'retry' | 'discard';
/** The step a run is in; error classification reads it, so a typo here must not compile. */
type Phase = 'source' | 'principal' | 'journal-read' | 'snapshot' | 'journal-save' | 'lookup' | 'journal-confirm' | 'journal-remove' | 'submit';
type JournalPhase = Extract<Phase, `journal-${string}`>;
const isJournalPhase = (phase: Phase): phase is JournalPhase => phase === 'journal-read' || phase === 'journal-save' || phase === 'journal-confirm' || phase === 'journal-remove';

/** Durable source/identity first; lookup before any replay; execution is a separate capability. */
export class NativeWorkSubmissionControls {
  private draft: Draft | undefined;
  private last: NativeWorkSubmissionState | undefined;
  private lastIdentity = '';
  private epoch = 0;
  private active: { readonly identity: string; readonly detach: () => void } | undefined;
  constructor(private readonly select: () => NativeWorkSubmissionSelection, private readonly newId: () => string = () => crypto.randomUUID()) {}
  private selection(): NativeWorkSubmissionSelection {
    try { return this.select(); } catch { return { available: false, identity: 'selection-error', reason: 'Native submission host or journal is unavailable.' }; }
  }
  get state(): NativeWorkSubmissionState | undefined {
    return this.selection().identity === this.lastIdentity ? this.last : undefined;
  }
  close(): void {
    ++this.epoch; const active = this.active; this.active = undefined; this.last = undefined;
    active?.detach();
  }
  submitFile(path: string): Promise<NativeWorkSubmissionState | undefined> {
    return this.run('submit', (selection, signal) => readNativeWorkSourceFile(path, selection.workspace, signal));
  }
  submitSource(source: NativeWorkSource): Promise<NativeWorkSubmissionState | undefined> {
    return this.run('submit', async () => validateNativeWorkSource(source));
  }
  status(): Promise<NativeWorkSubmissionState | undefined> { return this.run('status'); }
  retry(): Promise<NativeWorkSubmissionState | undefined> { return this.run('retry'); }
  discard(): Promise<NativeWorkSubmissionState | undefined> { return this.run('discard'); }

  private async run(mode: Mode, load?: (selection: Extract<NativeWorkSubmissionSelection, { available: true }>, signal: AbortSignal) => Promise<NativeWorkSource>): Promise<NativeWorkSubmissionState | undefined> {
    const selected = this.selection();
    if (this.active) {
      if (selected.identity !== this.active.identity || !selected.available) { this.close(); return; }
      return this.state;
    }
    let published = undefined as NativeWorkSubmissionState | undefined;
    const publish = (value: NativeWorkSubmissionState): NativeWorkSubmissionState => { this.lastIdentity = selected.identity; this.last = value; published = value; return value; };
    if (!selected.available) return publish({ status: 'unavailable', message: selected.reason });
    const epoch = ++this.epoch; const controller = new AbortController();
    let binding: NativeWorkSubmissionBinding | undefined; let disposed = false;
    let operationDraft: Draft | undefined; let scope: NativeSubmissionJournalBinding | undefined;
    let phase: Phase = 'source'; let result: NativeWorkSubmissionState | undefined; let savedHere = false;
    const dispose = (): void => { if (disposed || !binding) return; disposed = true; try { binding.dispose(); } catch {} };
    const current = (): boolean => {
      if (epoch !== this.epoch || controller.signal.aborted) return false;
      const now = this.selection(); return now.available && now.identity === selected.identity;
    };
    const detach = (): void => {
      controller.abort();
      if (operationDraft) operationDraft.outcome = 'unknown'; dispose();
    };
    // Selection is checked after every await below; nothing polls it in between.
    this.active = { identity: selected.identity, detach };
    try {
      publish({ status: 'pending', message: mode === 'submit' ? 'Validating exact source before native submission…' : 'Recovering the original submission journal and live principal…' });
      const source = mode === 'submit' ? validateNativeWorkSource(await load!(selected, controller.signal)) : undefined;
      if (!current()) return;
      binding = selected.bind(); if (!current()) return;
      phase = 'principal';
      // readPrincipal accepts only a device-token credential the host itself reported.
      const principalId = await binding.readPrincipal(controller.signal); if (!current()) return;
      scope = { endpoint: selected.endpoint, projectId: selected.projectId, workspace: selected.workspace, principalId };
      phase = 'journal-read';
      let stored = await selected.journal.read(scope); if (!current()) return;
      const prior = this.draft;
      const sameOwner = prior?.identity === selected.identity && sameBinding(prior.binding, scope);
      if (sameOwner && prior && stored?.command.requestId === prior.command.requestId && !sameCommand(stored.command, prior.command)) throw new Error('Journal source changed for the same request');
      if (sameOwner && prior && (stored?.command.requestId === prior.command.requestId || prior.outcome === 'unknown')) {
        operationDraft = prior;
      } else if (stored) {
        operationDraft = { identity: selected.identity, binding: stored.binding, command: freezeCommand(stored.command), outcome: 'unknown' };
      }
      this.draft = operationDraft;
      if (mode === 'submit' && operationDraft?.outcome === 'unknown') {
        result = publish({ status: 'unknown', message: 'A previous submission from this workspace is unresolved, so this one was not sent. Check it with /work submission-status, send it again with /work submission-retry, or drop it with /work submission-discard.', request: requestIdentity(operationDraft.command) });
      } else if (mode !== 'submit' && !operationDraft) {
        result = publish({ status: 'unavailable', message: 'No retained submission exists for this verified host, project, workspace and principal. Use /work submit-file <path>.' });
      } else if (mode === 'submit') {
        phase = 'snapshot'; const snapshot = await binding.readSnapshot(); if (!current()) return;
        if (snapshot.projectId !== selected.projectId || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new Error('Invalid live ledger revision');
        const command = freezeCommand({ requestId: this.newId(), inputId: this.newId(), expectedRevision: snapshot.revision, goal: source!.goal, criteria: [...source!.criteria] });
        if (![command.requestId, command.inputId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 200)
          || new TextEncoder().encode(JSON.stringify(command)).byteLength > NATIVE_SUBMISSION_MAX_BYTES) throw new NativeWorkSourceError('Submission identity or source exceeds native request limits.');
        operationDraft = { identity: selected.identity, binding: scope, command, outcome: 'unknown' }; this.draft = operationDraft;
        phase = 'journal-save';
        await selected.journal.save(scope, command, stored?.command.requestId ?? null); if (!current()) return;
        stored = { binding: scope, command }; savedHere = true;
      }
      if (!result && mode !== 'submit') {
        const draft = operationDraft!; phase = 'lookup';
        const found = await binding.client.get({ requestId: draft.command.requestId }, { signal: controller.signal }); if (!current()) return;
        if (found.kind === 'found') {
          this.validateReceipt(found.receipt, draft); draft.outcome = 'submitted';
          await this.release(selected, scope, draft);
          result = publish({ status: 'submitted', message: mode === 'discard' ? 'The host already has this submission, so it was not discarded: its work exists. No execution was started.' : 'Original submission found. No execution was started.', request: requestIdentity(draft.command), receipt: found.receipt, replayed: true });
        } else if (mode === 'discard') {
          phase = 'journal-remove';
          if (!selected.journal.remove) throw new Error('This journal cannot remove records');
          await selected.journal.remove(scope, draft.command.requestId); if (!current()) return;
          if (this.draft === draft) this.draft = undefined;
          result = publish({ status: 'discarded', message: 'The host has no record of this submission, so it was removed from the journal and nothing was sent. If a lost delivery still arrives, its work appears in /work. A new /work submit-file may be sent now.', request: requestIdentity(draft.command) });
        } else if (mode === 'status' || draft.outcome !== 'unknown') {
          result = publish({ status: 'not-found', message: draft.outcome === 'conflict'
            ? 'The stale submission was not found. An explicitly new submit-file command may capture a fresh revision and identity.'
            : 'Submission not found at this lookup. A lost in-flight delivery may still arrive; no replay was sent.', request: requestIdentity(draft.command) });
        }
      }
      if (!result) {
        const draft = operationDraft!;
        if (!current()) return;
        if (!stored) {
          phase = 'journal-save'; await selected.journal.save(scope, draft.command, null); if (!current()) return;
          savedHere = true;
        }
        // A save this run completed is already durable; only a record recovered from disk is confirmed first.
        if (!savedHere) { phase = 'journal-confirm'; await selected.journal.confirm(scope, draft.command); if (!current()) return; }
        phase = 'submit';
        publish({ status: 'pending', message: mode === 'retry' ? 'Replaying the exact durable request after lookup; IDs, source and revision are unchanged…' : 'Source and identity are durably recorded; submitting to the native ledger…', request: requestIdentity(draft.command) });
        const submitted = await binding.client.submit(draft.command, { signal: controller.signal }); if (!current()) return;
        this.validateReceipt(submitted.receipt, draft); draft.outcome = 'submitted';
        await this.release(selected, scope, draft);
        result = publish({ status: 'submitted', message: 'Native source submitted. No execution was started.', request: requestIdentity(draft.command), receipt: submitted.receipt, replayed: submitted.replayed });
      }
    } catch (error) {
      if (!current()) return;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (phase === 'journal-save' && code === 'conflict' && scope) {
        try {
          const actual = await selected.journal.read(scope); if (!current()) return;
          if (actual) { operationDraft = { identity: selected.identity, binding: actual.binding, command: freezeCommand(actual.command), outcome: 'unknown' }; this.draft = operationDraft; }
        } catch { /* Keep the original journal error; never send after failed persistence. */ }
      }
      // At the snapshot step the draft is only the earlier, already settled request; nothing was created for this run.
      const request = operationDraft && !(mode === 'submit' && phase === 'snapshot') ? requestIdentity(operationDraft.command) : undefined;
      if (error instanceof NativeWorkSourceError) result = publish({ status: 'invalid', message: error.message });
      else if (phase === 'journal-save' && code === 'journal_limit') result = publish({ status: 'unavailable', message: await this.fullJournalMessage(selected), request });
      else if (isJournalPhase(phase)) result = publish({ status: 'unavailable', message: 'The durable submission journal could not be confirmed. No submission was sent. The visible record was preserved; repair storage, then inspect the same request before retrying.', request });
      else if (code === 'NATIVE_SUBMISSION_CONFLICT' || code === 'CONFLICT') {
        if (operationDraft) operationDraft.outcome = 'conflict';
        result = publish({ status: 'conflict', message: 'Native ledger revision changed. The original request was not rewritten. Inspect its status; an explicitly new submit-file command may capture a fresh revision.', request });
      } else if (code === 'PAIRED_OWNER_REQUIRED' || code === 'NATIVE_SUBMISSION_UNSUPPORTED_AUTHORITY' || code === 'NATIVE_SUBMISSION_FORBIDDEN' || code === 'FORBIDDEN') {
        result = publish({ status: 'unavailable', message: 'Submission runs only for a paired device with work-ledger read and write access. Pair this terminal with the daemon (/devices migrate-shared), then retry. No submission was sent.', request });
      } else if (code === 'NATIVE_SUBMISSION_REQUEST_CONFLICT') {
        result = publish({ status: 'unknown', message: 'Submission identity conflicts with recorded input. Inspect the original request; no source or identity was replaced.', request });
      } else result = publish({ status: request ? 'unknown' : 'unavailable', message: request
        ? 'Submission outcome is unknown. Durable source, requestId, inputId and expectedRevision are retained. Inspect status before retrying.'
        : 'Source or native host could not be read. Check the source file, journal and selected host.', request });
    } finally {
      dispose();
      if (epoch === this.epoch) this.active = undefined;
      // Every early `if (!current()) return` lands here with nothing settled. The
      // pending line this run published must not outlive it: nothing is working
      // on it, and it would reappear if the selection flipped back.
      if (result === undefined && this.last !== undefined && this.last === published && this.last.status === 'pending') this.last = undefined;
    }
    if (!current()) { if (operationDraft) operationDraft.outcome = 'unknown'; return; }
    return result;
  }
  /** What a full journal holds, by workspace and age, so the person can choose what to discard. */
  private async fullJournalMessage(selected: Extract<NativeWorkSubmissionSelection, { available: true }>): Promise<string> {
    let records: readonly NativeSubmissionJournalRecord[] = [];
    try { records = (await selected.journal.list?.()) ?? []; } catch { /* the message below still names the step */ }
    const now = Date.now();
    const rows = records.map(record => `  ${record.binding.workspace} · project ${record.binding.projectId} · ${record.savedAt === undefined ? 'saved by an earlier version' : `saved ${Math.max(0, Math.round((now - record.savedAt) / 60_000))} min ago`}`);
    return ['The submission journal is full, so no submission was sent. It holds one unresolved submission per workspace; from each workspace listed, run /work submission-status to settle it or /work submission-discard to drop it, then submit again.',
      ...rows].join('\n');
  }
  /** A settled submission no longer needs its journal slot; a failed release leaves the record, which is harmless. */
  private async release(selected: Extract<NativeWorkSubmissionSelection, { available: true }>, scope: NativeSubmissionJournalBinding | undefined, draft: Draft): Promise<void> {
    if (!scope || !selected.journal.remove) return;
    try { await selected.journal.remove(scope, draft.command.requestId); } catch { /* the receipt is already validated */ }
  }
  private validateReceipt(receipt: NativeWorkSubmissionReceipt, draft: Draft): void {
    if (receipt.projectId !== draft.binding.projectId || receipt.requestId !== draft.command.requestId || receipt.inputId !== draft.command.inputId
      || receipt.goal !== draft.command.goal || JSON.stringify(receipt.criteria) !== JSON.stringify(draft.command.criteria)) throw new Error('Submission receipt differs from durable source');
  }
}

export function nativeWorkSubmissionLines(state: NativeWorkSubmissionState | undefined): string[] {
  if (!state) return ['Native submission was detached or its host, token or workspace changed. Its stale response was discarded.'];
  const lines = [state.message];
  if (state.request) lines.push(`requestId ${state.request.requestId} · inputId ${state.request.inputId} · submitted against ledger revision ${state.request.expectedRevision}`);
  if (state.receipt) {
    const receipt = state.receipt;
    lines.push(`Submission receipt: work ${receipt.workId} · attempt ${receipt.attemptId} · ledger revision ${receipt.ledgerRevision}${state.replayed ? ' · replay/lookup' : ''}`,
      `Native target: work r${receipt.expectedRevision.work} · criteria r${receipt.expectedRevision.criteria} · attempt r${receipt.expectedRevision.attempt}`,
      `Exact source retained: goal ${receipt.goal.length} characters · ${receipt.criteria.length} ordered criteria.`,
      `Inspect /work and use its explicit Start control, or /work start ${receipt.workId} in Agent. Submission never starts execution.`);
  }
  return lines;
}
