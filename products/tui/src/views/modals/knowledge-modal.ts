import { MODAL_TONES } from './modal-theme.ts';
import { infoRow, headerRow, runModalCommand } from './modal-surface-helpers.ts';
import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalTab,
  ConfigModalView,
} from '../../input/config-modal-types.ts';
import { JudgmentAuthorityRetiredError } from '@goodvibes-jev/engine/errors';
import type { KnowledgeService } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';

// ---------------------------------------------------------------------------
// Knowledge (graph) → config-modal surface (group-B port). Two tabs:
// 'Browse' (sources/nodes/issues + schedules) and 'Review' (the open-issue
// queue), the earlier view's browse/review toggle, now host tabs. Issue review
// mutations (accept/reject/resolve/reopen) route to the `/knowledge
// review-issue` command. 'm' cross-opens the memory surface. Selection-blind
// port: the earlier view's selected-row id/detail is folded into each row label.
// refresh() is the only place this module touches the platform.
// ---------------------------------------------------------------------------

type KnowledgeReadOptions = Parameters<KnowledgeService['listNodes']>[1];

export interface KnowledgeNodeLike { readonly id: string; readonly kind: string; readonly title: string; readonly summary?: string | undefined; }
export interface KnowledgeSourceLike { readonly id: string; readonly sourceType: string; readonly status: string; readonly title?: string | undefined; readonly canonicalUri?: string | undefined; readonly sourceUri?: string | undefined; readonly summary?: string | undefined; }
export interface KnowledgeIssueLike { readonly id: string; readonly severity: 'info' | 'warning' | 'error'; readonly code: string; readonly message: string; readonly status: 'open' | 'resolved'; readonly sourceId?: string | undefined; readonly nodeId?: string | undefined; }
export interface KnowledgeScheduleLike { readonly id: string; readonly label: string; readonly enabled: boolean; }

export interface KnowledgeModalDeps {
  readonly knowledgeApi: {
    readonly graph: {
      readonly nodes: { list(limit?: number, options?: KnowledgeReadOptions): Promise<readonly KnowledgeNodeLike[]> };
      readonly issues: {
        list(limit?: number, options?: KnowledgeReadOptions): Promise<readonly KnowledgeIssueLike[]>;
        /** Filtered read: the Review tab asks for open issues directly so a long store cannot push them out of the window. */
        query?(input: { readonly status?: string; readonly limit?: number }, options?: KnowledgeReadOptions): Promise<{ readonly total: number; readonly items: readonly KnowledgeIssueLike[] }>;
      };
    };
    /** Store-wide counts; without it the header falls back to the loaded window sizes. */
    readonly status?: {
      get(scope?: Record<string, never>, options?: KnowledgeReadOptions): Promise<{ readonly sourceCount: number; readonly nodeCount: number; readonly issueCount: number }>;
    };
    readonly sources: { list(limit?: number, options?: KnowledgeReadOptions): Promise<readonly KnowledgeSourceLike[]> };
    readonly jobs: { schedules: { list(limit?: number): Promise<readonly KnowledgeScheduleLike[]> | readonly KnowledgeScheduleLike[] } };
  };
}

type BrowseKind = 'node' | 'source' | 'issue';
interface BrowseRow { readonly kind: BrowseKind; readonly id: string; readonly title: string; readonly tag: string; readonly detail: string; readonly extra: string; }

/** Rows of each kind read at first, and how many more "l show older" adds. */
const LIST_LIMIT = 60;

function cleanInline(value: string | undefined): string { return (value ?? '').replace(/\s+/g, ' ').trim(); }

function nodeRow(node: KnowledgeNodeLike): BrowseRow {
  return { kind: 'node', id: node.id, title: cleanInline(node.title) || 'untitled', tag: `node/${node.kind}`, detail: cleanInline(node.summary), extra: '' };
}
function sourceRow(source: KnowledgeSourceLike): BrowseRow {
  return { kind: 'source', id: source.id, title: cleanInline(source.title) || cleanInline(source.canonicalUri) || cleanInline(source.sourceUri) || source.id, tag: `source/${source.status}`, detail: cleanInline(source.summary), extra: `type ${source.sourceType}` };
}
function issueRow(issue: KnowledgeIssueLike): BrowseRow {
  const refs = [issue.sourceId ? `source ${issue.sourceId}` : null, issue.nodeId ? `node ${issue.nodeId}` : null].filter((ref): ref is string => ref !== null);
  return { kind: 'issue', id: issue.id, title: issue.code, tag: `issue/${issue.severity}`, detail: cleanInline(issue.message), extra: refs.join('  ') };
}

export interface KnowledgeModalReadSurface extends ConfigModalSurface {
  whenLoaded(): Promise<void>;
}

class KnowledgeModalSurface implements KnowledgeModalReadSurface {
  readonly name = 'knowledge-modal';
  readonly title = 'Knowledge';
  private browseRows: BrowseRow[] = [];
  private reviewRows: BrowseRow[] = [];
  private sourceCount = 0;
  private nodeCount = 0;
  private issueCount = 0;
  /** How many open issues the store holds, which can exceed the Review rows loaded. */
  private openIssueCount = 0;
  /** Rows actually loaded per kind (each read takes listLimit), so the header can say when it shows only part. */
  private shownCounts = { sources: 0, nodes: 0, issues: 0 };
  /** Rows of each kind read now; grows by LIST_LIMIT with each "l show older", so every source, node and issue is reachable here. */
  private listLimit = LIST_LIMIT;
  private schedules: readonly KnowledgeScheduleLike[] = [];
  private loadError: string | null = null;

  private controller: AbortController | null = null;
  private requestRender: () => void = () => {};
  private pendingLoad: Promise<void> = Promise.resolve();
  private loading = false;

  constructor(private readonly deps: KnowledgeModalDeps) {}

  private readonly issueGate = (row: ConfigModalRow | null, tabId: string): boolean => tabId === 'review' && (row?.id.startsWith('issue:') ?? false);

  readonly actions = [
    { key: 'a', id: 'accept', label: 'accept', enabledFor: this.issueGate },
    { key: 'x', id: 'reject', label: 'reject', enabledFor: this.issueGate },
    { key: 's', id: 'resolve', label: 'resolve', enabledFor: this.issueGate },
    { key: 'o', id: 'reopen', label: 'reopen', enabledFor: this.issueGate },
    { key: 'm', id: 'openMemory', label: 'memory' },
    { key: 'r', id: 'refresh', label: 'refresh' },
    { key: 'l', id: 'showOlder', label: 'show older', enabledFor: (_row: ConfigModalRow | null, tabId: string) => this.mayHaveOlder(tabId) },
  ];

  /** Some kind on this tab came back as a full page: more may be past it. */
  private mayHaveOlder(tabId: string): boolean {
    if (tabId === 'review') return this.openIssueCount > this.reviewRows.length;
    const { sources, nodes, issues } = this.shownCounts;
    return this.sourceCount > sources || this.nodeCount > nodes || this.issueCount > issues
      || sources >= this.listLimit || nodes >= this.listLimit || issues >= this.listLimit;
  }

  onOpen(requestRender: () => void): void {
    this.requestRender = requestRender;
    this.refresh();
  }

  onClose(): void {
    const previous = this.controller;
    this.controller = null;
    this.requestRender = () => {};
    this.loading = false;
    previous?.abort();
  }

  whenLoaded(): Promise<void> { return this.pendingLoad; }

  private refresh(): void {
    const previous = this.controller;
    const controller = new AbortController();
    this.controller = controller;
    previous?.abort();
    this.loading = true;
    this.loadError = null;
    const assertCurrent = () => {
      if (controller.signal.aborted || this.controller !== controller) throw new JudgmentAuthorityRetiredError();
    };
    this.pendingLoad = this.load(controller, assertCurrent);
  }

  private async load(controller: AbortController, assertCurrent: () => void): Promise<void> {
    const options = { signal: controller.signal, assertCurrent };
    try {
      const api = this.deps.knowledgeApi;
      const [nodes, sources, issues, status, openIssues] = await Promise.all([
        api.graph.nodes.list(this.listLimit, options),
        api.sources.list(this.listLimit, options),
        api.graph.issues.list(this.listLimit, options),
        api.status?.get({}, options),
        api.graph.issues.query?.({ status: 'open', limit: this.listLimit }, options),
      ]);
      assertCurrent();
      const schedules = await this.deps.knowledgeApi.jobs.schedules.list(20);
      assertCurrent();
      this.sourceCount = status?.sourceCount ?? sources.length;
      this.nodeCount = status?.nodeCount ?? nodes.length;
      this.issueCount = status?.issueCount ?? issues.length;
      this.shownCounts = { sources: sources.length, nodes: nodes.length, issues: issues.length };
      this.browseRows = [...sources.map(sourceRow), ...nodes.map(nodeRow), ...issues.map(issueRow)];
      const reviewIssues = openIssues ? openIssues.items : issues.filter((issue) => issue.status === 'open');
      this.openIssueCount = openIssues ? openIssues.total : reviewIssues.length;
      this.reviewRows = reviewIssues.map(issueRow);
      this.schedules = schedules;
      this.loading = false;
      this.requestRender();
    } catch (e) {
      if (controller.signal.aborted || this.controller !== controller) return;
      this.browseRows = []; this.reviewRows = []; this.schedules = [];
      this.sourceCount = 0; this.nodeCount = 0; this.issueCount = 0; this.openIssueCount = 0;
      this.shownCounts = { sources: 0, nodes: 0, issues: 0 };
      this.loading = false;
      this.loadError = `Knowledge graph load failed: ${summarizeError(e)}`;
      this.requestRender();
    }
  }

  private rowFor(row: BrowseRow): ConfigModalRow {
    return { id: `${row.kind}:${row.id}`, label: `${row.tag.padEnd(16)} ${row.title.padEnd(28)} ${row.detail}${row.extra ? `  · ${row.extra}` : ''}` };
  }

  private browseTab(): ConfigModalTab {
    const readySources = this.sourceCount > 0 && this.nodeCount > 0;
    const count = (total: number, shown: number): string => (total > shown ? `${total} (listing ${shown})` : String(total));
    const header = [
      `sources ${count(this.sourceCount, this.shownCounts.sources)}  nodes ${count(this.nodeCount, this.shownCounts.nodes)}  issues ${count(this.issueCount, this.shownCounts.issues)}  schedules ${this.schedules.length}`,
      readySources ? 'retrieval ready (sources + nodes indexed)' : 'retrieval not ready (needs sources and nodes)',
    ];
    const rows: ConfigModalRow[] = this.browseRows.map((row) => this.rowFor(row));
    if (this.schedules.length > 0) {
      rows.push(headerRow('sched:title', 'Schedules'));
      this.schedules.slice(0, 4).forEach((s, i) => rows.push(infoRow(`sched:${i}`, `${s.enabled ? 'on ' : 'off'}  ${s.label}`, s.enabled ? undefined : { fg: MODAL_TONES.dim })));
    }
    return { id: 'browse', label: 'Browse', header, rows, emptyText: 'No ingested knowledge yet.', hints: this.mayHaveOlder('browse') ? ['m memory', 'l show older'] : ['m memory'] };
  }

  private reviewTab(): ConfigModalTab {
    const header = this.openIssueCount > this.reviewRows.length ? [`open issues ${this.openIssueCount} (listing ${this.reviewRows.length})`] : undefined;
    return { id: 'review', label: 'Review', ...(header ? { header } : {}), rows: this.reviewRows.map((row) => this.rowFor(row)), emptyText: 'No issues waiting for review.', hints: this.mayHaveOlder('review') ? ['a accept', 'x reject', 's resolve', 'o reopen', 'l show older'] : ['a accept', 'x reject', 's resolve', 'o reopen'] };
  }

  buildView(): ConfigModalView {
    if (this.loading) return { title: 'Knowledge', tabs: [{ id: 'browse', label: 'Browse', rows: [], emptyText: 'Loading knowledge graph…' }, { id: 'review', label: 'Review', rows: [], emptyText: 'Loading review queue…' }] };
    if (this.loadError) return { title: 'Knowledge', degraded: this.loadError, tabs: [{ id: 'browse', label: 'Browse', rows: [] }] };
    return { title: 'Knowledge', tabs: [this.browseTab(), this.reviewTab()] };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') { this.refresh(); ctx.setStatus('Reloading knowledge graph…'); return; }
    if (id === 'openMemory') { ctx.openModal?.('memory-modal'); return; }
    if (id === 'showOlder') { this.listLimit += LIST_LIMIT; this.refresh(); ctx.setStatus('Reading older knowledge…'); return; }
    const action = id === 'accept' ? 'accept' : id === 'reject' ? 'reject' : id === 'resolve' ? 'resolve' : id === 'reopen' ? 'reopen' : null;
    if (!action) return;
    const issueId = ctx.row?.id.startsWith('issue:') ? ctx.row.id.slice('issue:'.length) : null;
    if (!issueId) return;
    runModalCommand(ctx, 'knowledge', ['review-issue', issueId, action, '--reviewer', 'tui'], `/knowledge review-issue ${issueId} ${action}`, { afterSettle: () => this.refresh() });
  }
}

export function createKnowledgeModalSurface(deps: KnowledgeModalDeps): KnowledgeModalReadSurface {
  return new KnowledgeModalSurface(deps);
}
