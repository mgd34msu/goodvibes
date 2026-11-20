/**
 * hosted-runtime.ts, `/hosted`, the front door to a conversation the DAEMON
 * runs, described once (command-actions/).
 *
 * Local sessions are unchanged and remain the default experience: a turn typed
 * into the composer runs in this process, exactly as it always has. `/hosted`
 * is the opt-in, it asks the daemon to compose the same loop on its side, so
 * the conversation does not depend on this window staying open.
 *
 * The actions: see the session you are in, start one, see them all, join one,
 * send a message now or after this turn, stop the tool that is running, leave
 * it, and end it (asks first). Sending, queueing and stopping a tool are
 * `sessions.steer`, `sessions.followUp` and `sessions.toolCalls.cancel`, which
 * resolve a hosted id daemon-side.
 */
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import {
  replaceHostedAttachment, detachHostedAttachments, forgetHostedAttachment, hasHostedAttachments,
  assertHostedBindingCurrent, currentHostedBinding, hostedAttachmentOrigin,
} from '../../runtime/client/hosted-attachments.ts';
import { describeOperatorRpcError } from '../../runtime/client/operator-endpoint.ts';
import { requireShellPaths } from '@goodvibes-jev/engine/terminal-shell/command-service-access';
import {
  createDaemonVerbCaller,
  pinDaemonVerbCaller,
  resolveDaemonEndpoint,
  type DaemonEndpoint,
} from '../../runtime/client/operator-endpoint.ts';
import type { SessionBinding } from '@goodvibes-jev/engine/platform/platform/runtime/client/session-binding';
import { formatRefusal, readRefusal } from '@goodvibes-jev/engine/errors';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { defineCommand, defineList, type CommandDescription, type ListRow } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import {
  createHostedSessionsClient,
  describeDetachEffect,
  hostedSessionLabel,
  type HostedDetachPolicy,
  type HostedSessionRecord,
  type HostedSessionsClient,
} from '../../runtime/client/hosted-sessions.ts';
import { newestHistoryTime, watchHostedSession, type HostedSessionSubscription } from '../../runtime/client/hosted-session-stream.ts';
import { getSharedHostedSessionFeed, type HostedSessionFeed } from '../../views/hosted-session-feed.ts';
import { getSharedHostedSessionRoster } from '../../runtime/client/hosted-roster.ts';

/** The last list this terminal printed, so `attach 2` means what the user just read. */
let lastListedIds: readonly string[] = [];

/** One row of `/hosted list`, in the record's own words. */
export function renderHostedRecordLine(record: HostedSessionRecord, index: number): string {
  const attached = record.attachedClients.length > 0 ? record.attachedClients.join(', ') : 'nobody';
  const ended = record.status === 'terminated'
    ? `: ended: ${record.terminatedReason ?? 'no reason recorded'}`
    : '';
  return [
    `  ${index + 1}. ${hostedSessionLabel(record)} [${record.status}]${ended}`,
    `     id ${record.id}`,
    `     ${describeDetachEffect(record)}`,
    `     ${record.turnCount} turn(s), ${record.messageCount} message(s); attached: ${attached}`,
  ].join('\n');
}

/** The status block `/hosted` with no arguments prints. */
export function renderHostedStatus(feed: HostedSessionFeed): string {
  const state = feed.getState();
  if (!state.record) {
    return [
      'No hosted session is attached in this terminal.',
      '  A hosted session runs inside the daemon, so it can outlive this window.',
      '  /hosted new [prompt]   start one and join it',
      '  /hosted list           see what already exists',
    ].join('\n');
  }
  const record = state.record;
  return [
    `Attached to ${hostedSessionLabel(record)} [${record.status}]`,
    `  id ${record.id}`,
    `  workspace ${record.workspaceRoot}`,
    `  ${describeDetachEffect(record)}`,
    `  ${record.turnCount} turn(s), ${record.messageCount} message(s)`,
    state.streaming
      ? '  live event stream open'
      : `  no live stream: ${state.streamNote ?? 'not subscribed'}`,
    state.runningToolCalls.length > 0
      ? `  running: ${state.runningToolCalls.map((call) => `${call.tool} (${call.callId})`).join(', ')}`
      : '  no tool call is running',
  ].join('\n');
}

interface HostedCommandSeams {
  readonly client: HostedSessionsClient;
  /** The daemon `client` calls (its origin), or null when none can be reached (each verb then says why). */
  readonly origin: string | null;
  /** Where the live stream is opened and its bearer, or why it cannot be: resolved when the stream opens. */
  readonly endpoint: () => Promise<DaemonEndpoint>;
}

/**
 * Resolve everything a `/hosted` subcommand needs, or refuse honestly.
 *
 * The verbs go through `createDaemonVerbCaller`; the stream needs the base
 * URL and bearer directly, and takes both from `resolveDaemonEndpoint`, the
 * resolver the verb caller uses, so the stream dials the same daemon with the
 * same credential (a connected daemon's stored token, an /accounts sign-in session,
 * GOODVIBES_DAEMON_TOKEN, or this machine's operator token for the local one).
 */
function resolveSeams(context: CommandContext): HostedCommandSeams | null {
  const configManager = context.platform.configManager;
  const homeDirectory = (): string => requireShellPaths(context).homeDirectory;
  // Pinned to the daemon selected now: an attachment made through it is released there later.
  const pinned = pinDaemonVerbCaller({ configManager, homeDirectory });
  const client = createHostedSessionsClient('caller' in pinned ? pinned.caller : createDaemonVerbCaller({ configManager, homeDirectory }));
  // An endpoint that cannot be resolved is a stream that cannot be opened; the
  // verbs report their own refusal, so this is not a refusal of the command.
  return { client, origin: 'caller' in pinned ? pinned.origin : null, endpoint: () => resolveDaemonEndpoint({ configManager, homeDirectory }) };
}

/**
 * Why an act on the attached session `sessionId` may not go to the daemon
 * selected now, or null: the attachment was made on another daemon (the
 * selection moved since), whose session id means nothing here.
 */
function attachmentElsewhere(feed: HostedSessionFeed, sessionId: string, seams: Pick<HostedCommandSeams, 'origin'>): string | null {
  const origin = hostedAttachmentOrigin(feed, sessionId);
  if (origin === undefined || seams.origin === null || origin === seams.origin) return null;
  return `hosted session ${sessionId} is on the daemon at ${origin}, and this terminal now talks to ${seams.origin}; nothing was sent. /hosted leave releases it there; join a session on ${seams.origin} to continue here.`;
}

/**
 * Steer the attached hosted session and report whether the daemon took it, so a
 * caller other than the command line (the Agents modal) never claims a send that
 * did not happen. The text goes through untouched.
 */
export async function sayToHosted(
  context: CommandContext,
  text: string,
  seams: Pick<HostedCommandSeams, 'client' | 'origin'> | null = resolveSeams(context),
  /** The attachment the text was written for (a draft opened in the Agents view); default: the one attached now. */
  binding: SessionBinding | null = null,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  const feed = getSharedHostedSessionFeed();
  const captured = binding ?? currentHostedBinding(feed);
  if (!captured) return { ok: false, error: 'no hosted session is joined here; /hosted attach <id> first.' };
  // A draft goes only to the session it was written for: an attach that completed meanwhile does not redirect it.
  try {
    assertHostedBindingCurrent(feed, captured, 'the message');
  } catch (error) {
    const refused = readRefusal(error);
    return { ok: false, error: refused ? formatRefusal(refused) : describeOperatorRpcError(error) };
  }
  if (!seams) return { ok: false, error: 'the daemon is not reachable from this terminal.' };
  const elsewhere = attachmentElsewhere(feed, captured.sessionId, seams);
  if (elsewhere) return { ok: false, error: elsewhere };
  try {
    await seams.client.steer(captured.sessionId, text);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeOperatorRpcError(error) };
  }
}

/** Open the live stream for the attached session, and say so in the feed either way. */
async function openStream(
  seams: HostedCommandSeams,
  sessionId: string,
  feed: HostedSessionFeed,
  signal: AbortSignal,
  notBefore: number,
): Promise<void> {
  // The feed owns the subscription handle: the exit path has to be able to
  // close it too, and it has no way to reach a variable in this module.
  feed.closeStream();
  const endpoint = await seams.endpoint();
  if (signal.aborted) return;
  if (!endpoint.available) {
    feed.setStreaming(false, `nothing can be watched live: ${endpoint.reason}`);
    return;
  }
  // The stream watches the daemon the session was attached on, never one selected since.
  if (seams.origin !== null && endpoint.baseUrl !== seams.origin) {
    feed.setStreaming(false, `nothing can be watched live: the session is on ${seams.origin} and this terminal now talks to ${endpoint.baseUrl}`);
    return;
  }
  const token = endpoint.token;
  const subscription: HostedSessionSubscription | null = await watchHostedSession({
    baseUrl: endpoint.baseUrl,
    sessionId,
    getAuthToken: () => token,
    signal,
    // The daemon replays its newest buffered frames to a new stream; the ones the
    // backfill already shows must not be appended a second time.
    notBefore,
    onEvent: (event) => { if (!signal.aborted) feed.apply(event); },
    onLifecycle: (update) => { if (!signal.aborted) feed.applyLifecycle(update); },
    onTerminate: (error) => {
      if (!signal.aborted) feed.setStreaming(false, `the event stream ended: ${describeOperatorRpcError(error)}`);
    },
  });
  if (signal.aborted) { subscription?.close(); return; }
  feed.bindStream(subscription ? () => subscription.close() : null);
  feed.setStreaming(
    subscription !== null,
    subscription === null ? 'the daemon would not open an event stream' : null,
  );
}

/** Attach to a session by id, backfill it, and start watching it. */
async function attachSession(
  seams: HostedCommandSeams,
  sessionId: string | (() => Promise<HostedSessionRecord>),
  feed: HostedSessionFeed,
  context: CommandContext,
): Promise<void> {
  if (seams.origin === null) throw new Error('no daemon can be reached from this terminal; /settings daemon shows the connection');
  const attachment = await replaceHostedAttachment(feed, seams.client, seams.origin, sessionId,
    (result, signal) => openStream(seams, result.session.id, feed, signal, result.historyAsOf ?? newestHistoryTime(result.history)));
  context.print([
    `[hosted] attached to ${hostedSessionLabel(attachment.session)} (${attachment.history.length} message(s) backfilled)`,
    `  ${describeDetachEffect(attachment.session)}`,
  ].join('\n'));
  context.openAgents?.({ hosted: true });
}

/** Turn `attach 2` into the id the user just read off `/hosted list`; only a plain number is a list number. */
function resolveIdArgument(argument: string): string {
  if (!/^\d+$/.test(argument)) return argument;
  const index = Number(argument);
  if (index >= 1 && index <= lastListedIds.length) {
    return lastListedIds[index - 1] as string;
  }
  return argument;
}

const HOSTED_SESSIONS = defineList<CommandContext>({
  name: 'hosted.sessions',
  async read(ctx) {
    const seams = resolveSeams(ctx);
    if (!seams) return [];
    const records = await seams.client.list({ includeTerminated: false });
    lastListedIds = records.map((record) => record.id);
    return records.map((record): ListRow => ({
      value: record.id, label: hostedSessionLabel(record), detail: describeDetachEffect(record),
      state: `${record.status}, ${record.attachedClients.length > 0 ? `joined by ${record.attachedClients.join(', ')}` : 'nobody joined'}`,
    }));
  },
  operator: { method: 'sessions.hosted.list', input: {}, rows: { from: 'sessions', value: 'id', label: 'title', state: 'status' } },
});

const RUNNING_TOOLS = defineList<CommandContext>({
  name: 'hosted.running-tools',
  async read() {
    return getSharedHostedSessionFeed().getState().runningToolCalls.map((call): ListRow => ({ value: call.callId, label: call.tool, detail: call.callId }));
  },
  operator: { terminalOnly: 'The running tools are those of the session this terminal joined.' },
});

/** The joined session and the daemon to reach it on, or a refusal saying why not. */
function joined(ctx: CommandContext, what: string): { readonly seams: HostedCommandSeams; readonly sessionId: string } {
  const feed = getSharedHostedSessionFeed();
  const sessionId = feed.getState().record?.id;
  if (!sessionId) throw commandRefusal(`No hosted session is joined in this terminal, so nothing was ${what}.`, '/hosted attach <id> joins one; /hosted list shows them.');
  const seams = resolveSeams(ctx)!;
  const elsewhere = attachmentElsewhere(feed, sessionId, seams);
  if (elsewhere) throw commandRefusal(`Not ${what}: ${elsewhere}`);
  return { seams, sessionId };
}

/** A daemon refusal or failure, in the daemon's words, as a refusal of the action. */
async function daemonCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (readRefusal(error)) throw error;
    throw commandRefusal(describeOperatorRpcError(error));
  }
}

const SESSION_PICK = {
  id: 'session', label: 'Session', help: 'The hosted sessions the daemon has', kind: 'choice',
  choices: { list: HOSTED_SESSIONS, allowOther: { reason: 'a session id, or its number in the last /hosted list' } },
  required: true, typed: { position: 1 },
} as const;

const HOSTED_COMMAND: CommandDescription<CommandContext> = {
  name: 'hosted',
  title: 'Hosted sessions',
  summary: 'Conversations that run in the daemon, so they go on when this window closes',
  group: 'Sessions',
  report: 'see-joined',
  actions: [
    {
      id: 'see-joined', label: 'See the hosted session you are in', word: 'status', inputs: [],
      async rowValue() {
        const record = getSharedHostedSessionFeed().getState().record;
        return record ? `in ${hostedSessionLabel(record)}` : 'none joined';
      },
      sentence: 'Shows the hosted session this terminal joined, what leaving it would do, and the tool running in it.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'It is the session this terminal joined.' }, example: {},
      async run() {
        return renderHostedStatus(getSharedHostedSessionFeed());
      },
    },
    {
      id: 'start', label: 'Start a hosted session', word: 'new',
      inputs: [
        { id: 'prompt', label: 'First message', help: 'What it should start on, the way you would ask in the chat', kind: 'long-text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'nothing yet' }, typed: { tail: true } },
        { id: 'leave', label: 'When everyone leaves', help: 'Whether it keeps running once no terminal or browser has it open', kind: 'choice', choices: [
          { value: 'keep', label: 'Keep running', help: 'It waits, idle, to be joined again.' },
          { value: 'stop', label: 'Stop it', help: 'It ends when the last one leaves.' },
        ], required: { default: '', defaultMeans: 'as hostedSessions.detachPolicy says' }, typed: { flag: '--on-leave' } },
      ],
      sentence: 'A conversation will start in the daemon for this project and this terminal joins it; it lasts until you change it (ending it, or as "When everyone leaves" says).',
      done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'end',
      operator: { method: 'sessions.hosted.create', fields: { initialPrompt: 'prompt' } }, example: { prompt: 'summarise the open issues', leave: 'keep' },
      async run(values, ctx) {
        const seams = resolveSeams(ctx)!;
        const feed = getSharedHostedSessionFeed();
        const workspaceRoot = requireShellPaths(ctx).workingDirectory;
        const prompt = (values.prompt ?? '').trim();
        const policy: HostedDetachPolicy | undefined = values.leave === 'keep' ? 'survive' : values.leave === 'stop' ? 'kill' : undefined;
        await daemonCall(() => attachSession(seams, async () => {
          const record = await seams.client.create({
            workspaceRoot,
            originSurface: 'tui',
            ...(prompt ? { initialPrompt: prompt } : {}),
            ...(policy ? { detachPolicy: policy } : {}),
          });
          ctx.print([`Started ${hostedSessionLabel(record)} in ${record.workspaceRoot}.`, `  ${describeDetachEffect(record)}`].join('\n'));
          return record;
        }, feed, ctx));
      },
    },
    {
      id: 'see-all', label: 'See hosted sessions', word: 'list',
      inputs: [{ id: 'ended', label: 'Ended ones too', help: 'Also the ones that have ended and are still kept', kind: 'choice', choices: [{ value: 'no', label: 'Only running ones' }, { value: 'yes', label: 'Ended ones too' }], required: { default: 'no', defaultMeans: 'only running ones' }, typed: { flag: '--all', switchOn: 'yes' } }],
      sentence: 'Lists the hosted sessions the daemon has, who has joined each, and what leaving would do.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'sessions.hosted.list', fields: {} }, example: { ended: 'yes' },
      async run(values, ctx) {
        const seams = resolveSeams(ctx)!;
        const includeTerminated = values.ended === 'yes';
        const records = await daemonCall(() => seams.client.list({ includeTerminated }));
        lastListedIds = records.map((record) => record.id);
        // The session picker reads the same roster, so a list shown here is the list it shows.
        if (!includeTerminated) getSharedHostedSessionRoster().accept(records);
        if (records.length === 0) {
          return includeTerminated
            ? 'The daemon is hosting no sessions and keeps no ended ones.'
            : 'The daemon is hosting no sessions. /hosted list --all includes the ones that have ended.';
        }
        return [`Hosted sessions (${records.length}${includeTerminated ? ', including ended' : ''}):`, ...records.map(renderHostedRecordLine), '', '  /hosted attach <id or number>'].join('\n');
      },
    },
    {
      id: 'join', label: 'Join a hosted session', word: 'attach', inputs: [SESSION_PICK],
      sentence: 'This terminal joins hosted session {session}, shows its conversation so far and follows it live.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'sessions.hosted.attach', fields: { sessionId: 'session' } }, example: { session: 'hs-1' },
      async run(values, ctx) {
        const seams = resolveSeams(ctx)!;
        await daemonCall(() => attachSession(seams, resolveIdArgument(values.session!), getSharedHostedSessionFeed(), ctx));
      },
    },
    {
      id: 'send-now', label: 'Send a message now', word: 'send',
      inputs: [{ id: 'text', label: 'Message', help: 'What to tell it; it reads it during the turn it is in', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } }],
      sentence: '"{text}" will be sent to the hosted session now, into the turn it is running.', done: '',
      touches: 'this-machine', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'sessions.steer', fields: { message: 'text' } }, example: { text: 'focus on the failing test' },
      async run(values, ctx) {
        const outcome = await sayToHosted(ctx, values.text!.trim());
        if (!outcome.ok) throw commandRefusal(`Not sent: ${outcome.error}`);
        return 'Sent; its answer shows in the Agents view under Hosted (/agents).';
      },
    },
    {
      id: 'send-later', label: 'Send a message after this turn', word: 'send-later',
      inputs: [{ id: 'text', label: 'Message', help: 'What it should do next, once the turn it is in ends', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } }],
      sentence: '"{text}" will wait and run after the hosted session\'s current turn.', done: '',
      touches: 'this-machine', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'sessions.followUp', fields: { message: 'text' } }, example: { text: 'then update the changelog' },
      async run(values, ctx) {
        const { seams, sessionId } = joined(ctx, 'queued');
        await daemonCall(() => seams.client.followUp(sessionId, values.text!.trim()));
        return 'Queued: it runs after the current turn.';
      },
    },
    {
      id: 'stop-tool', label: 'Stop the tool that is running', word: 'stop-tool',
      inputs: [{ id: 'call', label: 'Tool', help: 'The tools running in the session now', kind: 'choice', choices: { list: RUNNING_TOOLS, allowOther: { reason: 'a tool call id' } }, required: { default: '', defaultMeans: 'the one running now' }, typed: { position: 1 } }],
      sentence: 'The tool call {call} in the hosted session will be stopped; the turn goes on without its result.', done: '',
      touches: 'this-machine', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'sessions.toolCalls.cancel', fields: { callId: 'call' } }, example: { call: 'call-1' },
      async run(values, ctx) {
        const { seams, sessionId } = joined(ctx, 'stopped');
        const callId = values.call || getSharedHostedSessionFeed().getState().runningToolCalls[0]?.callId;
        if (!callId) throw commandRefusal('No tool is running in the hosted session.');
        const cancelled = await daemonCall(() => seams.client.cancelToolCall(sessionId, callId));
        if (!cancelled) throw commandRefusal(`The daemon did not stop ${callId}; it may have finished already.`);
        return `Stopped tool call ${callId}.`;
      },
    },
    {
      id: 'leave', label: 'Leave the hosted session', word: 'leave', inputs: [],
      sentence: 'This terminal leaves the hosted session; it keeps running or ends, as its "when everyone leaves" setting says.', done: '',
      touches: 'this-machine', lasts: 'not-a-change', risk: 'none', undoneBy: 'join',
      operator: { method: 'sessions.hosted.detach', fields: {} }, example: {},
      async run(_values, ctx) {
        const feed = getSharedHostedSessionFeed();
        if (!hasHostedAttachments(feed)) throw commandRefusal('No hosted session is joined in this terminal.');
        const seams = resolveSeams(ctx)!;
        // Each attachment is released through the client it was made with, on its own daemon.
        const records = await daemonCall(() => detachHostedAttachments(feed, seams.client, seams.origin ?? 'the selected daemon'));
        if (records.length === 0) throw commandRefusal('No hosted session is joined in this terminal.');
        return records.map((record) => record.status === 'terminated'
          ? `Left ${hostedSessionLabel(record)}: it ended (${record.terminatedReason ?? 'no reason recorded'}), as its setting said it would.`
          : `Left ${hostedSessionLabel(record)}: it is still running in the daemon and can be joined again.`).join('\n');
      },
    },
    {
      // An id, never a list number: the question names exactly the session that ends, and a later list cannot change what it means.
      id: 'end', label: 'End a hosted session', word: 'end', inputs: [{ ...SESSION_PICK, choices: { list: HOSTED_SESSIONS, allowOther: { reason: 'a session id' } } }],
      sentence: 'Hosted session {session} and the turn it is running will end, whatever its setting says.',
      done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
      operator: { method: 'sessions.hosted.kill', fields: { sessionId: 'session' } }, example: { session: 'hs-1' },
      async run(values, ctx) {
        const feed = getSharedHostedSessionFeed();
        const target = values.session!;
        if (/^\d+$/.test(target)) throw commandRefusal(`${target} is a list number; ending a session takes its id, so the question names exactly the one that ends.`, '/hosted list shows the ids.');
        const seams = resolveSeams(ctx)!;
        const elsewhere = target === feed.getState().record?.id ? attachmentElsewhere(feed, target, seams) : null;
        if (elsewhere) throw commandRefusal(`Not ended: ${elsewhere}`);
        const record = await daemonCall(() => seams.client.kill(target));
        forgetHostedAttachment(feed, target);
        if (target === feed.getState().record?.id) feed.clear();
        return `Ended ${hostedSessionLabel(record)}: ${record.terminatedReason ?? 'no reason recorded'}.`;
      },
    },
  ],
};

const HOSTED_SLASH_COMMAND = defineCommand(HOSTED_COMMAND);

export function registerHostedRuntimeCommands(registry: CommandRegistry): void {
  registry.register(HOSTED_SLASH_COMMAND);
}

/**
 * Tests drive the module-level list memory (`/hosted attach 2`); this resets it
 * between them. The live stream is the feed's, and is reset with the feed.
 */
export function resetHostedCommandState(): void {
  lastListedIds = [];
}
