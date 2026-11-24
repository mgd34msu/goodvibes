import { legacyMigrationPreparationRevision } from '@goodvibes/engine/platform/platform/workflow/work-ledger';
import { nativeWorkExecutionLines, type NativeWorkExecutionAction, type NativeWorkExecutionState } from '@goodvibes/engine/terminal-shell/native';
import { nativeWorkIntegrationView } from '../../runtime/native-work-integration.ts';
import type { NativeWorkLedgerState } from '@goodvibes/engine/terminal-shell/native/bound-work-ledger';
import type { NativeWorkLedgerModalSource } from '../../runtime/native-work-ledger-host.ts';
import type { ConfigModalSurface, ConfigModalView, ConfigModalRow } from '../../input/config-modal-types.ts';

/** A shell built without a native host: the modal says why instead of showing a view. */
type NativeWorkLedgerUnwired = () => { readonly available: false; readonly identity: string; readonly reason: string };

/** Native facts only. Legacy planning and contract approvals remain separate surfaces. */
export function createNativeWorkLedgerModalSurface(source: NativeWorkLedgerModalSource | NativeWorkLedgerUnwired): ConfigModalSurface {
  const wired = typeof source === 'function' ? undefined : source;
  const unwired = typeof source === 'function' ? source().reason : '';
  let unwatch = () => {};
  const read = (): NativeWorkLedgerState => {
    if (!wired) return { status: 'unavailable', reason: unwired };
    wired.view.sync();
    noteExecution(wired.view.state);
    return wired.view.state;
  };
  // A new identity tells the modal its rows were rebuilt: a new binding, project or
  // provenance. Live updates of the same binding keep it, and the scroll with it.
  const identityOf = (state: NativeWorkLedgerState): string =>
    state.status === 'ready'
      ? JSON.stringify(['ready', state.snapshot.projectId, state.snapshot.provenance ?? null, state.executionAvailable])
      : JSON.stringify([state.status, state.reason]);
  const safe = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
  // Encode structure instead of concatenating user/host IDs with field suffixes.
  // The tuple remains injective across sections, items, roles and child indexes.
  const key = (section: string, itemId: string, role: string, index?: number): string =>
    JSON.stringify(index === undefined ? [section, itemId, role] : [section, itemId, role, index]);
  const row = (id: string, label: string): ConfigModalRow => ({ id, label: safe(label), selectable: false });
  const controlWork = (row: ConfigModalRow | null, tabId: string): string | undefined => {
    const state = read();
    if (state.status !== 'ready' || !state.executionAvailable || tabId !== 'work' || !row) return undefined;
    const identity = identityOf(state);
    return state.snapshot.works.find(view => row.id === key('control', view.work.id, identity))?.work.id;
  };
  /** The last execution answer the host gave for each work (check, start, stop, resume), kept while the view is bound. */
  const lastExecution = new Map<string, NonNullable<NativeWorkExecutionState['snapshot']>>();
  const noteExecution = (state: NativeWorkLedgerState): void => {
    const execution = state.status === 'ready' ? state.execution : undefined;
    if (execution?.snapshot && !execution.busy) lastExecution.set(execution.workId, execution.snapshot);
  };
  /**
   * What applies to a work as it stands, from its ledger attempt and the host's
   * last answer about its execution:
   *   no attempt, or one that is no longer active: check only (nothing to run here);
   *   not started yet: start, check (stop is offered once an attempt runs or waits);
   *   waiting to be admitted: check, stop, and resume when the host says recovery is needed;
   *   stopped before admission or cancelled: check only (a new attempt is needed);
   *   admitted: check and resume after it stopped or passed; check and stop while it runs.
   */
  /** Where a work stands, in words, from the same facts as `applicable`. */
  const standing = (workId: string, attemptState: string): string => {
    if (attemptState !== 'active') return attemptState === 'complete' ? 'finished' : attemptState === 'cancelled' ? 'cancelled' : 'released';
    const seen = lastExecution.get(workId);
    if (!seen) return 'not started';
    if (seen.kind === 'prevented-before-admission') return 'stopped before it started';
    if (seen.kind === 'pending-intent') return seen.state === 'refused' ? 'refused by the host' : seen.recovery === 'required' ? 'waiting to start: needs a resume' : 'waiting to start';
    if (seen.state === 'cancelled' || seen.recovery === 'cancelled') return 'stopped';
    if (seen.recovery === 'terminal') return 'ended';
    if (seen.progress?.status === 'passed') return 'passed, being checked';
    if (seen.recovery === 'required') return 'interrupted: needs a resume';
    return 'running';
  };
  const applicable = (workId: string): readonly NativeWorkExecutionAction[] => {
    const state = read();
    const attempt = state.status === 'ready' ? state.snapshot.works.find((view) => view.work.id === workId)?.attempt : undefined;
    if (!attempt) return [];
    if (attempt.state !== 'active') return ['status'];
    const seen = lastExecution.get(workId);
    if (!seen || seen.attemptId !== attempt.id) return ['start', 'status'];
    if (seen.kind === 'prevented-before-admission') return ['status'];
    if (seen.kind === 'pending-intent') return seen.recovery === 'required' ? ['status', 'cancel', 'resume'] : ['status', 'cancel'];
    if (seen.state === 'cancelled' || seen.recovery === 'cancelled' || seen.recovery === 'terminal') return ['status'];
    if (seen.recovery === 'required' || seen.progress?.status === 'passed' || seen.settlement?.state === 'published') return ['status', 'resume'];
    return ['status', 'cancel'];
  };
  // The words only: the keys (Ctrl+S, Ctrl+G I, …) are the hint line's, as this view's search takes plain letters.
  const keyWords: Readonly<Record<NativeWorkExecutionAction, string>> = { start: 'start', status: 'check', cancel: 'stop', resume: 'resume' };
  return {
    name: 'native-work-ledger-modal', title: 'Work',
    get actions() {
      const state = wired?.view.state;
      // Labelled for what a person gets: start it, check on it, stop it, carry on where it stopped or waits.
      // Only the keys that apply to the selected work as it stands are offered (and shown in the hints).
      return state?.status === 'ready' && state.executionAvailable ? ([['s', 'start', 'start'], ['i', 'status', 'check'], ['c', 'cancel', 'stop'], ['r', 'resume', 'resume']] as const).map(([key, id, label]) => ({
        key, id, label, confirm: id === 'cancel',
        enabledFor: (row: ConfigModalRow | null, tabId: string) => {
          const workId = controlWork(row, tabId);
          return workId !== undefined && applicable(workId).includes(id);
        },
      })) : [];
    },
    onAction(actionId, ctx) {
      if (!['start', 'status', 'cancel', 'resume'].includes(actionId)) return;
      const workId = controlWork(ctx.row, ctx.tabId);
      if (!workId || !wired?.view.execute) return;
      void wired.view.execute(actionId as NativeWorkExecutionAction, workId);
    },
    onOpen: changed => {
      if (!wired) return;
      unwatch();
      unwatch = wired.watch(changed);
      wired.view.open();
    },
    onClose: () => {
      unwatch();
      unwatch = () => {};
      wired?.view.close();
    },
    buildView(): ConfigModalView {
      const state = read();
      const ready = state.status === 'ready' ? state : undefined;
      const snapshot = ready?.snapshot;
      const executionAvailable = ready?.executionAvailable ?? false;
      const history = ready?.history ?? [];
      const identity = identityOf(state);
      const reason = state.status === 'ready' ? state.reason ?? '' : state.reason;
      const integration = nativeWorkIntegrationView(ready?.execution);
      const work: ConfigModalRow[] = []; const intent: ConfigModalRow[] = [];
      const attention: ConfigModalRow[] = []; const evidence: ConfigModalRow[] = []; const imports: ConfigModalRow[] = [];
      // The identifiers and revisions a person needs only to report a problem: kept, on their own tab.
      const details: ConfigModalRow[] = [];
      for (const view of snapshot?.works ?? []) {
        const w = view.work; const a = view.attempt;
        // A row reads as a task: its title and where it stands, then whether it is checked done.
        work.push(row(key('work', w.id, 'summary'), `${w.title}: ${a ? `${standing(w.id, a.state)}${a.report ? `, ${a.report}` : ''}` : `${w.reportedState}, not started here`}`));
        work.push(row(key('work', w.id, 'states'), `  Checked: ${view.verification.state}, ${view.verification.reason}`));
        if (executionAvailable) {
          const keys = applicable(w.id).map((act) => keyWords[act]);
          work.push({ id: key('control', w.id, identity), label: safe(keys.length > 0 ? `  ${w.title}: you can ${keys.join(', ')}` : `  ${w.title}: nothing to run here yet`), selectable: true });
        }
        details.push(row(key('details', w.id, 'work'), `${w.id} · ${w.title} · work revision ${w.revision} · criteria revision ${w.criteriaRevision} · reported ${w.reportedState}`));
        details.push(row(key('details', w.id, 'attempt'), a ? `  attempt ${a.id} · revision ${a.revision} · owner ${a.ownerId} · state ${a.state}` : '  no current attempt'));
        details.push(row(key('details', w.id, 'observed'), `  check and stop act on attempt ${wired?.view.observedExecutionAttempt?.(w.id) ?? a?.id ?? 'none'}`));
        intent.push(row(key('intent', w.id, 'goal'), `${w.title}: ${w.goal}`));
        w.criteria.forEach((criterion, index) => intent.push(row(key('intent', w.id, 'criterion', index), `${index + 1}. ${criterion}`)));
        view.attention.forEach((item, index) => attention.push(row(key('attention', w.id, 'item', index), `${w.title}: ${item.reason} (${item.kind})`)));
      }
      if (executionAvailable) {
        const lines = nativeWorkExecutionLines(ready?.execution);
        // Reserve progress structure before the first action so asynchronous
        // state/recovery updates paint without another key or scroll reset.
        for (let index = 0; index < 11; index++) work.push(row(key('execution', 'selected', 'progress', index), lines[index] ?? (index === 0 ? 'Execution: select a control row. Status/cancel retain the last observed attempt.' : '')));
      }
      // Retain durable historical references without calling old evidence current success.
      const proofs = new Map(history.flatMap(event => event.type !== 'import_legacy' && event.evidence ? [[event.evidence.id, event.evidence] as const] : []));
      for (const view of snapshot?.works ?? []) if (view.verification.evidence) proofs.set(view.verification.evidence.id, view.verification.evidence);
      for (const e of proofs.values()) {
        const t = e.target;
        evidence.push(row(key('evidence', e.id, 'summary'), `Recorded earlier: ${e.outcome}, ${e.reason}`));
        e.references.forEach((ref, i) => evidence.push(row(key('evidence', e.id, 'reference', i), `  ${ref.kind}: ${ref.ref}`)));
        details.push(row(key('details', e.id, 'evidence'), `evidence ${e.id} · work ${t.workId}@${t.workRevision} · criteria revision ${t.criteriaRevision} · attempt ${t.attemptId}@${t.attemptRevision}`));
        e.references.forEach((ref, i) => { if (ref.digest) details.push(row(key('details', e.id, 'digest', i), `  ${ref.kind} ${ref.ref} · digest ${ref.digest}`)); });
      }
      for (const event of history) {
        if (event.type !== 'import_legacy') continue;
        const eventId = String(event.sequence);
        imports.push(row(key('imports', eventId, 'summary'), `Import #${event.sequence} · ${event.works.length} work records · actor ${event.actorId} · request ${event.requestId}`));
        imports.push(row(key('imports', eventId, 'authority'), 'Historical approval and completion are source claims, not execution authority or verified evidence.'));
        event.works.forEach((work, index) => imports.push(row(key('imports', eventId, 'work', index), `${work.id} · ${work.title} · reported ${work.reportedState} · imported unverified`)));
        if (!event.manifest) { imports.push(row(key('imports', eventId, 'protected'), 'Protected legacy provenance requires read:knowledge authorization.')); continue; }
        imports.push(row(key('imports', eventId, 'revision'), `Preparation ${legacyMigrationPreparationRevision(event.manifest)}`));
        event.manifest.sources.forEach((source, index) => imports.push(row(key('imports', eventId, 'source', index), `Preserved source ${String(source.source.id)} · generation ${source.generation} · ${JSON.stringify(source.source)}`)));
        event.manifest.links.forEach((link, index) => imports.push(row(key('imports', eventId, 'link', index), `Link ${link.from} · ${link.relation} · ${link.to} · source ${link.sourceId} ${link.pointer}`)));
      }
      return { title: executionAvailable ? 'Work' : 'Work (read-only)', bindingIdentity: identity, scrollInformationalLines: true,
        ...(reason ? { degraded: safe(reason) } : {}),
        tabs: [['work', 'Work', work], ['intent', 'Goal and criteria', intent], ['attention', 'Needs you', attention], ['evidence', 'Results', evidence], ['imports', 'Imported', imports], ['integration', 'Connection', integration.rows], ['details', 'Details', details]].map(([id, label, rows]) => ({
          id: id as string, label: label as string, rows: rows as ConfigModalRow[],
          header: [id === 'details' && snapshot ? safe(`project ${snapshot.projectId} · cursor ${snapshot.cursor}`) : snapshot ? 'Work kept for this project.' : 'Nothing here yet: no work is kept for this project.', id === 'integration'
            ? executionAvailable ? integration.status : 'Not connected: the host that runs this work does not answer.'
            : executionAvailable ? 'Choose a work\'s key row: its keys are the ones that apply to it now. A work is done when its criteria are checked.' : 'Read-only here: approving a plan does not start this work.'],
          emptyText: safe(reason) || 'Nothing in this view.',
        })), hints: ['Esc closes this view; work keeps running. More: /work new · request · submit-file · submission · intake · import-preview · planner (/help work lists them all).'],
      };
    },
  };
}
