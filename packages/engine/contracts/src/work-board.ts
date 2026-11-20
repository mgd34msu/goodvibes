/**
 * The work board: everything working for the person, in four groups (waiting
 * for you, running now, scheduled, finished) and the platform's own
 * background services, with the words every surface shows. The terminal's
 * "Your agents" panel, the web UI's Work view, the account menu and the
 * sidebar badge all read this one reading and count only its rows.
 *
 * Pure and browser-safe (no node imports). Its sources are wire shapes the web
 * UI fetches and the terminal holds: fleet nodes (ProcessNode), asks with
 * their presentation, and optionally sessions and tasks.
 */
import { formatBeadTime } from './tool-call-summary.js';
import {
  describeChanges,
  describeLastRun,
  describeSchedule,
  describeTriggerCadence,
  type ScheduleCadence,
  type ScheduleRunOutcome,
} from './schedule-words.js';

export type BoardGroup = 'waiting' | 'running' | 'scheduled' | 'finished';
export type BoardRefType = 'ask' | 'agent' | 'schedule' | 'trigger' | 'session' | 'task' | 'contract' | 'process';
export type BoardAction = 'open' | 'stop' | 'answer' | 'pause' | 'resume';
export type BoardTone = 'needs-you' | 'working' | 'quiet' | 'done' | 'failed';

export interface BoardRow {
  readonly ref: { readonly type: BoardRefType; readonly id: string };
  readonly group: BoardGroup;
  /** "Writing docs/usage.md" | "Turn the sandbox off?" | "Morning summary to Telegram" */
  readonly title: string;
  /** "Helper agent": who does it, for an agent row. */
  readonly who?: string | undefined;
  /** "daily 8:00 · last: delivered" | "Every day at 8:00 · last ran today, delivered" */
  readonly meta: { readonly short: string; readonly full: string };
  /** "15s": the right-hand column of a running row in the terminal. */
  readonly right?: string | undefined;
  readonly tone: BoardTone;
  readonly actions: readonly BoardAction[];
  /** The node a sub-agent works under, so a list can indent it under its parent. */
  readonly parentId?: string | undefined;
}

export interface WorkBoard {
  readonly groups: Readonly<Record<BoardGroup, readonly BoardRow[]>>;
  /** Counts of the rows above; nothing else is counted. */
  readonly counts: Readonly<Record<BoardGroup, number>>;
  /** The platform's own services: how many are healthy, and a row for each one that is not. */
  readonly services: { readonly healthy: number; readonly unhealthy: readonly BoardRow[] };
  /** "1 running · nothing waiting for you" | "2 waiting for you" | "nothing running" */
  readonly headline: string;
}

/** A fleet node as the board reads it: ProcessNode, as `fleet.snapshot` sends it. */
export interface WorkBoardNode {
  readonly id: string;
  readonly kind: string;
  readonly serves: 'you' | 'system';
  readonly parentId?: string | undefined;
  readonly label: string;
  readonly task?: string | undefined;
  readonly state: string;
  readonly startedAt?: number | undefined;
  readonly completedAt?: number | undefined;
  readonly progress?: { readonly filesRead: number; readonly filesChanged: number } | undefined;
  readonly schedule?: {
    readonly cadence?: ScheduleCadence | undefined;
    readonly lastRunAt?: number | undefined;
    readonly lastOutcome?: ScheduleRunOutcome | undefined;
    readonly firedCount?: number | undefined;
    readonly lastFiredAt?: number | undefined;
    readonly since?: number | undefined;
  } | undefined;
  readonly currentActivity?: { readonly kind: string; readonly text: string; readonly at: number } | undefined;
  readonly capabilities: { readonly interruptible: boolean; readonly killable: boolean; readonly pausable: boolean; readonly resumable: boolean };
  readonly sessionRef?: { readonly sessionId?: string | undefined; readonly agentId?: string | undefined } | undefined;
  readonly needsAttention?: { readonly reason: string; readonly detail?: string | undefined } | undefined;
}

/** An open ask as the board reads it: an inbox item with its presentation (AskPresentation). */
export interface WorkBoardAsk {
  readonly id: string;
  readonly askedAt: number;
  /** The session and agent that asked, to match it to a node waiting on it. */
  readonly sessionId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly presentation: {
    readonly kind: string;
    /** One line for lists: "Turn the sandbox off?" */
    readonly title: string;
    readonly consequence?: { readonly text: string; readonly tone: string } | undefined;
    readonly countdown?: { readonly verb: string; readonly at: number } | undefined;
    readonly origin?: { readonly sessionTitle?: string | undefined; readonly by: string } | undefined;
  };
}

/** A conversation the board lists while it answers, and once it ended this session. */
export interface WorkBoardSession {
  readonly id: string;
  readonly title: string;
  readonly state: 'running' | 'idle' | 'ended' | 'failed';
  readonly startedAt?: number | undefined;
  readonly endedAt?: number | undefined;
}

/** A task the board lists while it runs, and once it ended this session. */
export interface WorkBoardTask {
  readonly id: string;
  readonly title: string;
  readonly status: 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  readonly startedAt?: number | undefined;
  readonly endedAt?: number | undefined;
}

export interface WorkBoardSources {
  readonly nodes: readonly WorkBoardNode[];
  readonly asks?: readonly WorkBoardAsk[] | undefined;
  readonly sessions?: readonly WorkBoardSession[] | undefined;
  readonly tasks?: readonly WorkBoardTask[] | undefined;
  /** When this session began: finished rows older than this are not shown. */
  readonly sessionStartedAt?: number | undefined;
}

/** Fleet states that are work in progress. */
const RUNNING_STATES: ReadonlySet<string> = new Set(['thinking', 'executing-tool', 'streaming', 'retrying', 'queued']);
/** Fleet states that are over. */
const FINISHED_STATES: ReadonlySet<string> = new Set(['done', 'failed', 'killed', 'interrupted']);
/** How many finished rows are shown. */
const FINISHED_LIMIT = 10;

/** "just now", "15 s ago", "3 min ago", "2 hours ago", "yesterday". */
export function agoWords(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function refType(kind: string): BoardRefType {
  switch (kind) {
    case 'agent': case 'acp-agent': case 'observed-external': return 'agent';
    case 'schedule': case 'hook-action': return 'schedule';
    case 'trigger': case 'watcher': return 'trigger';
    case 'contract': case 'contract-group': case 'contract-unit': return 'contract';
    default: return 'process';
  }
}

const AGENT_KINDS: ReadonlySet<string> = new Set(['agent', 'acp-agent', 'observed-external']);

/** The first sentence-ish line of a long task, for a title. */
function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}

/** "2 files read", "1 file changed", "2 files read · 1 changed". */
function progressWords(progress: WorkBoardNode['progress']): string | undefined {
  if (!progress) return undefined;
  const parts: string[] = [];
  if (progress.filesRead > 0) parts.push(`${plural(progress.filesRead, 'file')} read`);
  if (progress.filesChanged > 0) parts.push(parts.length > 0 ? `${progress.filesChanged} changed` : `${plural(progress.filesChanged, 'file')} changed`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function nodeActions(node: WorkBoardNode, group: BoardGroup): BoardAction[] {
  const actions: BoardAction[] = ['open'];
  if (group === 'running' && (node.capabilities.killable || node.capabilities.interruptible)) actions.push('stop');
  if (group === 'scheduled') {
    if (node.capabilities.pausable) actions.push('pause');
    if (node.capabilities.resumable) actions.push('resume');
    if (node.capabilities.killable) actions.push('stop');
  }
  return actions;
}

function runningRow(node: WorkBoardNode, now: number): BoardRow {
  const agent = AGENT_KINDS.has(node.kind);
  const activity = node.currentActivity?.kind === 'tool' ? node.currentActivity.text : undefined;
  const title = activity ?? (node.task ? firstLine(node.task) : '') ?? '';
  const startedAt = node.startedAt ?? now;
  const progress = progressWords(node.progress);
  const quiet = node.state === 'stalled';
  const started = quiet && node.currentActivity ? `quiet since ${agoWords(node.currentActivity.at, now)}` : `started ${agoWords(startedAt, now)}`;
  const full = [agent ? node.label : undefined, started, progress].filter((part): part is string => part !== undefined).join(' · ');
  return {
    ref: { type: refType(node.kind), id: node.id },
    group: 'running',
    title: title !== '' ? title : node.label,
    ...(agent ? { who: node.label } : {}),
    meta: { short: progress ?? '', full },
    right: formatBeadTime(Math.max(0, now - startedAt)).replace(/\.\ds$/, 's'),
    tone: quiet ? 'quiet' : 'working',
    actions: nodeActions(node, 'running'),
    ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
  };
}

function scheduledRow(node: WorkBoardNode, now: number): BoardRow {
  const facts = node.schedule;
  const paused = node.state === 'paused';
  let short: string;
  let full: string;
  if (node.kind === 'trigger' || node.kind === 'watcher') {
    const cadenceShort = describeTriggerCadence(facts?.cadence, 'short', now);
    const cadenceFull = describeTriggerCadence(facts?.cadence, 'full', now);
    const changesShort = facts?.firedCount !== undefined ? describeChanges(facts.firedCount, facts.lastFiredAt, facts.since ?? node.startedAt ?? now, 'short', now) : undefined;
    const changesFull = facts?.firedCount !== undefined ? describeChanges(facts.firedCount, facts.lastFiredAt, facts.since ?? node.startedAt ?? now, 'full', now) : undefined;
    short = [cadenceShort, changesShort].filter(Boolean).join(' · ');
    full = [cadenceFull, changesFull].filter(Boolean).join(' · ');
  } else {
    const cadenceShort = facts?.cadence ? describeSchedule(facts.cadence, 'short', now) : undefined;
    const cadenceFull = facts?.cadence ? describeSchedule(facts.cadence, 'full', now) : undefined;
    short = [cadenceShort, describeLastRun(facts?.lastRunAt, facts?.lastOutcome, 'short', now)].filter(Boolean).join(' · ');
    full = [cadenceFull, describeLastRun(facts?.lastRunAt, facts?.lastOutcome, 'full', now)].filter(Boolean).join(' · ');
  }
  if (paused) { short = `paused · ${short}`; full = `Paused · ${full}`; }
  return {
    ref: { type: refType(node.kind), id: node.id },
    group: 'scheduled',
    title: node.label,
    meta: { short, full },
    tone: 'quiet',
    actions: nodeActions(node, 'scheduled'),
  };
}

const FINISHED_WORDS: Readonly<Record<string, string>> = { done: 'finished', failed: 'failed', killed: 'stopped', interrupted: 'stopped' };

function finishedRow(node: WorkBoardNode, now: number): BoardRow {
  const agent = AGENT_KINDS.has(node.kind);
  const ended = node.completedAt !== undefined ? `${FINISHED_WORDS[node.state] ?? 'finished'} ${agoWords(node.completedAt, now)}` : FINISHED_WORDS[node.state] ?? 'finished';
  const progress = progressWords(node.progress);
  const full = [agent ? node.label : undefined, ended, progress].filter((part): part is string => part !== undefined).join(' · ');
  const title = node.task ? firstLine(node.task) : node.label;
  return {
    ref: { type: refType(node.kind), id: node.id },
    group: 'finished',
    title: title !== '' ? title : node.label,
    ...(agent ? { who: node.label } : {}),
    meta: { short: [ended, progress].filter(Boolean).join(' · '), full },
    tone: node.state === 'failed' ? 'failed' : node.state === 'done' ? 'done' : 'quiet',
    actions: ['open'],
    ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
  };
}

/** The consequence as a clause inside a meta line: "this weakens a safety setting". */
function clause(text: string): string {
  const trimmed = text.trim().replace(/\.$/, '');
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

function askRow(ask: WorkBoardAsk, now: number, who?: string | undefined): BoardRow {
  const p = ask.presentation;
  const from = p.origin?.sessionTitle !== undefined
    ? p.kind === 'purchase' ? `From "${p.origin.sessionTitle}"` : `Asked by ${p.origin.by} in "${p.origin.sessionTitle}"`
    : p.origin ? `Asked by ${p.origin.by}` : undefined;
  const minutes = p.countdown ? Math.max(0, Math.ceil((p.countdown.at - now) / 60_000)) : undefined;
  const until = p.countdown ? new Date(p.countdown.at) : undefined;
  const countdown = p.countdown && minutes !== undefined && until
    ? p.countdown.verb === 'goes ahead' ? `goes ahead in ${minutes} min unless you say no`
      : `${p.countdown.verb} until ${until.getHours()}:${String(until.getMinutes()).padStart(2, '0')}`
    : undefined;
  const parts = [from, p.kind === 'purchase' ? undefined : agoWords(ask.askedAt, now), p.consequence ? clause(p.consequence.text) : undefined, countdown]
    .filter((part): part is string => part !== undefined && part !== '');
  return {
    ref: { type: 'ask', id: ask.id },
    group: 'waiting',
    title: p.title,
    ...(who !== undefined ? { who } : {}),
    meta: { short: [p.kind === 'purchase' ? undefined : agoWords(ask.askedAt, now), countdown].filter(Boolean).join(' · '), full: parts.join(' · ') },
    tone: 'needs-you',
    actions: ['answer', 'open'],
  };
}

/** A node waiting on the person with no ask in the sources: still shown, from the node's own words. */
function waitingNodeRow(node: WorkBoardNode, now: number): BoardRow {
  const since = node.currentActivity?.at ?? node.startedAt;
  return {
    ref: { type: refType(node.kind), id: node.id },
    group: 'waiting',
    title: node.needsAttention?.detail ?? 'Waiting for your reply in its own conversation',
    ...(AGENT_KINDS.has(node.kind) ? { who: node.label } : {}),
    meta: { short: since !== undefined ? agoWords(since, now) : '', full: [AGENT_KINDS.has(node.kind) ? node.label : undefined, since !== undefined ? agoWords(since, now) : undefined].filter(Boolean).join(' · ') },
    tone: 'needs-you',
    actions: ['answer', 'open'],
  };
}

function serviceRow(node: WorkBoardNode, now: number): BoardRow {
  const since = node.currentActivity?.at ?? node.startedAt;
  const what = node.state === 'stalled' ? `${node.label} stopped answering` : `${node.label} failed`;
  return {
    ref: { type: refType(node.kind), id: node.id },
    group: 'waiting',
    title: what,
    meta: { short: since !== undefined ? agoWords(since, now) : '', full: since !== undefined ? agoWords(since, now) : '' },
    tone: 'failed',
    actions: node.capabilities.resumable ? ['open', 'resume'] : ['open'],
  };
}

function sessionRows(sessions: readonly WorkBoardSession[], now: number, since: number | undefined): { running: BoardRow[]; finished: Array<{ row: BoardRow; at: number }> } {
  const running: BoardRow[] = [];
  const finished: Array<{ row: BoardRow; at: number }> = [];
  for (const session of sessions) {
    if (session.state === 'running') {
      const startedAt = session.startedAt ?? now;
      running.push({
        ref: { type: 'session', id: session.id }, group: 'running', title: session.title,
        meta: { short: '', full: `answering · started ${agoWords(startedAt, now)}` },
        right: formatBeadTime(Math.max(0, now - startedAt)).replace(/\.\ds$/, 's'),
        tone: 'working', actions: ['open', 'stop'],
      });
    } else if ((session.state === 'ended' || session.state === 'failed') && session.endedAt !== undefined && (since === undefined || session.endedAt >= since)) {
      const ended = `${session.state === 'failed' ? 'failed' : 'finished'} ${agoWords(session.endedAt, now)}`;
      finished.push({ at: session.endedAt, row: {
        ref: { type: 'session', id: session.id }, group: 'finished', title: session.title,
        meta: { short: ended, full: ended }, tone: session.state === 'failed' ? 'failed' : 'done', actions: ['open'],
      } });
    }
  }
  return { running, finished };
}

function taskRows(tasks: readonly WorkBoardTask[], now: number, since: number | undefined): { waiting: BoardRow[]; running: BoardRow[]; finished: Array<{ row: BoardRow; at: number }> } {
  const waiting: BoardRow[] = [];
  const running: BoardRow[] = [];
  const finished: Array<{ row: BoardRow; at: number }> = [];
  for (const task of tasks) {
    const ref = { type: 'task' as const, id: task.id };
    if (task.status === 'blocked') {
      waiting.push({ ref, group: 'waiting', title: task.title, meta: { short: 'blocked', full: 'Blocked' }, tone: 'needs-you', actions: ['open'] });
    } else if (task.status === 'running' || task.status === 'queued') {
      const startedAt = task.startedAt ?? now;
      running.push({
        ref, group: 'running', title: task.title,
        meta: { short: task.status === 'queued' ? 'queued' : '', full: task.status === 'queued' ? 'Queued' : `started ${agoWords(startedAt, now)}` },
        right: formatBeadTime(Math.max(0, now - startedAt)).replace(/\.\ds$/, 's'),
        tone: 'working', actions: ['open', 'stop'],
      });
    } else if (task.endedAt !== undefined && (since === undefined || task.endedAt >= since)) {
      const ended = `${task.status === 'completed' ? 'finished' : task.status === 'failed' ? 'failed' : 'stopped'} ${agoWords(task.endedAt, now)}`;
      finished.push({ at: task.endedAt, row: {
        ref, group: 'finished', title: task.title, meta: { short: ended, full: ended },
        tone: task.status === 'failed' ? 'failed' : task.status === 'completed' ? 'done' : 'quiet', actions: ['open'],
      } });
    }
  }
  return { waiting, running, finished };
}

function headlineOf(waiting: number, running: number): string {
  if (waiting === 0 && running === 0) return 'nothing running';
  if (waiting === 0) return `${running} running · nothing waiting for you`;
  if (running === 0) return `${waiting} waiting for you`;
  return `${running} running · ${waiting} waiting for you`;
}

/**
 * The work board from what the surface holds. A `system` node goes to the
 * services count, and is a row only while it is stalled or failed. A `you`
 * node is running in a working state; waiting for the person through its ask
 * (never twice: a node whose ask is listed is not listed again); scheduled
 * while an idle or paused schedule, trigger, hook action or watcher; finished
 * once it ended this session (the newest ten).
 */
export function readWorkBoard(sources: WorkBoardSources, now: number): WorkBoard {
  const asks = sources.asks ?? [];
  const since = sources.sessionStartedAt;
  // An ask from an agent names it: "Helper agent · Run bun test?".
  const whoOf = (agentId: string | undefined): string | undefined => agentId === undefined ? undefined
    : sources.nodes.find((node) => node.id === agentId || node.sessionRef?.agentId === agentId)?.label;
  const waiting: BoardRow[] = asks.map((ask) => askRow(ask, now, whoOf(ask.agentId)));
  const askAgents = new Set(asks.flatMap((ask) => (ask.agentId !== undefined ? [ask.agentId] : [])));
  const askSessions = new Set(asks.flatMap((ask) => (ask.sessionId !== undefined ? [ask.sessionId] : [])));
  const running: BoardRow[] = [];
  const scheduled: BoardRow[] = [];
  const finished: Array<{ row: BoardRow; at: number }> = [];
  const unhealthy: BoardRow[] = [];
  let healthy = 0;
  for (const node of sources.nodes) {
    if (node.serves === 'system') {
      if (node.state === 'stalled' || node.state === 'failed') unhealthy.push(serviceRow(node, now));
      // A finished build (the code index) is healthy; a stopped watcher is not running at all.
      else if (node.state !== 'killed' && node.state !== 'interrupted') healthy++;
      continue;
    }
    if (node.state === 'awaiting-approval' || node.needsAttention !== undefined) {
      const asked = (node.sessionRef?.agentId !== undefined && askAgents.has(node.sessionRef.agentId))
        || (node.sessionRef?.sessionId !== undefined && askSessions.has(node.sessionRef.sessionId))
        || askAgents.has(node.id);
      if (!asked) waiting.push(waitingNodeRow(node, now));
      continue;
    }
    if (RUNNING_STATES.has(node.state) || node.state === 'stalled') { running.push(runningRow(node, now)); continue; }
    if (node.state === 'idle' || node.state === 'paused') { scheduled.push(scheduledRow(node, now)); continue; }
    if (FINISHED_STATES.has(node.state)) {
      const at = node.completedAt ?? node.startedAt ?? 0;
      if (since === undefined || at >= since) finished.push({ row: finishedRow(node, now), at });
    }
  }
  const sessions = sessionRows(sources.sessions ?? [], now, since);
  const tasks = taskRows(sources.tasks ?? [], now, since);
  waiting.push(...tasks.waiting);
  running.push(...sessions.running, ...tasks.running);
  finished.push(...sessions.finished, ...tasks.finished);
  const finishedRows = finished.sort((a, b) => b.at - a.at).slice(0, FINISHED_LIMIT).map((entry) => entry.row);
  const groups = { waiting, running, scheduled, finished: finishedRows };
  const counts = { waiting: waiting.length, running: running.length, scheduled: scheduled.length, finished: finishedRows.length };
  return { groups, counts, services: { healthy, unhealthy }, headline: headlineOf(counts.waiting, counts.running) };
}
