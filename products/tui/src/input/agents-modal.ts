/**
 * agents-modal.ts, the "Your agents" panel (/agents, F2, ctrl+o, and the old
 * console names fleet, cockpit, tasks, …): the work board reading drawn by
 * the shared renderer (terminal-shell renderer/work-board.ts) around the
 * shared list (terminal-shell work-board-input.ts), with this program's full
 * views and controllers.
 *
 * Keys on the list: ↑↓ move; Enter opens the selected agent (or background
 * process) full screen with its own composer, which steers it; a contract,
 * workflow or hosted agent opens full height inside the panel, where s steers
 * it; a row waiting on you acts (pick a winner, resolve a conflict) or opens
 * the agent whose ask waits; s stops it and what it started (asks first; also
 * ctrl+x); n starts a new agent; b opens the background services; p pauses or
 * resumes a schedule; i interrupts; D discards a worktree; f follows the
 * newest running agent; v switches to the archive, a archives or restores, A
 * archives everything finished; / filters. In the full view ctrl+x stops
 * (asks first), [ ] step between opened agents, and Esc goes back up a level
 * and never stops anything.
 */

import { readFile } from 'node:fs/promises';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { ContractView } from '@goodvibes-jev/engine/platform/platform/contract';
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import type { ConversationMessageSnapshot } from '@goodvibes-jev/engine/platform/platform/core';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { ProcessNode, SteerResult } from '@goodvibes-jev/engine/platform/platform/runtime/fleet';
import type { Line } from '@goodvibes-jev/engine/platform/platform/types';
import type { WorkBoardSession } from '@goodvibes-jev/engine/contracts';
import type { SurfaceModal, SurfaceModalHost } from '@goodvibes-jev/engine/terminal-shell/surface-modal-host';
import { renderWorkBoardPanel, type PanelDetail, type PanelText, type WorkBoardPanelView } from '@goodvibes-jev/engine/terminal-shell/work-board';
import { WorkBoardList } from '@goodvibes-jev/engine/terminal-shell/work-board-input';
import type { KitHint, SurfaceLayer } from '../renderer/surface-kit.ts';
import { fleetNodeAttention, isRunningProcessState, isTerminalProcessState, type FleetReadModel, type FleetSnapshot } from '../views/fleet-read-model.ts';
import type { FleetActs } from '../views/fleet-acts.ts';
import type { FleetSpawn } from '../views/fleet-spawn.ts';
import {
  activeFleetTab, attachFleetTab, EMPTY_FLEET_TABS_STATE, isAttachableFleetKind, stepFleetTab, type FleetTab, type FleetTabsState,
} from '../views/fleet-session-tabs.ts';
import { liveSteerableLabels, reconcileSteerBadges, steerRefusalMessage, steerBadgeFromReceipt, steerReceiptLabel } from '../views/fleet-steer.ts';
import { countDescendantStats, FleetStopTracker, toggleFleetPause } from '../views/fleet-stop.ts';
import { renderFleetDetailLines } from '../views/fleet-format.ts';
import { parseAgentLedger, renderFleetAgentTranscript, renderFleetContractSummary, renderFleetLedgerFallback, renderFleetTranscriptLoading } from '../views/fleet-transcript.ts';
import { isObservedExternalNode } from '../views/fleet-observed-render.ts';
import type { HostedSessionFeed } from '../views/hosted-session-feed.ts';
import { isTextBackspace } from './delete-key-policy.ts';
import type { ConfirmOptions } from './confirm-dialog.ts';
import type { ViewTarget } from './views.ts';
import { hostedHeaderTexts, hostedRowTexts, transcriptTail } from './agents-modal-text.ts';
import { HostedTranscriptViewport } from './hosted-transcript-viewport.ts';
import { currentHostedBinding } from '../runtime/client/hosted-attachments.ts';
import type { SessionBinding } from '@goodvibes-jev/engine/platform/platform/runtime/client/session-binding';

/** What the panel can do to a process (the process registry, through the fleet read model). */
export interface FleetActionCallbacks {
  readonly interrupt: (id: string) => boolean;
  readonly resume: (id: string) => boolean;
  readonly kill: (id: string, opts: { readonly cascade: boolean }) => readonly string[];
  /** An agent's conversation, live or just finished (only the newest `last` messages when given); empty when unavailable. */
  readonly getConversationSnapshot: (agentId: string, options?: { readonly last?: number }) => readonly ConversationMessageSnapshot[];
  /** The agent's on-disk event log, the fallback when its conversation is gone. */
  readonly resolveSessionLogPath: (agentId: string) => string;
  readonly steer: (id: string, text: string) => SteerResult;
}

export interface AgentsModalDeps {
  readonly readModel: FleetReadModel;
  readonly actions: FleetActionCallbacks;
  readonly acts?: FleetActs | null;
  readonly spawn?: FleetSpawn | null;
  readonly configManager?: ConfigManager | null;
  readonly hosted?: HostedSessionFeed;
  /**
   * Send a line to the hosted session (/hosted send). A returned promise is
   * awaited: `{ ok: false }` or a rejection keeps the draft and shows the
   * error; a plain return (nothing to await) counts as sent.
   */
  readonly steerHosted?: (text: string, binding: SessionBinding | null) => void | Promise<void | { readonly ok: boolean; readonly error?: string }>;
  readonly confirm?: (options: ConfirmOptions) => Promise<boolean>;
  readonly requestRender: () => void;
  /** Tick for elapsed times and steer badges (ms; 0 disables, for tests). */
  readonly tickMs?: number;
  /** Open an agent or background process full screen (shell/session-views.ts); false when it is not known here. */
  readonly openSessionView?: (target: { readonly kind: 'agent' | 'process'; readonly id: string }) => boolean;
  /** When this run of the program began: finished work from before it is not listed. */
  readonly sessionStartedAt?: number;
}

const HOSTED_ID = 'hosted-session';
const HOSTED_END_HINT = 'The hosted session ends with /hosted end; /hosted leave keeps or ends it, as its setting says.';

/** One key in the vocabulary the fleet controllers (acts, spawn) take. */
function keyName(token: InputToken): string | null {
  if (token.type === 'text') return token.value.length === 1 ? token.value : null;
  if (token.type === 'key') return token.logicalName ?? null;
  return null;
}

export class AgentsModal implements SurfaceModal {
  readonly name = 'agents';
  readonly list: WorkBoardList;
  follow = false;
  tabs: FleetTabsState = EMPTY_FLEET_TABS_STATE;
  /** The full-height view of the hosted session is open. */
  hostedFull = false;
  /** The composer: its target and, for the hosted session, the attachment it was opened for (sent only there). */
  steer: { readonly id: string; draft: string; readonly binding?: SessionBinding | null } | null = null;
  private hostedSending = false;
  status: PanelText | null = null;
  private receiptStatus: { nodeId: string; messageId: string; label: string; status: PanelText } | null = null;
  readonly stopTracker = new FleetStopTracker();
  private readonly unsubs: Array<() => void> = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly hostedViewport = new HostedTranscriptViewport();
  /**
   * The fleet as last read, shared by every helper of a frame. Dropped when the
   * registry reports a change, on the elapsed-time tick and around every key,
   * so a repaint the rest of the app asks for reads nothing new.
   */
  private liveSnapshot: FleetSnapshot | null = null;
  private archivedSnapshot: FleetSnapshot | null = null;
  /** The selected agent's transcript tail, read once per fleet reading. */
  private tailCache: { readonly nodeId: string; readonly texts: PanelText[] } | null = null;

  constructor(private readonly deps: AgentsModalDeps) {
    this.list = new WorkBoardList({
      nodes: () => this.fleet().rows.map((row) => row.node),
      sessions: () => this.hostedSessions(),
      archived: () => this.archivedFleet().rows.map((row) => row.node),
      sessionStartedAt: deps.sessionStartedAt,
    });
    // What 'n' (new agent) finds or fails on is said here, not behind the panel.
    deps.spawn?.reportTo((message) => { this.say(message, 'faint'); this.invalidate(); });
    this.unsubs.push(deps.readModel.subscribe(() => { this.invalidate(); this.onFleetChange(); deps.requestRender(); }));
    this.unsubs.push(deps.readModel.subscribeConsumed((event) => {
      // Unsubscribe cannot retract delivery already queued by the event bus.
      if (this.closed) return;
      for (const tab of this.tabs.tabs) {
        const badge = tab.steerBadge;
        if (badge && badge.messageId === event.messageId && (badge.status === 'queued' || badge.status === 'unknown' || badge.status === 'dropped')) {
          tab.steerBadge = { messageId: badge.messageId, status: 'consumed', queuedAt: badge.queuedAt, resolvedAt: Date.now() };
        }
      }
      deps.requestRender();
    }));
    if (deps.hosted) this.unsubs.push(deps.hosted.subscribe(() => {
      // Feed dispatch snapshots listeners; a queued callback can outlive close.
      if (this.closed) return;
      this.synchronizeHostedView(); this.list.invalidate(); deps.requestRender();
    }));
    const tickMs = deps.tickMs ?? 1_000;
    if (tickMs > 0) this.tickTimer = setInterval(() => { this.invalidate(); this.onFleetChange(); deps.requestRender(); }, tickMs);
  }

  private invalidate(): void {
    this.liveSnapshot = null;
    this.archivedSnapshot = null;
    this.tailCache = null;
    this.list.invalidate();
  }

  private fleet(): FleetSnapshot {
    return this.liveSnapshot ??= this.deps.readModel.getSnapshot();
  }

  private archivedFleet(): FleetSnapshot {
    return this.archivedSnapshot ??= this.deps.readModel.getArchivedSnapshot();
  }

  /** The daemon-hosted conversation this terminal is attached to, listed while it answers. */
  private hostedSessions(): WorkBoardSession[] {
    const state = this.deps.hosted?.getState();
    if (!state?.record || !state.streaming) return [];
    return [{ id: HOSTED_ID, title: state.record.title.trim() || 'Hosted session', state: 'running' }];
  }

  onClose(): void {
    this.closed = true;
    this.hostedViewport.reset();
    this.deps.spawn?.cancel();
    this.deps.spawn?.reportTo(null);
    this.deps.acts?.cancelPick();
    this.deps.acts?.forgetGraphsExcept(new Set(this.deps.readModel.getSnapshot().rows.map((row) => row.node.id)));
    this.invalidate();
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const tab of this.tabs.tabs) tab.lineCache.clear();
  }

  private onFleetChange(): void {
    this.applyFollow();
    if (this.tabs.tabs.length > 0) reconcileSteerBadges(this.tabs.tabs, (id) => this.findNode(id), Date.now());
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  private findNode(id: string): ProcessNode | null {
    return this.fleet().rows.find((row) => row.node.id === id)?.node ?? null;
  }

  private synchronizeHostedView(): void {
    const feed = this.deps.hosted;
    if (!feed) return;
    const state = feed.getState();
    this.hostedViewport.synchronize(state, feed.getGeneration());
    if (!state.record && this.hostedFull) this.hostedFull = false;
  }

  private hostedAttached(): boolean {
    return !this.list.archive && Boolean(this.deps.hosted?.getState().record);
  }

  /** The node of the selected row (live or archived), or null for a session row or none. */
  selectedNode(): ProcessNode | null {
    const selected = this.list.selected();
    if (!selected || selected.row.ref.type === 'session') return null;
    const id = selected.row.ref.id;
    const rows = this.list.archive ? this.archivedFleet().rows : this.fleet().rows;
    return rows.find((row) => row.node.id === id)?.node ?? null;
  }

  private move(delta: number): void {
    const before = this.list.selected()?.key;
    this.list.move(delta);
    if (this.list.selected()?.key !== before) this.deps.acts?.cancelPick();
    this.follow = false;
  }

  private applyFollow(): void {
    if (!this.follow) return;
    let best: ProcessNode | null = null;
    for (const row of this.fleet().rows) {
      if (!isRunningProcessState(row.node.state) || row.node.serves === 'system') continue;
      if (!best || (row.node.startedAt ?? 0) >= (best.startedAt ?? 0)) best = row.node;
    }
    if (best) {
      if (this.list.selected()?.row.ref.id !== best.id) this.deps.acts?.cancelPick();
      this.list.selectId(best.id);
    }
  }

  /** Select a specific process (a deep link from a notification, the work plan, /agents --target). */
  reveal(target: ViewTarget): boolean {
    this.invalidate();
    this.deps.acts?.cancelPick();
    const rows = this.fleet().rows;
    // A tool target (the keybindings modal's Tools tab) names a tool, not a
    // process: select the first process whose current step is that tool.
    const row = target.kind === 'tool'
      ? rows.find((r) => r.node.currentActivity?.toolName === target.id)
      : rows.find((r) => r.node.id === target.id && (!target.kind || r.node.kind === target.kind));
    this.list.archive = false;
    this.tabs = { tabs: this.tabs.tabs, activeTabIndex: 0 };
    this.hostedFull = false;
    this.list.query = '';
    if (!row) {
      this.status = target.kind === 'tool'
        ? { text: `Nothing is running ${target.id} right now.`, tone: 'muted' }
        : { text: `${target.id} is no longer running here.`, tone: 'warning' };
      return false;
    }
    // A background service is listed under the services line: open it so the row shows.
    if (row.node.serves === 'system') this.list.servicesOpen = true;
    this.list.selectId(row.node.id);
    this.status = null;
    return true;
  }

  /** Open the hosted session's full view (after /hosted new or attach). */
  showHosted(): void {
    this.hostedViewport.reset();
    this.synchronizeHostedView();
    this.deps.acts?.cancelPick();
    this.list.archive = false;
    this.list.selectId(HOSTED_ID);
    this.hostedFull = this.hostedAttached();
    this.tabs = { tabs: this.tabs.tabs, activeTabIndex: 0 };
  }

  private level(): 'list' | 'full' | 'picker' {
    if (this.deps.acts?.pickModeActive() || this.deps.spawn?.spawnModeActive()) return 'picker';
    if (this.hostedFull || this.tabs.activeTabIndex > 0) return 'full';
    return 'list';
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  private say(text: string, tone: PanelText['tone'] = 'muted'): void {
    this.receiptStatus = null;
    this.status = { text, tone };
  }

  private openSelected(host: SurfaceModalHost): void {
    const selected = this.list.selected();
    if (!selected) return;
    const row = selected.row;
    if (row.ref.type === 'session' && row.ref.id === HOSTED_ID) { this.hostedViewport.reset(); this.synchronizeHostedView(); this.hostedFull = this.hostedAttached(); return; }
    if (selected.section === 'service') {
      if (row.actions.includes('resume') && this.deps.actions.resume(row.ref.id)) { this.say(`Restarting ${this.findNode(row.ref.id)?.label ?? row.title}…`, 'warning'); return; }
      this.say(`${row.title}: it can't be restarted from here.`, 'faint');
      return;
    }
    const node = this.selectedNode();
    if (!node) return;
    if (this.deps.acts?.handleTreeKey('enter', node)) return;
    // An observed agent opens its own steering line (typing into its terminal session).
    if (isObservedExternalNode(node)) { this.deps.acts?.handleTreeKey('s', node); return; }
    // An agent or a background process opens full screen, outside the panel, with its own composer.
    const target = node.kind === 'agent' ? { kind: 'agent' as const, id: node.id }
      : node.kind === 'background-process' ? { kind: 'process' as const, id: node.id } : null;
    if (target && this.deps.openSessionView?.(target)) {
      host.close(this, 'done');
      return;
    }
    if (!isAttachableFleetKind(node.kind)) {
      this.say(`${row.title} has nothing more to open; its details are on this row.`, 'faint');
      return;
    }
    this.tabs = attachFleetTab(this.tabs, node);
  }

  /** s in an opened agent's full view: the composer line that steers it. */
  private beginSteer(): void {
    if (this.hostedFull) {
      if (!this.deps.steerHosted) { this.say('Talking to the hosted session is not available here.', 'error'); return; }
      // The draft belongs to the session attached now; an attach that completes while it is typed does not redirect it.
      this.steer = { id: HOSTED_ID, draft: '', binding: this.deps.hosted ? currentHostedBinding(this.deps.hosted) : null };
      return;
    }
    const tab = activeFleetTab(this.tabs);
    const node = tab ? this.findNode(tab.nodeId) : null;
    if (!node) { this.say('That agent finished: nothing to steer.', 'faint'); return; }
    if (isObservedExternalNode(node)) { this.deps.acts?.handleTreeKey('s', node); return; }
    if (isTerminalProcessState(node.state)) { this.say(`${node.label} already finished: nothing to steer.`, 'faint'); return; }
    if (!node.capabilities.steerable || !isAttachableFleetKind(node.kind)) { this.say(`${node.label} does not take messages.`, 'faint'); return; }
    this.steer = { id: node.id, draft: '' };
  }

  private submitSteer(): void {
    const steer = this.steer;
    if (!steer) return;
    const text = steer.draft.trim();
    if (!text) { this.steer = null; return; }
    if (steer.id === HOSTED_ID) {
      if (this.hostedSending) return;
      let pending: ReturnType<NonNullable<AgentsModalDeps['steerHosted']>>;
      try {
        pending = this.deps.steerHosted?.(text, steer.binding ?? null);
      } catch (error) {
        this.say(`Not sent to the hosted session: ${summarizeError(error)}`, 'error');
        return;
      }
      if (pending === undefined || typeof (pending as PromiseLike<unknown>).then !== 'function') {
        this.steer = null;
        this.say('Sent to the hosted session.');
        return;
      }
      this.hostedSending = true;
      void (pending as Promise<void | { readonly ok: boolean; readonly error?: string }>).then(
        (outcome) => outcome && outcome.ok === false ? (outcome.error ?? 'the GoodVibes service did not accept it') : null,
        (error: unknown) => summarizeError(error),
      ).then((failure) => {
        this.hostedSending = false;
        if (this.closed || this.steer !== steer) return;
        if (failure === null) {
          this.steer = null;
          this.say('Sent to the hosted session.');
        } else {
          // The draft stays so nothing typed is lost.
          this.say(`Not sent to the hosted session: ${failure}`, 'error');
        }
        this.deps.requestRender();
      });
      return;
    }
    const submittedKind = this.findNode(steer.id)?.kind;
    const result = this.deps.actions.steer(steer.id, text);
    // A synchronous host callback can close this panel or replace the composer.
    // Its receipt must not overwrite a newer target/draft or paint a closed view.
    if (this.closed || this.steer !== steer) return;
    if (result.queued === 'partial') {
      // Part of it reached the target: sending the draft again would type it twice, so it is not kept for a resend.
      this.say(`${result.reason}. Finish it in that session; it was not sent again.`, 'error');
      return;
    }
    if (!result.queued) {
      // The draft stays so nothing typed is lost.
      const siblings = liveSteerableLabels(this.fleet().rows.map((row) => row.node), steer.id);
      this.say(steerRefusalMessage(result.reason, siblings), 'error');
      return;
    }
    const badge = steerBadgeFromReceipt(result, submittedKind, Date.now());
    const node = this.findNode(steer.id);
    if (node) {
      const keep = this.tabs.activeTabIndex;
      this.tabs = attachFleetTab(this.tabs, node);
      if (this.level() !== 'full' || keep === 0) this.tabs = { tabs: this.tabs.tabs, activeTabIndex: keep };
      const tab = this.tabs.tabs.find((t) => t.nodeId === steer.id);
      if (tab) tab.steerBadge = badge;
    }
    this.steer = null;
    this.say(steerReceiptLabel(badge, node?.label ?? steer.id));
    if (node && this.status) this.receiptStatus = { nodeId: node.id, messageId: badge.messageId, label: node.label, status: this.status };
  }

  /** s / ctrl+x: stop the node and everything it started, after asking. */
  private stopSelected(nodeId?: string): void {
    const node = nodeId ? this.findNode(nodeId) : this.selectedNode();
    const row = this.list.selected()?.row;
    if (!node) {
      if (row?.ref.id === HOSTED_ID) this.say(HOSTED_END_HINT, 'faint');
      return;
    }
    const name = node.kind === 'agent' || node.kind === 'acp-agent' ? (row?.ref.id === node.id && row.who ? row.who : node.label) : node.label;
    const title = row && row.ref.id === node.id ? row.title : node.task ?? node.label;
    if (isTerminalProcessState(node.state)) { this.say(`${name} already finished.`, 'faint'); return; }
    if (!node.capabilities.killable) { this.say(`${name} can't be stopped from here.`, 'faint'); return; }
    if (!this.deps.confirm) { this.say('Stopping needs a confirm dialog, which is not available here.', 'error'); return; }
    const stats = countDescendantStats(this.fleet().rows, node.id);
    const more = stats.total > 0 ? ` and the ${stats.total} ${stats.total === 1 ? 'thing' : 'things'} it started` : '';
    void this.deps.confirm({
      title: `Stop ${name}?`,
      body: `This stops "${title}"${more}. It cannot be resumed.\nPress ctrl+x again to stop it; Esc keeps it running.`,
      confirmLabel: 'Stop',
      tone: 'danger',
      confirmChord: { key: 'x', ctrl: true },
    }).then((ok) => {
      if (ok) {
        this.deps.actions.kill(node.id, { cascade: true });
        this.stopTracker.mark(node.id);
        this.say(`Stopping ${name}…`, 'warning');
        this.invalidate();
      }
      this.deps.requestRender();
    });
  }

  private interruptSelected(): void {
    const node = this.selectedNode();
    if (!node || isTerminalProcessState(node.state)) return;
    if (!node.capabilities.interruptible) { this.say(`${node.label} can't be interrupted.`, 'faint'); return; }
    this.deps.actions.interrupt(node.id);
    this.stopTracker.mark(node.id);
    this.say(`Interrupting ${node.label}…`, 'warning');
  }

  private archiveSelected(all: boolean): void {
    if (all) {
      if (this.list.archive) return;
      const count = this.deps.readModel.archiveFinished();
      this.say(count > 0 ? `Archived ${count} finished ${count === 1 ? 'one' : 'ones'}.` : 'Nothing has finished to archive.', 'faint');
      return;
    }
    const node = this.selectedNode();
    if (!node) return;
    if (this.list.archive) {
      const restored = this.deps.readModel.unarchive(node.id);
      this.say(restored > 0 ? `Restored ${node.label}.` : 'Nothing restored for this one.', 'faint');
      return;
    }
    if (!isTerminalProcessState(node.state)) { this.say('Only finished work can be archived.', 'faint'); return; }
    const result = this.deps.readModel.archive(node.id);
    this.say(result.archived ? `Archived ${node.label}.` : result.reason ?? 'Could not archive this one.', 'faint');
  }

  // ── Keys ───────────────────────────────────────────────────────────────────

  escape(): boolean {
    this.invalidate();
    try { return this.escapeLevel(); } finally { this.invalidate(); }
  }

  private escapeLevel(): boolean {
    // Discovery owns no visible picker yet; Escape must invalidate it even
    // when another sub-level (filter/query/tab) consumes this key.
    if (!this.deps.spawn?.spawnModeActive()) this.deps.spawn?.cancel();
    if (!this.deps.acts?.pickModeActive()) this.deps.acts?.cancelPick();
    if (this.steer) { this.steer = null; return true; }
    if (this.deps.acts?.observedSteerActive()) { this.deps.acts.handleObservedSteerInput('escape'); return true; }
    if (this.deps.acts?.pickModeActive()) { this.deps.acts.handlePickInput('escape'); return true; }
    if (this.deps.spawn?.spawnModeActive()) { this.deps.spawn.handleSpawnInput('escape'); return true; }
    if (this.list.filtering) { this.list.filtering = false; return true; }
    if (this.hostedFull) { this.hostedFull = false; this.hostedViewport.reset(); return true; }
    if (this.tabs.activeTabIndex > 0) { this.tabs = { tabs: this.tabs.tabs, activeTabIndex: 0 }; return true; }
    if (this.list.query) { this.list.query = ''; return true; }
    if (this.list.servicesOpen) { this.list.servicesOpen = false; return true; }
    if (this.list.archive) { this.list.archive = false; this.list.selectedKey = null; return true; }
    return false;
  }

  handleToken(token: InputToken, host: SurfaceModalHost): void {
    this.invalidate();
    try { this.handleKey(token, host); } finally { this.invalidate(); }
  }

  private handleKey(token: InputToken, host: SurfaceModalHost): void {
    if (this.steer) { this.handleSteerToken(token); return; }
    // F2 and ctrl+o open this panel; pressed again here, they close it.
    if (token.type === 'key' && ((token.logicalName === 'f2' && !token.ctrl) || (token.ctrl && token.logicalName === 'o'))) {
      host.close(this, 'done');
      return;
    }
    const key = keyName(token);
    if (this.deps.acts?.observedSteerActive()) {
      if (token.type === 'text') for (const ch of token.value) this.deps.acts.handleObservedSteerInput(ch);
      else if (key) this.deps.acts.handleObservedSteerInput(key);
      return;
    }
    if (this.deps.acts?.pickModeActive()) { if (key) this.deps.acts.handlePickInput(key); return; }
    if (this.deps.spawn?.spawnModeActive()) { if (key) this.deps.spawn.handleSpawnInput(key); return; }
    if (this.list.filtering) { this.deps.acts?.cancelPick(); this.list.handleFilterToken(token); return; }
    if (this.level() === 'full') { this.handleFullToken(token); return; }
    if (token.type === 'key') {
      const name = token.logicalName ?? '';
      if (token.ctrl && name === 'x') { this.stopSelected(); return; }
      if (name === 'up') this.move(-1);
      else if (name === 'down') this.move(1);
      else if (name === 'pageup') this.move(-10);
      else if (name === 'pagedown') this.move(10);
      else if (name === 'enter') this.openSelected(host);
      else if (isTextBackspace(name) && this.list.query) { this.deps.acts?.cancelPick(); this.list.query = this.list.query.slice(0, -1); }
      return;
    }
    if (token.type !== 'text' || token.value.length !== 1) return;
    this.status = null;
    const node = this.selectedNode();
    // A newer list navigation or competing interaction owns the surface now.
    // The active picker was handled above; this only revokes a pending list read.
    if ('/sjknDbfvaApr[]'.includes(token.value)) this.deps.acts?.cancelPick();
    switch (token.value) {
      case '/': this.list.filtering = true; break;
      case 'j': this.move(1); break;
      case 'k': this.move(-1); break;
      case 's': this.stopSelected(); break;
      case 'b': this.list.toggleServices(); break;
      case 'r': this.invalidate(); break;
      case 'i': this.interruptSelected(); break;
      case 'p':
        if (node) toggleFleetPause(node, { interrupt: (id) => this.deps.actions.interrupt(id), resume: (id) => this.deps.actions.resume(id), setError: (m) => this.say(m, 'error'), setStatus: (m) => this.say(m, 'warning'), tracker: this.stopTracker });
        break;
      case 'n':
        if (this.deps.spawn) void this.deps.spawn.begin();
        else this.say('Starting a new agent needs the GoodVibes service, which is not connected.', 'faint');
        break;
      case 'D':
        if (node && !this.deps.acts?.handleTreeKey('D', node)) this.say('This row does not own a worktree.', 'faint');
        break;
      case 'f': this.follow = !this.follow; this.applyFollow(); this.say(this.follow ? 'Following the newest running agent.' : 'Stopped following.', 'faint'); break;
      case 'v': this.list.archive = !this.list.archive; this.list.selectedKey = null; break;
      case 'a': this.archiveSelected(false); break;
      case 'A': this.archiveSelected(true); break;
      case ']':
        if (this.tabs.tabs.length > 0) this.tabs = { tabs: this.tabs.tabs, activeTabIndex: 1 };
        break;
      case '[':
        if (this.tabs.tabs.length > 0) this.tabs = { tabs: this.tabs.tabs, activeTabIndex: this.tabs.tabs.length };
        break;
      default: break;
    }
  }

  private handleFullToken(token: InputToken): void {
    if (this.hostedFull) {
      this.synchronizeHostedView();
      if (!this.hostedFull) return;
      if (token.type === 'key' && !token.ctrl && !token.meta) {
        const name = token.logicalName ?? '';
        if (name === 'up') { this.hostedViewport.move(-1); return; }
        if (name === 'down') { this.hostedViewport.move(1); return; }
        if (name === 'pageup') { this.hostedViewport.page(-1); return; }
        if (name === 'pagedown') { this.hostedViewport.page(1); return; }
        if (name === 'home') { this.hostedViewport.oldest(); return; }
        if (name === 'end') { this.hostedViewport.latest(); return; }
      }
      if (token.type === 'text' && token.value === 'f') { this.hostedViewport.latest(); return; }
    }
    if (token.type === 'key') {
      const name = token.logicalName ?? '';
      if (token.ctrl && name === 'x') {
        const tab = activeFleetTab(this.tabs);
        if (tab) this.stopSelected(tab.nodeId);
        else this.say(HOSTED_END_HINT, 'faint');
      }
      return;
    }
    if (token.type !== 'text' || token.value.length !== 1) return;
    if (token.value === 's') this.beginSteer();
    else if ((token.value === ']' || token.value === '[') && !this.hostedFull) {
      const next = stepFleetTab(this.tabs, token.value === ']' ? 1 : -1);
      if (next.activeTabIndex > 0) this.tabs = next;
    }
  }

  private handleSteerToken(token: InputToken): void {
    const steer = this.steer!;
    if (token.type === 'text') {
      steer.draft += token.value.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
      return;
    }
    if (token.type !== 'key') return;
    const name = token.logicalName ?? '';
    if (name === 'enter') this.submitSteer();
    else if (isTextBackspace(name)) steer.draft = steer.draft.slice(0, -1);
  }

  // ── View ───────────────────────────────────────────────────────────────────

  private renderedStatus(): PanelText | null {
    const receipt = this.receiptStatus;
    if (!receipt || this.status !== receipt.status) return this.status;
    const badge = this.badgeFor(receipt.nodeId);
    if (!badge || badge.messageId !== receipt.messageId) return null;
    return { text: steerReceiptLabel(badge, receipt.label), tone: badge.status === 'unknown' ? 'warning' : receipt.status.tone };
  }

  private badgeFor(nodeId: string): FleetTab['steerBadge'] {
    return this.tabs.tabs.find((tab) => tab.nodeId === nodeId)?.steerBadge ?? null;
  }

  /** The selected row's detail (wide screens): model, time, files, cost when priced, and the live tail. */
  private detail(): PanelDetail | null {
    const selected = this.list.selected();
    if (!selected) return null;
    const row = selected.row;
    if (row.ref.type === 'session' && row.ref.id === HOSTED_ID) {
      const state = this.deps.hosted?.getState();
      if (!state?.record) return null;
      return { title: row.title, meta: 'a conversation running in the GoodVibes service', blocks: [{ kind: 'text', lines: hostedHeaderTexts(state) }], tail: hostedRowTexts(state.rows.slice(-40)) };
    }
    const node = this.selectedNode();
    if (!node) return { title: row.title, meta: row.meta.full, blocks: [], tail: [] };
    const stopping = this.stopTracker.isStopping(node.id);
    const blocked = !stopping && fleetNodeAttention(node) !== null;
    this.deps.acts?.ensureGraphFor(node);
    const observedDraft = this.deps.acts?.observedSteerDraftFor(node.id) ?? null;
    const graph = this.deps.acts?.graphFor(node.id) ?? null;
    let tail: PanelText[] = [];
    if (node.kind === 'agent' || node.kind === 'acp-agent') {
      // The tail shows 30 lines and every message it shows gives at least one, so only the last 30 messages are copied.
      if (this.tailCache?.nodeId !== node.id) this.tailCache = { nodeId: node.id, texts: transcriptTail(this.deps.actions.getConversationSnapshot(node.id, { last: 30 }), 30) };
      tail = this.tailCache.texts;
    }
    return { title: row.title, meta: row.meta.full, blocks: [{ kind: 'lines', build: (width) => renderFleetDetailLines(node, width, stopping, blocked, undefined, observedDraft, graph) }], tail };
  }

  private fullBody(width: number, height: number): readonly Line[] {
    if (this.hostedFull) return [];
    const tab = activeFleetTab(this.tabs);
    if (!tab) return [];
    const live = this.findNode(tab.nodeId);
    if (tab.kind === 'contract') {
      const descendants = new Set([tab.nodeId]);
      const members = this.fleet().rows.filter((row) => {
        if (!row.node.parentId || !descendants.has(row.node.parentId)) return false;
        descendants.add(row.node.id);
        return true;
      });
      // The platform contract fleet adapter publishes its ContractView as raw. Remote/pruned rows may omit it.
      const contract = live?.kind === 'contract' ? live.raw as ContractView | undefined : undefined;
      return renderFleetContractSummary(members, width, live === null || isTerminalProcessState(live.state), contract);
    }
    const isTerminal = live ? isTerminalProcessState(live.state) : true;
    const snapshot = this.deps.actions.getConversationSnapshot(tab.nodeId);
    const result = renderFleetAgentTranscript(snapshot, isTerminal, tab.lineCache, width, height, this.deps.configManager ?? null);
    if (result.mode !== 'unavailable') return result.lines;
    if (!tab.ledgerLoadStarted) {
      tab.ledgerLoadStarted = true;
      readFile(this.deps.actions.resolveSessionLogPath(tab.nodeId), 'utf-8')
        .then((raw) => { tab.ledgerEntries = parseAgentLedger(raw); })
        .catch(() => { tab.ledgerEntries = []; })
        .finally(() => this.deps.requestRender());
    }
    return tab.ledgerEntries !== null ? renderFleetLedgerFallback(tab.ledgerEntries, width, height) : renderFleetTranscriptLoading(width);
  }

  /** The headline, and when the service capped its answer, how much of it is shown. */
  private sub(): string {
    const headline = this.list.headline();
    const partial = this.list.archive ? undefined : this.fleet().daemonPartial;
    return partial ? `${headline} · showing ${partial.shown} of ${partial.total} from the GoodVibes service` : headline;
  }

  private hints(level: 'list' | 'full' | 'picker'): KitHint[] {
    if (this.steer) return [['⏎', 'send'], ['esc', 'cancel']];
    if (this.deps.acts?.observedSteerActive()) {
      return [['⏎', this.deps.acts.observedSteerSubmits() ? 'type and press Enter there' : 'type only'], ['tab', 'submit on/off'], ['esc', 'cancel']];
    }
    if (level === 'picker') return [['↑↓', 'choose'], ['⏎', this.deps.acts?.pickModeActive() ? 'pick (asks first)' : 'next'], ['esc', 'back']];
    if (level === 'full') {
      if (this.hostedFull) return [['↑↓', 'scroll'], ['f', this.hostedViewport.following ? 'following' : 'follow tail'], ['s', 'say'], ['esc', 'back']];
      const tab = activeFleetTab(this.tabs);
      const node = tab ? this.findNode(tab.nodeId) : null;
      const live = node !== null && !isTerminalProcessState(node.state);
      const hints: KitHint[] = [];
      if (live && node.capabilities.steerable) hints.push(['s', 'steer']);
      if (live && node.capabilities.killable) hints.push(['ctrl+x', 'stop (asks first)']);
      hints.push(['[ ]', 'other agents'], ['esc', 'back']);
      return hints;
    }
    const node = this.selectedNode();
    const attention = node ? fleetNodeAttention(node) : null;
    const enterLabel = attention?.reason === 'pick' ? 'pick a winner' : attention?.reason === 'conflict' ? 'resolve conflict' : undefined;
    return this.list.hints({ canSpawn: true, canPause: true, enterLabel });
  }

  private buildView(screenWidth: number): WorkBoardPanelView {
    this.synchronizeHostedView();
    const level = this.level();
    const tab = activeFleetTab(this.tabs);
    const selectedNode = this.selectedNode();
    const input = this.steer
      ? { label: this.steer.id === HOSTED_ID ? 'say: ' : `message to ${this.findNode(this.steer.id)?.label ?? ''}: `, draft: this.steer.draft }
      : this.deps.acts?.observedSteerActive() && selectedNode
        ? {
          label: this.deps.acts.observedSteerSubmits() ? 'type and submit in its terminal: ' : 'type into its terminal: ',
          draft: this.deps.acts.observedSteerDraftFor(selectedNode.id) ?? '',
        }
        : null;
    const pick = this.deps.acts?.pickView() ?? null;
    const spawn = this.deps.spawn?.spawnView() ?? null;
    const hostedState = this.deps.hosted?.getState();
    const hostedGeneration = this.deps.hosted?.getGeneration() ?? 0;
    // The detail inset is drawn only on a wide screen; on 80 columns it is not read at all.
    const wide = screenWidth >= 90;
    const list = level === 'list' ? this.list.view({
      stopping: (id) => this.stopTracker.isStopping(id),
      onClick: (key) => { this.list.select(key); this.follow = false; this.deps.requestRender(); },
    }) : null;
    const tabNode = tab ? this.findNode(tab.nodeId) : null;
    return {
      level,
      crumbs: level === 'full' ? [this.hostedFull ? (hostedState?.record?.title || 'hosted session') : (tabNode?.label ?? tab!.label)]
        : level === 'picker' ? [pick ? 'pick a winner' : spawn?.title ?? 'new agent']
          : this.list.archive ? ['archive'] : [],
      sub: level === 'list' ? this.sub() : '',
      hints: this.hints(level),
      status: this.deps.acts?.observedSteerActive() && this.deps.acts.observedSteerPending()
        ? { text: 'Waiting for the owner to approve typing into this session…', tone: 'warning' }
        : this.deps.acts?.observedSteerActive() && this.deps.acts.observedSteerFailure()
          ? { text: this.deps.acts.observedSteerFailure()!, tone: 'error' }
          : this.renderedStatus(),
      input,
      list,
      detail: level === 'list' && wide ? this.detail() : null,
      full: level === 'full' ? {
        meta: this.hostedFull ? 'in the GoodVibes service' : tabNode && !isTerminalProcessState(tabNode.state) ? 'running' : 'finished',
        header: this.hostedFull && hostedState ? hostedHeaderTexts(hostedState) : [],
        body: this.hostedFull && hostedState ? (width, height) => this.hostedViewport.render(hostedState, hostedGeneration, width, height) : (width, height) => this.fullBody(width, height),
        ...(this.hostedFull ? { scroll: () => this.hostedViewport.position } : {}),
      } : null,
      picker: level === 'picker'
        ? pick
          ? { intro: `Best of N: ${pick.title}. Choose the winner; Enter shows its diff and asks before merging.${pick.proposal ? ` The judge proposes ${pick.proposal} (advisory).` : ''}`, options: pick.candidates, side: pick.diff ? diffSide(pick.diff) : [{ text: 'This candidate has no diff to preview.', tone: 'faint' }] }
          : { intro: spawn?.creating ? 'Starting the agent…' : spawn?.intro ?? '', options: spawn?.options ?? [], side: [] }
        : null,
      scrollOwner: this,
    };
  }

  render(screenWidth: number, screenHeight: number): SurfaceLayer {
    return renderWorkBoardPanel(this.buildView(screenWidth), screenWidth, screenHeight);
  }
}

/** The files a candidate diff touches, for the picker's side column. */
function diffSide(diff: string): PanelText[] {
  const files = diff.split('\n').filter((line) => line.startsWith('diff --git ')).map((line) => line.replace(/^diff --git a\/.+? b\//, ''));
  const added = diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  return [
    { text: `${files.length} file${files.length === 1 ? '' : 's'} · +${added} −${removed}`, tone: 'text', bold: true },
    ...files.map((file) => ({ text: file, tone: 'muted' as const })),
  ];
}
