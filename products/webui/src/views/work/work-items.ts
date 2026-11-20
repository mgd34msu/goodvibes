/**
 * The Work view's list, as the work board reads it (ux A3.1): waiting for you,
 * running now, scheduled, finished, and the platform's own background services
 * behind one line. The words and the grouping are the board's
 * (contracts/src/work-board.ts readWorkBoard); this file only hands it what the
 * page fetched and maps each row back to the detail it opens.
 *
 * What the board reads:
 * - fleet nodes as they arrive (`serves`, `progress`, `schedule` set by the
 *   daemon's adapters; never inferred here);
 * - asks: approvals and open inbox items with their presentation (lib/asks.ts);
 * - sessions: a daemon-hosted session while its turn runs, and once it ended;
 * - runtime tasks; contracts the fleet does not carry; CI watches, which watch
 *   for their event like a trigger; a ready best-of-N group, which waits for
 *   your pick (its attempts fold into it), stated as the node's own words.
 *
 * Counts: the sidebar badge, the account menu and the page all read the same
 * board's `counts` (lib/needs-you.ts), so they cannot disagree.
 *
 * Pure: every function here is a projection of the fetched records.
 */
import {
  readWorkBoard,
  type BoardRow,
  type WorkBoard,
  type WorkBoardNode,
  type WorkBoardSession,
  type WorkBoardTask,
} from '@goodvibes/engine/contracts';
import type { StatusTone } from '../../components/ui/StatusDot';
import type {
  ApprovalRecord,
  ContractSummaryRecord,
  FleetAttemptGroup,
  FleetProcessNode,
  HostedSessionRecord,
  OperatorMethodOutput,
  RuntimeTaskSummary,
} from '../../lib/goodvibes';
import { attemptGroupRef, isAwaitingApprovalState, isObservedKind, isStalledState, isTerminalState } from '../../lib/fleet';
import { boardAsk, wirePresentation, type OpenAsk } from '../../lib/asks';
import { isClosedStatus, type UnionSessionRecord } from '../../lib/sessions-union';
import { whenLabel } from '../../lib/when-label';
import type { ProcessKind } from '@goodvibes/engine/platform/platform/runtime/fleet';
import { attemptGroupProgress } from './attempt-group-progress';

/** Short time label ("5m ago", "Nov 14"); '' for a missing or epoch time. */
export { whenLabel };

/** Sentence-case a status word for display. */
export function sentenceCase(word: string): string {
  const trimmed = word.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed;
}

export type CiWatch = OperatorMethodOutput<'ci.watches.list'>['watches'][number];

/** One phrase per engine process kind: adding a kind to the engine fails the typecheck here. */
const FLEET_KIND_PHRASES: Record<ProcessKind, string> = {
  'agent': 'Agent',
  'acp-agent': 'External agent',
  'observed-external': 'External',
  'contract': 'Contract',
  'contract-group': 'Contract group',
  'contract-unit': 'Contract unit',
  'workflow': 'Workflow',
  'trigger': 'Trigger',
  'hook-action': 'Hook action',
  'schedule': 'Schedule',
  'watcher': 'Watcher',
  'background-process': 'Background process',
  'code-index': 'Code index',
};

/** Plain words for a fleet kind, sentence case. A kind this client does not know renders verbatim. */
export function fleetKindPhrase(kind: string): string {
  const known = Object.hasOwn(FLEET_KIND_PHRASES, kind) ? FLEET_KIND_PHRASES[kind as ProcessKind] : undefined;
  return known ?? (kind.trim() || 'Unknown kind');
}

/** Plain words for a fleet process state. Unknown states render verbatim. */
export function fleetStatePhrase(state: string): string {
  switch (state) {
    case 'thinking': return 'thinking';
    case 'executing-tool': return 'running a tool';
    case 'awaiting-approval': return 'waiting for approval';
    case 'streaming': return 'writing';
    case 'stalled': return 'stalled';
    case 'retrying': return 'retrying';
    case 'done': return 'done';
    case 'failed': return 'failed';
    case 'killed': return 'stopped';
    case 'interrupted': return 'interrupted';
    case 'idle': return 'idle';
    case 'queued': return 'queued';
    case 'paused': return 'paused';
    default: return state.trim() || 'unknown state';
  }
}

export function fleetTone(node: Pick<FleetProcessNode, 'state' | 'needsAttention'>): StatusTone {
  if (node.needsAttention) return 'warn';
  if (isStalledState(node.state) || isAwaitingApprovalState(node.state)) return 'warn';
  if (node.state === 'failed' || node.state === 'killed') return 'bad';
  if (isTerminalState(node.state)) return 'idle';
  if (node.state === 'idle' || node.state === 'paused' || node.state === 'queued') return 'idle';
  return 'live';
}

/** Human words for a fleet attention reason. */
export function attentionPhrase(reason: string): string {
  if (reason === 'approval') return 'Needs approval';
  if (reason === 'input') return 'Needs input';
  if (reason === 'pick') return 'Needs your pick';
  if (reason === 'conflict') return 'Merge conflict';
  return reason.trim() || 'Needs you';
}

/**
 * A cost string only when the daemon priced it (priced or estimated with a
 * figure). Unpriced and unknown return undefined: nothing is shown rather
 * than a "price unknown" marker.
 */
export function knownCost(node: Pick<FleetProcessNode, 'costUsd' | 'costState' | 'kind'>): string | undefined {
  if (isObservedKind(node.kind)) return undefined;
  if (node.costState === 'unpriced' || node.costUsd == null) return undefined;
  const amount = `$${node.costUsd.toFixed(2)}`;
  return node.costState === 'estimated' ? `~${amount}` : amount;
}

/** An approval's one line, in the presentation's words ("Run bun test?"). */
export function approvalTitle(record: ApprovalRecord): string {
  return wirePresentation(record)?.title ?? (record.request.analysis.summary.trim() || record.request.tool);
}

export function ciWatchLabel(watch: Pick<CiWatch, 'repo' | 'ref' | 'prNumber'>): string {
  if (watch.prNumber) return `${watch.repo} #${watch.prNumber}`;
  return watch.ref ? `${watch.repo}@${watch.ref}` : watch.repo;
}

/**
 * Collapse best-of-N sibling nodes out of the tree: a node that is an attempt
 * of a group fleet.attempts.list tracks is represented by the group's row.
 */
export function visibleFleetNodes(
  nodes: readonly FleetProcessNode[],
  groups: readonly FleetAttemptGroup[],
): FleetProcessNode[] {
  if (groups.length === 0) return [...nodes];
  const groupIds = new Set(groups.map((g) => g.groupId));
  return nodes.filter((n) => {
    const gid = attemptGroupRef(n)?.groupId ?? '';
    return !(gid && groupIds.has(gid));
  });
}

/** The fields the board reads that the generated contract type may not list yet. */
type BoardFields = Partial<Pick<WorkBoardNode, 'serves' | 'progress' | 'schedule' | 'currentActivity' | 'completedAt' | 'parentId' | 'task'>>;

/** A fleet node as the board reads it. A node with no `serves` (an older daemon) counts as yours. */
function boardNode(node: FleetProcessNode): WorkBoardNode {
  const extra = node as FleetProcessNode & BoardFields;
  return {
    id: node.id,
    kind: node.kind,
    serves: extra.serves === 'system' ? 'system' : 'you',
    ...(extra.parentId ? { parentId: extra.parentId } : {}),
    label: node.label || node.id,
    ...(extra.task ? { task: extra.task } : {}),
    state: node.state,
    ...(typeof node.startedAt === 'number' ? { startedAt: node.startedAt } : {}),
    ...(typeof extra.completedAt === 'number' ? { completedAt: extra.completedAt } : {}),
    ...(extra.progress ? { progress: extra.progress } : {}),
    ...(extra.schedule ? { schedule: extra.schedule } : {}),
    ...(extra.currentActivity ? { currentActivity: extra.currentActivity } : {}),
    capabilities: node.capabilities,
    ...(node.sessionRef ? { sessionRef: node.sessionRef } : {}),
    ...(node.needsAttention ? { needsAttention: node.needsAttention } : {}),
  };
}

const NO_CONTROLS = { interruptible: false, killable: false, pausable: false, resumable: false } as const;

/** A ready best-of-N group waits for your pick; its attempts fold into it. */
function attemptGroupNode(group: FleetAttemptGroup): WorkBoardNode | undefined {
  const progress = attemptGroupProgress(group);
  if (!progress.ready) return undefined;
  const count = progress.count;
  return {
    id: `attempt-group:${group.groupId}`,
    kind: 'workflow',
    serves: 'you',
    label: group.sourceTitle || 'Best of several attempts',
    state: 'idle',
    capabilities: NO_CONTROLS,
    needsAttention: {
      reason: 'pick',
      detail: `Pick a winner: ${count} attempt${count === 1 ? '' : 's'}${group.sourceTitle ? ` for ${group.sourceTitle}` : ''}`,
    },
  };
}

/** A CI watch watches for its event, as a trigger does. */
function ciWatchNode(watch: CiWatch): WorkBoardNode {
  return {
    id: `ci-watch:${watch.id}`,
    kind: 'watcher',
    serves: 'you',
    label: `Watch CI on ${ciWatchLabel(watch)}`,
    state: 'idle',
    startedAt: watch.createdAt,
    capabilities: NO_CONTROLS,
  };
}

const TASK_STATES: ReadonlySet<string> = new Set(['queued', 'running', 'blocked', 'completed', 'failed', 'cancelled']);

function boardTask(task: RuntimeTaskSummary): WorkBoardTask {
  const status = TASK_STATES.has(task.status) ? task.status as WorkBoardTask['status'] : 'running';
  return {
    id: `task:${task.id}`,
    title: task.title || task.id,
    status,
    ...(typeof task.startedAt === 'number' ? { startedAt: task.startedAt } : {}),
    ...(typeof (task as { endedAt?: unknown }).endedAt === 'number' ? { endedAt: (task as { endedAt: number }).endedAt } : {}),
  };
}

/** A contract the fleet does not carry (its summary only): running until it passes, fails or is cancelled. */
function contractTask(contract: ContractSummaryRecord): WorkBoardTask {
  const status: WorkBoardTask['status'] = contract.status === 'passed' ? 'completed'
    : contract.status === 'failed' ? 'failed' : contract.status === 'cancelled' ? 'cancelled' : 'running';
  const updatedAt = (contract as { updatedAt?: unknown }).updatedAt;
  return {
    id: `contract:${contract.id}`,
    title: contract.goal || contract.ask || contract.id,
    status,
    startedAt: contract.createdAt,
    ...(status !== 'running' ? { endedAt: typeof updatedAt === 'number' ? updatedAt : contract.createdAt } : {}),
  };
}

/**
 * A session the board lists: a daemon-hosted one while its turn runs, and any
 * session once it ended. An open session between turns is not work in
 * progress; WorkView lists those apart (`openSessions`).
 */
function boardSession(record: UnionSessionRecord | undefined, hosted: HostedSessionRecord | undefined, chatTitle: string | undefined): WorkBoardSession {
  const id = record?.id ?? hosted?.id ?? '';
  const ended = hosted ? hosted.status === 'terminated' : isClosedStatus(record?.status ?? '');
  const updatedAt = Math.max(record?.updatedAt ?? 0, hosted?.updatedAt ?? 0);
  const state: WorkBoardSession['state'] = ended ? (record?.lastError ? 'failed' : 'ended') : hosted?.status === 'running' ? 'running' : 'idle';
  return {
    id,
    title: chatTitle || record?.title || hosted?.title || id,
    state,
    ...(state === 'running' ? { startedAt: updatedAt } : {}),
    ...(ended ? { endedAt: updatedAt } : {}),
  };
}

export interface WorkSources {
  readonly asks: readonly OpenAsk[];
  readonly nodes: readonly FleetProcessNode[];
  readonly attemptGroups: readonly FleetAttemptGroup[];
  readonly sessions?: readonly UnionSessionRecord[];
  /** A chat's current title by id (the chat owns its title; the session record keeps the first one). */
  readonly chatTitles?: ReadonlyMap<string, string> | undefined;
  readonly hosted?: readonly HostedSessionRecord[];
  readonly tasks?: readonly RuntimeTaskSummary[];
  readonly ciWatches?: readonly CiWatch[];
  /** One summary per contract; a contract the fleet carries is its node's row. */
  readonly contracts?: readonly ContractSummaryRecord[];
}

export interface WorkReading {
  readonly board: WorkBoard;
  /** Sessions open between turns: listed apart, behind one line, so none is unreachable. */
  readonly openSessions: readonly WorkBoardSession[];
}

/** The board for what the page (or the shell, for its counts) fetched. */
export function readWork(sources: WorkSources, now: number): WorkReading {
  const ready = sources.attemptGroups.map(attemptGroupNode).filter((node): node is WorkBoardNode => node !== undefined);
  const readyIds = new Set(sources.attemptGroups.filter((group) => attemptGroupProgress(group).ready).map((group) => group.groupId));
  // Attempts of a group still running stay rows of their own; a ready group is one row.
  const fleet = sources.nodes.filter((node) => {
    const gid = attemptGroupRef(node)?.groupId;
    return !(gid && readyIds.has(gid));
  });
  const nodeIds = new Set(fleet.map((node) => node.id));
  const nodes = [...fleet.map(boardNode), ...ready, ...(sources.ciWatches ?? []).map(ciWatchNode)];

  const hostedById = new Map((sources.hosted ?? []).map((session) => [session.id, session]));
  const unionIds = new Set((sources.sessions ?? []).map((record) => record.id));
  const sessions = [
    ...(sources.sessions ?? []).map((record) => boardSession(record, hostedById.get(record.id), sources.chatTitles?.get(record.id))),
    ...(sources.hosted ?? []).filter((session) => !unionIds.has(session.id)).map((session) => boardSession(undefined, session, undefined)),
  ];
  // A runtime task an agent runs is that agent's row already (the task's id and owner are the agent's).
  const agentIds = new Set(fleet.flatMap((node) => [node.id, ...(node.sessionRef?.agentId ? [node.sessionRef.agentId] : [])]));
  const tasks = [
    ...(sources.tasks ?? []).filter((task) => !agentIds.has(task.id) && !(task.owner && agentIds.has(task.owner))).map(boardTask),
    ...(sources.contracts ?? []).filter((contract) => !nodeIds.has(`contract:${contract.id}`)).map(contractTask),
  ];
  const board = readWorkBoard({ nodes, asks: sources.asks.map(boardAsk), sessions, tasks }, now);
  return { board, openSessions: sessions.filter((session) => session.state === 'idle') };
}

/** The archive: every archived node as a finished row, in the board's words (no "newest ten" limit). */
export function archivedRows(nodes: readonly FleetProcessNode[], now: number): BoardRow[] {
  return nodes.flatMap((node) => {
    const finished = { ...boardNode(node), serves: 'you' as const, state: isTerminalState(node.state) ? node.state : 'done' };
    return readWorkBoard({ nodes: [finished] }, now).groups.finished;
  });
}

/**
 * The Work key of a row's detail: `approval:<id>` and `inbox:<id>` for an ask,
 * `session:<id>`, `task:<id>` / `contract:<id>` for a task row, and for a node
 * `attempt-group:<id>`, `ci-watch:<id>`, `contract:<id>` (a contract root opens
 * the contract) or `fleet:<id>`.
 */
export function workKeyOf(row: BoardRow): string {
  const { type, id } = row.ref;
  if (type === 'ask' || type === 'task') return id;
  if (type === 'session') return `session:${id}`;
  if (id.startsWith('attempt-group:') || id.startsWith('ci-watch:')) return id;
  return `fleet:${id}`;
}

/** Rows matching a search, on their title and their words. */
export function matchesQuery(row: BoardRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return row.title.toLowerCase().includes(needle) || row.meta.full.toLowerCase().includes(needle) || (row.who ?? '').toLowerCase().includes(needle);
}
