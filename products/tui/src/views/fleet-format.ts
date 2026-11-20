// ---------------------------------------------------------------------------
// fleet-format.ts
//
// Pure cell-formatting helpers for the Your agents panel's detail inset (wide
// screens): the selected node's model, time, files and cost when priced, its
// contract checks and its task graph. The rows themselves are the work board
// reading drawn by terminal-shell renderer/work-board.ts.
// ---------------------------------------------------------------------------

import type { ProcessCostState, ProcessNode, ProcessCheckSummary, ProcessUsage } from '@goodvibes-jev/engine/platform/platform/runtime/fleet';
import type { Line } from '@goodvibes-jev/engine/platform/platform/types';
import { buildViewLine, DEFAULT_VIEW_PALETTE, type ViewPalette } from './polish.ts';
import { fleetAttentionText, fleetNodeAttention, fleetStallMarker, fleetUsageTokens, hasFleetCost, type FleetStateTone } from './fleet-read-model.ts';
import { fleetStateDisplay } from './fleet-stop.ts';
import { formatElapsed } from '../utils/format-elapsed.ts';
import { truncateDisplay } from '@goodvibes-jev/engine/platform/platform/utils/terminal-width';
import { contractTree, type ContractView } from '@goodvibes-jev/engine/platform/platform/contract';
import { cellText } from '../renderer/lane-graph/bead.ts';
import { wrapText } from '@goodvibes-jev/engine/platform/platform/utils/terminal-width';
import { isObservedExternalNode, renderObservedDetailLines } from './fleet-observed-render.ts';
import { renderPoolSummary, type WorkstreamGraphSnapshot } from './workstream-graph-render.ts';

export function toneColor(tone: FleetStateTone, palette: ViewPalette): string {
  switch (tone) {
    case 'active': return palette.info ?? DEFAULT_VIEW_PALETTE.info;
    case 'success': return palette.good ?? DEFAULT_VIEW_PALETTE.good;
    case 'failure': return palette.bad ?? DEFAULT_VIEW_PALETTE.bad;
    case 'warn': return palette.warn ?? DEFAULT_VIEW_PALETTE.warn;
    case 'muted': return palette.dim;
  }
}

export function formatFleetTokens(usage: ProcessUsage | undefined): string {
  const total = fleetUsageTokens(usage);
  if (total === null) return 'n/a';
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
}

/** A dollar amount at the precision a per-agent cost needs: sub-cent amounts keep four places. */
export function formatAgentCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

/** Honest cost display: never a fabricated $0.00, 'unpriced' when costState says so. */
export function formatFleetCost(costUsd: number | null | undefined, costState: ProcessCostState): string {
  if (!hasFleetCost(costUsd, costState)) return 'unpriced';
  const formatted = formatAgentCost(costUsd as number);
  return costState === 'estimated' ? `~${formatted}` : formatted;
}

/**
 * The selected-node detail block under the fleet tree. Pure (extracted from
 * the Agents modal's detail renderer to hold that file under the 800-line architecture
 * cap). `stopping`/`blocked` are display-only overrides the caller derives from
 * the stop tracker + node state, mirror the tree row exactly so the literal
 * 'state' text never claims a past-tense outcome mid-write, and a
 * blocked-on-user node reads 'blocked on you' here too.
 */
/** The public fleet check summary: recorded criteria and readings, without inferred scores. */
export function renderCheckLines(check: ProcessCheckSummary, width: number, palette: ViewPalette = DEFAULT_VIEW_PALETTE): Line[] {
  const lines: Line[] = [buildViewLine(width, [
    [' checks ', palette.label],
    [`${check.met}/${check.judged} criteria met · ${check.nudges} corrections`, palette.value],
  ])];
  if (check.criteria.length === 0) {
    lines.push(buildViewLine(width, [['   No recorded criteria.', palette.dim]]));
    return lines;
  }
  for (const criterion of check.criteria) {
    const tone = criterion.verdict === 'met' ? palette.good ?? palette.info
      : criterion.verdict === 'unmet' ? palette.bad ?? palette.warn ?? DEFAULT_VIEW_PALETTE.warn
      : criterion.verdict === 'unshown' ? palette.warn ?? DEFAULT_VIEW_PALETTE.warn : palette.dim;
    const mark = `[${criterion.verdict}${criterion.outcome ? ` · ${criterion.outcome}` : ''}]`;
    for (const [index, text] of wrapText(cellText(criterion.text), Math.max(1, width - 4)).entries()) {
      if (index === 0) lines.push(buildViewLine(width, [[' ', palette.dim], [mark, tone]]));
      lines.push(buildViewLine(width, [['   ', palette.dim], [text, palette.value]]));
    }
    if (criterion.severity) lines.push(buildViewLine(width, [['   severity ', palette.label], [criterion.severity, tone]]));
  }
  return lines;
}

/**
 * The task graph's edges + elastic-pool posture for a workstream row, rendered
 * IN the fleet detail (the tree shows nodes; edges/pool used to be reachable
 * only via /graph, /graph still works). Fetched lazily by fleet-acts and fetched
 * again when the group's units change;
 * rendered only once a snapshot is in hand. An empty graph states so honestly.
 */
export function renderGraphPostureLines(graph: WorkstreamGraphSnapshot, width: number, palette: ViewPalette = DEFAULT_VIEW_PALETTE): Line[] {
  const C = palette;
  const lines: Line[] = [
    buildViewLine(width, [[' graph ', C.label], [renderPoolSummary(graph.pool), C.value]]),
  ];
  if (graph.edges.length === 0) {
    lines.push(buildViewLine(width, [['   ', C.dim], ['no dependency edges', C.dim]]));
    return lines;
  }
  const titleById = new Map(graph.nodes.map((n) => [n.id, n.title]));
  lines.push(buildViewLine(width, [[' edges ', C.label], [`${graph.edges.length} dependency link(s)`, C.value]]));
  for (const edge of graph.edges) {
    const from = titleById.get(edge.from) ?? edge.from;
    const to = titleById.get(edge.to) ?? edge.to;
    for (const seg of wrapText(`${from} → ${to}`, Math.max(1, width - 5))) {
      lines.push(buildViewLine(width, [['   ', C.dim], [seg, C.dim]]));
    }
  }
  return lines;
}

export function renderFleetDetailLines(
  node: ProcessNode,
  width: number,
  stopping: boolean,
  blocked: boolean,
  palette: ViewPalette = DEFAULT_VIEW_PALETTE,
  observedSteerDraft: string | null = null,
  graphSnapshot: WorkstreamGraphSnapshot | null = null,
): Line[] {
  const C = palette;
  // Observed foreign agents drill into their own detail (facts + steer-or-reason,
  // never a stop), see fleet-observed-render.ts. The drill-in steer draft (when
  // the composer is open on this row) renders an input line in that detail.
  if (isObservedExternalNode(node)) return renderObservedDetailLines(node, width, palette, observedSteerDraft);
  const disp = fleetStateDisplay(node.state, stopping, blocked);
  const color = toneColor(disp.tone, C);
  // A blocked node's state text names WHY in the reason's own words
  // ('needs your pick' / 'merge conflict waiting on you' / …) so the detail
  // block never contradicts the row's reason-specific badge; the shared ⚑
  // glyph/tone (disp) is unchanged. 'stopping' still wins over the reason.
  const stateLabel = blocked && !stopping
    ? fleetAttentionText(fleetNodeAttention(node) ?? { reason: 'approval' })
    : disp.label;

  // Only facts that are known: no "model unknown", no "cost unpriced", no internal id.
  // One fact per line, and only facts that are known: no "model unknown", no
  // "cost unpriced", no internal id. The row above already carries the title.
  const fact = (label: string, value: string, tone: string = C.value): Line => buildViewLine(width, [[` ${label} `, C.label], [value, tone]]);
  const factLines: Line[] = [];
  if (blocked || stopping) factLines.push(buildViewLine(width, [[' ', C.dim], [stateLabel, color]]));
  if (node.model) factLines.push(fact('model', node.model, C.info));
  factLines.push(fact('time', formatElapsed(node.elapsedMs)));
  if (node.progress && (node.progress.filesRead > 0 || node.progress.filesChanged > 0)) {
    factLines.push(fact('files', `${node.progress.filesRead} read · ${node.progress.filesChanged} changed`));
  }
  if (fleetUsageTokens(node.usage) !== null) factLines.push(fact('tokens', formatFleetTokens(node.usage)));
  if (hasFleetCost(node.costUsd, node.costState)) factLines.push(fact('cost', formatFleetCost(node.costUsd, node.costState)));
  const stallMarker = fleetStallMarker(node);
  if (stallMarker) factLines.push(fact('quiet', stallMarker.replace(/^quiet /, ''), C.warn ?? DEFAULT_VIEW_PALETTE.warn));
  if (node.currentActivity) factLines.push(fact('now', truncateDisplay(node.currentActivity.text, Math.max(0, width - 6)), C.dim));
  // The contract DTO carries its own workspace/application facts. Unit snapshots
  // do not expose an individual worktree/conflict list, so none is invented here.
  const raw = node.kind === 'contract' ? node.raw : (node.raw as { contract?: unknown } | undefined)?.contract;
  const contract = raw as ContractView | undefined;
  const contractLines: Line[] = [];
  if (contract && typeof contract.projectRoot === 'string') {
    for (const pathLine of wrapText(cellText(contractTree(contract)), Math.max(1, width - 12))) {
      contractLines.push(buildViewLine(width, [[' workspace ', C.label], [pathLine, C.value]]));
    }
    if (contract.commit) {
      const tone = contract.commit.status === 'failed' ? C.warn ?? DEFAULT_VIEW_PALETTE.warn : C.dim;
      for (const note of wrapText(cellText(`Changes ${contract.commit.status}: ${contract.commit.note}`), Math.max(1, width - 2))) {
        contractLines.push(buildViewLine(width, [[' ', C.dim], [note, tone]]));
      }
    }
  }
  const checkLines = node.check ? renderCheckLines(node.check, width, C) : [];
  // The task graph's edges/pool posture for a workstream row (fetched + cached
  // by fleet-acts); rendered in-view under the chain, /graph still available.
  const graphLines = graphSnapshot ? renderGraphPostureLines(graphSnapshot, width, C) : [];
  return [...factLines, ...contractLines, ...checkLines, ...graphLines];
}
