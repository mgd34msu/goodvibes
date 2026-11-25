/**
 * Handing coding work to the terminal app (capabilities/builtin/handed-off.ts),
 * done by the daemon: a shared session on the daemon's own session broker, the
 * work as its first message (asking before it changes anything), and the
 * record of the hand-off in the daemon's store, `<daemon home>/handed-off.json`.
 *
 * Until this version the Agent kept the records in its own home
 * (`~/.goodvibes/agent/delegations/delegations.json`). At the daemon's first
 * start of this version every record there that the daemon's store does not
 * hold is carried in, once (a record of the carry beside the store,
 * `handed-off-carried.json`, makes it once). The Agent's file is never
 * written, so a 3.5.0 Agent after a rollback still lists every hand-off it
 * made; one it makes then stays in its own file.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CapabilityRefusal } from '@goodvibes/engine/platform/platform/capabilities';
import type { SharedSessionBroker, SharedSessionParticipant } from '@goodvibes/engine/platform/platform/control-plane';
import { noteListChanged } from '@goodvibes/engine/platform/platform/runtime/emitters';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { logger } from '@goodvibes/engine/platform/platform/utils';
import { readJsonStore, updateJsonStore, type JsonStoreSpec } from './store-file.js';
import type { StoreAct } from './agent-store-common.js';

/** One hand-off: the shared session it went to and the input that carries it. */
export interface HandedOffRecord {
  readonly sessionId: string;
  readonly task: string;
  readonly createdAt: string;
  readonly inputId?: string | undefined;
  readonly reviewRequested: boolean;
}

/** The session broker's part a hand-off uses. */
export type HandOffSessions = Pick<SharedSessionBroker, 'ensureSession' | 'submitMessage' | 'getSession' | 'getInputs' | 'getMessages' | 'closeSession' | 'deleteSession'>;

/** Older hand-offs drop off the list; their sessions stay on the daemon. */
const MAX_HANDED_OFF = 200;

function parseRecord(value: unknown): HandedOffRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const sessionId = typeof entry['sessionId'] === 'string' ? entry['sessionId'].trim() : '';
  const createdAt = typeof entry['createdAt'] === 'string' ? entry['createdAt'] : '';
  if (!sessionId || !createdAt) return null;
  const inputId = typeof entry['inputId'] === 'string' && entry['inputId'].trim() ? entry['inputId'].trim() : undefined;
  return { sessionId, task: typeof entry['task'] === 'string' ? entry['task'] : '', createdAt, ...(inputId ? { inputId } : {}), reviewRequested: entry['reviewRequested'] === true };
}

/** The same shape the Agent's file has, so its records are read as they are. */
const HANDED_OFF_STORE: JsonStoreSpec<HandedOffRecord> = { label: 'hand-off list', entriesKey: 'delegations', version: 1, parseEntry: parseRecord };

export function handedOffStorePath(daemonHome: string): string {
  return join(daemonHome, 'handed-off.json');
}

/** The Agent's own record of its hand-offs before this version. */
export function agentHandOffStorePath(homeDirectory: string): string {
  return join(homeDirectory, '.goodvibes', 'agent', 'delegations', 'delegations.json');
}

/** Newest first. */
export function listHandedOff(daemonHome: string): readonly HandedOffRecord[] {
  return [...readJsonStore(handedOffStorePath(daemonHome), HANDED_OFF_STORE).entries].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function recordHandedOff(daemonHome: string, entry: HandedOffRecord): void {
  updateJsonStore(handedOffStorePath(daemonHome), HANDED_OFF_STORE, (store) => {
    const kept = store.entries.filter((existing) => existing.sessionId !== entry.sessionId);
    return { value: undefined, entries: [...kept, entry].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(-MAX_HANDED_OFF) };
  });
}

/**
 * Carry the Agent's hand-off records into the daemon's store, once. Answers how many were carried, or undefined when
 * it ran before or the Agent kept none. A record the daemon's store already holds (same session) is kept as it is.
 */
export function carryAgentHandOffsOnce(input: { readonly homeDirectory: string; readonly daemonHome: string }): number | undefined {
  const done = join(input.daemonHome, 'handed-off-carried.json');
  const from = agentHandOffStorePath(input.homeDirectory);
  if (existsSync(done) || !existsSync(from)) return undefined;
  try {
    const theirs = readJsonStore(from, HANDED_OFF_STORE).entries;
    let carried = 0;
    updateJsonStore(handedOffStorePath(input.daemonHome), HANDED_OFF_STORE, (store) => {
      const have = new Set(store.entries.map((entry) => entry.sessionId));
      const added = theirs.filter((entry) => !have.has(entry.sessionId));
      carried = added.length;
      return { value: undefined, entries: [...store.entries, ...added].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(-MAX_HANDED_OFF) };
    });
    writeFileSync(done, `${JSON.stringify({ version: 1, at: new Date().toISOString(), from, carried }, null, 2)}\n`, { mode: 0o600 });
    if (carried > 0) noteListChanged({ list: 'handed-off', change: 'created' });
    return carried;
  } catch (error) {
    // Not marked done: the next start tries again, and the Agent's file is untouched either way.
    logger.warn('[agents] the Agent\'s hand-offs could not be carried into the daemon\'s store; they stay in the Agent\'s file', { error: summarizeError(error) });
    return undefined;
  }
}

/** Where a hand-off stands, in words. */
const STATE_WORDS: Readonly<Record<string, string>> = {
  queued: 'it is waiting for the terminal app to take it', delivered: 'the terminal app has taken it', running: 'the terminal app is working on it',
  failed: 'it failed', cancelled: 'it was stopped', unreadable: 'its session could not be read', unknown: 'where it stands is not known',
  active: 'its session is open', closed: 'its session is closed', gone: 'its session no longer exists on the daemon',
};

function excerpt(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function body(values: Readonly<Record<string, string>>): string {
  const review = values['review'] === 'yes';
  return [
    'GoodVibes Agent explicit build delegation.', '',
    'Original user ask', values['task'] ?? '', '',
    'Delegation reason', values['reason'] || '(not supplied)', '',
    'Success criteria or expected evidence', values['success'] || '(not supplied)', '',
    'Workspace or worktree hint', values['workspace'] || '(not supplied)', '',
    'Priority or deadline', values['priority'] || '(not supplied)', '',
    'Agent policy',
    '- GoodVibes Agent is not the coding TUI.',
    '- Preserve the full original ask.',
    '- GoodVibes TUI owns file edits, git/worktree flows, execution isolation UX, and any delegated review owner chain.',
    review
      ? '- Delegated review was explicitly requested by the Agent user for this build/fix/review handoff.'
      : '- Delegated review was not explicitly requested; do not add review solely because this came from Agent.',
  ].join('\n');
}

/** A hand-off as facts, with its session's state when the session can be read. */
function handOffFacts(entry: HandedOffRecord, sessions: HandOffSessions | undefined) {
  const base = { id: entry.sessionId, sessionId: entry.sessionId, task: entry.task, createdAt: entry.createdAt, reviewRequested: entry.reviewRequested };
  if (!sessions) return { ...base, state: 'unknown' };
  try {
    const session = sessions.getSession(entry.sessionId);
    if (!session) return { ...base, state: 'gone' };
    const inputs = sessions.getInputs(entry.sessionId, 50);
    const input = (entry.inputId ? inputs.find((candidate) => candidate.id === entry.inputId) : undefined) ?? inputs[inputs.length - 1];
    const answer = [...sessions.getMessages(entry.sessionId, 100)].reverse().find((message) => message.role === 'assistant');
    return {
      ...base, state: answer ? 'answered' : input?.state ?? session.status, session: session.status, ...(session.title ? { title: session.title } : {}),
      ...(input ? { input: input.state, ...(input.error ? { inputError: input.error } : {}) } : {}),
      ...(answer ? { answer: excerpt(answer.body), answeredAt: new Date(answer.createdAt).toISOString() } : {}),
    };
  } catch (error) {
    return { ...base, state: 'unreadable', error: summarizeError(error) };
  }
}

/** The acts, over the daemon's session broker and its home. */
export function handOffActs(deps: { readonly sessions?: HandOffSessions | undefined; readonly daemonHome: string }): Readonly<Record<string, StoreAct>> {
  return {
    async 'agents.hand-off'(values, context) {
      const sessions = deps.sessions;
      if (!sessions) throw new CapabilityRefusal('The work was not handed off: this daemon has no shared sessions to hand it to.', 'Start the GoodVibes daemon that came with this version.');
      const task = (values.task ?? '').trim();
      if (!task) throw new CapabilityRefusal('The work was not handed off: say what to build, fix or review.');
      const title = `Agent delegation: ${task.slice(0, 72)}`;
      const participant = { surfaceKind: 'service', surfaceId: 'goodvibes-agent', externalId: 'goodvibes-agent', displayName: 'GoodVibes Agent', lastSeenAt: Date.now() } satisfies SharedSessionParticipant;
      const metadata = {
        originSurface: 'goodvibes-agent', task, reviewRequested: values.review === 'yes', wrfcRequested: values.review === 'yes',
        delegationReason: values.reason ?? '', successCriteria: values.success ?? '', workspaceHint: values.workspace ?? '', priority: values.priority ?? '',
        ...(context.shellPaths.workingDirectory ? { projectRoot: context.shellPaths.workingDirectory } : {}),
      };
      let created: string | undefined;
      try {
        const session = await sessions.ensureSession({ title, participant, metadata });
        created = session.id;
        const submission = await sessions.submitMessage({
          sessionId: session.id, providerMessageId: `agent-delegation:${randomUUID()}`, body: body(values),
          surfaceKind: participant.surfaceKind, surfaceId: participant.surfaceId, externalId: participant.externalId, displayName: participant.displayName,
          title, metadata: { ...metadata, kind: 'task' },
          routing: { executionIntent: { riskClass: 'elevated', requiresApproval: true, networkPolicy: 'inherit', filesystemPolicy: 'workspace-write' } },
        });
        created = undefined;
        const inputId = (submission as { readonly input?: { readonly id?: string } }).input?.id;
        const record: HandedOffRecord = { sessionId: session.id, task, createdAt: new Date().toISOString(), ...(inputId ? { inputId } : {}), reviewRequested: values.review === 'yes' };
        let kept = 'It is kept in Handed off, in the Work place, with its progress and answer.';
        try {
          recordHandedOff(deps.daemonHome, record);
          noteListChanged({ list: 'handed-off', change: 'created', id: session.id });
        } catch (error) {
          kept = `It could not be kept in Handed off (${summarizeError(error)}); its session is ${session.id}.`;
        }
        return {
          text: [`Handed to the terminal app as a shared session${values.review === 'yes' ? ', with review asked for' : ''}: "${excerpt(task, 120)}".`, kept].join('\n'),
          data: { handedOff: handOffFacts(record, sessions) },
        };
      } catch (error) {
        let cleanup = '';
        if (created) {
          try {
            await sessions.closeSession(created);
            const removed = await sessions.deleteSession(created);
            cleanup = removed === 'deleted' || removed === 'not-found' ? ' The empty session it had made was removed.' : ` The empty session ${created} it had made is left (${removed}).`;
          } catch (cause) {
            cleanup = ` The empty session ${created} it had made is left: removing it failed (${summarizeError(cause)}).`;
          }
        }
        if (error instanceof CapabilityRefusal) throw error;
        throw new CapabilityRefusal(`The work was not handed off: ${summarizeError(error)}.${cleanup}`, 'Hand it off again with the same words.');
      }
    },
    async 'agents.handed-off'(values) {
      let all: readonly HandedOffRecord[];
      try { all = listHandedOff(deps.daemonHome); } catch (error) {
        throw new CapabilityRefusal(`The hand-offs could not be read: ${summarizeError(error)}.`, undefined, 'UNAVAILABLE');
      }
      const wanted = (values.session ?? '').trim();
      if (wanted) {
        const exact = all.find((entry) => entry.sessionId === wanted);
        const matches = exact ? [exact] : all.filter((entry) => entry.sessionId.startsWith(wanted));
        if (matches.length !== 1) throw new CapabilityRefusal(`No hand-off has a session matching ${wanted}.`, 'Handed off, in the Work place, lists them.', 'NOT_FOUND');
        const facts = handOffFacts(matches[0]!, deps.sessions);
        const said = 'answer' in facts && facts.answer ? `its latest answer: ${facts.answer}` : facts.state === 'gone' ? 'its session no longer exists on the daemon' : (STATE_WORDS[facts.state] ?? `its session is ${facts.state}`);
        return { text: `"${excerpt(facts.task, 120)}", handed off ${facts.createdAt.slice(0, 16).replace('T', ' ')}: ${said}.`, data: { handedOff: [facts] } };
      }
      const facts = all.map((entry) => handOffFacts(entry, deps.sessions));
      if (facts.length === 0) return { text: 'No work handed off yet.', data: { handedOff: [] } };
      return {
        text: [`Work handed off (${facts.length}, newest first)`, ...facts.map((entry) => `  ${entry.createdAt.slice(0, 16).replace('T', ' ')}  ${excerpt(entry.task, 72)}  (${'answer' in entry && entry.answer ? 'answered' : STATE_WORDS[entry.state] ?? entry.state})`)].join('\n'),
        data: { handedOff: facts },
      };
    },
  };
}
