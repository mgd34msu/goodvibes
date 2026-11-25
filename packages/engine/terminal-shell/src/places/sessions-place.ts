/**
 * sessions-place.ts, the Sessions place: your conversations.
 *
 * Six lists. Sessions: this conversation and the ones saved in this project,
 * read from the program holding the conversation (they are its own files,
 * `<project>/.goodvibes/<program>/sessions/`) and read again whenever the
 * daemon's session list changes (a session saved, closed or written into by
 * another terminal); searched in place as the person types, by title and by
 * what was said; resume, write out, rename, copy, upload and delete are
 * controls on the session they act on. Branches: this conversation's
 * branches, switched to or brought in. Record: the open conversation's record,
 * each view opening whole, and its bookmarked blocks, each moving the
 * conversation to its place. Hand-offs: the project's cross-session task graph
 * (one file for both terminal programs, the one a turn's task tool reads),
 * with adding a task, handing it to another session, accepting, taking back
 * and cancelling. Hosted: the conversations the daemon runs, following its
 * hosted-session events. Joined here: the hosted session this terminal joined,
 * with sending to it and leaving it. Every action is a capability; only those
 * that apply to the selected item in its state are on the hint row.
 *
 * Moving through the conversation (the next or previous entry) and what the
 * composer waits on are keys of the conversation itself, not rows here: a
 * context of the key table read while writing a message (`SESSIONS_VIEW_KEYS`).
 */
import type { KeyContext } from '../keybindings.js';
import type { PlaceHost } from './place-host.js';
import { definePlace, type PlaceItem } from './place-types.js';

/** A conversation of this program: the open one, or one saved in this project. */
interface SessionItem extends PlaceItem {
  readonly state: 'current' | 'saved';
  readonly title: string;
  readonly when?: number | undefined;
  readonly messages: number;
  readonly model: string;
  readonly provider: string;
  readonly file: string;
  /** What it was doing when it was left (tasks, approvals), in words. */
  readonly left?: string | undefined;
}

interface BranchItem extends PlaceItem {
  readonly state: 'current' | 'other';
  readonly messages: number;
}

/** A view of the open conversation's record, or one of its bookmarked blocks. */
interface RecordItem extends PlaceItem {
  readonly state: 'events' | 'groups' | 'hotspots' | 'restored' | 'bookmark';
  readonly title: string;
  readonly about: string;
  readonly when?: number | undefined;
}

/** A task of the project's cross-session task graph, with the hand-off waiting on it. */
interface TaskItem extends PlaceItem {
  /**
   * Its lifecycle state, or `handed-off` while a hand-off of it waits to be accepted; in a program that changes only its
   * own session's part, `handed-to-here`, `handed-from-here`, `handed-elsewhere` or `of-another-session` (tasksOf).
   */
  readonly state: string;
  readonly title: string;
  readonly task: string;
  readonly session: string;
  readonly sessionTitle: string;
  readonly status: string;
  readonly waitsOn: readonly string[];
  readonly handoff?: { readonly id: string; readonly to: string; readonly reason: string; readonly was: string } | undefined;
}

interface HostedItem extends PlaceItem {
  readonly state: 'idle' | 'running';
  readonly title: string;
  readonly workspace: string;
  readonly joinedBy: readonly string[];
  readonly turns: number;
  readonly messages: number;
  readonly onLeave: string;
  readonly model: string;
  readonly from: string;
}

interface JoinedItem extends PlaceItem {
  /** `running-tool` while the session runs a tool (its own events say so), else `joined`. */
  readonly state: 'joined' | 'running-tool';
  readonly title: string;
  readonly lines: readonly string[];
  readonly runningTool?: string | undefined;
}

type Item = SessionItem | BranchItem | RecordItem | TaskItem | HostedItem | JoinedItem;

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const time = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
const record = (value: unknown): Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Text that came from a file or another process, with control characters taken out before it is drawn. */
// eslint-disable-next-line no-control-regex
const plain = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();

/** What a saved session was doing when it was left, from its return context. */
function leftWith(context: unknown): string | undefined {
  const left = record(context);
  const parts = [
    count(left.activeTasks) ? plural(count(left.activeTasks), 'task') + ' running' : '',
    count(left.blockedTasks) ? plural(count(left.blockedTasks), 'task') + ' blocked' : '',
    count(left.pendingApprovals) ? plural(count(left.pendingApprovals), 'approval') + ' waiting' : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * The program's `sessions` source: `{ current: { id, title, messages, model, provider }, saved: SessionInfo[] }`
 * (sessions-sources.ts). The open conversation is first; a saved file of it is not listed twice.
 */
function sessionsOf(raw: unknown): readonly SessionItem[] {
  const body = record(raw);
  const current = record(body.current);
  const currentId = text(current.id);
  const saved = Array.isArray(body.saved) ? body.saved.map(record) : [];
  const own = saved.find((info) => text(info.name) === currentId);
  const items: SessionItem[] = [];
  if (currentId) {
    items.push({
      id: currentId, state: 'current',
      title: plain(text(current.title)).replace(/^\(untitled\)$/, '') || 'This conversation',
      when: time(own?.timestamp), messages: count(current.messages),
      model: text(current.model), provider: text(current.provider), file: text(own?.filePath),
    });
  }
  for (const info of saved) {
    const id = text(info.name);
    if (!id || id === currentId) continue;
    const left = leftWith(info.returnContext);
    items.push({
      id, state: 'saved', title: plain(text(info.title)) || id,
      when: time(info.timestamp), messages: count(info.messageCount),
      model: text(info.model), provider: text(info.provider), file: text(info.filePath),
      ...(left ? { left } : {}),
    });
  }
  return items;
}

/** The program's `branches` source: `{ branches: [{ name, messageCount, isCurrent }] }`. */
function branchesOf(raw: unknown): readonly BranchItem[] {
  const branches = Array.isArray(record(raw).branches) ? (record(raw).branches as unknown[]).map(record) : [];
  return branches.filter((branch) => text(branch.name)).map((branch): BranchItem => ({
    id: text(branch.name), state: branch.isCurrent === true ? 'current' : 'other', messages: count(branch.messageCount),
  }));
}

/** The views of the open conversation's record, always there: each opens whole. */
const RECORD_VIEWS: readonly RecordItem[] = [
  { id: 'record:events', state: 'events', title: 'Every entry, newest page first', about: 'Messages, tool calls, approvals and notices, one entry per line.' },
  { id: 'record:groups', state: 'groups', title: 'Turn by turn', about: 'The record grouped by turn, newest page first.' },
  { id: 'record:hotspots', state: 'hotspots', title: 'Where it spent most', about: 'The whole record counted by what took the most entries.' },
  { id: 'record:restored', state: 'restored', title: 'What the last resume brought back', about: 'The approvals, tasks, remote state and notices a resume restored.' },
];

/** The program's `record` source: `{ bookmarks: [{ key, label, timestamp }] }`; the views come first. */
function recordOf(raw: unknown): readonly RecordItem[] {
  const bookmarks = Array.isArray(record(raw).bookmarks) ? (record(raw).bookmarks as unknown[]).map(record) : [];
  return [
    ...RECORD_VIEWS,
    ...bookmarks.filter((mark) => text(mark.key)).map((mark): RecordItem => ({
      // The label starts with the block's kind as stored (`assistant_turn: `): the row says it in words after it.
      id: text(mark.key), state: 'bookmark', title: plain(text(mark.label)).replace(/^[a-z]+(?:_[a-z]+)+:\s*/, '') || 'A bookmarked block',
      about: 'A block you bookmarked in this conversation.', when: time(mark.timestamp),
    })),
  ];
}

/**
 * The program's `task-graph` source: the graph's snapshot (`refs`, `edges`, `handoffs`) with `titles` (a session's
 * title by its id, where this program knows it). Every task once, with the hand-off waiting on it.
 */
function tasksOf(raw: unknown): readonly TaskItem[] {
  const body = record(raw);
  const titles = record(body.titles);
  const refs = Object.values(record(body.refs)).map(record);
  const edges = Array.isArray(body.edges) ? body.edges.map(record) : [];
  const handoffs = Array.isArray(body.handoffs) ? body.handoffs.map(record) : [];
  const titleOf = (session: string): string => plain(text(titles[session])) || session;
  // A program that changes only its own session's part (the Agent) shows controls only there: a hand-off to this
  // session (`handed-to-here`: accept), one from it (`handed-from-here`: take back, cancel), its own open tasks.
  const here = text(body.here);
  const ownOnly = body.ownTasksOnly === true;
  const stateOf = (session: string, status: string, waiting: Readonly<Record<string, unknown>> | undefined): string => {
    if (!ownOnly) return waiting ? 'handed-off' : status;
    if (waiting) return text(waiting.toSessionId) === here ? 'handed-to-here' : session === here ? 'handed-from-here' : 'handed-elsewhere';
    return session === here ? status : 'of-another-session';
  };
  return refs.filter((ref) => text(ref.sessionId) && text(ref.taskId)).map((ref): TaskItem => {
    const session = text(ref.sessionId);
    const task = text(ref.taskId);
    const waiting = handoffs.find((handoff) => handoff.acknowledged !== true && text(record(handoff.taskRef).sessionId) === session && text(record(handoff.taskRef).taskId) === task);
    const waitsOn = edges.filter((edge) => text(record(edge.fromRef).sessionId) === session && text(record(edge.fromRef).taskId) === task)
      .map((edge) => `${text(record(edge.toRef).taskId)} (${titleOf(text(record(edge.toRef).sessionId))})`);
    return {
      // Not the session's id first: the place names an item by its title wherever a word starts its id.
      id: `task ${task} of ${session}`, state: stateOf(session, text(ref.status) || 'queued', waiting),
      title: plain(text(ref.label) || text(ref.title)) || task, task, session, sessionTitle: titleOf(session), status: text(ref.status), waitsOn,
      // A hand-off to the session open here says so in two words, so the row's "to ..." is shown whole at 80 columns.
      ...(waiting ? { handoff: { id: text(waiting.handoffId), to: here !== '' && text(waiting.toSessionId) === here ? 'this conversation' : titleOf(text(waiting.toSessionId)), reason: plain(text(waiting.reason)), was: text(waiting.previousStatus) || 'queued' } } : {}),
    };
  });
}

/** What leaving does, from the record's effective policy. */
function onLeaveOf(session: Readonly<Record<string, unknown>>): string {
  return text(session.effectiveDetachPolicy) === 'survive'
    ? 'it keeps running when the last one leaves, and can be joined again'
    : 'it ends when the last one leaves';
}

/** `sessions.hosted.list`: the live ones (ended ones are not asked for). */
function hostedOf(output: unknown): readonly HostedItem[] {
  const sessions = Array.isArray(record(output).sessions) ? (record(output).sessions as unknown[]).map(record) : [];
  return sessions.filter((session) => text(session.id) && (session.status === 'idle' || session.status === 'running')).map((session): HostedItem => ({
    id: text(session.id),
    state: session.status === 'running' ? 'running' : 'idle',
    title: plain(text(session.title)) || 'Untitled hosted session',
    workspace: text(session.workspaceRoot),
    joinedBy: Array.isArray(session.attachedClients) ? session.attachedClients.filter((client): client is string => typeof client === 'string') : [],
    turns: count(session.turnCount), messages: count(session.messageCount),
    onLeave: onLeaveOf(session), model: text(session.modelId), from: text(session.originSurface),
  }));
}

/** The program's `hosted-joined` source: `{ id, title, lines }` for the session this terminal joined, or nothing. */
function joinedOf(raw: unknown): readonly JoinedItem[] {
  const joined = record(raw);
  const id = text(joined.id);
  if (!id) return [];
  const lines = Array.isArray(joined.lines) ? joined.lines.filter((line): line is string => typeof line === 'string').map(plain) : [];
  const runningTool = plain(text(joined.runningTool));
  return [{ id, state: runningTool ? 'running-tool' : 'joined', title: plain(text(joined.title)) || id, lines, ...(runningTool ? { runningTool } : {}) }];
}

/** The model as a person reads it: once, with its provider when the model's own name does not already carry it. */
function modelWords(session: SessionItem): string {
  if (!session.provider || session.model.startsWith(`${session.provider}:`)) return session.model;
  return `${session.model} (${session.provider})`;
}

function when(at: number | undefined): string {
  return at === undefined ? 'not saved yet' : new Date(at).toLocaleString();
}

const FROM_WORDS: Readonly<Record<string, string>> = { tui: 'the terminal app', agent: 'the Agent', webui: 'the web UI' };

/** The hosted lifecycle (created, joined, left, ended, a turn ended) on the daemon's session domain. */
const HOSTED_EVENTS = { domains: ['session'], events: ['hosted-session-update'] } as const;
/**
 * The daemon's session list: every terminal program tells the daemon when a session exists, closes and what was
 * typed into it, so a session saved or written into by another terminal reads the saved sessions again.
 */
const SESSION_LIST_EVENTS = { domains: ['session'], events: ['session-update'] } as const;

/** A task that can still be handed off or cancelled: not ended, and no hand-off of it waiting. */
const OPEN_TASK = ['queued', 'running', 'blocked'];

export const SESSIONS_PLACE = definePlace<Item>({
  id: 'sessions',
  group: 'sessions',
  title: 'Sessions',
  lists: [
    {
      id: 'sessions',
      label: 'Sessions',
      noun: 'your saved sessions',
      source: { kind: 'session', name: 'sessions', items: sessionsOf },
      follows: SESSION_LIST_EVENTS,
      search: { key: 's', label: 'search them' },
      empty: 'No conversation yet.',
      row: (item) => {
        const session = item as SessionItem;
        return {
          title: session.title,
          right: session.state === 'current' ? 'open here' : plural(session.messages, 'message'),
          mark: session.state === 'current' ? 'running' : session.left ? 'attention' : 'ok',
        };
      },
      detail: (item) => {
        const session = item as SessionItem;
        return [
          { label: session.state === 'current' ? 'Saved' : 'Last saved', text: when(session.when) },
          { label: 'Messages', text: String(session.messages) },
          ...(session.model ? [{ label: 'Model', text: modelWords(session) }] : []),
          ...(session.left ? [{ label: 'Left with', text: session.left, tone: 'warning' as const }] : []),
          ...(session.file ? [{ label: 'File', text: session.file, tone: 'muted' as const }] : []),
          { label: 'Id', text: session.id, tone: 'muted' as const },
        ];
      },
    },
    {
      id: 'branches',
      label: 'Branches',
      noun: 'this conversation\'s branches',
      source: { kind: 'session', name: 'branches', items: branchesOf },
      empty: 'This conversation has no branches.',
      row: (item) => {
        const branch = item as BranchItem;
        return { title: branch.id, right: branch.state === 'current' ? 'you are here' : plural(branch.messages, 'message'), mark: branch.state === 'current' ? 'running' : 'ok' };
      },
      detail: (item) => {
        const branch = item as BranchItem;
        return [
          { label: 'Messages', text: String(branch.messages) },
          { text: branch.state === 'current' ? 'The conversation goes on from this branch.' : 'Switch to go on from here, or bring in the messages it gained after it was made.', tone: 'muted' as const },
        ];
      },
    },
    {
      id: 'record',
      label: 'Record',
      noun: 'this conversation\'s record',
      source: { kind: 'session', name: 'record', items: recordOf },
      empty: 'This conversation has no record yet.',
      row: (item) => {
        const entry = item as RecordItem;
        return entry.state === 'bookmark'
          ? { title: entry.title, right: entry.when === undefined ? 'bookmark' : new Date(entry.when).toLocaleTimeString(), mark: 'ok' }
          : { title: entry.title };
      },
      detail: (item) => {
        const entry = item as RecordItem;
        return [{ text: entry.about }, ...(entry.state === 'bookmark' ? [{ text: 'Enter moves the conversation to it; Esc then shows it.', tone: 'muted' as const }] : [])];
      },
    },
    {
      id: 'handoffs',
      label: 'Hand-offs',
      noun: 'the cross-session task graph',
      source: { kind: 'session', name: 'task-graph', items: tasksOf },
      empty: 'No task is linked across sessions in this project.',
      row: (item) => {
        const task = item as TaskItem;
        return {
          title: task.title,
          right: task.handoff ? `to ${task.handoff.to}` : task.status,
          mark: task.handoff ? 'waiting' : task.status === 'running' ? 'running' : task.status === 'blocked' ? 'attention' : task.status === 'queued' ? 'ok' : 'paused',
        };
      },
      detail: (item) => {
        const task = item as TaskItem;
        return [
          { label: 'Task', text: task.task },
          { label: 'In session', text: task.sessionTitle },
          { label: 'State', text: task.handoff ? `handed off, blocked until it is accepted (it was ${task.handoff.was})` : task.status },
          ...(task.waitsOn.length > 0 ? [{ label: 'Waits on', text: task.waitsOn.join(', ') }] : []),
          ...(task.handoff ? [{ label: 'Handed to', text: task.handoff.to }, ...(task.handoff.reason ? [{ label: 'Why', text: task.handoff.reason }] : [])] : []),
        ];
      },
    },
    {
      id: 'hosted',
      label: 'Hosted',
      noun: 'the daemon\'s hosted sessions',
      source: { kind: 'daemon', method: 'sessions.hosted.list', input: {}, items: hostedOf },
      follows: HOSTED_EVENTS,
      empty: 'The daemon is running no conversation of its own.',
      row: (item) => {
        const hosted = item as HostedItem;
        return { title: hosted.title, right: hosted.state === 'running' ? 'running a turn' : hosted.joinedBy.length > 0 ? 'joined' : 'idle', mark: hosted.state === 'running' ? 'running' : 'ok' };
      },
      detail: (item) => {
        const hosted = item as HostedItem;
        return [
          { label: 'Folder', text: hosted.workspace },
          { label: 'Joined by', text: hosted.joinedBy.length > 0 ? hosted.joinedBy.join(', ') : 'nobody' },
          { label: 'So far', text: `${plural(hosted.turns, 'turn')}, ${plural(hosted.messages, 'message')}` },
          { label: 'When everyone leaves', text: hosted.onLeave },
          ...(hosted.model ? [{ label: 'Model', text: hosted.model }] : []),
          ...(FROM_WORDS[hosted.from] ? [{ label: 'Started for', text: FROM_WORDS[hosted.from]! }] : []),
        ];
      },
    },
    {
      id: 'joined',
      label: 'Joined here',
      noun: 'the hosted session this terminal joined',
      source: { kind: 'session', name: 'hosted-joined', items: joinedOf },
      empty: 'This terminal has joined no hosted session.',
      row: (item) => ({ title: (item as JoinedItem).title, right: (item as JoinedItem).runningTool ? `running ${(item as JoinedItem).runningTool}` : 'joined', mark: 'running' }),
      detail: (item) => (item as JoinedItem).lines.map((line) => ({ text: line })),
    },
  ],
  actions: [
    { key: 'h', id: 'start-hosted', capability: 'hosted.new', label: 'start a hosted session' },
    { key: 'enter', list: 'sessions', states: ['saved'], capability: 'session.resume', label: 'resume here', fill: { session: 'id' } },
    { key: 'w', list: 'sessions', capability: 'session.save-saved', label: 'write to a file', fill: { session: 'id' } },
    { key: 'e', list: 'sessions', capability: 'session.rename', label: 'rename', fill: { session: 'id' } },
    { key: 'f', list: 'sessions', states: ['current'], capability: 'session.fork', label: 'continue in a copy' },
    { key: 'u', list: 'sessions', states: ['current'], capability: 'session.upload', label: 'upload for a link' },
    { key: 'x', list: 'sessions', states: ['saved'], capability: 'session.delete', label: 'delete', fill: { session: 'id' } },
    { key: 'enter', list: 'branches', states: ['other'], capability: 'session.switch-branch', label: 'switch to it', fill: { branch: 'id' } },
    { key: 'm', list: 'branches', states: ['other'], capability: 'session.merge-branch', label: 'bring its messages in', fill: { branch: 'id' } },
    { key: 'enter', list: 'record', states: ['events'], capability: 'session.events', label: 'open it' },
    { key: 'enter', list: 'record', states: ['groups'], capability: 'session.groups', label: 'open it' },
    { key: 'enter', list: 'record', states: ['hotspots'], capability: 'session.hotspots', label: 'open it' },
    { key: 'enter', list: 'record', states: ['restored'], capability: 'session.restored', label: 'open it' },
    { key: 'enter', list: 'record', states: ['bookmark'], capability: 'session.bookmarks', label: 'go to it', fill: { block: 'id' } },
    { key: 'g', id: 'see-graph', list: 'handoffs', whole: true, capability: 'session.graph', label: 'see the whole graph' },
    { key: 'n', id: 'add-task', list: 'handoffs', whole: true, capability: 'session.link-task', label: 'add a task' },
    { key: 'o', id: 'hand-off', list: 'handoffs', states: OPEN_TASK, capability: 'session.hand-off', label: 'hand it to another session', fill: { task: 'task', from: 'session' } },
    { key: 'a', id: 'accept', list: 'handoffs', states: ['handed-off', 'handed-to-here'], capability: 'session.accept', label: 'accept it', fill: { handoff: (item) => (item as TaskItem).handoff?.id ?? '' } },
    { key: 'w', id: 'take-back', list: 'handoffs', states: ['handed-off', 'handed-from-here'], capability: 'session.withdraw', label: 'take it back', fill: { handoff: (item) => (item as TaskItem).handoff?.id ?? '' } },
    { key: 'x', id: 'cancel-task', list: 'handoffs', states: [...OPEN_TASK, 'handed-off', 'handed-from-here'], capability: 'session.cancel', label: 'cancel it', fill: { task: 'task', from: 'session' } },
    { key: 'enter', list: 'hosted', capability: 'hosted.attach', label: 'join', fill: { session: 'id' } },
    { key: 'x', list: 'hosted', capability: 'hosted.end', label: 'end', fill: { session: 'id' } },
    { key: 't', list: 'joined', capability: 'hosted.send', label: 'send a message now' },
    { key: 'l', list: 'joined', capability: 'hosted.leave', label: 'leave' },
    // Tools and extensions (builtin/tools-extras.ts): the tool running in the joined session, stopped; the turn goes on.
    // Shown only while the session runs a tool (the item's state, from the session's own events).
    { key: 'k', list: 'joined', states: ['running-tool'], capability: 'hosted.stop-tool', label: 'stop the running tool' },
  ],
  count: (lists) => {
    const left = (lists.sessions ?? []).filter((item) => (item as SessionItem).left !== undefined).length;
    return left > 0 ? { count: left, words: `${left} left with work open`, tone: 'waiting' } : undefined;
  },
});

// ---------------------------------------------------------------------------
// Moving through the conversation: keys read while writing a message
// ---------------------------------------------------------------------------

/** The key context of moving through the open conversation (`place.conversation-view.<entry>` in keybindings.json). */
export const SESSIONS_VIEW_KEYS = 'place.conversation-view';

/**
 * Each entry with the capability it runs. Ctrl+E (`next-error-line-end`) stays the program's key for the next error;
 * these have no key until a person binds one in the Keys place (none had one before).
 */
const VIEW_KEYS: readonly { readonly name: string; readonly description: string; readonly capability: string; readonly values: Readonly<Record<string, string>> }[] = [
  { name: 'next-entry', description: 'move the conversation to the next entry', capability: 'session.next', values: { kind: 'all' } },
  { name: 'previous-entry', description: 'move the conversation to the previous entry', capability: 'session.prev', values: { kind: 'all' } },
  { name: 'previous-error', description: 'move the conversation to the previous error', capability: 'session.prev', values: { kind: 'error' } },
  { name: 'composer', description: 'say what the message box waits on', capability: 'session.composer', values: {} },
];

/** The conversation's movement keys as a context of the key table, read while writing a message. */
export function sessionsViewKeyContext(): KeyContext {
  return {
    id: SESSIONS_VIEW_KEYS,
    title: 'Moving through this conversation, while writing a message',
    global: true,
    actions: VIEW_KEYS.map((entry) => ({ name: entry.name, description: entry.description, defaults: [] })),
  };
}

/**
 * Run what a movement key names (`place.conversation-view.next-entry`): its capability, the outcome said in the
 * conversation when it has words (moving says nothing; a failure says why). False when the key is not one of these.
 */
export function runSessionsViewKey(host: PlaceHost, action: string, say: (line: string) => void): boolean {
  if (!action.startsWith(`${SESSIONS_VIEW_KEYS}.`)) return false;
  const entry = VIEW_KEYS.find((candidate) => candidate.name === action.slice(SESSIONS_VIEW_KEYS.length + 1));
  if (!entry) return true;
  void host.runCapability(entry.capability, entry.values).then((outcome) => {
    if (!outcome.ok) say(`Not moved: ${outcome.reason}`);
    else if (outcome.lines.length > 0) say(outcome.lines.join('\n'));
    host.requestRender();
  });
  return true;
}
