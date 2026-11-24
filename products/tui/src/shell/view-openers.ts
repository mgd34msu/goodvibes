/**
 * view-openers.ts, the openers for the built-in modals: Agents, Usage,
 * Changes (and its previews), Notifications and the local-auth password
 * prompt, plus ctx.openView, which turns any current or old view name
 * ('fleet', 'cockpit', 'tokens', 'git', 'providers', …) into the modal that
 * holds it now (input/views.ts).
 *
 * Every modal is a kit SurfaceModal pushed on the input handler's modal host.
 * Opening one that is already open brings it to the top instead of stacking a
 * second copy.
 */

import type { CommandContext } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import type { SurfaceModal } from '@goodvibes/engine/terminal-shell/surface-modal-host';
import { runPickedCommand } from '@goodvibes/engine/terminal-shell/command-registry';
import { openModeSegment } from '@goodvibes/engine/terminal-shell/first-run';
import type { ShellViews } from '../views/builtin-views.ts';
import type { ViewPanelAdapter } from '../views/view-panel-adapter.ts';
import { AgentsModal } from '../input/agents-modal.ts';
import { UsageModal } from '../input/usage-modal.ts';
import { ChangesModal, type ChangesDeps } from '../input/changes-modal.ts';
import { NotificationsModal } from '../input/notifications-modal.ts';
import { MaskedEntryModal } from '../input/masked-entry-modal.ts';
import { confirmThrough } from '../input/confirm-dialog.ts';
import { resolveViewName, type ViewTarget } from '../input/views.ts';
import { getSharedNotificationFeed } from '../views/notifications-feed.ts';
import { getSharedHostedSessionFeed } from '../views/hosted-session-feed.ts';
import { revertReviewHunk } from '../input/commands/review-runtime.ts';
import { sayToHosted } from '../input/commands/hosted-runtime.ts';

export interface WireViewOpenersOptions {
  readonly commandContext: CommandContext;
  readonly input: InputHandler;
  readonly views: ShellViews;
  readonly viewPanelAdapter: ViewPanelAdapter;
  readonly render: () => void;
}

/** Split a preview text into a diff and a note: `@@ label @@\n text` is a note, not a hunk. */
function previewParts(text: string): { diff: string | null; note: string | null } {
  const first = text.split('\n', 1)[0] ?? '';
  if (/^@@ (?!-)/.test(first)) return { diff: null, note: text.slice(first.length + 1).trim() || null };
  return { diff: text, note: null };
}

export function wireViewOpeners(options: WireViewOpenersOptions): void {
  const { commandContext, input, views, viewPanelAdapter, render } = options;
  const host = input.surfaceModals;

  const findOpen = <T extends SurfaceModal>(type: abstract new (...args: never[]) => T): T | undefined =>
    host.modals().find((modal): modal is T => modal instanceof type);

  const show = (modal: SurfaceModal): void => {
    host.push(modal);
    render();
  };

  // ── Agents ────────────────────────────────────────────────────────────────
  commandContext.openAgents = (opts = {}) => {
    const modal = findOpen(AgentsModal) ?? new AgentsModal({
      readModel: views.fleet.readModel,
      actions: views.fleet.actions,
      acts: views.fleet.acts,
      spawn: views.fleet.spawn,
      configManager: views.configManager,
      hosted: getSharedHostedSessionFeed(),
      // The outcome goes back to the modal so it never claims a send that did not happen.
      // The draft's own attachment travels with it: sent only to the session it was written for.
      steerHosted: (text, binding) => sayToHosted(commandContext, text, undefined, binding),
      confirm: (confirmOptions) => confirmThrough(host, confirmOptions),
      requestRender: render,
      openSessionView: (target) => commandContext.openSessionView?.(target) ?? false,
      // Finished work listed is this run's: the service's older finished rows stay in its own history.
      sessionStartedAt: Math.floor(performance.timeOrigin),
      asks: () => commandContext.waitingAsks?.() ?? [],
    });
    if (opts.target) modal.reveal(opts.target);
    if (opts.hosted) modal.showHosted();
    show(modal);
  };

  // ── Usage ─────────────────────────────────────────────────────────────────
  commandContext.openUsage = (opts = {}) => {
    const existing = findOpen(UsageModal);
    if (existing) {
      if (opts.tab) existing.tab = opts.tab;
      show(existing);
      return;
    }
    show(new UsageModal({
      tracker: views.usage,
      tab: opts.tab,
      compact: () => { void runPickedCommand(commandContext.executeCommand, 'compact', [], (message) => commandContext.print(message)).finally(render); },
      requestRender: render,
    }));
  };
  // A click on a status bar segment opens its view; elsewhere on the row, Usage.
  input.onFooterTarget = (target) => {
    if (target === 'usage') commandContext.openUsage?.();
    // The mode opens first run's "Who decides" while no decision model can be asked; otherwise /permissions:
    // what is in force and why on its first row, the fix and the mode setting below it.
    else if (target === 'mode') void openModeSegment(commandContext).finally(render);
    else if (target === 'notices') commandContext.openNotifications?.();
    else if (target === 'context') commandContext.openContextInspector?.();
    else if (target === 'changes') commandContext.openChanges?.();
    else if (target === 'model') commandContext.openModelPicker?.();
    else if (target === 'agents') commandContext.openAgents?.();
    else if (target === 'commands') commandContext.openCommandPalette?.();
    else if (target === 'bottom') {
      if (input.sessionView?.active) input.sessionView.follow();
      else input.transcriptScroll?.toBottom();
      render();
    }
  };

  // ── Changes ───────────────────────────────────────────────────────────────
  const changesDeps: ChangesDeps = {
    workingDirectory: views.workingDirectory,
    getSessionFiles: views.getSessionFiles,
    requestRender: render,
    // A steer message built from the review is sent as written, not read as composer input.
    submitInput: (text) => commandContext.submitTurn?.(text),
    openInEditor: (path, line) => commandContext.openFileInEditor?.(path, line),
    revertHunk: (hunk) => revertReviewHunk(commandContext, hunk),
    confirm: (confirmOptions) => confirmThrough(host, confirmOptions),
  };
  // One workspace for the session: reviewed marks and attached comments survive closing it.
  const workspace = new ChangesModal(changesDeps, 'workspace');
  commandContext.openChanges = (opts = {}) => {
    show(workspace);
    void workspace.reload(opts.source ?? workspace.source);
  };

  const preview = (title: string, text: string | null, note: string | null): ChangesModal => {
    const modal = new ChangesModal(changesDeps, 'preview');
    const parts = text ? previewParts(text) : { diff: null, note: null };
    modal.loadPreview(title, parts.diff, note ?? parts.note);
    show(modal);
    return modal;
  };
  commandContext.previewChanges = async (opts) => {
    const modal = preview(opts.title, opts.diff ?? null, opts.note ?? null);
    if (!opts.question) return false;
    return modal.ask(opts.question);
  };

  // The fleet acts show candidate diffs and ask over them through this.
  let fleetPreview: ChangesModal | null = null;
  views.bridge.diffSurface = {
    show: (title, diff) => {
      if (fleetPreview) host.close(fleetPreview, 'done');
      fleetPreview = preview(title, diff, null);
    },
    armConfirm: (arm) => {
      const tone = arm.verb === 'Discard' ? 'danger' as const : 'warning' as const;
      const asked = fleetPreview && host.modals().includes(fleetPreview)
        ? fleetPreview.ask({ text: arm.label, confirmLabel: arm.verb, tone })
        : confirmThrough(host, { title: `${arm.verb}?`, body: arm.label, confirmLabel: arm.verb, tone });
      void asked.then((ok) => {
        if (ok) void arm.onConfirm();
        else arm.onCancel?.();
        render();
      });
    },
    close: () => {
      if (fleetPreview) host.close(fleetPreview, 'done');
      fleetPreview = null;
      render();
    },
  };

  // ── Notifications ─────────────────────────────────────────────────────────
  const redirect = (name: string): string | undefined => views.modalSurfaces.getModalRedirect(name);
  commandContext.openNotifications = () => {
    show(findOpen(NotificationsModal) ?? new NotificationsModal({
      feed: getSharedNotificationFeed(),
      resolveSubject: (subject) => (resolveViewName(subject, redirect) ? () => { openView(subject); } : null),
    }));
  };

  // ── Local-auth password prompt ────────────────────────────────────────────
  const openMaskedEntry = (kind: 'add-user' | 'rotate-password', username?: string): void => {
    show(new MaskedEntryModal({
      kind,
      username,
      auth: views.localUserAuthManager,
      onDone: (message) => { commandContext.print(message); render(); },
    }));
  };
  views.bridge.openMaskedEntry = openMaskedEntry;
  commandContext.openLocalAuthMaskedEntry = openMaskedEntry;

  // ── Any view by name ──────────────────────────────────────────────────────
  const openView = (name: string, target?: ViewTarget): boolean => {
    const route = resolveViewName(name, redirect);
    if (!route) return false;
    switch (route.kind) {
      case 'agents': commandContext.openAgents?.({ target, hosted: route.hosted }); break;
      case 'usage': commandContext.openUsage?.({ tab: route.tab }); break;
      case 'changes': commandContext.openChanges?.({ source: route.mode === 'git' ? 'working' : 'session' }); break;
      case 'notifications': commandContext.openNotifications?.(); break;
      case 'sessions': commandContext.openSessionPicker?.(); break;
      case 'modal': commandContext.openModal?.(route.name); break;
    }
    return true;
  };
  commandContext.openView = openView;
  // What panels.list and panels.open report: the listed views whose modal is on
  // screen now, bottom of the stack first, so the last one is the view in front.
  const openViewIds = (): readonly string[] => {
    const open: string[] = [];
    for (const modal of host.modals()) {
      if (modal instanceof AgentsModal) open.push('agents');
      else if (modal instanceof UsageModal) open.push('usage');
      else if (modal === workspace) open.push('changes');
      else if (modal instanceof NotificationsModal) open.push('notifications');
    }
    if (input.sessionPickerModal.active) open.push('sessions');
    return open;
  };
  viewPanelAdapter.setOpener((id) => openView(id) && openViewIds().includes(id), openViewIds);

  // The older per-console callbacks commands still call, each onto its modal.
  commandContext.openForensicsView = () => { openView('forensics'); };
  commandContext.openIncidentView = () => { openView('incident'); };
  commandContext.openPolicyView = () => { openView('policy'); };
  commandContext.openHooksView = () => { openView('hooks'); };
  commandContext.openCommunicationView = () => { openView('communication'); };
  commandContext.openOrchestrationView = () => { openView('orchestration'); };
  commandContext.openCockpitView = () => { openView('cockpit'); };
  commandContext.openSecurityView = () => { openView('security'); };
  commandContext.openKnowledgeView = () => { openView('knowledge'); };
  commandContext.openMemoryView = () => { openView('memory'); };
  commandContext.openRemoteView = () => { openView('remote'); };
  commandContext.openSubscriptionView = () => { openView('subscription'); };
}
