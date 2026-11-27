/**
 * agent.ts, the AGENT side of the Agent Client Protocol (ACP).
 *
 * Exposes a GoodVibes session as an ACP agent so ACP-capable editors (Zed and
 * others) can drive GoodVibes over stdio: initialize/authenticate → session
 * lifecycle → streamed content + tool-call updates → permission requests
 * mapped onto the platform permission callback.
 *
 * The substrate is the platform Embedding API (`createEmbeddedSession`): each
 * ACP session is one embedded session, holding its own shared session, on the
 * one embedded GoodVibes daemon of the process and home directory (the embed
 * layer decides which sessions share a daemon). A prompt is one submitted
 * input; the submission's completion handle (the agent that took the input:
 * its streamed text, tool calls and terminal event) becomes ACP
 * `session/update` notifications and the prompt's stop reason. No new engine,
 * the adapter is a protocol mapping over the embed surface. `session/close`
 * ends a session; the daemon stops when no session uses it.
 *
 * Honest capability surface (see `initialize`): anything the platform does not
 * support is reported `false`, never stubbed,
 *   - `loadSession: false` (no session restore over ACP)
 *   - prompt `image`/`audio`/`embeddedContext`: false (input is text; the
 *     submit seam takes a text body)
 *   - `mcpCapabilities.http`/`sse`: false (our MCP client is stdio JSON-RPC
 *     only). STDIO `mcpServers` declared in `session/new` ARE wired into the
 *     embedded session's tool surface; an http/sse entry is rejected by name
 *     (a compliant client never sends one, given the advertised capabilities).
 * Turn cancellation is real: `session/cancel` aborts the session's active
 * agent(s) in-flight (`EmbeddedSession.cancelActive` → the agent's cancellation
 * signal, which the agent runner threads into the provider call), so an
 * already-executing provider call is stopped mid-flight and the agent emits its
 * cancelled outcome. A still-queued input (not yet delivered to an agent) is
 * additionally cancelled via the broker's `cancelInput`, and the in-flight
 * prompt resolves with stop reason `cancelled`.
 */

// `@agentclientprotocol/sdk` is an optionalDependency, so its VALUES are taken
// off the awaited module in acp/optional-acp-library.ts rather than imported here. The
// type imports below stay type-only and are erased; see optional-acp-library.ts.
import { loadAcpLibrary } from './optional-acp-library.js';
import type { AgentSideConnection, Agent } from '@agentclientprotocol/sdk';
import type {
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PermissionOption,
  PromptRequest,
  PromptResponse,
  StopReason,
} from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { GOODVIBES_TUI_SURFACE_ROOT, resolveGoodVibesHome } from '../config/goodvibes-home.js';
import {
  createEmbeddedSession,
  type EmbeddedRunEvent,
  type EmbeddedRunOutcome,
  type EmbeddedSession,
  type EmbeddedSubmission,
} from '../embed/session.js';
import type { PermissionPromptDecision, PermissionPromptRequest, PermissionRequestHandler } from '../permissions/prompt.js';
import type { McpServerConfig } from '../mcp/config.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { OwnedScope } from '../utils/owned-work.js';
import type { TurnInputParty } from '../security/turn-input-party.js';

/** Factory seam for the embedded-session substrate (tests inject fakes). */
export type EmbeddedSessionFactory = (options: {
  readonly workspace: string;
  readonly requestPermission: PermissionRequestHandler;
  /** stdio MCP servers the ACP client declared, translated for the embedded session. */
  readonly mcpServers?: readonly McpServerConfig[] | undefined;
}) => Promise<EmbeddedSession>;

/**
 * The ACP `mcpServers` entry shapes (from the ACP schema): a stdio server
 * (untagged, carrying `command`) or an http/sse server (tagged `type`, carrying
 * `url`). Modeled locally and read defensively because the vendor types degrade
 * to `any` when the ACP SDK types are absent.
 */
interface AcpEnvVariable { readonly name: string; readonly value: string }
interface AcpMcpServerDeclaration {
  readonly type?: string | undefined;
  readonly name?: string | undefined;
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: readonly AcpEnvVariable[] | undefined;
  readonly url?: string | undefined;
}

/**
 * Translate a client's declared ACP MCP servers into our stdio `McpServerConfig`
 * shape. Returns the supported stdio configs and the names of servers we
 * genuinely cannot support (http/sse, no such transport in our MCP client,
 * which is stdio JSON-RPC only). We advertise `mcpCapabilities.http/sse: false`
 * in `initialize`, so a compliant client never sends those; when one arrives
 * anyway it is reported by name rather than silently dropped.
 */
export function translateAcpMcpServers(
  servers: readonly AcpMcpServerDeclaration[],
): { readonly configs: McpServerConfig[]; readonly unsupported: string[] } {
  const configs: McpServerConfig[] = [];
  const unsupported: string[] = [];
  for (const server of servers) {
    const transport = server.type;
    const isRemote = transport === 'http' || transport === 'sse' || (server.url !== undefined && server.command === undefined);
    if (isRemote) {
      unsupported.push(`${server.name ?? server.url ?? 'unnamed'} (${transport ?? 'http/sse'})`);
      continue;
    }
    if (!server.name || !server.command) {
      unsupported.push(`${server.name ?? 'unnamed'} (missing command)`);
      continue;
    }
    const env: Record<string, string> = {};
    for (const variable of server.env ?? []) {
      if (variable && typeof variable.name === 'string') env[variable.name] = String(variable.value ?? '');
    }
    configs.push({
      name: server.name,
      command: server.command,
      ...(server.args && server.args.length > 0 ? { args: [...server.args] } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    });
  }
  return { configs, unsupported };
}

export interface AcpAgentOptions {
  /** Tree root handed to the embedded daemon. Defaults to the process's GoodVibes home. */
  readonly homeDirectory?: string | undefined;
  /** Substrate override; defaults to `createEmbeddedSession`. */
  readonly sessionFactory?: EmbeddedSessionFactory | undefined;
  /**
   * Whose input this connection's prompts are (security/turn-input-party.ts). The owner's when this is their own program
   * on a connection they started (`goodvibes acp` launched by their editor: products/tui `acp-command.ts`); someone else's
   * when the program was started for anyone else (the daemon's runner or hosted agent for another caller says so:
   * acp/connection-party.ts `ACP_STARTED_FOR_ENV`). Absent: someone else's.
   */
  readonly inputParty?: TurnInputParty | undefined;
}

/** `session/close` (ACP schema 0.21): the session to end, and an empty answer. */
interface CloseSessionRequest { readonly sessionId: string }
type CloseSessionResponse = Record<string, never>;

interface ActivePrompt {
  /** True while `submit` is still resolving: there is nothing to abort yet. */
  submitting: boolean;
  /** Set once the broker has accepted the input. */
  inputId: string | undefined;
  resolve: (stopReason: StopReason) => void;
}

interface AcpSessionState {
  readonly cwd: string;
  /** This session's embedded session; its permission asks come back tagged with this ACP session. */
  readonly embedded: EmbeddedSession;
  /** The shared session inside the daemon that holds this editor thread. */
  readonly sharedSessionId: string;
  /** Agents this session's prompts started; cancel uses them. */
  readonly agentIds: Set<string>;
  /** The prompt in flight, from the moment it is accepted until it resolves. At most one per session. */
  activePrompt: ActivePrompt | null;
  /** `session/cancel` arrived for the current prompt. Reset when the next prompt starts. */
  cancelled: boolean;
}

const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
];

/** Extract the text of a prompt: text blocks verbatim, resource links by URI. */
export function promptText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'resource_link') parts.push(block.uri);
    // image/audio/resource are refused via promptCapabilities; skip defensively.
  }
  return parts.join('\n\n');
}

/**
 * Map how a run ended onto an ACP stop reason. A run that failed or never
 * started has none: the prompt request ends with an error saying why
 * (outcomeText), never as a refusal the model did not make.
 */
export function stopReasonFor(outcome: EmbeddedRunOutcome): StopReason | undefined {
  switch (outcome.outcome) {
    case 'completed': return 'end_turn';
    case 'cancelled': return 'cancelled';
    case 'failed':
    case 'not-started':
      return undefined;
  }
}

/**
 * The line shown to the editor about how a run ended, or null when the
 * streamed text already said everything. A stop reason alone cannot say why a
 * run failed or never started; a completed run that streamed nothing shows its
 * final output.
 */
export function outcomeText(outcome: EmbeddedRunOutcome, streamedText: boolean): string | null {
  switch (outcome.outcome) {
    case 'completed': return !streamedText && outcome.output ? outcome.output : null;
    case 'failed': return `The run failed: ${outcome.error}`;
    case 'not-started': return `Nothing ran (${outcome.state}): ${outcome.reason}`;
    case 'cancelled': return null;
  }
}

/** Map an ACP permission outcome back onto the platform decision shape. */
export function mapPermissionOutcome(
  outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string },
): PermissionPromptDecision {
  if (outcome.outcome === 'cancelled') return { approved: false };
  switch (outcome.optionId) {
    case 'allow-once':
      return { approved: true };
    case 'allow-always':
      return { approved: true, remember: true };
    default:
      return { approved: false };
  }
}

/**
 * The ACP `Agent` implementation backed by embedded GoodVibes sessions.
 * One instance serves one connection. Each ACP session is one embedded
 * session with one shared session in it; the embedded sessions of one home
 * directory run on one daemon.
 */
export class GoodVibesAcpAgent implements Agent {
  private readonly sessions = new Map<string, AcpSessionState>();
  /** Owns each session still being opened: one that lands after dispose() is stopped, never added. */
  readonly #opening = new OwnedScope('ACP agent sessions');

  constructor(
    private readonly conn: Pick<AgentSideConnection, 'sessionUpdate' | 'requestPermission'>,
    private readonly options: AcpAgentOptions = {},
  ) {}

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    const { PROTOCOL_VERSION } = await loadAcpLibrary();
    return {
      protocolVersion: Math.min(params.protocolVersion, PROTOCOL_VERSION),
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { close: {} },
      },
      authMethods: [],
    };
  }

  /** No authentication required: the embedded daemon is process-local. */
  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse | void> {
    return;
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const acpSessionId = `gv-${randomUUID()}`;
    // Translate the client's declared MCP servers: stdio servers are wired into
    // the session's tool surface; http/sse servers are genuinely unsupported (our
    // MCP client is stdio JSON-RPC only) and rejected by name rather than dropped.
    const declared = Array.isArray((params as { mcpServers?: unknown }).mcpServers)
      ? ((params as { mcpServers: unknown[] }).mcpServers as Parameters<typeof translateAcpMcpServers>[0])
      : [];
    const { configs: mcpServers, unsupported } = translateAcpMcpServers(declared);
    if (unsupported.length > 0) {
      throw new Error(
        `ACP session/new declared MCP server(s) with an unsupported transport: ${unsupported.join(', ')}. ` +
        `This agent supports stdio MCP servers only (it advertises mcpCapabilities.http=false, sse=false).`,
      );
    }
    const cwd = resolve(params.cwd);
    const factory: EmbeddedSessionFactory =
      this.options.sessionFactory ??
      (async ({ workspace, requestPermission, mcpServers: servers }) =>
        createEmbeddedSession({
          workspace,
          homeDirectory: this.options.homeDirectory ?? resolveGoodVibesHome(),
          requestPermission,
          // The editor's thread is the person's own, as in the terminal app: its
          // input is first-party, and the model, providers and permission mode
          // are the ones the terminal app's settings name.
          surfaceKind: 'tui',
          boot: { settingsSurfaceRoot: GOODVIBES_TUI_SURFACE_ROOT },
          // Whose input it is: the connection's party, never the owner's unless the program said so.
          ...(this.options.inputParty ? { inputParty: this.options.inputParty } : {}),
          ...(servers && servers.length > 0 ? { mcpServers: servers } : {}),
        }));
    const state = await this.#opening.opening(`ACP session ${acpSessionId}`, async (signal): Promise<AcpSessionState> => {
      const embedded = await factory({
        workspace: cwd,
        requestPermission: (request) => this.bridgePermission(acpSessionId, request),
        ...(mcpServers.length > 0 ? { mcpServers } : {}),
      });
      try {
        signal.throwIfAborted();
        const shared = await embedded.sessions.createSession({ project: cwd, title: `ACP session ${acpSessionId}` });
        return { cwd, embedded, sharedSessionId: shared.id, agentIds: new Set(), activePrompt: null, cancelled: false };
      } catch (error) {
        await this.stopEmbedded(cwd, embedded);
        throw error;
      }
    }, opened => this.stopEmbedded(opened.cwd, opened.embedded));
    this.sessions.set(acpSessionId, state);
    return { sessionId: acpSessionId };
  }

  private async stopEmbedded(cwd: string, embedded: EmbeddedSession): Promise<void> {
    await embedded.stop().catch((error: unknown) => {
      logger.warn('ACP embedded session did not stop cleanly', { cwd, error: summarizeError(error) });
    });
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const state = this.sessions.get(params.sessionId);
    if (!state) throw new Error(`Unknown ACP session: ${params.sessionId}`);
    if (state.activePrompt) {
      throw new Error(
        `ACP session ${params.sessionId} already has a prompt running; wait for it to finish or send session/cancel before prompting again.`,
      );
    }
    state.cancelled = false;

    return new Promise<PromptResponse>((resolvePrompt, rejectPrompt) => {
      let finished = false;
      let offEvents: () => void = () => {};
      const finish = (stopReason: StopReason): void => {
        if (finished) return;
        finished = true;
        offEvents();
        state.activePrompt = null;
        resolvePrompt({ stopReason });
      };
      const active: ActivePrompt = { submitting: true, inputId: undefined, resolve: finish };
      state.activePrompt = active;

      void (async () => {
        let submission: EmbeddedSubmission;
        try {
          submission = await state.embedded.submit({ body: promptText(params.prompt), sessionId: state.sharedSessionId });
        } catch (error) {
          finished = true;
          state.activePrompt = null;
          rejectPrompt(error);
          return;
        }
        const { completion } = submission;
        if (completion.agentId) state.agentIds.add(completion.agentId);
        active.submitting = false;
        active.inputId = submission.input?.id;
        // A cancel that arrived while submit was resolving had nothing to abort
        // yet; apply it now that the agent and input ids are known.
        if (state.cancelled) {
          await this.cancelWork(state, active.inputId);
          finish('cancelled');
          return;
        }
        let streamedText = false;
        offEvents = completion.onEvent((event) => {
          if (finished) return;
          if (event.type === 'text') streamedText = true;
          this.forwardRunEvent(params.sessionId, event);
        });
        const outcome = await completion.done;
        if (finished) return;
        const stopReason = state.cancelled ? 'cancelled' : stopReasonFor(outcome);
        if (stopReason === undefined) {
          // A failed or never-started run is reported to the editor as an error, with what happened.
          finished = true;
          offEvents();
          state.activePrompt = null;
          rejectPrompt(new Error(outcomeText(outcome, streamedText) ?? 'The run failed.'));
          return;
        }
        const text = state.cancelled ? null : outcomeText(outcome, streamedText);
        if (text) {
          this.notify({
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
          });
        }
        finish(stopReason);
      })();
    });
  }

  async cancel(params: CancelNotification): Promise<void> {
    const state = this.sessions.get(params.sessionId);
    if (!state) return;
    state.cancelled = true;
    const active = state.activePrompt;
    if (!active) {
      state.embedded.cancelActive(state.agentIds);
      return;
    }
    // Still inside `submit`: no ids to abort yet. `prompt` applies the cancel
    // as soon as the submission returns, and resolves it then.
    if (active.submitting) return;
    await this.cancelWork(state, active.inputId);
    active.resolve('cancelled');
  }

  /** `session/close`: end the session's work and its embedded session; the daemon stops when no session uses it. */
  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const state = this.sessions.get(params.sessionId);
    if (!state) return {};
    await this.cancel({ sessionId: params.sessionId });
    this.sessions.delete(params.sessionId);
    await state.embedded.sessions.closeSession(state.sharedSessionId).catch((error: unknown) => {
      logger.warn('ACP shared session could not be closed', { sessionId: params.sessionId, error: summarizeError(error) });
    });
    await this.stopEmbedded(state.cwd, state.embedded);
    return {};
  }

  /**
   * Real cancellation: abort the agents this session started so the running
   * turn stops mid-provider-call and emits its cancelled outcome, rather than
   * running to completion. A still-queued input, which cancelActive cannot
   * reach because it has not been delivered to an agent, is cancelled through
   * the broker.
   */
  private async cancelWork(state: AcpSessionState, inputId: string | undefined): Promise<void> {
    state.embedded.cancelActive(state.agentIds);
    if (inputId) {
      await state.embedded.sessions.cancelInput(state.sharedSessionId, inputId).catch(() => null);
    }
  }

  /** Send a session update; a closed or failing client connection is logged, never an unhandled rejection. */
  private notify(notification: Parameters<AgentSideConnection['sessionUpdate']>[0]): void {
    try {
      Promise.resolve(this.conn.sessionUpdate(notification)).catch((error: unknown) => {
        logger.warn('ACP session update could not be delivered', { error: summarizeError(error) });
      });
    } catch (error) {
      logger.warn('ACP session update could not be delivered', { error: summarizeError(error) });
    }
  }

  /** Tear down every embedded session (used by serveAcpAgent on stream end); the daemon stops with the last. */
  async dispose(): Promise<void> {
    // Opens still in flight are stopped as they land (bounded); one that never lands is named.
    const report = await this.#opening.close('the ACP connection ended');
    if (report.stillRunning.length > 0) logger.warn('ACP sessions were still opening when the connection ended', { stillRunning: report.stillRunning.map(entry => entry.label) });
    const states = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(states.map((state) => state.embedded.stop()));
  }

  /**
   * Show a permission ask in the editor thread of the ACP session it belongs
   * to. The embed layer hands each ask to the session whose agent asked (and
   * refuses one no session can be named for), so it arrives already routed.
   */
  private async bridgePermission(acpSessionId: string, request: PermissionPromptRequest): Promise<PermissionPromptDecision> {
    const response = await this.conn.requestPermission({
      sessionId: acpSessionId,
      toolCall: {
        toolCallId: request.callId,
        title: request.tool,
        status: 'pending',
        rawInput: request.args,
      },
      options: PERMISSION_OPTIONS,
    });
    return mapPermissionOutcome(response.outcome as Parameters<typeof mapPermissionOutcome>[0]);
  }

  private forwardRunEvent(acpSessionId: string, event: EmbeddedRunEvent): void {
    switch (event.type) {
      case 'text':
        this.notify({
          sessionId: acpSessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.text } },
        });
        return;
      case 'progress':
        // Why the answer is late (a provider error being retried): said in the thread, not left as silence.
        this.notify({
          sessionId: acpSessionId,
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: event.text } },
        });
        return;
      case 'tool-started':
        this.notify({
          sessionId: acpSessionId,
          update: { sessionUpdate: 'tool_call', toolCallId: event.callId, title: event.tool, status: 'in_progress' },
        });
        return;
      case 'tool-settled':
        this.notify({
          sessionId: acpSessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: event.callId,
            status: event.ok ? 'completed' : 'failed',
            ...(event.ok || event.error === undefined
              ? {}
              : { content: [{ type: 'content', content: { type: 'text', text: event.error } }] }),
          },
        });
        return;
    }
  }
}

/** The byte streams an ACP agent speaks over; the process's stdin/stdout unless supplied. */
export interface AcpStdio {
  readonly input: ReadableStream<Uint8Array>;
  readonly output: WritableStream<Uint8Array>;
}

/**
 * Serve a GoodVibes ACP agent over stdio. Call from a headless entry point;
 * returns the connection and a dispose handle (the caller owns process exit).
 *
 * Async because `@agentclientprotocol/sdk` is an optionalDependency and the
 * connection cannot be built before it resolves. When the package is absent
 * the returned promise rejects with an error naming it, which is the honest
 * answer for an entry point whose whole job is to speak that protocol.
 */
export async function serveAcpAgent(options: AcpAgentOptions = {}, stdio?: AcpStdio): Promise<{
  connection: AgentSideConnection;
  dispose: () => Promise<void>;
}> {
  const { AgentSideConnection, ndJsonStream } = await loadAcpLibrary();
  let agent: GoodVibesAcpAgent | null = null;
  const stdout = stdio?.output ?? new WritableStream<Uint8Array>({
    write(chunk) {
      process.stdout.write(chunk);
    },
  });
  const stdin = stdio?.input ?? new ReadableStream<Uint8Array>({
    start(controller) {
      process.stdin.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
        // Stop reading while the protocol layer is behind; `pull` resumes.
        if ((controller.desiredSize ?? 1) <= 0) process.stdin.pause();
      });
      process.stdin.on('end', () => controller.close());
      process.stdin.on('error', (error) => controller.error(error));
    },
    pull() {
      process.stdin.resume();
    },
  });
  const connection = new AgentSideConnection((conn) => {
    agent = new GoodVibesAcpAgent(conn, options);
    return agent;
  }, ndJsonStream(stdout, stdin));
  return {
    connection,
    dispose: async () => {
      await agent?.dispose();
    },
  };
}
