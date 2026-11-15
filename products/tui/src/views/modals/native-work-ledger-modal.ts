import { legacyMigrationPreparationRevision } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger';
import { nativeWorkExecutionLines, type NativeWorkExecutionAction } from '@goodvibes-jev/engine/terminal-shell/native';
import { nativeWorkIntegrationView } from '../../runtime/native-work-integration.ts';
import type { NativeWorkLedgerState } from '@goodvibes-jev/engine/terminal-shell/native/bound-work-ledger';
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
  return {
    name: 'native-work-ledger-modal', title: 'Native Work',
    get actions() {
      const state = wired?.view.state;
      return state?.status === 'ready' && state.executionAvailable ? ([['s', 'start'], ['i', 'status'], ['c', 'cancel'], ['r', 'resume']] as const).map(([key, id]) => ({
        key, id, label: id, confirm: id === 'cancel', enabledFor: (row: ConfigModalRow | null, tabId: string) => controlWork(row, tabId) !== undefined,
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
      for (const view of snapshot?.works ?? []) {
        const w = view.work; const a = view.attempt;
        work.push(row(key('work', w.id, 'summary'), `${w.id} · ${w.title} · work revision ${w.revision} · criteria revision ${w.criteriaRevision}`));
        work.push(row(key('work', w.id, 'states'), `reportedState ${w.reportedState} · verificationState ${view.verification.state}: ${view.verification.reason}`));
        if (executionAvailable) work.push({ id: key('control', w.id, identity), label: safe(`Control ${w.id}: s start · i status · c cancel · r explicit resume/reconcile · status/cancel attempt ${wired?.view.observedExecutionAttempt?.(w.id) ?? a?.id ?? 'none'}`), selectable: true });
        work.push(row(key('work', w.id, 'attempt'), a ? `attempt ${a.id} · revision ${a.revision} · owner ${a.ownerId} · state ${a.state}${a.report ? ` · ${a.report}` : ''}` : 'No current attempt.'));
        intent.push(row(key('intent', w.id, 'goal'), `${w.id} · goal: ${w.goal} · criteria revision ${w.criteriaRevision}`));
        w.criteria.forEach((criterion, index) => intent.push(row(key('intent', w.id, 'criterion', index), `${index + 1}. ${criterion}`)));
        view.attention.forEach((item, index) => attention.push(row(key('attention', w.id, 'item', index), `${w.id} · attempt ${a?.id ?? 'none'} · ${item.kind}: ${item.reason}`)));
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
        evidence.push(row(key('evidence', e.id, 'summary'), `${e.id} · historical outcome ${e.outcome} · work ${t.workId}@${t.workRevision} · criteria revision ${t.criteriaRevision} · attempt ${t.attemptId}@${t.attemptRevision} · ${e.reason}`));
        e.references.forEach((ref, i) => evidence.push(row(key('evidence', e.id, 'reference', i), `${ref.kind}: ${ref.ref}${ref.digest ? ` · digest ${ref.digest}` : ''}`)));
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
      return { title: executionAvailable ? 'Native Work' : 'Native Work (read-only)', bindingIdentity: identity, scrollInformationalLines: true,
        deferredStructureMessage: 'Native rows changed; press an arrow key to show the current layout.',
        ...(reason ? { degraded: safe(reason) } : {}),
        tabs: [['work', 'Work', work], ['intent', 'Intent', intent], ['attention', 'Attention', attention], ['evidence', 'Evidence', evidence], ['imports', 'Legacy imports', imports], ['integration', 'Integration', integration.rows]].map(([id, label, rows]) => ({
          id: id as string, label: label as string, rows: rows as ConfigModalRow[],
          header: [snapshot ? safe(`project ${snapshot.projectId} · durable cursor ${snapshot.cursor}`) : 'No native host data.', id === 'integration'
            ? executionAvailable ? integration.status : 'Integration unavailable: native execution status is not connected.'
            : executionAvailable ? 'Select a control row for explicit execution. Ledger criteria and verification remain authoritative.' : 'Read-only. Planning approvals do not authorize native execution.'],
          emptyText: safe(reason) || 'No native records in this view.',
        })), hints: ['Esc detaches local requests. Execution controls are on Work. Reopen to reconnect.'],
      };
    },
  };
}
