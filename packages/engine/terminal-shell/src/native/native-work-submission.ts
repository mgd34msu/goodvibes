import type { WorkLedgerReadSnapshot } from '@goodvibes/engine/platform/platform/workflow/work-ledger';
import type { OperatorNativeWorkSubmissionClient, NativeWorkSubmissionRequest, NativeWorkSubmissionReceipt } from '@goodvibes/engine/platform/platform/workflow/work-ledger/native-submission-client';
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
  /** The request's identity and what was asked for (the Work place's Unanswered list names it by its goal). */
  readonly request?: Readonly<Pick<NativeWorkSubmissionRequest, 'requestId' | 'inputId' | 'expectedRevision' | 'goal'>> | undefined;
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
/** The answer when nothing asked for from this folder waits: not a failure to read. */
export const NO_SENT_WORK_WAITS = 'No work you asked for from this folder waits for an answer.';
const requestIdentity =(command: NativeWorkSubmissionRequest): Pick<NativeWorkSubmissionRequest, 'requestId' | 'inputId' | 'expectedRevision' | 'goal'> => ({
  requestId: command.requestId, inputId: command.inputId, expectedRevision: command.expectedRevision, goal: command.goal,
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
      publish({ status: 'pending', message: mode === 'submit' ? 'Checking what you asked for before it is sent…' : 'Looking up the work you sent earlier…' });
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
        result = publish({ status: 'unknown', message: 'Work you asked for earlier from this folder has no answer from the daemon yet, so this one was not sent. It waits in Work, under Unanswered, where you can check it, send it again or drop it.', request: requestIdentity(operationDraft.command) });
      } else if (mode !== 'submit' && !operationDraft) {
        result = publish({ status: 'unavailable', message: NO_SENT_WORK_WAITS });
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
          result = publish({ status: 'submitted', message: mode === 'discard' ? 'The daemon already has this work, so it was not dropped: it is in Work, not started.' : 'The daemon has this work: it is in Work, not started.', request: requestIdentity(draft.command), receipt: found.receipt, replayed: true });
        } else if (mode === 'discard') {
          phase = 'journal-remove';
          if (!selected.journal.remove) throw new Error('This journal cannot remove records');
          await selected.journal.remove(scope, draft.command.requestId); if (!current()) return;
          if (this.draft === draft) this.draft = undefined;
          result = publish({ status: 'discarded', message: 'The daemon has no record of this work, so it was dropped and nothing was sent. If a lost answer still arrives, the work shows in Work. You can ask for new work now.', request: requestIdentity(draft.command) });
        } else if (mode === 'status' || draft.outcome !== 'unknown') {
          result = publish({ status: 'not-found', message: draft.outcome === 'conflict'
            ? 'The daemon does not have this work. Drop it and ask for the work again.'
            : 'The daemon does not have this work yet. An answer may still be on its way; nothing was sent again.', request: requestIdentity(draft.command) });
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
        publish({ status: 'pending', message: mode === 'retry' ? 'Sending the same work again, exactly as before…' : 'Saved on this computer; sending it to the daemon…', request: requestIdentity(draft.command) });
        const submitted = await binding.client.submit(draft.command, { signal: controller.signal }); if (!current()) return;
        this.validateReceipt(submitted.receipt, draft); draft.outcome = 'submitted';
        await this.release(selected, scope, draft);
        result = publish({ status: 'submitted', message: 'Sent: the work is in Work, not started.', request: requestIdentity(draft.command), receipt: submitted.receipt, replayed: submitted.replayed });
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
      else if (isJournalPhase(phase)) result = publish({ status: 'unavailable', message: 'What you asked for could not be saved on this computer, so nothing was sent. What was saved before is kept; fix the folder or free some space, then check it again.', request });
      else if (code === 'NATIVE_SUBMISSION_CONFLICT' || code === 'CONFLICT') {
        if (operationDraft) operationDraft.outcome = 'conflict';
        result = publish({ status: 'conflict', message: 'Other work changed at the same moment, so this was not taken as it was. Check it, or drop it and ask for the work again.', request });
      } else if (code === 'PAIRED_OWNER_REQUIRED' || code === 'NATIVE_SUBMISSION_UNSUPPORTED_AUTHORITY' || code === 'NATIVE_SUBMISSION_FORBIDDEN' || code === 'FORBIDDEN') {
        result = publish({ status: 'unavailable', message: 'Work can be asked for only from the daemon\'s own computer or a paired device. Pair this terminal with the daemon in Devices and network, then try again. Nothing was sent.', request });
      } else if (code === 'NATIVE_SUBMISSION_WORKSPACE_REFUSED') {
        // The host refused the workspace before it wrote anything: nothing is pending, so no journal entry is kept.
        const draft = operationDraft;
        if (draft) { draft.outcome = 'submitted'; await this.release(selected, scope, draft); if (this.draft === draft) this.draft = undefined; }
        result = publish({ status: 'unavailable', message: workspaceRefusalMessage(error) });
      } else if (code === 'NATIVE_SUBMISSION_REQUEST_CONFLICT') {
        result = publish({ status: 'unknown', message: 'This clashes with work sent earlier. Check the earlier one first; nothing was replaced.', request });
      } else result = publish({ status: request ? 'unknown' : 'unavailable', message: request
        ? 'Whether the daemon has this work is not known. What you asked for is kept here; check it before sending it again.'
        : phase === 'source' ? 'The file could not be read. Check that it is there and holds "goal" and "criteria".'
          : 'The daemon could not be reached, so nothing was sent. Ask again once it runs.', request });
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
    return ['Too much work without an answer is kept, so this was not sent. Each folder keeps one; in each folder listed, check it or drop it in Work, under Unanswered, then ask again.',
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

/**
 * The host's own words for a workspace it refused before writing: what is true and what to do.
 * Only this code's text is shown; it is the daemon's fixed refusal naming the local workspace.
 */
function workspaceRefusalMessage(error: unknown): string {
  const fallback = 'Not submitted: native work cannot run in this workspace. Nothing was written.';
  if (!error || typeof error !== 'object') return fallback;
  const { message, next } = error as { message?: unknown; next?: unknown };
  const steps = Array.isArray(next) ? next.filter((step): step is string => typeof step === 'string' && step.trim().length > 0) : [];
  return [typeof message === 'string' && message.trim() ? message.trim() : fallback, ...steps].join(' ');
}

/** What became of work asked for, in a person's words: the outcome line of New work and of the Unanswered list's controls. */
export function nativeWorkSubmissionLines(state: NativeWorkSubmissionState | undefined): string[] {
  if (!state) return ['The daemon or this folder changed while this was sent; its answer was set aside. Check it again.'];
  const lines = [state.message];
  if (state.receipt) {
    const goal = state.receipt.goal.split('\n')[0]!.trim();
    const results = state.receipt.criteria.length;
    lines.push(`"${goal.length > 80 ? `${goal.slice(0, 77)}...` : goal}", with ${results} result${results === 1 ? '' : 's'} to meet: start it from Work when you want it to run.`);
  }
  return lines;
}
