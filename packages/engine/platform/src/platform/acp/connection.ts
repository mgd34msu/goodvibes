import { isProxy } from 'node:util/types';
/**
 * AcpConnection, Per-subagent ACP connection.
 *
 * Spawns a child process via Bun.spawn and connects to it via ClientSideConnection
 * using ndJsonStream over stdio. Implements the ACP Client interface so the
 * subagent can request permissions and send session updates.
 */

// `@agentclientprotocol/sdk` is an optionalDependency: its values are taken
// off the awaited module in acp/optional-acp-library.ts at the point the connection is
// built, never imported at module init. The type import below is erased.
import { loadAcpLibrary } from './optional-acp-library.js';
import type { ClientSideConnection } from '@agentclientprotocol/sdk';
import type {
  Client,
  Agent,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from './protocol.js';
import type { SubagentInfo, SubagentResult, SubagentTask } from './protocol.js';
import {
  ACP_HANDSHAKE_TIMEOUT_MS,
  drainStderrTail,
  messageChunkText,
  permissionOutcomeFor,
  readNdJsonMessages,
  stopAcpChild,
  wellFormedPermissionOptions,
  withTimeout,
} from './protocol.js';
import { admitExternalRequest, externalAskDeadlineMs, type ExternalPermissionHost, type ExternalOperationSource } from '../permissions/external-request.js';
import { AcpPermissionWire } from './permission-wire.js';
import { logger } from '../utils/logger.js';
import { AcpError } from '../types/errors.js';
import { VERSION } from '../version.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import {
  emitAgentCancelled,
  emitAgentCompleted,
  emitAgentFailed,
  emitAgentStreamDelta,
  emitTransportAuthenticating,
  emitTransportConnected,
  emitTransportDisconnected,
  emitTransportInitializing,
  emitTransportSyncing,
  emitTransportTerminalFailure,
} from '../runtime/emitters/index.js';
import type { HookDispatcher } from '../hooks/index.js';
import type { HookCategory, HookEventPath, HookPhase } from '../hooks/types.js';
import { summarizeError } from '../utils/error-display.js';
import type { AgentUsage } from '../../events/agents.js';

/** Most streamed text kept as the run's `output`; beyond it the text is cut and says so. */
const OUTPUT_CAP_CHARS = 64_000;

/** Shape of the (experimental/unstable) ACP `PromptResponse.usage` field. */
interface AcpPromptUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
}

/**
 * Map the ACP prompt response's usage field (`cachedReadTokens`/`cachedWriteTokens`,
 * ACP protocol naming) onto the platform's `AgentUsage` shape (`cacheReadTokens`/
 * `cacheWriteTokens`). Exported for unit testing without spawning a real
 * ACP subprocess.
 */
export function mapAcpUsage(usage: AcpPromptUsage | null | undefined): AgentUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedReadTokens != null ? { cacheReadTokens: usage.cachedReadTokens } : {}),
    ...(usage.cachedWriteTokens != null ? { cacheWriteTokens: usage.cachedWriteTokens } : {}),
  };
}

/** What a subagent connection is wired to besides its task and command. */
export interface AcpConnectionOptions {
  readonly runtimeBus?: RuntimeEventBus | null | undefined;
  readonly hookDispatcher?: Pick<HookDispatcher, 'fire'> | null | undefined;
  /** The owner of the child's permission asks; without one every ask is refused. */
  readonly permissionHost?: ExternalPermissionHost | undefined;
  /** The original goal the asks are judged against. */
  readonly operation?: ExternalOperationSource | undefined;
  /** Bound on the initialize and session/new handshake. */
  readonly handshakeTimeoutMs?: number | undefined;
}

/**
 * AcpConnection manages the lifecycle of a single subagent child process.
 *
 * Lifecycle:
 *   1. Construct with spawn params
 *   2. Call run(), spawns child, performs ACP handshake, starts a session
 *   3. Resolves with SubagentResult when the subagent completes or is cancelled
 *   4. Call cancel() to abort
 */
export class AcpConnection {
  public readonly id: string;
  private info: SubagentInfo;
  private spawnCmd: string[];
  private readonly lifetime = new AbortController();
  private permissionWire: AcpPermissionWire | undefined;
  private runtimeBus: RuntimeEventBus | null;
  private conn: ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private childProcess: ReturnType<typeof Bun.spawn> | null = null;
  private toolCallsMade = 0;
  /** Tail of the streamed text, for progress display only. */
  private lastProgressText = '';
  /** The streamed text kept for the final `output`, up to OUTPUT_CAP_CHARS. */
  private outputText = '';
  private outputTruncated = false;
  private stderr: { tail(): string } | null = null;
  private transportClosed = false;
  private stopping: Promise<void> | null = null;
  private readonly hookDispatcher: Pick<HookDispatcher, 'fire'> | null;
  private readonly permissionHost: ExternalPermissionHost | undefined;
  private readonly operation: ExternalOperationSource | undefined;
  private readonly handshakeTimeoutMs: number;

  constructor(
    id: string,
    private task: SubagentTask,
    spawnCmd: string[],
    options: AcpConnectionOptions = {},
  ) {
    this.id = id;
    this.task = { ...task, tools: [...task.tools] };
    this.spawnCmd = [...spawnCmd];
    this.runtimeBus = options.runtimeBus ?? null;
    this.hookDispatcher = options.hookDispatcher ?? null;
    this.permissionHost = options.permissionHost;
    this.operation = options.operation;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? ACP_HANDSHAKE_TIMEOUT_MS;
    this.info = {
      id,
      task: task.description,
      status: 'running',
      startedAt: Date.now(),
    };
  }

  /** Current info snapshot. */
  getInfo(): SubagentInfo {
    return { ...this.info };
  }

  /**
   * Spawn the child process, perform the ACP handshake, and run the prompt.
   * Resolves with SubagentResult when the subagent completes or errors.
   */
  async run(): Promise<SubagentResult> {
    const startedAt = this.info.startedAt;

    try {
      this.lifetime.signal.throwIfAborted();
      this.transportClosed = false;
      this.emitTransportInitializing();

      // 0. Resolve the ACP SDK. Inside the try, so an install without the
      //    optional package fails this subagent run with a message naming it
      //    rather than preventing the process from starting.
      const { ClientSideConnection } = await loadAcpLibrary();
      this.lifetime.signal.throwIfAborted();

      // 1. Spawn child process with piped stdio
      this.childProcess = Bun.spawn(this.spawnCmd, {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      this.stderr = drainStderrTail(this.childProcess.stderr);

      // 2. Wire the child's stdio. The permission wire is the one serialiser of
      // what is sent (it holds an approved answer until its bytes go out); the
      // child's stdout is read as one JSON message per line.
      if (!this.childProcess.stdin) {
        throw new AcpError('ACP subprocess stdin not available, was it spawned with stdin: "pipe"?');
      }
      const bunStdin = this.childProcess.stdin as import('bun').FileSink;
      // Bun's piped stdout is ReadableStream-shaped at runtime.
      const stdout = readNdJsonMessages(this.childProcess.stdout as unknown as ReadableStream<Uint8Array>);

      const ownedChild = this.childProcess;
      // An ask belongs to the session and child that were live when it arrived;
      // config, deadline and the original goal are the admission's to check.
      this.permissionWire = new AcpPermissionWire(() => {
        const sessionId = this.sessionId;
        return { assertCurrent: () => {
          this.lifetime.signal.throwIfAborted();
          if (!sessionId || this.sessionId !== sessionId || this.childProcess !== ownedChild) throw new Error('the subagent session that raised this ask has ended');
        }, close: () => {} };
      });
      const wire = this.permissionWire;
      type WireMessage = typeof stdout extends ReadableStream<infer Message> ? Message : never;
      const readable = stdout.pipeThrough(new TransformStream<WireMessage, WireMessage>({ transform(message, controller) {
        wire.observe(message); controller.enqueue(message);
      } }));
      const writable = new WritableStream<WireMessage>({
        write(message) { wire.write(message, bytes => { bunStdin.write(bytes); }); },
        close() { bunStdin.end(); }, abort() { bunStdin.end(); },
      });

      // 3. Build the Client implementation that handles agent callbacks
      const clientImpl: Client = this.buildClientImpl();

      // 4. Create the ClientSideConnection (TUI = ACP client, child = ACP agent)
      this.conn = new ClientSideConnection((_agent: Agent) => clientImpl, { readable, writable });

      // 5. ACP handshake: initialize (protocolVersion is a number)
      this.emitTransportAuthenticating();
      await withTimeout(this.conn.initialize({
        protocolVersion: 1,
        clientInfo: { name: 'goodvibes-platform', version: VERSION },
        clientCapabilities: {},
      }), this.handshakeTimeoutMs, 'ACP initialize');

      this.lifetime.signal.throwIfAborted();

      // 6. Create a session (cwd is required, mcpServers is required)
      const sessionResp = await withTimeout<{ readonly sessionId: string }>(this.conn.newSession({
        cwd: this.task.workingDirectory,
        mcpServers: [],
      }), this.handshakeTimeoutMs, 'ACP session/new');
      this.lifetime.signal.throwIfAborted();
      this.sessionId = sessionResp.sessionId;
      this.emitTransportConnected();
      this.emitTransportSyncing();

      // 7. Send the prompt (uses 'prompt' field with ContentBlock array)
      const promptResp = await this.conn.prompt({
        sessionId: this.sessionId,
        prompt: [
          {
            type: 'text' as const,
            text: this.buildPromptText(),
          },
        ],
      });

      this.lifetime.signal.throwIfAborted();
      // Only `end_turn` is finished work: a refusal, a token or turn limit or a
      // cancel left the task incomplete, and the parent must not read it as done.
      const finished = promptResp.stopReason === 'end_turn';
      const streamed = this.outputText + (this.outputTruncated ? `\n[output truncated at ${OUTPUT_CAP_CHARS} characters]` : '');
      const output = finished
        ? streamed || `Completed with stop reason: ${promptResp.stopReason}`
        : `Stopped before finishing (stop reason: ${promptResp.stopReason})${streamed ? `:\n${streamed}` : '.'}`;
      const result: SubagentResult = {
        id: this.id,
        success: finished,
        output,
        toolCallsMade: this.toolCallsMade,
        duration: Date.now() - startedAt,
      };

      // The first terminal outcome wins: a cancel that already settled this run
      // is not overwritten, and no second terminal event is emitted.
      const cancelledByChild = promptResp.stopReason === 'cancelled';
      if (!this.settle(finished ? 'complete' : cancelledByChild ? 'cancelled' : 'error')) return result;
      if (this.runtimeBus) {
        if (finished) {
          emitAgentCompleted(this.runtimeBus, this.emitterContext(), {
            agentId: this.id,
            durationMs: result.duration,
            output: result.output,
            toolCallsMade: result.toolCallsMade,
            usage: mapAcpUsage(promptResp.usage),
          });
        } else if (cancelledByChild) {
          emitAgentCancelled(this.runtimeBus, this.emitterContext(), {
            agentId: this.id,
            reason: 'ACP agent ended the prompt as cancelled',
          });
        } else {
          emitAgentFailed(this.runtimeBus, this.emitterContext(), {
            agentId: this.id,
            error: result.output,
            durationMs: result.duration,
          });
        }
      }
      this.emitTransportDisconnected(finished ? 'ACP session completed' : `ACP session stopped (${promptResp.stopReason})`, false);
      return result;
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(summarizeError(err));
      const stderrTail = this.stderr?.tail();
      const error = stderrTail ? new Error(`${cause.message} (agent stderr: ${stderrTail})`) : cause;
      const failureResult = {
        id: this.id,
        success: false,
        output: error.message,
        toolCallsMade: this.toolCallsMade,
        duration: Date.now() - startedAt,
      };
      if (!this.settle('error')) return failureResult;
      if (this.runtimeBus) {
        emitAgentFailed(this.runtimeBus, this.emitterContext(), {
          agentId: this.id,
          error: error.message,
          durationMs: Date.now() - startedAt,
        });
      }
      this.emitTransportTerminalFailure(error.message);
      return failureResult;
    } finally {
      void this.cleanup();
    }
  }

  /** Cancel the running subagent. */
  async cancel(): Promise<void> {
    // Aborting the lifetime makes a parked run() throw; claim the outcome first
    // so that throw reads as this cancel, not as a separate failure.
    const won = this.settle('cancelled');
    this.lifetime.abort();
    this.permissionWire?.close();
    if (this.conn && this.sessionId) {
      try {
        await this.conn.cancel({ sessionId: this.sessionId });
      } catch (err) {
        // If protocol cancel fails, still kill the child process.
        logger.error('AcpConnection.cancel: failed to send cancel to subagent', { id: this.id, err: summarizeError(err) });
      }
    }
    if (won) {
      if (this.runtimeBus) {
        emitAgentCancelled(this.runtimeBus, this.emitterContext(), {
          agentId: this.id,
          reason: 'ACP session cancelled',
        });
      }
      this.emitTransportDisconnected('ACP session cancelled', false);
    }
    // Cancelled means the child has exited: a subagent still writing files
    // after its parent moved on is the thing this wait rules out.
    await this.cleanup();
  }

  /** Record a terminal status unless one is already recorded. Returns whether this call set it. */
  private settle(status: 'complete' | 'error' | 'cancelled'): boolean {
    if (this.info.status === 'complete' || this.info.status === 'error' || this.info.status === 'cancelled') return false;
    this.info.status = status;
    return true;
  }

  private emitterContext(): import('../runtime/emitters/index.js').EmitterContext {
    return {
      sessionId: this.task.sessionId ?? 'acp-connection',
      traceId: `acp-connection:${this.id}`,
      source: 'acp-connection',
    };
  }

  private transportId(): string {
    return `acp:${this.id}`;
  }

  private transportEndpoint(): string {
    return `stdio://subagent/${this.id}`;
  }

  private emitTransportInitializing(): void {
    if (!this.runtimeBus) return;
    emitTransportInitializing(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
      protocol: 'acp-stdio',
    });
    void this.fireTransportHook('initializing', {
      transportId: this.transportId(),
      protocol: 'acp-stdio',
    });
  }

  private emitTransportAuthenticating(): void {
    if (!this.runtimeBus) return;
    emitTransportAuthenticating(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
    });
    void this.fireTransportHook('authenticating', {
      transportId: this.transportId(),
    });
  }

  private emitTransportConnected(): void {
    if (!this.runtimeBus) return;
    emitTransportConnected(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
      endpoint: this.transportEndpoint(),
    });
    void this.fireTransportHook('connected', {
      transportId: this.transportId(),
      endpoint: this.transportEndpoint(),
    });
  }

  private emitTransportSyncing(): void {
    if (!this.runtimeBus) return;
    emitTransportSyncing(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
    });
    void this.fireTransportHook('syncing', {
      transportId: this.transportId(),
    });
  }

  private emitTransportDisconnected(reason: string, willRetry: boolean): void {
    if (!this.runtimeBus || this.transportClosed) return;
    this.transportClosed = true;
    emitTransportDisconnected(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
      reason,
      willRetry,
    });
    void this.fireTransportHook('disconnected', {
      transportId: this.transportId(),
      reason,
      willRetry,
    });
  }

  private emitTransportTerminalFailure(error: string): void {
    if (!this.runtimeBus || this.transportClosed) return;
    this.transportClosed = true;
    emitTransportTerminalFailure(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
      error,
    });
    void this.fireTransportHook('failed', {
      transportId: this.transportId(),
      error,
    });
  }

  private async fireTransportHook(specific: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.hookDispatcher) return;
    try {
      await this.hookDispatcher.fire({
        path: `Lifecycle:transport:${specific}` as HookEventPath,
        phase: 'Lifecycle' as HookPhase,
        category: 'transport' as HookCategory,
        specific,
        sessionId: this.task.sessionId ?? 'acp-connection',
        timestamp: Date.now(),
        payload,
      });
    } catch (error) {
      logger.warn('AcpConnection transport hook failed', {
        id: this.id,
        specific,
        error: summarizeError(error),
      });
    }
  }

  /** Revoke the run's authority and stop the child; every caller shares one stop. */
  private cleanup(): Promise<void> {
    this.lifetime.abort();
    this.permissionWire?.close();
    if (!this.stopping) {
      const child = this.childProcess;
      this.stopping = child
        ? stopAcpChild(child).catch((error: unknown) => {
          logger.error('AcpConnection: the subagent process could not be stopped', { id: this.id, pid: child.pid, err: summarizeError(error) });
        })
        : Promise.resolve();
    }
    this.childProcess = null;
    this.conn = null;
    this.sessionId = null;
    return this.stopping;
  }

  /** Why an ask was refused without a decision on its merits: logged once and kept on the run's info. */
  private refuse(reason: string): RequestPermissionResponse {
    this.info.lastRefusal = { at: Date.now(), reason };
    logger.warn('AcpConnection: permission ask refused', { id: this.id, reason });
    return { outcome: { outcome: 'cancelled' } };
  }

  private buildClientImpl(): Client {
    return {
      /** same recorded autonomous owner and final wire fence as host ACP. */
      requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
        let binding: ReturnType<AcpPermissionWire['binding']>;
        let admission: Awaited<ReturnType<typeof admitExternalRequest>> | undefined;
        let deferred = false;
        let deadline: AbortSignal | undefined;
        let deadlineMs = 0;
        try {
          if (isProxy(params)) return this.refuse('the permission ask could not be read');
          const call = Object.getOwnPropertyDescriptor(params, 'toolCall')?.value as unknown;
          if (isProxy(call)) return this.refuse('the permission ask could not be read');
          const id = call && typeof call === 'object' ? Object.getOwnPropertyDescriptor(call, 'toolCallId')?.value as unknown : undefined;
          if (typeof id !== 'string') return this.refuse('the permission ask has no tool call id');
          binding = this.permissionWire?.binding(id);
          binding?.bindTerminal(cancelled);
          if (this.lifetime.signal.aborted) return cancelled;
          const owned = binding?.request;
          const protocolSubject = binding?.protocolSubject;
          const host = this.permissionHost, operation = this.operation;
          if (!host || !operation) return this.refuse('no permission owner is configured for subagents, so asks cannot be decided');
          if (!binding || !owned || !protocolSubject) return this.refuse('the permission ask was not a well-formed ACP request');
          if (!this.sessionId || owned.sessionId !== this.sessionId || !owned.toolCall.toolCallId || !wellFormedPermissionOptions(owned.options))
            return this.refuse('the permission ask named another session or offered malformed options');
          deadlineMs = externalAskDeadlineMs(host);
          deadline = AbortSignal.timeout(deadlineMs);
          const signal = AbortSignal.any([this.lifetime.signal, binding.signal, deadline]);
          const wire = binding;
          const assertCurrent = () => { signal.throwIfAborted(); wire.assertCurrent(); operation.assertCurrent(); };
          assertCurrent();
          // Capture the actual originating goal, never the child tool title or generated task prose.
          admission = await admitExternalRequest(host, { connectionId: this.id, destination: this.spawnCmd[0] ?? '', signal, assertCurrent },
            { ...operation, assertCurrent: () => {} }, {
              tool: owned.toolCall.title ?? 'ACP action', protocolSubject,
              args: { ...(owned.toolCall.rawInput && typeof owned.toolCall.rawInput === 'object' && !Array.isArray(owned.toolCall.rawInput)
                ? owned.toolCall.rawInput as Record<string, unknown> : {}), destination: { command: this.spawnCmd, cwd: this.task.workingDirectory } },
            });
          const response = permissionOutcomeFor(owned.options, { approved: admission.result.approved, remember: false });
          // The wire checks once more, immediately before the response bytes are written.
          wire.defer(response, admission, admission.result.approved && response.outcome.outcome === 'selected', () => {});
          deferred = true;
          return response;
        } catch (error) {
          if (this.lifetime.signal.aborted) return cancelled;
          return this.refuse(deadline?.aborted
            ? `the permission decision did not arrive within ${deadlineMs} ms (judgment.decisionDeadlineMs)`
            : `the permission ask could not be decided: ${summarizeError(error)}`);
        } finally { if (!deferred) admission?.close(); }
      },

      /** Handle session update notifications from the subagent. */
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        const update = params.update;

        // Count tool calls
        if (update.sessionUpdate === 'tool_call') {
          this.toolCallsMade++;
        }

        // Collect streamed text: the whole answer (capped) for `output`, a short tail for progress.
        const text = messageChunkText(update);
        if (text) {
          const room = OUTPUT_CAP_CHARS - this.outputText.length;
          this.outputText += text.slice(0, Math.max(room, 0));
          if (text.length > room) this.outputTruncated = true;
          this.lastProgressText = (this.lastProgressText + text).slice(-1000);
          this.info.progress = this.lastProgressText.slice(-200);
          if (this.runtimeBus) {
            emitAgentStreamDelta(this.runtimeBus, this.emitterContext(), {
              agentId: this.id,
              content: text,
              accumulated: this.lastProgressText,
            });
          }
        }
      },
    };
  }

  private buildPromptText(): string {
    const parts: string[] = [`Task: ${this.task.description}`];

    if (this.task.context) {
      parts.push(`Context:\n${this.task.context}`);
    }

    if (this.task.tools.length > 0) {
      parts.push(`Available tools: ${this.task.tools.join(', ')}`);
    }

    if (this.task.model) {
      parts.push(`Use model: ${this.task.model}`);
    }

    return parts.join('\n\n');
  }
}
