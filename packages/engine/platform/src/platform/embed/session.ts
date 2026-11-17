/**
 * embed/session.ts
 *
 * The thin, in-process embedding facade over the existing daemon boot factory.
 * It invents no runtime machinery: it wires `bootDaemon` to the daemon's
 * already-exposed runtime event bus, shared session broker, and approval broker,
 * and adds one convenience, bridging an injected `PermissionRequestHandler`
 * onto the broker so an embedder can answer permission asks with a callback
 * instead of driving the HTTP approvals routes.
 *
 * One daemon per process and home directory: the sessions of one home share
 * the daemon booted for the first of them, so a second session starts without
 * a boot and cannot disturb the first one's work (its judgment readings, its
 * stores, its background services). A session whose workspace lies outside
 * that daemon's directory, or that asks for different daemon settings or a
 * different MCP server under a name already in use, gets a daemon of its own.
 * The daemon stops with the last session that uses it.
 *
 * This is the substrate the ACP adapter (`../acp/agent`) drives: create a
 * session against a workspace, submit input, subscribe to typed events, answer
 * permission asks, and shut down.
 */

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { bootDaemon, type BootDaemonOptions, type BootedDaemon } from '../daemon/boot.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { ApprovalBroker, SharedSessionBroker } from '../control-plane/index.js';
import type { SharedApprovalRecord } from '../control-plane/approval-broker.js';
import type { SharedSessionSubmission } from '../control-plane/session-types.js';
import type { AutomationSurfaceKind } from '../automation/types.js';
import type { PermissionRequestHandler } from '../permissions/prompt.js';
import type { McpServerConfig } from '../mcp/config.js';
import type { AgentEvent } from '../../events/agents.js';
import type { ToolEvent } from '../../events/tools.js';
import { logger } from '../utils/logger.js';

/** Options for {@link createEmbeddedSession}. */
export interface EmbedSessionOptions {
  /** The workspace / project root the session operates against. */
  readonly workspace: string;
  /** Injected home directory, the daemon stays entirely inside it. Sessions of one home share one daemon. */
  readonly homeDirectory: string;
  /** Bearer token required by the HTTP surface. Omit for session-based auth. Part of the daemon's settings. */
  readonly token?: string | undefined;
  /**
   * A callback that answers this session's permission asks: those raised by the
   * agents its submissions started, and on a daemon no other session can have
   * asked through, every pending approval. Omit to resolve approvals another way
   * (HTTP routes, direct broker).
   */
  readonly requestPermission?: PermissionRequestHandler | undefined;
  /** Transport surface kind attributed to submitted input. Default `webhook`. */
  readonly surfaceKind?: AutomationSurfaceKind | undefined;
  /** Stable surface id for this embedder. Default a generated `embed-<uuid>`. */
  readonly surfaceId?: string | undefined;
  /**
   * MCP servers to connect into the daemon's tool surface (e.g. the servers an
   * ACP client declares in `session/new`). Each is connected through the
   * daemon's live MCP registry (tools namespaced `mcp:<name>:<tool>`), once per
   * daemon however many sessions declare it, and disconnected when the last
   * session that declared it stops. stdio transport only, the registry
   * spawns a process. A server that fails to connect is logged and skipped; it
   * never aborts session creation.
   */
  readonly mcpServers?: readonly McpServerConfig[] | undefined;
  /** Escape hatch for the remaining boot options (port, host, serveFactory…). Part of the daemon's settings. */
  readonly boot?: Partial<Omit<BootDaemonOptions, 'workingDir' | 'homeDirectory' | 'token'>> | undefined;
}

/** Structured input to {@link EmbeddedSession.submit}. */
export interface EmbeddedSessionInput {
  readonly body: string;
  readonly title?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/** What the agent working on one submitted input did, in the order it happened. */
export type EmbeddedRunEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool-started'; readonly callId: string; readonly tool: string }
  | { readonly type: 'tool-settled'; readonly callId: string; readonly tool: string; readonly ok: boolean; readonly error?: string | undefined };

/** How the work on one submitted input ended. */
export type EmbeddedRunOutcome =
  | { readonly outcome: 'completed'; readonly agentId: string; readonly output: string }
  | { readonly outcome: 'failed'; readonly agentId: string; readonly error: string }
  | { readonly outcome: 'cancelled'; readonly agentId?: string | undefined; readonly reason: string }
  /** No agent took the input (queued behind other work, or refused); `state` is the input's state. */
  | { readonly outcome: 'not-started'; readonly state: string; readonly reason: string };

/**
 * The work started (or reached) by one submitted input. It follows the one
 * agent the broker handed the input to, from that agent's own events, so it
 * is scoped to this input and nothing else on the bus.
 */
export interface EmbeddedCompletion {
  /** The agent working on the input, or undefined when none took it. */
  readonly agentId: string | undefined;
  /** Receive the run's events; events that happened before the first listener are replayed to it. */
  onEvent(listener: (event: EmbeddedRunEvent) => void): () => void;
  /** Settles once with how the run ended. Never rejects. */
  readonly done: Promise<EmbeddedRunOutcome>;
}

/** The broker's submission record plus the handle on the work it started. */
export type EmbeddedSubmission = SharedSessionSubmission & { readonly completion: EmbeddedCompletion };

/** A live embedded GoodVibes session. */
export interface EmbeddedSession {
  /** The workspace this session operates against. */
  readonly workspace: string;
  /** Base URL of the underlying daemon's HTTP surface (shared by the sessions of one daemon). */
  readonly url: string;
  /** The daemon's runtime event bus, subscribe with `.on(type, cb)` / `.onDomain(domain, cb)`. It carries every session of the daemon; a submission's `completion` is scoped to its own run. */
  readonly events: RuntimeEventBus;
  /** The approval broker, the seam permission asks flow through. */
  readonly approvals: ApprovalBroker;
  /** The shared session broker backing this session. */
  readonly sessions: SharedSessionBroker;
  /**
   * Submit input to the session. Returns the broker's submission record and a
   * `completion` handle on the work it started. When the broker answers in
   * spawn mode (nothing is running for the input), the text starts a contract
   * in this session's workspace and the record's `activeAgentId` is the
   * contract's owner agent, bound to the session; the handle follows that
   * agent's stream and terminal event.
   */
  submit(input: string | EmbeddedSessionInput): Promise<EmbeddedSubmission>;
  /**
   * Cancel the in-flight work for one or more running agents this session's
   * submissions started (the ids a submission reported as `activeAgentId`).
   * This is a REAL cancellation: it aborts the agent's in-flight provider call
   * so the turn stops mid-flight and emits its cancelled outcome, rather than
   * only cancelling a still-queued input. Other ids, including another
   * session's agents on the same daemon, are ignored. Returns the number of
   * agents actually cancelled.
   */
  cancelActive(agentIds: Iterable<string>): number;
  /**
   * End the session: its followed runs end as cancelled and its running agents
   * are cancelled. The daemon stops, and its port is released, when no other
   * session uses it. Idempotent.
   */
  stop(): Promise<void>;
}

/** One session's share of a daemon. */
interface Member {
  readonly workspace: string;
  readonly requestPermission: PermissionRequestHandler | undefined;
  /** Agents this session's submissions started or reached. */
  readonly agentIds: Set<string>;
  /** Shared sessions this session's submissions went to; a contract's unit agents carry the one that started it. */
  readonly sessionIds: Set<string>;
  /** Contracts this session's submissions started; their unit agents ask under their own ids. */
  readonly contractIds: Set<string>;
  /** Runs still being followed; stopping the session ends each as cancelled. */
  readonly liveRuns: Set<RunWatch>;
}

/** The daemon of one home directory, shared by the sessions that fit it. */
interface SharedDaemon {
  readonly home: string;
  /** The daemon's working directory, links followed. */
  readonly workingDir: string;
  readonly token: string | undefined;
  readonly boot: EmbedSessionOptions['boot'];
  readonly booted: Promise<BootedDaemon>;
  readonly members: Set<Member>;
  /** Declared MCP servers by name: the config, how many live sessions declared it, and its connection. */
  readonly mcp: Map<string, DeclaredMcpServer>;
}

interface DeclaredMcpServer {
  readonly config: string;
  users: number;
  /** Settles true once connected; null until a session connects it, after a failed attempt, or once it is being disconnected. */
  connection: Promise<boolean> | null;
  /** The disconnect started when its last session stopped; a session that declares it again waits for it, then connects. */
  removal: Promise<unknown> | null;
}

/** Where an agent's record says it belongs. */
type AgentOwnershipSource = Pick<BootedDaemon['server'], 'agentOwnership'>;

/** Live embedded daemons of this process, by home directory. */
const embeddedDaemons = new Map<string, SharedDaemon[]>();

function realOrResolved(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function isWithin(root: string, candidate: string): boolean {
  const from = relative(root, candidate);
  return from === '' || (!from.startsWith('..') && !isAbsolute(from));
}

/** Two option bags name the same daemon settings when every value is the same value. */
function sameBootOptions(a: EmbedSessionOptions['boot'], b: EmbedSessionOptions['boot']): boolean {
  const left: Record<string, unknown> = a ?? {};
  const right: Record<string, unknown> = b ?? {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (!Object.is(left[key], right[key])) return false;
  return true;
}

/** Whether a session with these options can run on `daemon`: same settings, workspace inside it, no clashing MCP server. */
function fits(daemon: SharedDaemon, options: EmbedSessionOptions, workspace: string): boolean {
  if (daemon.token !== options.token || !sameBootOptions(daemon.boot, options.boot)) return false;
  if (!isWithin(daemon.workingDir, workspace)) return false;
  return (options.mcpServers ?? []).every((server) => {
    const entry = daemon.mcp.get(server.name);
    return entry === undefined || entry.users === 0 || entry.config === JSON.stringify(server);
  });
}

/**
 * Create an embedded GoodVibes session bound to a workspace. The first session
 * of a home directory boots an in-process daemon; later sessions whose
 * workspace lies inside its directory join it. Exposes the daemon's runtime bus
 * / session broker / approval broker, and, when a `requestPermission` callback
 * is given, answers this session's pending approvals with it.
 */
export async function createEmbeddedSession(options: EmbedSessionOptions): Promise<EmbeddedSession> {
  const home = resolve(options.homeDirectory);
  const workspace = realOrResolved(options.workspace);
  const running = embeddedDaemons.get(home) ?? [];
  const daemon = running.find((candidate) => fits(candidate, options, workspace)) ?? startDaemon(home, workspace, options);
  const member: Member = {
    workspace, requestPermission: options.requestPermission,
    agentIds: new Set(), sessionIds: new Set(), contractIds: new Set(), liveRuns: new Set(),
  };
  daemon.members.add(member);

  // Claim each declared MCP server before the first await, so a session
  // created meanwhile with another server under the same name gets its own daemon.
  const declared: { readonly server: McpServerConfig; readonly entry: DeclaredMcpServer }[] = [];
  for (const mcpServer of options.mcpServers ?? []) {
    const config = JSON.stringify(mcpServer);
    let entry = daemon.mcp.get(mcpServer.name);
    if (entry === undefined || entry.config !== config) {
      entry = { config, users: 0, connection: null, removal: null };
      daemon.mcp.set(mcpServer.name, entry);
    }
    entry.users += 1;
    declared.push({ server: mcpServer, entry });
  }
  /**
   * Give up this session's claim on its declared servers. A server no live
   * session declares any more is disconnected, so its tools leave the other
   * sessions' tool surface; `connected` is omitted when the daemon itself is
   * stopping (or never booted) and takes every server down anyway.
   */
  const releaseDeclared = (connected?: Pick<BootedDaemon['server'], 'unregisterMcpServer'>): void => {
    for (const { server: mcpServer, entry } of declared) {
      entry.users = Math.max(0, entry.users - 1);
      const connection = entry.connection;
      if (entry.users > 0 || connected === undefined || connection === null || daemon.mcp.get(mcpServer.name) !== entry) continue;
      entry.connection = null;
      const registry = connected;
      const removal: Promise<unknown> = connection
        .then((ok) => (ok ? registry.unregisterMcpServer(mcpServer) : false))
        .catch((error: unknown) => {
          logger.warn('createEmbeddedSession: failed to disconnect a declared MCP server no session uses', {
            server: mcpServer.name,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (entry.removal === removal) entry.removal = null;
        });
      entry.removal = removal;
    }
  };

  let booted: BootedDaemon;
  try {
    booted = await daemon.booted;
  } catch (error) {
    releaseDeclared();
    daemon.members.delete(member);
    throw error;
  }
  const server = booted.server;
  const sessions = server.sessions;
  const surfaceKind: AutomationSurfaceKind = options.surfaceKind ?? 'webhook';
  const surfaceId = options.surfaceId ?? `embed-${randomUUID()}`;

  // Connect the declared MCP servers this daemon does not have yet into its
  // live MCP registry so their tools join the tool surface; one declared by an
  // earlier session is connected once. A single server's failure is logged and
  // skipped (the next session that declares it tries again), it never aborts the session.
  for (const { server: mcpServer, entry } of declared) {
    // A disconnect started by the last session that declared it finishes first.
    while (entry.removal !== null && entry.connection === null) await entry.removal;
    entry.connection ??= server.registerMcpServer(mcpServer).then(() => true, (error: unknown) => {
      logger.warn('createEmbeddedSession: failed to connect declared MCP server', {
        server: mcpServer.name,
        error: error instanceof Error ? error.message : String(error),
      });
      entry.connection = null;
      return false;
    });
    await entry.connection;
  }

  let stopped: Promise<void> | null = null;
  return {
    workspace: options.workspace,
    url: booted.url,
    events: server.eventBus,
    approvals: booted.approvals,
    sessions,
    // Run as the daemon's own work: its readings keep this daemon's judgment
    // port when another daemon runs in this process.
    submit: (input) => server.inJudgmentRuntime(async () => {
      if (stopped) throw new Error('This embedded session has stopped; create a new one to submit input.');
      const body = typeof input === 'string' ? input : input.body;
      const structured = typeof input === 'string' ? undefined : input;
      // Subscribed before the submit: a run that fails at once can end before
      // the broker answers with the agent id, and its events are held until then.
      const watch = watchRun(server.eventBus, member.liveRuns);
      try {
        const submission = await sessions.submitMessage({
          surfaceKind,
          surfaceId,
          body,
          ...(structured?.sessionId !== undefined ? { sessionId: structured.sessionId } : {}),
          ...(structured?.title !== undefined ? { title: structured.title } : {}),
          ...(structured?.metadata !== undefined ? { metadata: structured.metadata } : {}),
        });
        member.sessionIds.add(submission.session.id);
        if (submission.mode !== 'spawn') {
          // Only a live agent that was handed this input is working on it; a
          // queued or refused input has nothing to follow yet.
          const agentId = submission.mode === 'continued-live' ? submission.activeAgentId : undefined;
          if (agentId) member.agentIds.add(agentId);
          return { ...submission, completion: agentId
            ? watch.follow(agentId)
            : watch.notStarted(submission.state, notStartedReason(submission.mode)) };
        }
        // Spawn mode: nothing is running for this input yet. The submitted text
        // is the ask of a new contract (contract runner design 10.2), started
        // through the daemon's contracts operator surface in this session's
        // workspace, and its owner agent is bound to the session as the agent
        // working on it.
        let started: Awaited<ReturnType<typeof server.contracts.start>>;
        try {
          started = await server.contracts.start({
            ask: body,
            sessionId: submission.session.id,
            ...(workspace === daemon.workingDir ? {} : { workspaceRoot: workspace }),
          });
        } catch (error) {
          // The input was recorded before the contract was refused. Fail it so no
          // queued input is left that nothing will run and a retry does not double up.
          await sessions.failInput(submission.session.id, submission.input.id, error instanceof Error ? error.message : String(error)).catch(() => null);
          throw error;
        }
        member.agentIds.add(started.ownerAgentId);
        member.contractIds.add(started.contract.id);
        const bound = await sessions.bindAgent(submission.session.id, started.ownerAgentId, submission.input.id);
        return { ...submission, session: bound ?? submission.session, activeAgentId: started.ownerAgentId,
          completion: watch.follow(started.ownerAgentId) };
      } catch (error) {
        watch.abandon();
        throw error;
      }
    }),
    cancelActive: (agentIds) => {
      let cancelled = 0;
      for (const agentId of agentIds) {
        if (member.agentIds.has(agentId) && server.cancelAgent(agentId)) cancelled += 1;
      }
      return cancelled;
    },
    stop: () => {
      stopped ??= (async () => {
        for (const run of [...member.liveRuns]) run.end({ outcome: 'cancelled', reason: 'The embedded session stopped.' });
        for (const agentId of member.agentIds) server.cancelAgent(agentId);
        daemon.members.delete(member);
        // The last session stops the daemon, which takes every server down with it.
        releaseDeclared(daemon.members.size > 0 ? server : undefined);
        await releaseIfUnused(daemon);
      })();
      return stopped;
    },
  };
}

/** Boot the daemon for a session no running daemon fits, and register it for the sessions that follow. */
function startDaemon(home: string, workspace: string, options: EmbedSessionOptions): SharedDaemon {
  const daemon: SharedDaemon = {
    home,
    workingDir: workspace,
    token: options.token,
    boot: options.boot,
    members: new Set(),
    mcp: new Map(),
    booted: bootDaemon({
      workingDir: options.workspace,
      homeDirectory: options.homeDirectory,
      ...(options.token !== undefined ? { token: options.token } : {}),
      ...(options.boot ?? {}),
    }).then((booted) => {
      bridgeApprovals(daemon, booted.server, booted.approvals);
      return booted;
    }),
  };
  // A boot that failed is forgotten so the next session boots again.
  daemon.booted.catch(() => forget(daemon));
  embeddedDaemons.set(home, [...(embeddedDaemons.get(home) ?? []), daemon]);
  return daemon;
}

function forget(daemon: SharedDaemon): void {
  const remaining = (embeddedDaemons.get(daemon.home) ?? []).filter((candidate) => candidate !== daemon);
  if (remaining.length > 0) embeddedDaemons.set(daemon.home, remaining);
  else embeddedDaemons.delete(daemon.home);
}

/** Stop a daemon no session uses any more. */
async function releaseIfUnused(daemon: SharedDaemon): Promise<void> {
  if (daemon.members.size > 0) return;
  // Unregistered before the await: a session created while this one stops boots a new daemon.
  forget(daemon);
  const booted = await daemon.booted.catch(() => null);
  await booted?.stop();
}

/**
 * The session a pending approval belongs to: the one whose submissions went to
 * the approval's shared session; else the one whose submission started the
 * agent that asked, or started the contract that agent works on, or went to the
 * shared session that agent works for; else the one session with a run in
 * flight, else the daemon's only session. `undefined` when none can be named.
 */
function memberForApproval(daemon: SharedDaemon, server: AgentOwnershipSource, approval: SharedApprovalRecord): Member | undefined {
  const members = [...daemon.members];
  const only = (holds: (member: Member) => boolean): Member | undefined => {
    const matches = members.filter(holds);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const approvalSession = approval.sessionId;
  if (approvalSession !== undefined) {
    const bySession = only((member) => member.sessionIds.has(approvalSession));
    if (bySession) return bySession;
  }
  const attribution = approval.request.attribution;
  const agentId = attribution?.kind === 'background-agent' ? attribution.agentId : undefined;
  if (agentId !== undefined) {
    const owner = only((member) => member.agentIds.has(agentId));
    if (owner) return owner;
    const ownership = server.agentOwnership(agentId);
    const contractId = ownership?.contractId;
    const sessionId = ownership?.sessionId;
    const byContract = contractId === undefined ? undefined : only((member) => member.contractIds.has(contractId));
    if (byContract) return byContract;
    const byAgentSession = sessionId === undefined ? undefined : only((member) => member.sessionIds.has(sessionId));
    if (byAgentSession) return byAgentSession;
  }
  const running = members.filter((member) => member.liveRuns.size > 0);
  if (running.length === 1) return running[0];
  return members.length === 1 ? members[0] : undefined;
}

/**
 * Answer each pending approval with the permission callback of the session it
 * belongs to. An ask whose session has no callback is left to the other
 * approval routes. An ask no session can be named for is refused when every
 * session answers by callback (nobody else would), and left pending otherwise.
 */
function bridgeApprovals(daemon: SharedDaemon, server: AgentOwnershipSource, approvals: ApprovalBroker): void {
  const handled = new Set<string>();
  const deny = (approvalId: string, reason: string): Promise<unknown> =>
    approvals.resolveApproval(approvalId, { approved: false, reason, actor: 'embed', actorSurface: 'embed' })
      .catch((error: unknown) => {
        logger.warn('createEmbeddedSession: could not record a denial for an approval', {
          approvalId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  approvals.subscribe((approval) => {
    if (approval.status !== 'pending' || handled.has(approval.id)) return;
    const member = memberForApproval(daemon, server, approval);
    if (member === undefined) {
      const members = [...daemon.members];
      if (members.length === 0 || members.some((candidate) => candidate.requestPermission === undefined)) return;
      handled.add(approval.id);
      logger.warn('createEmbeddedSession: denied an approval no embedded session could be named for', {
        approvalId: approval.id,
        tool: approval.request.tool,
        sessions: members.length,
      });
      void deny(approval.id, `${members.length} embedded sessions share this daemon and none of them started the agent that asked, so the ask was not shown to any of them.`)
        .finally(() => handled.delete(approval.id));
      return;
    }
    const handler = member.requestPermission;
    if (handler === undefined) return;
    handled.add(approval.id);
    // An ask that needs the owner's own decision can only be approved through the
    // host's private owner route, never by an embedder callback. Say so and deny
    // instead of prompting for an answer that could not be honoured.
    if (approval.requiresOwnerDecision) {
      logger.warn('createEmbeddedSession: denied an approval that requires the owner decision; an embedded permission callback cannot approve it', {
        approvalId: approval.id,
        tool: approval.request.tool,
      });
      void deny(approval.id, 'This approval needs the owner decision and cannot be approved from an embedded client.')
        .finally(() => handled.delete(approval.id));
      return;
    }
    void handler(approval.request)
      .then(async (decision) => {
        try {
          await approvals.resolveApproval(approval.id, {
            approved: decision.approved,
            actor: 'embed',
            actorSurface: 'embed',
            ...(decision.remember !== undefined ? { remember: decision.remember } : {}),
            ...(decision.modifiedArgs !== undefined ? { modifiedArgs: decision.modifiedArgs } : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn('createEmbeddedSession: the embedder\'s decision was refused; denying the approval', { approvalId: approval.id, error: message });
          await deny(approval.id, `The embedder's decision could not be applied: ${message}`);
        }
      }, async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('createEmbeddedSession: the permission callback failed; denying the approval', { approvalId: approval.id, error: message });
        await deny(approval.id, 'The embedder\'s permission callback failed.');
      })
      .finally(() => handled.delete(approval.id));
  });
}

function notStartedReason(mode: SharedSessionSubmission['mode']): string {
  switch (mode) {
    case 'queued-follow-up': return 'The message is queued behind the work already running in this session; it runs when that work ends.';
    case 'queued-for-surface': return 'The message was queued for another connected surface of this session.';
    case 'rejected': return 'No running agent accepted the message.';
    default: return 'No agent took the message.';
  }
}

interface RunWatch {
  follow(agentId: string): EmbeddedCompletion;
  notStarted(state: string, reason: string): EmbeddedCompletion;
  /** The submit failed: stop listening without settling a handle nobody holds. */
  abandon(): void;
  end(outcome: EmbeddedRunOutcome): void;
}

type WatchedEnvelope = { readonly domain: 'agents'; readonly payload: AgentEvent } | { readonly domain: 'tools'; readonly payload: ToolEvent };

/** One run's view of the bus: the events of one agent, held until its id is known. */
function watchRun(bus: RuntimeEventBus, live: Set<RunWatch>): RunWatch {
  let agentId: string | undefined;
  let settled = false;
  let early: WatchedEnvelope[] | null = [];
  // Events kept for replay until the first listener attaches.
  let unheard: EmbeddedRunEvent[] | null = [];
  const listeners = new Set<(event: EmbeddedRunEvent) => void>();
  const openTools = new Set<string>();
  let settle!: (outcome: EmbeddedRunOutcome) => void;
  const done = new Promise<EmbeddedRunOutcome>((resolve) => { settle = resolve; });

  const publish = (event: EmbeddedRunEvent): void => {
    if (unheard) { unheard.push(event); return; }
    for (const listener of listeners) {
      try { listener(event); }
      catch (error) { logger.warn('createEmbeddedSession: a run listener threw', { error: error instanceof Error ? error.message : String(error) }); }
    }
  };
  const toolStarted = (callId: string, tool: string): void => {
    if (openTools.has(callId)) return;
    openTools.add(callId);
    publish({ type: 'tool-started', callId, tool });
  };
  const toolSettled = (callId: string, tool: string, ok: boolean, error?: string): void => {
    openTools.delete(callId);
    publish({ type: 'tool-settled', callId, tool, ok, ...(error === undefined ? {} : { error }) });
  };
  const handle = (envelope: WatchedEnvelope): void => {
    if (settled || agentId === undefined) return;
    if (envelope.domain === 'agents') {
      const event = envelope.payload;
      if (event.agentId !== agentId) return;
      switch (event.type) {
        case 'AGENT_STREAM_DELTA': if (event.content) publish({ type: 'text', text: event.content }); return;
        case 'AGENT_AWAITING_TOOL': toolStarted(event.callId, event.tool); return;
        case 'AGENT_COMPLETED': watch.end({ outcome: 'completed', agentId, output: event.output ?? '' }); return;
        case 'AGENT_FAILED': watch.end({ outcome: 'failed', agentId, error: event.error }); return;
        case 'AGENT_CANCELLED': watch.end({ outcome: 'cancelled', agentId, reason: event.reason ?? 'The run was cancelled.' }); return;
        default: return;
      }
    }
    const event = envelope.payload;
    // A worker agent's tool calls run under turn ids `<agentId>:turn:<n>`.
    if (!('turnId' in event) || typeof event.turnId !== 'string' || !event.turnId.startsWith(`${agentId}:`)) return;
    switch (event.type) {
      case 'TOOL_EXECUTING': toolStarted(event.callId, event.tool); return;
      case 'TOOL_SUCCEEDED': toolSettled(event.callId, event.tool, true); return;
      case 'TOOL_FAILED': toolSettled(event.callId, event.tool, false, event.error); return;
      case 'TOOL_CANCELLED': toolSettled(event.callId, event.tool, false, event.reason ?? 'cancelled'); return;
      default: return;
    }
  };
  const receive = (envelope: WatchedEnvelope): void => {
    if (early) early.push(envelope);
    else handle(envelope);
  };
  const offAgents = bus.onDomain('agents', (envelope) => receive({ domain: 'agents', payload: envelope.payload }));
  const offTools = bus.onDomain('tools', (envelope) => receive({ domain: 'tools', payload: envelope.payload }));
  const release = (): void => { offAgents(); offTools(); early = null; live.delete(watch); };

  const completion = (): EmbeddedCompletion => ({
    agentId,
    onEvent(listener) {
      listeners.add(listener);
      if (unheard) {
        const replay = unheard;
        unheard = null;
        for (const event of replay) publish(event);
      }
      return () => { listeners.delete(listener); };
    },
    done,
  });

  const watch: RunWatch = {
    follow(id) {
      agentId = id;
      const held = early ?? [];
      early = null;
      for (const envelope of held) handle(envelope);
      return completion();
    },
    notStarted(state, reason) {
      watch.end({ outcome: 'not-started', state, reason });
      return completion();
    },
    abandon() { settled = true; release(); },
    end(outcome) {
      if (settled) return;
      settled = true;
      release();
      settle(outcome);
    },
  };
  live.add(watch);
  return watch;
}
