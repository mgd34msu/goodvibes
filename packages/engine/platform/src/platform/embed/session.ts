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
 * This is the substrate the ACP adapter (`../acp/agent`) drives: create a
 * session against a workspace, submit input, subscribe to typed events, answer
 * permission asks, and shut down.
 */

import { randomUUID } from 'node:crypto';
import { bootDaemon, type BootDaemonOptions } from '../daemon/boot.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { ApprovalBroker, SharedSessionBroker } from '../control-plane/index.js';
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
  /** Injected home directory, the daemon stays entirely inside it. */
  readonly homeDirectory: string;
  /** Bearer token required by the HTTP surface. Omit for session-based auth. */
  readonly token?: string | undefined;
  /**
   * A callback that answers permission asks. When provided, every pending
   * approval on the session's broker is routed to it and resolved with its
   * decision. Omit to resolve approvals another way (HTTP routes, direct broker).
   */
  readonly requestPermission?: PermissionRequestHandler | undefined;
  /** Transport surface kind attributed to submitted input. Default `webhook`. */
  readonly surfaceKind?: AutomationSurfaceKind | undefined;
  /** Stable surface id for this embedder. Default a generated `embed-<uuid>`. */
  readonly surfaceId?: string | undefined;
  /**
   * MCP servers to connect into the session's tool surface at boot (e.g. the
   * servers an ACP client declares in `session/new`). Each is connected through
   * the daemon's live MCP registry (tools namespaced `mcp:<name>:<tool>`). stdio
   * transport only, the registry spawns a process. A server that fails to
   * connect is logged and skipped; it never aborts session creation.
   */
  readonly mcpServers?: readonly McpServerConfig[] | undefined;
  /** Escape hatch for the remaining boot options (port, host, serveFactory…). */
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
  /** Base URL of the underlying daemon's HTTP surface. */
  readonly url: string;
  /** The runtime event bus, subscribe with `.on(type, cb)` / `.onDomain(domain, cb)`. */
  readonly events: RuntimeEventBus;
  /** The approval broker, the seam permission asks flow through. */
  readonly approvals: ApprovalBroker;
  /** The shared session broker backing this session. */
  readonly sessions: SharedSessionBroker;
  /**
   * Submit input to the session. Returns the broker's submission record and a
   * `completion` handle on the work it started. When the broker answers in
   * spawn mode (nothing is running for the input), the text starts a contract
   * and the record's `activeAgentId` is the contract's owner agent, bound to
   * the session; the handle follows that agent's stream and terminal event.
   */
  submit(input: string | EmbeddedSessionInput): Promise<EmbeddedSubmission>;
  /**
   * Cancel the in-flight work for one or more running agents (the agent ids a
   * submission reported as `activeAgentId`). This is a REAL cancellation: it
   * aborts the agent's in-flight provider call so the turn stops mid-flight and
   * emits its cancelled outcome, rather than only cancelling a still-queued
   * input. Unknown ids are ignored. Returns the number of agents actually
   * cancelled.
   */
  cancelActive(agentIds: Iterable<string>): number;
  /** Tear down the session and release the port. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Create an embedded GoodVibes session bound to a workspace. Boots an in-process
 * daemon, exposes its runtime bus / session broker / approval broker, and, when
 * a `requestPermission` callback is given, bridges pending approvals to it.
 */
export async function createEmbeddedSession(options: EmbedSessionOptions): Promise<EmbeddedSession> {
  const daemon = await bootDaemon({
    workingDir: options.workspace,
    homeDirectory: options.homeDirectory,
    ...(options.token !== undefined ? { token: options.token } : {}),
    ...(options.boot ?? {}),
  });
  const server = daemon.server;
  const events = server.eventBus;
  const sessions = server.sessions;
  const approvals = daemon.approvals;
  const surfaceKind: AutomationSurfaceKind = options.surfaceKind ?? 'webhook';
  const surfaceId = options.surfaceId ?? `embed-${randomUUID()}`;

  // Connect any embedder-declared MCP servers (e.g. an ACP client's session/new
  // servers) into the live MCP registry so their tools join the session surface.
  // A single server's failure is logged and skipped, it never aborts the session.
  for (const mcpServer of options.mcpServers ?? []) {
    try {
      await server.registerMcpServer(mcpServer);
    } catch (error) {
      logger.warn('createEmbeddedSession: failed to connect declared MCP server', {
        server: mcpServer.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Bridge an injected permission callback onto the broker: each pending
  // approval is answered by the callback and resolved with its decision.
  let unsubscribe: (() => void) | undefined;
  if (options.requestPermission) {
    const handler = options.requestPermission;
    const handled = new Set<string>();
    const deny = (approvalId: string, reason: string): Promise<unknown> =>
      approvals.resolveApproval(approvalId, { approved: false, reason, actor: 'embed', actorSurface: 'embed' })
        .catch((error: unknown) => {
          logger.warn('createEmbeddedSession: could not record a denial for an approval', {
            approvalId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    unsubscribe = approvals.subscribe((approval) => {
      if (approval.status !== 'pending' || handled.has(approval.id)) return;
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

  // Runs still being followed; stopping the session ends each as cancelled.
  const liveRuns = new Set<RunWatch>();

  return {
    workspace: options.workspace,
    url: daemon.url,
    events,
    approvals,
    sessions,
    submit: async (input) => {
      const body = typeof input === 'string' ? input : input.body;
      const structured = typeof input === 'string' ? undefined : input;
      // Subscribed before the submit: a run that fails at once can end before
      // the broker answers with the agent id, and its events are held until then.
      const watch = watchRun(events, liveRuns);
      try {
        const submission = await sessions.submitMessage({
          surfaceKind,
          surfaceId,
          body,
          ...(structured?.sessionId !== undefined ? { sessionId: structured.sessionId } : {}),
          ...(structured?.title !== undefined ? { title: structured.title } : {}),
          ...(structured?.metadata !== undefined ? { metadata: structured.metadata } : {}),
        });
        if (submission.mode !== 'spawn') {
          // Only a live agent that was handed this input is working on it; a
          // queued or refused input has nothing to follow yet.
          const agentId = submission.mode === 'continued-live' ? submission.activeAgentId : undefined;
          return { ...submission, completion: agentId
            ? watch.follow(agentId)
            : watch.notStarted(submission.state, notStartedReason(submission.mode)) };
        }
        // Spawn mode: nothing is running for this input yet. The submitted text
        // is the ask of a new contract (contract runner design 10.2), started
        // through the daemon's contracts operator surface in the daemon's
        // working directory (this workspace), and its owner agent is bound to the
        // session as the agent working on it.
        let started: Awaited<ReturnType<typeof server.contracts.start>>;
        try {
          started = await server.contracts.start({ ask: body, sessionId: submission.session.id });
        } catch (error) {
          // The input was recorded before the contract was refused. Fail it so no
          // queued input is left that nothing will run and a retry does not double up.
          await sessions.failInput(submission.session.id, submission.input.id, error instanceof Error ? error.message : String(error)).catch(() => null);
          throw error;
        }
        const bound = await sessions.bindAgent(submission.session.id, started.ownerAgentId, submission.input.id);
        return { ...submission, session: bound ?? submission.session, activeAgentId: started.ownerAgentId,
          completion: watch.follow(started.ownerAgentId) };
      } catch (error) {
        watch.abandon();
        throw error;
      }
    },
    cancelActive: (agentIds) => {
      let cancelled = 0;
      for (const agentId of agentIds) {
        if (server.cancelAgent(agentId)) cancelled += 1;
      }
      return cancelled;
    },
    stop: async () => {
      unsubscribe?.();
      for (const run of [...liveRuns]) run.end({ outcome: 'cancelled', reason: 'The embedded session stopped.' });
      await daemon.stop();
    },
  };
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
