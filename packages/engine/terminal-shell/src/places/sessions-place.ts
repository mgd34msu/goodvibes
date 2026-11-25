/**
 * sessions-place.ts, the Sessions place: your conversations.
 *
 * Four lists. Sessions: this conversation and the ones saved in this project,
 * read from the program holding the conversation (they are its own files,
 * `<project>/.goodvibes/<program>/sessions/`); resume, write out, rename,
 * copy, upload and delete are controls on the session they act on. Branches:
 * this conversation's branches, switched to or brought in. Hosted: the
 * conversations the daemon runs, read from the daemon and following its
 * hosted-session events, so one started, joined, left or ended anywhere shows
 * here with no key pressed. Joined here: the hosted session this terminal
 * joined, with sending to it and leaving it. Every action is a capability;
 * only those that apply to the selected item in its state are on the hint row.
 */
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
  readonly state: 'joined';
  readonly title: string;
  readonly lines: readonly string[];
}

type Item = SessionItem | BranchItem | HostedItem | JoinedItem;

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
  return [{ id, state: 'joined', title: plain(text(joined.title)) || id, lines }];
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
      row: (item) => ({ title: (item as JoinedItem).title, right: 'joined', mark: 'running' }),
      detail: (item) => (item as JoinedItem).lines.map((line) => ({ text: line })),
    },
  ],
  actions: [
    { key: 's', id: 'search', capability: 'session.search', label: 'search saved sessions' },
    { key: 'h', id: 'start-hosted', capability: 'hosted.new', label: 'start a hosted session' },
    { key: 'enter', list: 'sessions', states: ['saved'], capability: 'session.resume', label: 'resume here', fill: { session: 'id' } },
    { key: 'w', list: 'sessions', capability: 'session.save-saved', label: 'write to a file', fill: { session: 'id' } },
    { key: 'e', list: 'sessions', states: ['current'], capability: 'session.rename', label: 'rename' },
    { key: 'f', list: 'sessions', states: ['current'], capability: 'session.fork', label: 'continue in a copy' },
    { key: 'u', list: 'sessions', states: ['current'], capability: 'session.upload', label: 'upload for a link' },
    { key: 'x', list: 'sessions', states: ['saved'], capability: 'session.delete', label: 'delete', fill: { session: 'id' } },
    { key: 'enter', list: 'branches', states: ['other'], capability: 'session.switch-branch', label: 'switch to it', fill: { branch: 'id' } },
    { key: 'm', list: 'branches', states: ['other'], capability: 'session.merge-branch', label: 'bring its messages in', fill: { branch: 'id' } },
    { key: 'enter', list: 'hosted', capability: 'hosted.attach', label: 'join', fill: { session: 'id' } },
    { key: 'x', list: 'hosted', capability: 'hosted.end', label: 'end', fill: { session: 'id' } },
    { key: 't', list: 'joined', capability: 'hosted.send', label: 'send a message now' },
    { key: 'l', list: 'joined', capability: 'hosted.leave', label: 'leave' },
  ],
  count: (lists) => {
    const left = (lists.sessions ?? []).filter((item) => (item as SessionItem).left !== undefined).length;
    return left > 0 ? { count: left, words: `${left} left with work open`, tone: 'waiting' } : undefined;
  },
});
