/**
 * hosted-runtime.ts, this terminal's part in a conversation the DAEMON runs.
 *
 * Local sessions are unchanged and remain the default experience: a turn typed
 * into the composer runs in this process, exactly as it always has. A hosted
 * session is the opt-in: the daemon composes the same loop on its side, so the
 * conversation does not depend on this window staying open.
 *
 * Every act is a capability (capabilities/builtin/sessions.ts, conversation-controls.ts,
 * tools-extras.ts) with its control in a place (Sessions: Hosted and Joined here;
 * This conversation): starting one is the daemon's (`hosted.new`), and this
 * terminal joins what its own press started (programSideOf below). Here are the
 * terminal's own pieces those capabilities run with: joining and following one
 * live, sending to it now or after its turn, stopping the tool it runs, leaving
 * it. Sending, queueing and stopping a tool are `sessions.steer`,
 * `sessions.followUp` and `sessions.toolCalls.cancel`, which resolve a hosted id
 * daemon-side.
 */
import type { CommandContext } from '../command-registry.ts';
import {
  replaceHostedAttachment, detachHostedAttachments, forgetHostedAttachment, hasHostedAttachments,
  assertHostedBindingCurrent, currentHostedBinding, hostedAttachmentOrigin,
} from '../../runtime/client/hosted-attachments.ts';
import { describeOperatorRpcError } from '../../runtime/client/operator-endpoint.ts';
import { requireShellPaths } from '@goodvibes/engine/terminal-shell/command-service-access';
import {
  createDaemonVerbCaller,
  pinDaemonVerbCaller,
  resolveDaemonEndpoint,
  type DaemonEndpoint,
} from '../../runtime/client/operator-endpoint.ts';
import type { SessionBinding } from '@goodvibes/engine/platform/platform/runtime/client/session-binding';
import { formatRefusal, readRefusal } from '@goodvibes/engine/errors';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { defineList, programSideOf, type ListRow } from '@goodvibes/engine/terminal-shell/command-actions';
import {
  createHostedSessionsClient,
  describeDetachEffect,
  hostedSessionLabel,
  type HostedSessionRecord,
  type HostedSessionsClient,
} from '../../runtime/client/hosted-sessions.ts';
import { newestHistoryTime, watchHostedSession, type HostedSessionSubscription } from '../../runtime/client/hosted-session-stream.ts';
import { getSharedHostedSessionFeed, type HostedSessionFeed } from '../../views/hosted-session-feed.ts';
import type { HostedJoin, ToolsExtrasSessionServices } from '@goodvibes/engine/platform/platform/capabilities';

/** The joined session's status (`hosted.status`; the Sessions place's Joined here shows its lines). */
export function renderHostedStatus(feed: HostedSessionFeed): string {
  const state = feed.getState();
  if (!state.record) {
    return [
      'No hosted session is joined in this terminal.',
      '  A hosted session runs inside the daemon, so it can outlive this window.',
      '  The Sessions place lists them under Hosted, where one is started (and joined) or joined.',
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
 * Resolve everything a hosted act of this terminal needs, or refuse honestly.
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
  return `hosted session ${sessionId} is on the daemon at ${origin}, and this terminal now talks to ${seams.origin}; nothing was sent. Leaving it (Sessions, Joined here) releases it there; join a session on ${seams.origin} to continue here.`;
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
  /** The person typed it himself (never the model's call): sent with his claim, so it runs as his turn in the session's project. */
  personAsked = false,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  const feed = getSharedHostedSessionFeed();
  const captured = binding ?? currentHostedBinding(feed);
  if (!captured) return { ok: false, error: 'no hosted session is joined here; join one first (Sessions, Hosted).' };
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
    await seams.client.steer(captured.sessionId, text, personAsked);
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
  /** Open Your agents on it: only for the person's own press, never for a model's join. */
  opensScreen: boolean,
): Promise<void> {
  if (seams.origin === null) throw new Error('no daemon can be reached from this terminal; /settings open daemon shows the connection');
  const attachment = await replaceHostedAttachment(feed, seams.client, seams.origin, sessionId,
    (result, signal) => openStream(seams, result.session.id, feed, signal, result.historyAsOf ?? newestHistoryTime(result.history)));
  context.print([
    `[hosted] attached to ${hostedSessionLabel(attachment.session)} (${attachment.history.length} message(s) backfilled)`,
    `  ${describeDetachEffect(attachment.session)}`,
  ].join('\n'));
  if (opensScreen) context.openAgents?.({ hosted: true });
}

// The daemon's hosted sessions, which joining and ending choose from (capabilities/builtin/sessions.ts HOSTED_SESSIONS_LIST).
defineList<CommandContext>({
  name: 'hosted.sessions',
  async read(ctx) {
    const seams = resolveSeams(ctx);
    if (!seams) return [];
    const records = await seams.client.list({ includeTerminated: false });
    return records.map((record): ListRow => ({
      value: record.id, label: hostedSessionLabel(record), detail: describeDetachEffect(record),
      state: `${record.status}, ${record.attachedClients.length > 0 ? `joined by ${record.attachedClients.join(', ')}` : 'nobody joined'}`,
    }));
  },
  operator: { method: 'sessions.hosted.list', input: {}, rows: { from: 'sessions', value: 'id', label: 'title', state: 'status' } },
});

// The tools running in the joined session, which `hosted.stop-tool` (builtin/tools-extras.ts) chooses from.
defineList<CommandContext>({
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
  if (!sessionId) throw commandRefusal(`No hosted session is joined in this terminal, so nothing was ${what}.`, 'The Sessions place lists them under Hosted; join one there first.');
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

/** What a routine prints while it runs, as its answer in words. */
async function said(ctx: CommandContext, run: (ctx: CommandContext) => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  let answering = true;
  const answeringCtx: CommandContext = { ...ctx, print: (message: string) => { if (answering) lines.push(message); else ctx.print(message); } };
  try {
    const returned = await run(answeringCtx);
    if (typeof returned === 'string' && returned.trim() !== '') lines.push(returned);
  } finally {
    answering = false;
  }
  return lines.join('\n');
}

/**
 * This terminal's own join of the daemon's hosted sessions, as the hosted capabilities take it
 * (capabilities/builtin/sessions.ts): each runs the daemon's method with this terminal's own id, and
 * joining follows the session live here.
 */
export function hostedJoinOf(ctx: CommandContext): HostedJoin {
  return {
    joined: () => hasHostedAttachments(getSharedHostedSessionFeed()),
    status: async () => renderHostedStatus(getSharedHostedSessionFeed()),
    join: (session, options) => said(ctx, async (c) => {
      const seams = resolveSeams(c)!;
      const sessionId = session.trim();
      await daemonCall(() => attachSession(seams, sessionId, getSharedHostedSessionFeed(), c, options?.opensScreen === true));
    }),
    send: async (text, personAsked) => {
      const outcome = await sayToHosted(ctx, text, undefined, null, personAsked === true);
      if (!outcome.ok) throw commandRefusal(`Not sent: ${outcome.error}`);
      return 'Sent; its answer shows in the Agents view under Hosted.';
    },
    leave: async () => {
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
    // A message for after the turn (hosted.send-later, a control on the conversation: builtin/conversation-controls.ts).
    sendLater: async (text, personAsked) => {
      const { seams, sessionId } = joined(ctx, 'queued');
      await daemonCall(() => seams.client.followUp(sessionId, text, personAsked === true));
      return 'Queued: it runs after the current turn.';
    },
  };
}

/** The tool call running in the session this terminal joined, stopped through the daemon (builtin/tools-extras.ts `hosted.stop-tool`). */
export function hostedToolStopOf(ctx: CommandContext): NonNullable<ToolsExtrasSessionServices['hostedToolStop']> {
  return {
    async stop(call) {
      const { seams, sessionId } = joined(ctx, 'stopped');
      const running = getSharedHostedSessionFeed().getState().runningToolCalls;
      const callId = call || running[0]?.callId;
      if (!callId) throw commandRefusal('No tool is running in the hosted session.');
      // Named by its tool, as the person saw it running; the call's id only when the tool is not known here.
      const named = running.find((entry) => entry.callId === callId)?.tool;
      const cancelled = await daemonCall(() => seams.client.cancelToolCall(sessionId, callId));
      if (!cancelled) throw commandRefusal(`The daemon did not stop ${named ?? callId}; it may have finished already.`);
      return `Stopped ${named ? `the running ${named}` : `tool call ${callId}`}; the turn goes on without its result.`;
    },
  };
}

/**
 * Starting a hosted session from this terminal's own press (the Sessions place, `h`) is one control: the daemon starts
 * it (`hosted.new`, as the press's request, its kind this terminal's), then this terminal joins it and follows it live,
 * as the start always did. A model's or a script's start goes through the daemon alone and joins nothing here.
 */
programSideOf('hosted.new', {
  async after(_values, ctx, answer) {
    const session = (answer.data as { readonly session?: { readonly id?: unknown } } | undefined)?.session;
    const sessionId = typeof session?.id === 'string' ? session.id : '';
    if (!sessionId) return 'This terminal did not join it: the daemon gave no session id.';
    try {
      return await said(ctx as CommandContext, async (c) => {
        // This terminal's own press: Your agents opens on what it started, as before.
        await daemonCall(() => attachSession(resolveSeams(c)!, sessionId, getSharedHostedSessionFeed(), c, true));
      });
    } catch (error) {
      // It was started: the join is what failed, and the session can still be joined from the list.
      return `This terminal did not join it: ${describeOperatorRpcError(error)}`;
    }
  },
});

/** A hosted session ended from here that this terminal had joined: its attachment and the live view are let go. */
programSideOf('hosted.end', {
  after(values) {
    const target = values.session ?? '';
    const feed = getSharedHostedSessionFeed();
    forgetHostedAttachment(feed, target);
    if (target !== '' && target === feed.getState().record?.id) feed.clear();
  },
});

