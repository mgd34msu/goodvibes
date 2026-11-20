/**
 * work-board-input.ts, the list of the "Your agents" panel in both terminal
 * programs: the work board reading (readWorkBoard) over the fleet nodes the
 * program holds, the row selected, the background services opened or not,
 * and the filter. The terminal app's panel (products/tui input/agents-modal.ts)
 * adds its full views and controllers around it; the Agent opens
 * WorkBoardModal, below, as is.
 *
 * Keys on the list: ↑↓ move; ⏎ open (an agent opens full screen with its
 * composer line, which steers it; a waiting row opens what waits); s stop
 * (asks first); n new agent; b background services; / filter; r read again
 * after a failed read. Esc goes back one level and never stops anything.
 */

import {
  formatBeadTime,
  readWorkBoard,
  type BoardRow,
  type WorkBoard,
  type WorkBoardAsk,
  type WorkBoardNode,
  type WorkBoardSession,
  type WorkBoardSources,
  type WorkBoardTask,
} from '@goodvibes-jev/engine/contracts';
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import type { ProcessNode } from '@goodvibes-jev/engine/platform/platform/runtime/fleet';
import type { PermissionPromptRequest } from '@goodvibes-jev/engine/platform/platform/permissions';
import { askPresentationFor } from './permission-prompt-facts.js';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import type { ConfirmOptions } from './confirm-dialog-types.js';
import { isTextBackspace } from './delete-key-policy.js';
import type { FleetSpawn } from './fleet-spawn.js';
import type { KitHint, SurfaceLayer } from './renderer/surface-kit.js';
import {
  renderWorkBoardPanel,
  type PanelDetail,
  type PanelText,
  type WorkBoardEntry,
  type WorkBoardListView,
  type WorkBoardPanelView,
} from './renderer/work-board.js';
import type { SurfaceModal, SurfaceModalHost } from './surface-modal-host.js';

/** What the board is read from, each time the panel draws or takes a key. */
export interface WorkBoardListSources {
  /** The fleet nodes this program holds (its own and the daemon's). May throw: the panel says why. */
  readonly nodes: () => readonly WorkBoardNode[];
  readonly asks?: (() => readonly WorkBoardAsk[]) | undefined;
  readonly sessions?: (() => readonly WorkBoardSession[]) | undefined;
  readonly tasks?: (() => readonly WorkBoardTask[]) | undefined;
  /** When this run of the program began: older finished rows are not listed. */
  readonly sessionStartedAt?: number | undefined;
  /**
   * How many calendar events fall today (the Agent's own calendar), read once
   * when the panel opens; a line under Scheduled says so and opens them.
   */
  readonly eventsToday?: (() => number) | undefined;
  /** The archived nodes (the terminal app's archive view), each read as a finished row. */
  readonly archived?: (() => readonly WorkBoardNode[]) | undefined;
  readonly now?: (() => number) | undefined;
}

export type WorkBoardSection = 'waiting' | 'agents' | 'scheduled' | 'calendar' | 'service';

/** A row the cursor can rest on. */
export interface WorkBoardSelectable {
  readonly key: string;
  readonly row: BoardRow;
  readonly depth: number;
  readonly section: WorkBoardSection;
}

/** The state word of a healthy background service, listed while the services are open. */
const SERVICE_STATE_WORDS: Readonly<Record<string, string>> = {
  thinking: 'working', 'executing-tool': 'working', streaming: 'working', retrying: 'retrying', queued: 'starting',
  idle: 'between checks', paused: 'paused', done: 'up to date', 'awaiting-approval': 'waiting',
};

/** The line under Scheduled for today's calendar events: "1 event today". */
function eventsTodayRow(count: number): BoardRow {
  return {
    ref: { type: 'schedule', id: 'calendar-today' }, group: 'scheduled',
    title: `${count} event${count === 1 ? '' : 's'} today`, meta: { short: '', full: 'from your calendar' },
    tone: 'quiet', actions: ['open'],
  };
}

export function boardKey(row: BoardRow): string {
  return `${row.ref.type}:${row.ref.id}`;
}

/** Sub-agents follow their parent (depth-first), keeping the reading's order otherwise. */
function nestRows(rows: readonly BoardRow[]): Array<{ row: BoardRow; depth: number }> {
  const ids = new Set(rows.map((row) => row.ref.id));
  const children = new Map<string, BoardRow[]>();
  const roots: BoardRow[] = [];
  for (const row of rows) {
    if (row.parentId !== undefined && ids.has(row.parentId) && row.parentId !== row.ref.id) {
      const list = children.get(row.parentId) ?? [];
      list.push(row);
      children.set(row.parentId, list);
    } else roots.push(row);
  }
  const out: Array<{ row: BoardRow; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (row: BoardRow, depth: number): void => {
    if (seen.has(row.ref.id)) return;
    seen.add(row.ref.id);
    out.push({ row, depth });
    for (const child of children.get(row.ref.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  // A cycle leaves rows unvisited: list them flat rather than lose them.
  for (const row of rows) if (!seen.has(row.ref.id)) out.push({ row, depth: 0 });
  return out;
}

export class WorkBoardList {
  selectedKey: string | null = null;
  servicesOpen = false;
  query = '';
  filtering = false;
  /** The archive view: archived nodes instead of the live board. */
  archive = false;
  private cache: { board: WorkBoard | null; error: string | null; nodes: readonly WorkBoardNode[]; asks: readonly WorkBoardAsk[] } | null = null;
  private archiveCache: { rows: BoardRow[]; nodes: readonly WorkBoardNode[] } | null = null;
  /** Read once per open: the calendar is a file read, not a fact the fleet ticks. */
  private eventsTodayCache: number | null = null;

  constructor(private readonly sources: WorkBoardListSources) {}

  /** Drop the cached reading: the next draw or key reads the fleet again. */
  invalidate(): void {
    this.cache = null;
    this.archiveCache = null;
  }

  /** Each archived node as the reading words it (one reading per node, so none is cut by the finished limit). */
  private readArchive(): { rows: BoardRow[]; nodes: readonly WorkBoardNode[] } {
    if (this.archiveCache) return this.archiveCache;
    const now = this.sources.now?.() ?? Date.now();
    const nodes = this.sources.archived?.() ?? [];
    const rows: BoardRow[] = [];
    for (const node of nodes) {
      const board = readWorkBoard({ nodes: [node] }, now);
      const row = board.groups.finished[0] ?? board.groups.scheduled[0] ?? board.groups.running[0] ?? board.groups.waiting[0];
      if (row) rows.push(row);
    }
    this.archiveCache = { rows, nodes };
    return this.archiveCache;
  }

  private read(): { board: WorkBoard | null; error: string | null; nodes: readonly WorkBoardNode[]; asks: readonly WorkBoardAsk[] } {
    if (this.cache) return this.cache;
    const now = this.sources.now?.() ?? Date.now();
    try {
      const nodes = this.sources.nodes();
      const asks = this.sources.asks?.() ?? [];
      const input: WorkBoardSources = {
        nodes,
        asks,
        sessions: this.sources.sessions?.(),
        tasks: this.sources.tasks?.(),
        sessionStartedAt: this.sources.sessionStartedAt,
      };
      this.cache = { board: readWorkBoard(input, now), error: null, nodes, asks };
    } catch (error) {
      const sentence = summarizeError(error).replace(/\.?\s*$/, '.');
      this.cache = { board: null, error: sentence, nodes: [], asks: [] };
    }
    return this.cache;
  }

  board(): WorkBoard | null {
    return this.read().board;
  }

  error(): string | null {
    return this.read().error;
  }

  /** The ask behind a waiting row, when the row is an ask. */
  ask(row: BoardRow): WorkBoardAsk | undefined {
    return row.ref.type === 'ask' ? this.read().asks.find((ask) => ask.id === row.ref.id) : undefined;
  }

  /** The node behind a row, when the row is a fleet node. */
  node(row: BoardRow): WorkBoardNode | undefined {
    const nodes = this.archive ? this.readArchive().nodes : this.read().nodes;
    return nodes.find((node) => node.id === row.ref.id);
  }

  private matches(row: BoardRow): boolean {
    const q = this.query.trim().toLowerCase();
    if (!q) return true;
    return [row.title, row.who ?? '', row.meta.full].some((text) => text.toLowerCase().includes(q));
  }

  /** Every row the cursor can rest on, in the order the panel draws them. */
  selectables(): WorkBoardSelectable[] {
    if (this.archive) {
      return this.readArchive().rows.filter((row) => this.matches(row)).map((row) => ({ key: boardKey(row), row, depth: 0, section: 'agents' as const }));
    }
    const board = this.board();
    if (!board) return [];
    const out: WorkBoardSelectable[] = [];
    for (const row of board.groups.waiting) if (this.matches(row)) out.push({ key: boardKey(row), row, depth: 0, section: 'waiting' });
    const agents = [...board.groups.running, ...board.groups.finished].filter((row) => this.matches(row));
    const running = nestRows(agents.filter((row) => row.group === 'running'));
    const finished = nestRows(agents.filter((row) => row.group === 'finished'));
    for (const { row, depth } of [...running, ...finished]) out.push({ key: boardKey(row), row, depth, section: 'agents' });
    for (const row of board.groups.scheduled) if (this.matches(row)) out.push({ key: boardKey(row), row, depth: 0, section: 'scheduled' });
    const events = this.eventsToday();
    if (events > 0 && !this.query) out.push({ key: 'calendar:today', row: eventsTodayRow(events), depth: 0, section: 'calendar' });
    for (const row of board.services.unhealthy) out.push({ key: boardKey(row), row, depth: 0, section: 'service' });
    return out;
  }

  selected(): WorkBoardSelectable | null {
    const all = this.selectables();
    if (all.length === 0) return null;
    return all.find((entry) => entry.key === this.selectedKey) ?? all[0]!;
  }

  select(key: string): void {
    this.selectedKey = key;
  }

  /** Select the row of a node or session by its id; false when no row shows it. */
  selectId(id: string): boolean {
    const found = this.selectables().find((entry) => entry.row.ref.id === id);
    if (!found) return false;
    this.selectedKey = found.key;
    return true;
  }

  move(delta: number): void {
    const all = this.selectables();
    if (all.length === 0) return;
    const current = all.findIndex((entry) => entry.key === this.selectedKey);
    const next = Math.max(0, Math.min(all.length - 1, (current < 0 ? 0 : current) + delta));
    this.selectedKey = all[next]!.key;
  }

  /** Calendar events today, read once per open; 0 when this program keeps no calendar or it cannot be read. */
  eventsToday(): number {
    if (this.eventsTodayCache === null) {
      try { this.eventsTodayCache = this.sources.eventsToday?.() ?? 0; } catch { this.eventsTodayCache = 0; }
    }
    return this.eventsTodayCache;
  }

  toggleServices(): void {
    this.servicesOpen = !this.servicesOpen;
  }

  /** Healthy background services with their state words (the rows `b` opens). */
  private serviceRows(): Array<{ label: string; state: string }> {
    return this.read().nodes
      .filter((node) => node.serves === 'system' && node.state !== 'stalled' && node.state !== 'failed' && node.state !== 'killed' && node.state !== 'interrupted')
      .map((node) => ({ label: node.label, state: node.state === 'idle' && node.kind !== 'watcher' ? 'idle' : SERVICE_STATE_WORDS[node.state] ?? node.state }));
  }

  /** Text typed while filtering. Returns true when it was taken. */
  handleFilterToken(token: InputToken): boolean {
    if (!this.filtering) return false;
    if (token.type === 'text') {
      this.query += [...token.value].filter((ch) => ch >= ' ').join('');
      this.selectedKey = null;
      return true;
    }
    if (token.type !== 'key') return true;
    const name = token.logicalName ?? '';
    if (isTextBackspace(name)) { this.query = this.query.slice(0, -1); return true; }
    if (name === 'enter') { this.filtering = false; return true; }
    if (name === 'up' || name === 'down') { this.filtering = false; this.move(name === 'up' ? -1 : 1); }
    return true;
  }

  /** The list level as the renderer draws it. `stopping` marks rows whose stop is in flight. */
  view(options: { readonly stopping?: (id: string) => boolean; readonly onClick?: (key: string) => void } = {}): WorkBoardListView {
    const read = this.read();
    const board = read.board;
    const selected = this.selected();
    const entry = (item: WorkBoardSelectable): WorkBoardEntry => ({
      key: item.key,
      row: item.row,
      depth: item.depth,
      selected: selected?.key === item.key,
      stopping: options.stopping?.(item.row.ref.id) ?? false,
      onClick: options.onClick ? () => options.onClick!(item.key) : undefined,
    });
    const all = this.selectables();
    const agents = all.filter((item) => item.section === 'agents');
    if (this.archive) {
      const archived = this.readArchive().rows.length;
      return {
        waiting: [], agents: agents.map(entry), finishedEmpty: false, empty: agents.length === 0, scheduled: [], eventsToday: null,
        services: { healthy: 0, unhealthy: [], open: false, rows: [] }, error: null,
        filter: this.filtering || this.query ? { query: this.query, active: this.filtering, count: `${agents.length} of ${archived}` } : null,
        archive: true,
      };
    }
    const shown = all.length;
    const total = board ? board.counts.waiting + board.counts.running + board.counts.finished + board.counts.scheduled : 0;
    return {
      waiting: all.filter((item) => item.section === 'waiting').map(entry),
      agents: agents.map(entry),
      finishedEmpty: !agents.some((item) => item.row.group === 'finished'),
      empty: !all.some((item) => item.section === 'waiting' || item.section === 'agents'),
      scheduled: all.filter((item) => item.section === 'scheduled').map(entry),
      eventsToday: all.filter((item) => item.section === 'calendar').map(entry)[0] ?? null,
      services: {
        healthy: board?.services.healthy ?? 0,
        unhealthy: all.filter((item) => item.section === 'service').map(entry),
        open: this.servicesOpen,
        rows: this.servicesOpen ? this.serviceRows() : [],
      },
      error: read.error,
      filter: this.filtering || this.query
        ? { query: this.query, active: this.filtering, count: this.query ? `${shown - (board?.services.unhealthy.length ?? 0)} of ${total}` : `${total} shown` }
        : null,
      archive: false,
    };
  }

  /** The headline beside the title: "1 running · nothing waiting for you". */
  headline(): string {
    if (this.archive) return `${this.readArchive().rows.length} archived`;
    const read = this.read();
    if (read.error !== null) return '';
    return read.board?.headline ?? '';
  }

  /** The list keys every program shares: hints for the selected row. */
  hints(options: { readonly canSpawn: boolean; readonly canPause?: boolean | undefined; readonly enterLabel?: string | undefined }): KitHint[] {
    if (this.filtering) return [['⏎', 'done'], ['esc', 'stop filtering']];
    if (this.archive) return [['v', 'back to the live list'], ['a', 'restore']];
    if (this.error() !== null) return [['r', 'try again'], ['n', 'new agent']];
    const hints: KitHint[] = [];
    const selected = this.selected();
    if (selected) hints.push(['⏎', options.enterLabel ?? (selected.row.actions.includes('resume') && selected.section === 'service' ? 'restart' : 'open')]);
    if (selected?.row.actions.includes('stop')) hints.push(['s', 'stop']);
    // A schedule's own actions: the reading offers pause or resume for it.
    if (options.canPause && selected?.section === 'scheduled') {
      if (selected.row.actions.includes('resume') && this.node(selected.row)?.state === 'paused') hints.push(['p', 'resume']);
      else if (selected.row.actions.includes('pause')) hints.push(['p', 'pause']);
    }
    if (options.canSpawn) hints.push(['n', 'new agent']);
    hints.push(['b', 'background services']);
    return hints;
  }
}

/** When each ask was first seen, by its call id (the card's request object is replaced as it is typed in). */
const askSeenAt = new Map<string, number>();

/**
 * The ask on screen as a waiting row: its words are the card's own
 * (ask-presentation, the same object the card draws), with the agent that
 * asked when a background agent did. Nothing is computed that the card did not.
 */
export function waitingAskOf(request: PermissionPromptRequest | null | undefined): WorkBoardAsk[] {
  if (!request) return [];
  let at = askSeenAt.get(request.callId);
  if (at === undefined) {
    if (askSeenAt.size > 64) askSeenAt.clear();
    at = Date.now();
    askSeenAt.set(request.callId, at);
  }
  const agentId = request.attribution?.kind === 'background-agent' ? request.attribution.agentId : undefined;
  return [{ id: request.callId, askedAt: at, ...(agentId !== undefined ? { agentId } : {}), presentation: askPresentationFor(request) }];
}

/** An ask's own words as the detail shows them: its question, what it acts on, and the consequence. */
interface AskWords {
  readonly question?: string | undefined;
  readonly subject?: { readonly lines: readonly string[] } | undefined;
  readonly consequence?: { readonly text: string; readonly tone: string } | undefined;
}

/** The detail of a waiting ask: the question, what it acts on, and what follows. */
export function boardAskDetail(row: BoardRow, ask: WorkBoardAsk): PanelDetail {
  const words = ask.presentation as WorkBoardAsk['presentation'] & AskWords;
  const lines: PanelText[] = [];
  if (words.question) lines.push({ text: words.question, tone: 'text', bold: true });
  for (const line of words.subject?.lines ?? []) lines.push({ text: line, tone: 'brand' });
  if (words.consequence) lines.push({ text: words.consequence.text, tone: words.consequence.tone === 'cannot-undo' ? 'error' : 'muted' });
  lines.push({ text: 'Enter opens the question to answer it.', tone: 'faint' });
  return { title: row.who ? `${row.who} asks` : row.title, meta: row.meta.full, blocks: [{ kind: 'text', lines }], tail: [] };
}

/**
 * The selected row's detail on a wide screen, from the facts its node holds:
 * the model, the time, files read and changed, tokens, the cost only when it
 * is priced, and what it is doing now. Nothing unknown is printed.
 */
export function boardNodeDetail(row: BoardRow, node: Partial<ProcessNode> | undefined): PanelDetail {
  const lines: PanelText[] = [];
  const fact = (label: string, value: string): void => { lines.push({ text: `${label}  ${value}`, tone: 'muted' }); };
  if (node?.model) fact('model', node.model);
  if (node?.elapsedMs !== undefined && node.elapsedMs > 0) fact('time', formatBeadTime(node.elapsedMs).replace(/\.\ds$/, 's'));
  if (node?.progress && (node.progress.filesRead > 0 || node.progress.filesChanged > 0)) fact('files', `${node.progress.filesRead} read · ${node.progress.filesChanged} changed`);
  const usage = node?.usage;
  const tokens = usage ? usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : 0;
  if (tokens > 0) fact('tokens', tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens));
  if (node && node.costState !== undefined && node.costState !== 'unpriced' && typeof node.costUsd === 'number') fact('cost', `${node.costState === 'estimated' ? '~' : ''}$${node.costUsd < 0.01 ? node.costUsd.toFixed(4) : node.costUsd.toFixed(3)}`);
  if (node?.currentActivity) fact('now', node.currentActivity.text);
  return { title: row.title, meta: row.meta.full, blocks: lines.length > 0 ? [{ kind: 'text', lines }] : [], tail: [] };
}

// ---------------------------------------------------------------------------
// The panel as a modal (the Agent opens this one as is)
// ---------------------------------------------------------------------------

export interface WorkBoardModalDeps {
  readonly sources: WorkBoardListSources;
  /** The fleet changed: repaint. Returns an unsubscribe. */
  readonly subscribe?: ((listener: () => void) => () => void) | undefined;
  readonly requestRender: () => void;
  /** Tick for times on the rows (ms; 0 disables). */
  readonly tickMs?: number | undefined;
  /** Open an agent or a background process full screen; false when this program cannot open it here. */
  readonly openSessionView?: ((target: { readonly kind: 'agent' | 'process'; readonly id: string }) => boolean) | undefined;
  /** Open what a waiting row waits for (an ask card); false when it is not here. */
  readonly openAsk?: ((row: BoardRow) => boolean) | undefined;
  /** Stop a node and everything it started; the ids stopped. */
  readonly kill?: ((id: string) => readonly string[]) | undefined;
  /** Start a paused or stalled node again. */
  readonly resume?: ((id: string) => boolean) | undefined;
  readonly confirm?: ((options: ConfirmOptions) => Promise<boolean>) | undefined;
  readonly spawn?: FleetSpawn | null | undefined;
  /** Open today's calendar events (the line under Scheduled). */
  readonly openEventsToday?: (() => void) | undefined;
  /** The selected row's detail on wide screens. */
  readonly detail?: ((row: BoardRow, node: WorkBoardNode | undefined) => PanelDetail | null) | undefined;
}

export class WorkBoardModal implements SurfaceModal {
  readonly name = 'agents';
  readonly list: WorkBoardList;
  status: PanelText | null = null;
  private readonly unsubs: Array<() => void> = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly stopping = new Set<string>();

  constructor(private readonly deps: WorkBoardModalDeps) {
    this.list = new WorkBoardList(deps.sources);
    deps.spawn?.reportTo((message) => { this.say(message, 'faint'); this.list.invalidate(); });
    if (deps.subscribe) this.unsubs.push(deps.subscribe(() => { if (this.closed) return; this.list.invalidate(); deps.requestRender(); }));
    const tickMs = deps.tickMs ?? 1_000;
    if (tickMs > 0) this.tickTimer = setInterval(() => { this.list.invalidate(); deps.requestRender(); }, tickMs);
  }

  onClose(): void {
    this.closed = true;
    this.deps.spawn?.cancel();
    this.deps.spawn?.reportTo(null);
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private say(text: string, tone: PanelText['tone'] = 'muted'): void {
    this.status = { text, tone };
  }

  escape(): boolean {
    this.list.invalidate();
    if (this.deps.spawn?.spawnModeActive()) { this.deps.spawn.handleSpawnInput('escape'); return true; }
    if (this.list.filtering) { this.list.filtering = false; return true; }
    if (this.list.query) { this.list.query = ''; return true; }
    if (this.list.servicesOpen) { this.list.servicesOpen = false; return true; }
    return false;
  }

  handleToken(token: InputToken, host: SurfaceModalHost): void {
    this.list.invalidate();
    try { this.handleKey(token, host); } finally { this.list.invalidate(); }
  }

  private handleKey(token: InputToken, host: SurfaceModalHost): void {
    if (token.type === 'key' && token.ctrl && token.logicalName === 'o') { host.close(this, 'done'); return; }
    if (this.deps.spawn?.spawnModeActive()) {
      const key = token.type === 'text' ? (token.value.length === 1 ? token.value : null) : token.type === 'key' ? token.logicalName ?? null : null;
      if (key) this.deps.spawn.handleSpawnInput(key);
      return;
    }
    if (this.list.handleFilterToken(token)) return;
    if (token.type === 'key') {
      const name = token.logicalName ?? '';
      if (name === 'up') this.list.move(-1);
      else if (name === 'down') this.list.move(1);
      else if (name === 'pageup') this.list.move(-10);
      else if (name === 'pagedown') this.list.move(10);
      else if (name === 'enter') this.open(host);
      return;
    }
    if (token.type !== 'text' || token.value.length !== 1) return;
    this.status = null;
    switch (token.value) {
      case 'j': this.list.move(1); break;
      case 'k': this.list.move(-1); break;
      case '/': this.list.filtering = true; break;
      case 'b': this.list.toggleServices(); break;
      case 'r': this.list.invalidate(); break;
      case 's': this.stopSelected(); break;
      case 'n':
        if (this.deps.spawn) void this.deps.spawn.begin();
        else this.say('Starting a new agent here needs the GoodVibes service, which is not connected.', 'faint');
        break;
      default: break;
    }
  }

  private open(host: SurfaceModalHost): void {
    const selected = this.list.selected();
    if (!selected) return;
    const row = selected.row;
    if (selected.section === 'service') {
      if (row.actions.includes('resume') && this.deps.resume?.(row.ref.id)) { this.say(`Restarting ${row.title.replace(/ (stopped answering|failed)$/, '')}…`, 'warning'); return; }
      this.say(`${row.title}. It can't be restarted from here.`, 'faint');
      return;
    }
    if (selected.section === 'calendar') { host.close(this, 'done'); this.deps.openEventsToday?.(); return; }
    if (selected.section === 'waiting' && this.deps.openAsk?.(row)) { host.close(this, 'done'); return; }
    // An ask's card is the one on screen under the panel: closing the panel puts it in front.
    if (row.ref.type === 'ask') { host.close(this, 'done'); return; }
    const node = this.list.node(row);
    const target = node?.kind === 'agent' ? { kind: 'agent' as const, id: node.id }
      : node?.kind === 'background-process' ? { kind: 'process' as const, id: node.id } : null;
    if (target && this.deps.openSessionView?.(target)) { host.close(this, 'done'); return; }
    if (selected.section === 'waiting') { host.close(this, 'done'); return; }
    this.say(`${row.title} has nothing more to open here; its details are on this row.`, 'faint');
  }

  private stopSelected(): void {
    const selected = this.list.selected();
    if (!selected) return;
    const row = selected.row;
    if (!row.actions.includes('stop')) { this.say(row.group === 'finished' ? `${row.title} already finished.` : `${row.title} can't be stopped from here.`, 'faint'); return; }
    if (!this.deps.kill) { this.say('Stopping is not available here.', 'faint'); return; }
    if (!this.deps.confirm) { this.say('Stopping needs a confirm dialog, which is not available here.', 'error'); return; }
    const name = row.who ?? row.title;
    void this.deps.confirm({
      title: `Stop ${name}?`,
      body: `This stops "${row.title}" and everything it started. It cannot be resumed.`,
      confirmLabel: 'Stop',
      tone: 'danger',
    }).then((ok) => {
      if (ok && !this.closed) {
        const stopped = this.deps.kill!(row.ref.id);
        if (stopped.length > 0) { for (const id of stopped) this.stopping.add(id); this.say(`Stopping ${name}…`, 'warning'); }
        else this.say(`${name} can't be stopped from here: it runs in the GoodVibes service.`, 'faint');
        this.list.invalidate();
      }
      this.deps.requestRender();
    });
  }

  private buildView(screenWidth: number): WorkBoardPanelView {
    const spawn = this.deps.spawn?.spawnView() ?? null;
    if (spawn) {
      return {
        level: 'picker', crumbs: [spawn.title], sub: '', hints: [['↑↓', 'choose'], ['⏎', 'next'], ['esc', 'back']], status: this.status, input: null,
        list: null, detail: null, full: null,
        picker: { intro: spawn.creating ? 'Starting the agent…' : spawn.intro, options: spawn.options, side: [] },
        scrollOwner: this,
      };
    }
    const selected = this.list.selected();
    // The detail inset is drawn only on a wide screen; on 80 columns it is not built at all.
    const node = selected && screenWidth >= 90 ? this.list.node(selected.row) : undefined;
    const ask = selected && screenWidth >= 90 ? this.list.ask(selected.row) : undefined;
    const detail = selected && screenWidth >= 90
      ? ask ? boardAskDetail(selected.row, ask)
        : this.deps.detail ? this.deps.detail(selected.row, node) : boardNodeDetail(selected.row, node as Partial<ProcessNode> | undefined)
      : null;
    return {
      level: 'list',
      crumbs: [],
      sub: this.list.headline(),
      hints: this.list.hints({ canSpawn: true }),
      status: this.status,
      input: null,
      list: this.list.view({
        stopping: (id) => this.stopping.has(id),
        onClick: (key) => { this.list.select(key); this.deps.requestRender(); },
      }),
      detail,
      full: null,
      picker: null,
      scrollOwner: this,
    };
  }

  render(screenWidth: number, screenHeight: number): SurfaceLayer {
    return renderWorkBoardPanel(this.buildView(screenWidth), screenWidth, screenHeight);
  }
}
