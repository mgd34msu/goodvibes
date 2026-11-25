/**
 * work-agents-entries.ts, the Work place's lists and actions for remote
 * runners (the second half of the Work and agents group; the place itself is
 * declared in the Work place file, which spreads these in).
 *
 * Every list reads the daemon's runners (`remote.list` through
 * `capabilities.run`, one call per refresh for all three) and follows the
 * daemon's `remote-runners` list change and its `agents` events, so a runner
 * started, ending, failing or stopped anywhere, a pool made or an artifact
 * handed back shows with no key pressed. Every action is a `remote.*`
 * capability, which runs in the daemon.
 *
 * The live lists the capabilities' inputs choose from (`remote.runners`,
 * `remote.pools`, ...) and the Recorded runs source are the terminal's side,
 * in work-agents-lists.ts, read from the same daemon answer, so a form opened
 * from the place offers the daemon's runners. This file holds no terminal
 * code: the web UI draws these lists too (places/browser.ts).
 */
import type { PlaceAction, PlaceDetailLine, PlaceFollow, PlaceItem, PlaceList } from './place-types.js';

/** A remote runner the daemon knows: one with a contract, or a live connection. */
export interface RunnerItem extends PlaceItem {
  readonly kind: 'runner';
  /**
   * running: connected or connecting; degraded: its transport is struggling; failed: its agent stopped answering and the
   * connection was lost for good (it needs recovering); ended: it finished or was stopped; local: no transport.
   */
  readonly state: 'running' | 'degraded' | 'failed' | 'ended' | 'local';
  readonly label: string;
  readonly template: string;
  readonly transport: string;
  readonly pool?: string | undefined;
  readonly trust: string;
  readonly tools: readonly string[];
  readonly writeScope: readonly string[];
  readonly folder?: string | undefined;
  readonly errors: number;
  readonly lastError?: string | undefined;
  readonly heartbeat?: string | undefined;
  readonly recovery: readonly string[];
}

export interface PoolItem extends PlaceItem {
  readonly kind: 'pool';
  readonly state: 'empty' | 'holding' | 'full';
  readonly label: string;
  readonly runners: readonly string[];
  /** The runners' names, in the order of `runners` (a runner no longer known keeps its id). */
  readonly runnerNames: readonly string[];
  readonly limit?: number | undefined;
  readonly trust: string;
  readonly template?: string | undefined;
  readonly description?: string | undefined;
}

export interface HandedBackItem extends PlaceItem {
  readonly kind: 'handed-back';
  /** The task's state when it was captured. */
  readonly state: 'completed' | 'failed' | 'cancelled' | 'running' | 'pending' | 'unknown';
  readonly runner: string;
  /** The runner's name while the daemon still knows it, else its id. */
  readonly runnerName: string;
  readonly task: string;
  readonly summary: string;
  readonly template: string;
  readonly tools: readonly string[];
  readonly at?: number | undefined;
  readonly error?: string | undefined;
  readonly toolCalls: number;
  readonly errors: number;
}

/** A run this program recorded of one of its turns (builtin/replay.ts); `loaded` is the one being stepped through. */
export interface RecordedRunItem extends PlaceItem {
  readonly kind: 'recorded-run';
  readonly state: 'loaded' | 'recorded';
  readonly rev?: number | undefined;
  readonly total?: number | undefined;
  /** When it started and how many events it holds, where the ledger says. */
  readonly at?: number | undefined;
  readonly events?: number | undefined;
}

/**
 * An agent this program started in this session (builtin/agents.ts); `in-group` is one running as part of a group of
 * agents; `ended` one that finished, failed or was stopped, kept so its record can be read.
 */
export interface YourAgentItem extends PlaceItem {
  readonly kind: 'agent';
  readonly state: 'running' | 'in-group' | 'ended';
  readonly task: string;
  readonly status: string;
  readonly group?: string | undefined;
  readonly progress?: string | undefined;
  readonly error?: string | undefined;
}

/**
 * A group of agents in words, for the question that stops it: its recipe (a team group's id names it), how many of
 * its agents still run, and the task of the one selected. Never the group's id.
 */
function groupWords(item: YourAgentItem, items: readonly YourAgentItem[]): string {
  const running = items.filter((other) => other.group === item.group && other.state !== 'ended').length;
  const recipe = /^cohort:[^:]+:([^:]+):\d+$/u.exec(item.group ?? '')?.[1]?.replace(/-/g, ' ');
  const count = `${running} agent${running === 1 ? '' : 's'}`;
  return recipe ? `of the recipe "${recipe}" (${count}, among them the one on "${item.task}")` : `of the agent on "${item.task}" (${count})`;
}

/** An agent archetype (built in, or in this project's agents folder). */
export interface ArchetypeItem extends PlaceItem {
  readonly kind: 'archetype';
  readonly state: 'ok' | 'problems';
  readonly label: string;
  readonly family: string;
  readonly issues: number;
}

/** A third-party coding agent the daemon found on this machine and can host. */
export interface CodingAgentItem extends PlaceItem {
  readonly kind: 'coding-agent';
  readonly state: 'installed';
  readonly title: string;
  readonly binaryPath: string;
}

/** A research run the daemon keeps for this project: what it asks and where it stands. */
export interface ResearchRunItem extends PlaceItem {
  readonly kind: 'research-run';
  /** The run's own status: planned, running, paused, blocked, completed, failed or cancelled. */
  readonly state: string;
  readonly title: string;
  readonly question: string;
  readonly phase: string;
  readonly progress: number;
  readonly sources: number;
  readonly nextSteps: readonly string[];
  readonly note?: string | undefined;
  readonly error?: string | undefined;
  readonly report?: string | undefined;
}

/** A source in this project's research queue. */
export interface ResearchSourceItem extends PlaceItem {
  readonly kind: 'research-source';
  /** Its review status: candidate (not reviewed yet), reviewed, used, rejected. */
  readonly state: string;
  readonly title: string;
  readonly question: string;
  readonly summary: string;
  readonly credibility: string;
  readonly score: number;
  readonly url?: string | undefined;
  readonly publisher?: string | undefined;
}

/** Coding work handed to the terminal app: its shared session, and its answer once there is one. */
export interface HandedOffItem extends PlaceItem {
  readonly kind: 'handed-off';
  /** answered; the input's state (queued, delivered, failed ...); gone when the session no longer exists; unreadable. */
  readonly state: string;
  readonly task: string;
  readonly createdAt: string;
  readonly reviewRequested: boolean;
  readonly session?: string | undefined;
  readonly answer?: string | undefined;
  readonly answeredAt?: string | undefined;
  readonly error?: string | undefined;
}

/** A task suite run in this session (builtin/eval.ts): its last result, and the gate's verdict when it was gated. */
export interface EvaluationItem extends PlaceItem {
  readonly kind: 'evaluation';
  readonly state: 'passed' | 'failed';
  readonly passed: number;
  readonly total: number;
  readonly at: number;
  readonly gate?: 'passed' | 'failed' | undefined;
  readonly failed: readonly string[];
}

export type WorkAgentItem = RunnerItem | PoolItem | HandedBackItem | RecordedRunItem | YourAgentItem | ArchetypeItem | CodingAgentItem
  | ResearchRunItem | ResearchSourceItem | HandedOffItem | EvaluationItem;

/** The session source a program that runs task suites supplies (work-agents-lists.ts `evaluationsPlaceSource`). */
export const EVALUATIONS_SOURCE = 'eval-results';

export function researchRunItems(output: unknown): readonly ResearchRunItem[] {
  return (Array.isArray(listed(output)['runs']) ? listed(output)['runs'] as unknown[] : []).map(record).filter((run) => text(run['id'])).map((run): ResearchRunItem => ({
    kind: 'research-run', id: text(run['id']), state: text(run['status']) || 'planned', title: plain(run['title']) || text(run['id']), question: plain(run['question']),
    phase: text(run['phase']), progress: count(run['progress']), sources: count(run['sources']), nextSteps: strings(run['nextSteps']).map((step) => plain(step)),
    ...(plain(run['note']) ? { note: plain(run['note']) } : {}), ...(plain(run['error']) ? { error: plain(run['error']) } : {}), ...(text(run['report']) ? { report: text(run['report']) } : {}),
  }));
}

export function researchSourceItems(output: unknown): readonly ResearchSourceItem[] {
  return (Array.isArray(listed(output)['sources']) ? listed(output)['sources'] as unknown[] : []).map(record).filter((source) => text(source['id'])).map((source): ResearchSourceItem => ({
    kind: 'research-source', id: text(source['id']), state: text(source['status']) || 'candidate', title: plain(source['title']) || text(source['id']),
    question: plain(source['question']), summary: plain(source['summary']), credibility: text(source['credibility']) || 'unreviewed', score: count(source['score']),
    ...(plain(source['url']) ? { url: plain(source['url']) } : {}), ...(plain(source['publisher']) ? { publisher: plain(source['publisher']) } : {}),
  }));
}

export function handedOffItems(output: unknown): readonly HandedOffItem[] {
  return (Array.isArray(listed(output)['handedOff']) ? listed(output)['handedOff'] as unknown[] : []).map(record).filter((entry) => text(entry['sessionId'])).map((entry): HandedOffItem => ({
    kind: 'handed-off', id: text(entry['sessionId']), state: text(entry['state']) || 'unknown', task: plain(entry['task']), createdAt: text(entry['createdAt']),
    reviewRequested: entry['reviewRequested'] === true, ...(text(entry['session']) ? { session: text(entry['session']) } : {}),
    ...(plain(entry['answer']) ? { answer: plain(entry['answer']), answeredAt: text(entry['answeredAt']) } : {}),
    ...(plain(entry['error'] ?? entry['inputError']) ? { error: plain(entry['error'] ?? entry['inputError']) } : {}),
  }));
}

export function evaluationItems(raw: unknown): readonly EvaluationItem[] {
  return (Array.isArray(raw) ? raw : []).map(record).filter((row) => text(row['suite'])).map((row): EvaluationItem => {
    const passed = count(row['passed']); const total = count(row['total']);
    const gate = row['gate'] === 'passed' || row['gate'] === 'failed' ? row['gate'] : undefined;
    return {
      kind: 'evaluation', id: text(row['suite']), state: (gate ?? (passed === total ? 'passed' : 'failed')) as EvaluationItem['state'], passed, total, at: count(row['at']),
      ...(gate ? { gate } : {}), failed: strings(row['failed']),
    };
  });
}

/** The session sources a program that runs its own agents supplies (work-agents-lists.ts `agentsPlaceSources`). */
export const YOUR_AGENTS_SOURCE = 'agents-running';
export const ARCHETYPES_SOURCE = 'agents-archetypes';

const ENDED_AGENT = new Set(['completed', 'failed', 'cancelled', 'done', 'stopped']);

export function yourAgentItems(raw: unknown): readonly YourAgentItem[] {
  return (Array.isArray(raw) ? raw : []).map(record).filter((row) => text(row['id'])).map((row): YourAgentItem => {
    const status = text(row['status']);
    const group = text(row['graphId']);
    return {
      kind: 'agent', id: text(row['id']), task: plain(row['task']), status, ...(group ? { group } : {}),
      ...(plain(row['progress']) ? { progress: plain(row['progress']) } : {}), ...(plain(row['error']) ? { error: plain(row['error']) } : {}),
      state: ENDED_AGENT.has(status) ? 'ended' : group ? 'in-group' : 'running',
    };
  });
}

export function archetypeItems(raw: unknown): readonly ArchetypeItem[] {
  return (Array.isArray(raw) ? raw : []).map(record).filter((row) => text(row['id'])).map((row): ArchetypeItem => {
    const issues = count(row['issues']);
    return { kind: 'archetype', id: text(row['id']), state: issues > 0 ? 'problems' : 'ok', label: plain(row['label']), family: text(row['family']), issues };
  });
}

export function codingAgentItems(output: unknown): readonly CodingAgentItem[] {
  const agents = listed(output)['agents'];
  return (Array.isArray(agents) ? agents : []).map(record).filter((agent) => text(agent['id'])).map((agent): CodingAgentItem => ({
    kind: 'coding-agent', id: text(agent['id']), state: 'installed', title: plain(agent['title']) || text(agent['id']), binaryPath: plain(agent['binaryPath']),
  }));
}

/** The session source a program holding recorded runs supplies: `{ runs: newest first, loaded, rev, total }`. */
export const RECORDED_RUNS_SOURCE = 'replay-runs';

export function recordedRunItems(raw: unknown): readonly RecordedRunItem[] {
  const value = record(raw);
  const loaded = text(value['loaded']);
  const started = record(value['started']);
  return strings(value['runs']).map((id): RecordedRunItem => ({
    kind: 'recorded-run', id, state: id === loaded ? 'loaded' : 'recorded',
    ...(typeof record(started[id])['at'] === 'number' ? { at: record(started[id])['at'] as number, events: count(record(started[id])['events']) } : {}),
    ...(id === loaded && typeof value['rev'] === 'number' ? { rev: value['rev'] } : {}),
    ...(id === loaded && typeof value['total'] === 'number' ? { total: value['total'] } : {}),
  }));
}

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const strings = (value: unknown): readonly string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Text from another machine (a runner's label, task or error), with control characters taken out. */
const plain = (value: unknown): string => text(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();

/** The `data` of the daemon's `remote.list` answer. */
function listed(output: unknown): Record<string, unknown> {
  return record(record(output)['data']);
}

const LIVE = new Set(['initializing', 'authenticating', 'connected', 'syncing']);
const STRUGGLING = new Set(['degraded', 'reconnecting']);

function runnerState(transport: string, live: boolean): RunnerItem['state'] {
  if (!transport) return 'local';
  // Lost for good: its agent stopped answering or went away mid-task. It is not running, and it needs recovering.
  if (transport === 'terminal_failure') return 'failed';
  if (!live) return 'ended';
  if (LIVE.has(transport)) return 'running';
  if (STRUGGLING.has(transport)) return 'degraded';
  return 'ended';
}

export function runnerItems(output: unknown): readonly RunnerItem[] {
  const data = listed(output);
  const connections = new Map((Array.isArray(data['connections']) ? data['connections'] : []).map((entry) => [text(record(entry)['id']), record(entry)]));
  const supervised = new Map((Array.isArray(data['supervised']) ? data['supervised'] : []).map((entry) => [text(record(entry)['runnerId']), record(entry)]));
  // A runner's pool is named as the pool list names it.
  const poolNames = new Map((Array.isArray(data['pools']) ? data['pools'] : []).map((entry) => [text(record(entry)['id']), plain(record(entry)['label']) || text(record(entry)['id'])]));
  const items: RunnerItem[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(data['contracts']) ? data['contracts'] : []) {
    const contract = record(raw);
    const id = text(contract['runnerId']);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const connection = connections.get(id);
    const session = supervised.get(id);
    const ceiling = record(contract['capabilityCeiling']);
    const transport = text(connection?.['transportState']) || text(record(contract['transport'])['state']);
    items.push({
      kind: 'runner', id, state: runnerState(transport, connection !== undefined),
      label: plain(contract['label']) || id, template: text(contract['template']) || 'general', transport,
      ...(text(contract['poolId']) ? { pool: poolNames.get(text(contract['poolId'])) ?? text(contract['poolId']) } : {}),
      trust: text(contract['trustClass']), tools: strings(ceiling['allowedTools']), writeScope: strings(ceiling['writeScope']),
      ...(text(contract['workspaceRoot']) ? { folder: text(contract['workspaceRoot']) } : {}),
      errors: count(connection?.['errorCount'] ?? record(contract['transport'])['errorCount']),
      ...(plain(connection?.['lastError'] ?? record(contract['transport'])['lastError']) ? { lastError: plain(connection?.['lastError'] ?? record(contract['transport'])['lastError']) } : {}),
      ...(session ? { heartbeat: `${text(session['heartbeat'])}${text(session['heartbeatDetail']) ? ` (${plain(session['heartbeatDetail'])})` : ''}` } : {}),
      recovery: (Array.isArray(session?.['recovery']) ? session['recovery'] as unknown[] : []).map((step) => [plain(record(step)['label']), plain(record(step)['reason'])].filter(Boolean).join(': ')).filter(Boolean),
    });
  }
  // A connection with no contract yet (it is still starting) is shown too.
  for (const [id, connection] of connections) {
    if (!id || seen.has(id)) continue;
    const transport = text(connection['transportState']);
    items.push({ kind: 'runner', id, state: runnerState(transport, true), label: plain(connection['label']) || id, template: 'general', transport, trust: 'self-hosted-acp', tools: [], writeScope: [], errors: count(connection['errorCount']), recovery: [] });
  }
  return items;
}

export function poolItems(output: unknown): readonly PoolItem[] {
  const names = new Map(runnerItems(output).map((runner) => [runner.id, runner.label]));
  return (Array.isArray(listed(output)['pools']) ? listed(output)['pools'] as unknown[] : []).map(record).filter((pool) => text(pool['id'])).map((pool): PoolItem => {
    const runners = strings(pool['runnerIds']);
    const limit = typeof pool['maxRunners'] === 'number' ? pool['maxRunners'] : undefined;
    return {
      kind: 'pool', id: text(pool['id']), state: runners.length === 0 ? 'empty' : limit !== undefined && runners.length >= limit ? 'full' : 'holding',
      label: plain(pool['label']) || text(pool['id']), runners, runnerNames: runners.map((runnerId) => names.get(runnerId) ?? runnerId),
      ...(limit !== undefined ? { limit } : {}), trust: text(pool['trustClass']),
      ...(text(pool['preferredTemplate']) ? { template: text(pool['preferredTemplate']) } : {}),
      ...(plain(pool['description']) ? { description: plain(pool['description']) } : {}),
    };
  });
}

const HANDED_BACK_STATES = new Set<HandedBackItem['state']>(['completed', 'failed', 'cancelled', 'running', 'pending', 'unknown']);

export function handedBackItems(output: unknown): readonly HandedBackItem[] {
  const names = new Map(runnerItems(output).map((runner) => [runner.id, runner.label]));
  return (Array.isArray(listed(output)['artifacts']) ? listed(output)['artifacts'] as unknown[] : []).map(record).filter((artifact) => text(artifact['id'])).map((artifact): HandedBackItem => {
    const status = text(artifact['status']) as HandedBackItem['state'];
    return {
      kind: 'handed-back', id: text(artifact['id']), state: HANDED_BACK_STATES.has(status) ? status : 'unknown',
      runner: text(artifact['runnerId']), runnerName: names.get(text(artifact['runnerId'])) ?? text(artifact['runnerId']), task: plain(artifact['task']), summary: plain(artifact['summary']), template: text(artifact['template']),
      tools: strings(artifact['tools']), ...(typeof artifact['createdAt'] === 'number' ? { at: artifact['createdAt'] } : {}),
      ...(plain(artifact['error']) ? { error: plain(artifact['error']) } : {}),
      toolCalls: count(artifact['toolCallCount']), errors: count(artifact['errorCount']),
    };
  });
}

/** One read of the daemon's runners for all three lists. */
const RUNNERS_SOURCE = { kind: 'daemon', method: 'capabilities.run', input: { id: 'remote.list' } } as const;

/** A runner started, ended or stopped (agents events), and every change made to pools, contracts or artifacts. */
const RUNNER_EVENTS: PlaceFollow = { domains: ['agents', 'workspace'], events: ['agents'], lists: ['remote-runners'] };

const RUNNER_STATE_WORDS: Readonly<Record<RunnerItem['state'], string>> = { running: 'running', degraded: 'struggling', failed: 'failed', ended: 'ended', local: 'in the daemon' };
/** How far a pool's runners are trusted, in words. */
const TRUST_WORDS: Readonly<Record<string, string>> = {
  'self-hosted-acp': 'runners this daemon starts on this machine', 'local-daemon': 'agents inside the daemon', mixed: 'runners of either kind',
};
/** A runner that needs recovering: struggling, or lost for good. */
const NEEDS_RECOVERY: readonly RunnerItem['state'][] = ['degraded', 'failed'];

function when(at: number | undefined): string {
  return at ? new Date(at).toLocaleString() : 'not known';
}

const runnersList: PlaceList<WorkAgentItem> = {
  id: 'runners',
  label: 'Runners',
  noun: 'the remote runners',
  source: { ...RUNNERS_SOURCE, items: runnerItems },
  follows: RUNNER_EVENTS,
  empty: 'No remote runners: none has been started.',
  row: (item) => {
    const runner = item as RunnerItem;
    return {
      title: runner.label,
      ...(runner.state === 'running' ? {} : { right: RUNNER_STATE_WORDS[runner.state] }),
      mark: runner.state === 'running' ? 'running' : NEEDS_RECOVERY.includes(runner.state) ? 'attention' : runner.state === 'ended' ? 'paused' : 'ok',
    };
  },
  detail: (item) => {
    const runner = item as RunnerItem;
    const lines: PlaceDetailLine[] = [
      { label: 'State', text: RUNNER_STATE_WORDS[runner.state] },
      { label: 'Kind of agent', text: runner.template },
      ...(runner.pool ? [{ label: 'Pool', text: runner.pool }] : []),
      ...(runner.folder ? [{ label: 'Works in', text: runner.folder }] : []),
      { label: 'Tools', text: runner.tools.length > 0 ? runner.tools.join(', ') : 'none set' },
      { label: 'May write', text: runner.writeScope.length > 0 ? runner.writeScope.join(', ') : 'its folder, under the permission rules' },
      // A heartbeat and how to recover are a live runner's; an ended one has neither.
      ...(runner.heartbeat && (LIVE_RUNNER.includes(runner.state) || runner.state === 'failed') ? [{ label: 'Heartbeat', text: runner.heartbeat }] : []),
      ...(runner.errors > 0 ? [{ label: 'Errors', text: String(runner.errors), tone: 'warning' as const }] : []),
      ...(runner.lastError ? [{ label: 'Last error', text: runner.lastError, tone: 'warning' as const }] : []),
      ...(NEEDS_RECOVERY.includes(runner.state) ? runner.recovery.map((step, index) => ({ label: index === 0 ? 'To recover' : '', text: step })) : []),
    ];
    return lines;
  },
};

const poolsList: PlaceList<WorkAgentItem> = {
  id: 'pools',
  label: 'Runner pools',
  noun: 'your runner pools',
  source: { ...RUNNERS_SOURCE, items: poolItems },
  follows: RUNNER_EVENTS,
  empty: 'No runner pools yet.',
  row: (item) => {
    const pool = item as PoolItem;
    return { title: pool.label, right: pool.state === 'full' ? 'full' : `${pool.runners.length} runner${pool.runners.length === 1 ? '' : 's'}`, mark: pool.state === 'full' ? 'attention' : 'ok' };
  },
  detail: (item) => {
    const pool = item as PoolItem;
    return [
      { label: 'Runners', text: pool.runnerNames.length > 0 ? pool.runnerNames.join(', ') : 'none yet' },
      { label: 'Limit', text: pool.limit !== undefined ? String(pool.limit) : 'none' },
      { label: 'Trust', text: TRUST_WORDS[pool.trust] ?? (pool.trust || 'not said') },
      { label: 'Usual agent', text: pool.template ?? 'general' },
      ...(pool.description ? [{ label: 'About', text: pool.description }] : []),
    ];
  },
};

const STATUS_WORDS: Readonly<Record<HandedBackItem['state'], string>> = { completed: 'finished', failed: 'failed', cancelled: 'stopped', running: 'still running when saved', pending: 'not started when saved', unknown: 'not known' };
/** The same, short enough for a row's right side at 80 columns. */
const STATUS_ROW_WORDS: Readonly<Record<HandedBackItem['state'], string>> = { completed: 'finished', failed: 'failed', cancelled: 'stopped', running: 'running', pending: 'not started', unknown: 'not known' };

const handedBackList: PlaceList<WorkAgentItem> = {
  id: 'handed-back',
  label: 'Handed back',
  noun: 'what runners handed back',
  source: { ...RUNNERS_SOURCE, items: handedBackItems },
  follows: RUNNER_EVENTS,
  empty: 'Nothing handed back yet: save a runner\'s work to review it here.',
  row: (item) => {
    const artifact = item as HandedBackItem;
    return { title: artifact.task || artifact.summary || artifact.id, right: STATUS_ROW_WORDS[artifact.state], mark: artifact.state === 'failed' ? 'attention' : artifact.state === 'completed' ? 'ok' : 'paused' };
  },
  detail: (item) => {
    const artifact = item as HandedBackItem;
    return [
      { label: 'Task', text: artifact.task || 'not said' },
      { label: 'Result', text: STATUS_WORDS[artifact.state] },
      // A runner is named by its task, so it is named here only when that differs.
      ...(artifact.runnerName !== artifact.task ? [{ label: 'Runner', text: artifact.runnerName }] : []),
      { label: 'Saved', text: when(artifact.at) },
      { label: 'Tools it had', text: artifact.tools.length > 0 ? artifact.tools.join(', ') : 'none' },
      { label: 'Evidence', text: `${artifact.toolCalls} tool call${artifact.toolCalls === 1 ? '' : 's'}, ${artifact.errors} error${artifact.errors === 1 ? '' : 's'}` },
      ...(artifact.error ? [{ label: 'What went wrong', text: artifact.error, tone: 'warning' as const }] : []),
      { text: '' },
      { label: 'Summary', text: artifact.summary || 'none' },
    ];
  },
};

const recordedRunsList: PlaceList<WorkAgentItem> = {
  id: 'recorded-runs',
  label: 'Recorded runs',
  noun: 'recorded runs',
  source: { kind: 'session', name: RECORDED_RUNS_SOURCE, items: recordedRunItems },
  // Only the terminal app records its turns: the Agent has no recorded runs and shows no such tab.
  programs: ['tui'],
  empty: 'No runs recorded yet: each turn in this project is recorded as one.',
  row: (item) => {
    const run = item as RecordedRunItem;
    // A run is named by when it started; its id is no word a person reads.
    // Short enough for a row at 80 columns: the time alone for a turn of today, the date and time otherwise;
    // how many events it holds is in its detail.
    const title = run.at === undefined ? run.id
      : new Date(run.at).toDateString() === new Date().toDateString() ? new Date(run.at).toLocaleTimeString() : when(run.at);
    return {
      title,
      ...(run.state === 'loaded'
        ? { right: run.total !== undefined ? `at ${run.rev ?? 0} of ${run.total}` : 'loaded', mark: 'running' as const }
        : { mark: 'ok' as const }),
    };
  },
  detail: (item) => {
    const run = item as RecordedRunItem;
    return [
      ...(run.at !== undefined ? [{ label: 'Started', text: when(run.at) }] : []),
      ...(run.events !== undefined ? [{ label: 'Events', text: String(run.events) }] : []),
      { label: 'Run', text: run.id },
      { label: 'State', text: run.state === 'loaded' ? `loaded${run.total !== undefined ? `, at event ${run.rev ?? 0} of ${run.total}` : ''}` : 'recorded' },
    ];
  },
};

const AGENT_STATE_WORDS: Readonly<Record<YourAgentItem['state'], string>> = { running: 'running', 'in-group': 'running in a group', ended: 'ended' };
const AGENT_STATUS_WORDS: Readonly<Record<string, string>> = {
  pending: 'starting', running: 'running', completed: 'ended: finished', failed: 'ended: failed', cancelled: 'ended: stopped',
};

const yourAgentsList: PlaceList<WorkAgentItem> = {
  id: 'agents',
  label: 'Your agents',
  noun: 'the agents started here',
  source: { kind: 'session', name: YOUR_AGENTS_SOURCE, items: yourAgentItems },
  // The terminal app runs agents of its own; the Agent hands work on instead.
  programs: ['tui'],
  empty: 'No agents started in this session: start one in a team mode, from a recipe or from an archetype.',
  row: (item) => {
    const agent = item as YourAgentItem;
    return { title: agent.task || agent.id, ...(agent.state === 'running' ? {} : { right: AGENT_STATE_WORDS[agent.state] }), mark: agent.state === 'ended' ? 'paused' : 'running' };
  },
  detail: (item) => {
    const agent = item as YourAgentItem;
    return [
      { label: 'Task', text: agent.task || 'not said' },
      { label: 'State', text: AGENT_STATUS_WORDS[agent.status] ?? (agent.status || AGENT_STATE_WORDS[agent.state]) },
      ...(agent.group ? [{ label: 'Group', text: agent.state === 'ended' ? 'it ran in a group' : 'it runs in a group: stopping the group stops them all' }] : []),
      ...(agent.progress ? [{ label: agent.state === 'ended' ? 'Last heard' : 'Now', text: agent.progress }] : []),
      ...(agent.error ? [{ label: 'What went wrong', text: agent.error, tone: 'warning' as const }] : []),
    ];
  },
};

const archetypesList: PlaceList<WorkAgentItem> = {
  id: 'archetypes',
  label: 'Archetypes',
  noun: 'the agent archetypes',
  source: { kind: 'session', name: ARCHETYPES_SOURCE, items: archetypeItems },
  programs: ['tui'],
  empty: 'No agent archetypes found.',
  row: (item) => {
    const archetype = item as ArchetypeItem;
    return { title: archetype.id, right: archetype.issues > 0 ? `${archetype.issues} problem${archetype.issues === 1 ? '' : 's'}` : archetype.family, mark: archetype.issues > 0 ? 'attention' : 'ok' };
  },
  detail: (item) => {
    const archetype = item as ArchetypeItem;
    return [{ label: 'What it is', text: archetype.label || 'not said' }, { label: 'Family', text: archetype.family || 'not said' }, ...(archetype.issues > 0 ? [{ label: 'Problems', text: String(archetype.issues), tone: 'warning' as const }] : [])];
  },
};

const codingAgentsList: PlaceList<WorkAgentItem> = {
  id: 'coding-agents',
  label: 'Coding agents',
  noun: 'the coding agents on this machine',
  source: { kind: 'daemon', method: 'capabilities.run', input: { id: 'agents.hostable' }, items: codingAgentItems },
  // A hosted one shows on the agents domain the daemon announces.
  follows: { domains: ['agents'], events: ['agents'] },
  empty: 'No third-party coding agents found. Install Claude Code, Codex or opencode on PATH to host one.',
  row: (item) => ({ title: (item as CodingAgentItem).title }),
  detail: (item) => [{ label: 'Coding agent', text: (item as CodingAgentItem).title }, { label: 'Program', text: (item as CodingAgentItem).binaryPath || 'not said' }],
};

/** One read of the daemon's research runs and research queue for both lists, read again on every change (LIST_CHANGED `research`). */
const RESEARCH_SOURCE = { kind: 'daemon', method: 'capabilities.run', input: { id: 'research.runs' } } as const;
const RESEARCH_EVENTS: PlaceFollow = { domains: ['workspace'], events: [], lists: ['research'] };

const RESEARCH_STATE_WORDS: Readonly<Record<string, string>> = {
  planned: 'not started', running: 'collecting sources', paused: 'paused', blocked: 'stopped on a problem', completed: 'done', failed: 'failed', cancelled: 'stopped',
};
/** The one word a run's row has room for; the detail says it in full. */
const RESEARCH_ROW_WORDS: Readonly<Record<string, string>> = {
  planned: 'not started', running: 'collecting', paused: 'paused', blocked: 'stopped', completed: 'done', failed: 'failed', cancelled: 'stopped',
};
const CREDIBILITY_WORDS: Readonly<Record<string, string>> = { unreviewed: 'not judged yet', high: 'high', medium: 'medium', low: 'low', mixed: 'mixed' };
const SOURCE_STATE_WORDS: Readonly<Record<string, string>> = { candidate: 'not reviewed yet', reviewed: 'reviewed', used: 'used in a report', rejected: 'set aside' };

const researchList: PlaceList<WorkAgentItem> = {
  id: 'research',
  label: 'Research',
  noun: 'your research runs',
  source: { ...RESEARCH_SOURCE, items: researchRunItems },
  follows: RESEARCH_EVENTS,
  empty: 'No research runs yet: start one, and the daemon collects public web sources for it.',
  row: (item) => {
    const run = item as ResearchRunItem;
    return {
      title: run.title,
      right: RESEARCH_ROW_WORDS[run.state] ?? run.state,
      mark: run.state === 'running' ? 'running' : run.state === 'blocked' || run.state === 'failed' ? 'attention' : run.state === 'completed' ? 'ok' : 'paused',
    };
  },
  detail: (item) => {
    const run = item as ResearchRunItem;
    return [
      { label: 'Question', text: run.question || 'not said' },
      { label: 'Where it stands', text: `${RESEARCH_STATE_WORDS[run.state] ?? run.state}${run.state === 'running' ? `, ${run.progress}% done` : ''}` },
      { label: 'Sources', text: `${run.sources} collected` },
      ...(run.note ? [{ label: 'Last note', text: run.note }] : []),
      ...(run.error ? [{ label: 'What went wrong', text: run.error, tone: 'warning' as const }] : []),
      ...run.nextSteps.map((step, index) => ({ label: index === 0 ? 'Next' : '', text: step })),
      ...(run.report ? [{ label: 'Report', text: `saved as artifact ${run.report}` }] : []),
    ];
  },
};

const sourcesList: PlaceList<WorkAgentItem> = {
  id: 'sources',
  label: 'Sources',
  noun: 'your research queue',
  source: { ...RESEARCH_SOURCE, items: researchSourceItems },
  follows: RESEARCH_EVENTS,
  empty: 'The research queue is empty: a research run fills it, and you can add a source of your own.',
  row: (item) => {
    const source = item as ResearchSourceItem;
    // The row has room for one short word: "new" until it is judged, then how far it is trusted.
    return { title: source.title, right: source.credibility === 'unreviewed' ? 'new' : CREDIBILITY_WORDS[source.credibility] ?? source.credibility, mark: source.state === 'rejected' ? 'paused' : source.state === 'used' ? 'ok' : 'waiting' };
  },
  detail: (item) => {
    const source = item as ResearchSourceItem;
    return [
      { label: 'For the question', text: source.question || 'not said' },
      ...(source.url ? [{ label: 'Address', text: source.url }] : []),
      ...(source.publisher ? [{ label: 'Publisher', text: source.publisher }] : []),
      { label: 'Trust', text: `${CREDIBILITY_WORDS[source.credibility] ?? source.credibility}${source.score > 0 ? `, score ${source.score}` : ''}` },
      { label: 'State', text: SOURCE_STATE_WORDS[source.state] ?? source.state },
      { text: '' },
      { label: 'Summary', text: source.summary || 'none' },
    ];
  },
};

const HANDED_OFF_WORDS: Readonly<Record<string, string>> = {
  answered: 'answered', queued: 'waiting to be taken', delivered: 'taken', running: 'being worked on', failed: 'failed', cancelled: 'stopped',
  gone: 'session gone', unreadable: 'could not be read', unknown: 'state not known', active: 'open', closed: 'closed',
};

/** The one word a hand-off's row has room for; the detail says it in full. */
const HANDED_OFF_ROW_WORDS: Readonly<Record<string, string>> = {
  answered: 'answered', queued: 'waiting', delivered: 'taken', running: 'working', failed: 'failed', cancelled: 'stopped',
  gone: 'gone', unreadable: 'unreadable', unknown: 'not known', active: 'open', closed: 'closed',
};

const handedOffList: PlaceList<WorkAgentItem> = {
  id: 'handed-off',
  label: 'Handed off',
  noun: 'the work you handed off',
  source: { kind: 'daemon', method: 'capabilities.run', input: { id: 'agents.handed-off' }, items: handedOffItems },
  // A hand-off made anywhere, and its session answering.
  follows: { domains: ['session', 'workspace'], events: ['session'], lists: ['handed-off'] },
  empty: 'No work handed off yet: hand coding work to the terminal app and follow it here.',
  row: (item) => {
    const entry = item as HandedOffItem;
    return {
      title: entry.task || entry.id, right: HANDED_OFF_ROW_WORDS[entry.state] ?? entry.state,
      mark: entry.state === 'answered' ? 'ok' : entry.state === 'failed' || entry.state === 'gone' || entry.state === 'unreadable' ? 'attention' : 'running',
    };
  },
  detail: (item) => {
    const entry = item as HandedOffItem;
    return [
      { label: 'The work', text: entry.task || 'not said' },
      { label: 'Handed off', text: entry.createdAt ? new Date(entry.createdAt).toLocaleString() : 'not known' },
      { label: 'Where it stands', text: HANDED_OFF_WORDS[entry.state] ?? entry.state },
      ...(entry.reviewRequested ? [{ label: 'Review', text: 'asked for' }] : []),
      ...(entry.error ? [{ label: 'What went wrong', text: entry.error, tone: 'warning' as const }] : []),
      ...(entry.answer ? [{ text: '' }, { label: 'Latest answer', text: entry.answer }] : []),
    ];
  },
};

const evaluationsList: PlaceList<WorkAgentItem> = {
  id: 'evaluations',
  label: 'Evaluations',
  noun: 'the task suites run here',
  source: { kind: 'session', name: EVALUATIONS_SOURCE, items: evaluationItems },
  // Task suites run in the terminal app's project; the Agent runs none.
  programs: ['tui'],
  empty: 'No task suite run in this session: run one to test the product on real tasks.',
  row: (item) => {
    const run = item as EvaluationItem;
    return { title: run.id, right: run.gate ? `gate ${run.gate}` : `${run.passed} of ${run.total} passed`, mark: run.state === 'passed' ? 'ok' : 'attention' };
  },
  detail: (item) => {
    const run = item as EvaluationItem;
    return [
      { label: 'Suite', text: run.id },
      { label: 'Passed', text: `${run.passed} of ${run.total}` },
      ...(run.gate ? [{ label: 'Gate', text: run.gate }] : []),
      ...(run.failed.length > 0 ? [{ label: 'Failed', text: run.failed.join(', '), tone: 'warning' as const }] : []),
      { label: 'Run', text: run.at ? new Date(run.at).toLocaleString() : 'not known' },
    ];
  },
};

export const WORK_AGENT_LISTS: readonly PlaceList<WorkAgentItem>[] = [
  yourAgentsList, archetypesList, codingAgentsList, handedOffList, researchList, sourcesList, evaluationsList,
  runnersList, poolsList, handedBackList, recordedRunsList,
];

const LIVE_RUNNER = ['running', 'degraded'];

export const WORK_AGENT_ACTIONS: readonly PlaceAction<WorkAgentItem>[] = [
  // Your agents: start them in a team mode or from a recipe, see the modes, stop one or its group.
  { key: 's', id: 'start-agent', list: 'agents', whole: true, capability: 'agents.start', label: 'start an agent' },
  { key: 'R', id: 'run-recipe', list: 'agents', whole: true, capability: 'agents.recipe', label: 'run a recipe' },
  { key: 't', id: 'team-modes', list: 'agents', whole: true, capability: 'agents.team', label: 'team modes and recipes' },
  // Only a running agent has these; an ended one is listed for its record.
  { key: 'x', id: 'stop-agent', list: 'agents', states: ['running', 'in-group'], capability: 'agents.stop', label: 'stop it', fill: { agent: 'id' } },
  { key: 'b', id: 'stop-branch', list: 'agents', states: ['running', 'in-group'], capability: 'agents.stop-branch', label: 'stop it and what it started', fill: { agent: 'id' } },
  { key: 'X', id: 'stop-group', list: 'agents', states: ['in-group'], capability: 'agents.stop-group', label: 'stop its group', fill: { group: (item) => (item as YourAgentItem).group ?? '' },
    shownAs: { group: (item, items) => groupWords(item as YourAgentItem, items as readonly YourAgentItem[]) } },
  // Archetypes: see one, start an agent from one; the tab is the list of them.
  { key: 'enter', id: 'archetype', list: 'archetypes', capability: 'agents.archetype', label: 'see it', fill: { archetype: 'id' } },
  { key: 's', id: 'start-from-archetype', list: 'archetypes', capability: 'agents.start-archetype', label: 'start an agent from it', fill: { archetype: 'id' } },
  { key: 'l', id: 'all-archetypes', list: 'archetypes', whole: true, capability: 'agents.archetypes', label: 'list them all' },
  // Coding agents the daemon hosts.
  { key: 'enter', id: 'host', list: 'coding-agents', capability: 'agents.host', label: 'host it', fill: { agent: 'id' } },
  { key: 'l', id: 'coding-agents', list: 'coding-agents', whole: true, capability: 'agents.hostable', label: 'list them' },
  // A media job a provider was still making when its answer came back: collected by the daemon, from anywhere in the place.
  { key: 'J', id: 'collect-media-job', capability: 'media.collect', label: 'collect a media job' },
  // The Agent's briefing of its own state (the terminal app keeps none: the capability refuses there).
  { key: 'O', id: 'briefing', capability: 'work.brief', label: 'your briefing', programs: ['agent'] },
  // Web research: a question or a page goes to the Agent's conversation; runs, the queue and reports are the daemon's.
  { key: 'Q', id: 'research-question', capability: 'research.ask', label: 'research a question', programs: ['agent'] },
  { key: 'W', id: 'look-at-page', capability: 'research.inspect', label: 'look at a web page', programs: ['agent'] },
  { key: 's', id: 'start-research', list: 'research', whole: true, capability: 'research.start-run', label: 'start a research run' },
  { key: 'w', id: 'save-report', list: 'research', capability: 'research.save-report', label: 'save a sourced report', fill: { question: (item) => (item as ResearchRunItem).question, title: (item) => (item as ResearchRunItem).title } },
  { key: 'a', id: 'add-source', list: 'sources', whole: true, capability: 'research.add-source', label: 'add a source' },
  // Coding work handed to the terminal app, as a shared session it takes up: from every program, the terminal app too.
  { key: 'h', id: 'hand-off', list: 'handed-off', whole: true, capability: 'agents.hand-off', label: 'hand coding work on' },
  { key: 'enter', id: 'handed-off-detail', list: 'handed-off', capability: 'agents.handed-off', label: 'where it stands', fill: { session: 'id' } },
  // Task suites run in the terminal app's project.
  { key: 'l', id: 'suite-tasks', list: 'evaluations', whole: true, capability: 'eval.list', label: 'tasks in a suite' },
  { key: 's', id: 'run-suite', list: 'evaluations', whole: true, capability: 'eval.run', label: 'run a suite' },
  { key: 'c', id: 'compare-baseline', list: 'evaluations', whole: true, capability: 'eval.compare', label: 'compare with the baseline' },
  { key: 'g', id: 'gate-suite', list: 'evaluations', whole: true, capability: 'eval.gate', label: 'run and stop on a regression' },
  { key: 'enter', id: 'run-suite-again', list: 'evaluations', capability: 'eval.run', label: 'run it again', fill: { suite: 'id' } },
  // Runners: start one, look at one, stop one, save its work.
  // What acts on the runners as a whole is on the tab whether or not a runner is selected (the first one is started here).
  { key: 'd', id: 'start-runner', list: 'runners', whole: true, capability: 'remote.dispatch', label: 'start a runner' },
  { key: 'D', id: 'start-from-pool', list: 'runners', whole: true, capability: 'remote.dispatch-pool', label: 'start from a pool' },
  { key: 'enter', id: 'runner-contract', list: 'runners', capability: 'remote.contract', label: 'contract', fill: { runner: 'id' } },
  { key: 'v', list: 'runners', states: LIVE_RUNNER, capability: 'remote.supervisor', label: 'supervisor', fill: { runner: 'id' } },
  { key: 'k', list: 'runners', states: LIVE_RUNNER, capability: 'remote.capabilities', label: 'what it can do', fill: { runner: 'id' } },
  { key: 'h', list: 'runners', states: [...NEEDS_RECOVERY], capability: 'remote.recover', label: 'how to recover', fill: { runner: 'id' } },
  { key: 'o', list: 'runners', states: LIVE_RUNNER, capability: 'remote.show', label: 'connection', fill: { connection: 'id' } },
  { key: 'x', id: 'stop-runner', list: 'runners', states: LIVE_RUNNER, capability: 'remote.stop', label: 'stop', fill: { connection: 'id' } },
  { key: 'e', id: 'save-work', list: 'runners', capability: 'remote.export', label: 'save its work', fill: { runner: 'id' } },
  { key: 'a', id: 'put-in-pool', list: 'runners', capability: 'remote.assign', label: 'put in a pool', fill: { runner: 'id' } },
  { key: 'u', id: 'setup', list: 'runners', whole: true, capability: 'remote.setup', label: 'setup' },
  { key: 'U', id: 'save-setup', list: 'runners', whole: true, capability: 'remote.setup-export', label: 'save setup' },
  { key: 'E', id: 'environment', list: 'runners', whole: true, capability: 'remote.env', label: 'environment' },
  { key: 'w', id: 'save-environment', list: 'runners', whole: true, capability: 'remote.env-export', label: 'save environment' },
  { key: 'b', id: 'save-startup-bundle', list: 'runners', whole: true, capability: 'remote.bootstrap-export', label: 'start-up bundle' },
  { key: 'B', id: 'open-startup-bundle', list: 'runners', whole: true, capability: 'remote.bootstrap-inspect', label: 'look in a start-up bundle' },
  { key: 'S', id: 'save-runner-bundle', list: 'runners', whole: true, capability: 'remote.session-export', label: 'save runners' },
  { key: 'L', id: 'look-in-runner-bundle', list: 'runners', whole: true, capability: 'remote.session-inspect', label: 'look in a runner bundle' },
  { key: 'I', id: 'bring-in-runner-bundle', list: 'runners', whole: true, capability: 'remote.session-import', label: 'bring in runners' },
  // Pools.
  { key: 'm', id: 'make-pool', list: 'pools', whole: true, capability: 'remote.create-pool', label: 'make a pool' },
  { key: 'enter', id: 'pool-detail', list: 'pools', capability: 'remote.pool', label: 'pool', fill: { pool: 'id' } },
  { key: 'd', id: 'start-in-pool', list: 'pools', states: ['empty', 'holding'], capability: 'remote.dispatch-pool', label: 'start a runner here', fill: { pool: 'id' } },
  { key: 'a', id: 'add-runner', list: 'pools', states: ['empty', 'holding'], capability: 'remote.assign', label: 'add a runner', fill: { pool: 'id' } },
  { key: 'u', id: 'take-runner-out', list: 'pools', states: ['holding', 'full'], capability: 'remote.unassign', label: 'take a runner out', fill: { pool: 'id' } },
  // What runners handed back.
  { key: 'enter', id: 'review', list: 'handed-back', capability: 'remote.review', label: 'review', fill: { artifact: 'id' } },
  { key: 'e', id: 'save-artifact', list: 'handed-back', capability: 'remote.artifact-export', label: 'save to a file', fill: { artifact: 'id' } },
  { key: 'g', id: 'run-here', list: 'handed-back', capability: 'remote.rerun-local', label: 'run its task here', fill: { artifact: 'id' } },
  { key: 'i', id: 'bring-in', list: 'handed-back', whole: true, capability: 'remote.import', label: 'bring one in' },
  // Recorded runs of this program's turns.
  { key: 'enter', id: 'load-run', list: 'recorded-runs', states: ['recorded'], capability: 'replay.load', label: 'load', fill: { run: 'id' } },
  { key: 'enter', id: 'run-status', list: 'recorded-runs', states: ['loaded'], capability: 'replay.status', label: 'where am I' },
  { key: 'l', id: 'step-run', list: 'recorded-runs', states: ['loaded'], capability: 'replay.step', label: 'step' },
  { key: 'j', id: 'jump-in-run', list: 'recorded-runs', states: ['loaded'], capability: 'replay.seek', label: 'jump to' },
  { key: 'c', id: 'compare-runs', list: 'recorded-runs', states: ['recorded'], capability: 'replay.diff', label: 'compare with the loaded one', fill: { run: 'id' } },
  { key: 'e', id: 'save-replay-report', list: 'recorded-runs', states: ['loaded'], capability: 'replay.export', label: 'save the report' },
  { key: 'L', id: 'list-runs', list: 'recorded-runs', whole: true, capability: 'replay.runs', label: 'list them' },
];

/** What the terminal side of these lists reads (work-agents-lists.ts: the Recorded runs source, the forms' live lists). */
export { LIVE_RUNNER, RUNNER_STATE_WORDS, listed as listedRunners };
