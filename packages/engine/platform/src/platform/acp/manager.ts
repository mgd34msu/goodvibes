import { captureAutonomousSource, retainAutonomousSource } from '../permissions/autonomous.js';
import { currentExternalOperationSource } from '../permissions/external-operation-scope.js';
import type { ExternalPermissionHost, ExternalOperationSource } from '../permissions/external-request.js';
/**
 * AcpManager, Manages the lifecycle of all subagent ACP connections.
 *
 * The TUI orchestrator calls spawn() when it needs to delegate work.
 * The manager tracks active subagents and provides cancel / waitAll.
 */

import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AcpConnection } from './connection.js';
import type { SubagentInfo, SubagentResult, SubagentTask } from './protocol.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { emitAgentSpawning } from '../runtime/emitters/index.js';
import type { HookDispatcher } from '../hooks/index.js';

/**
 * How the running program starts itself as an ACP agent. Only the product's
 * entry point knows its own verb and file, so it registers the command at
 * start; the engine never guesses one.
 */
let selfAcpCommand: readonly string[] | undefined;

/** Called by a product entry point that serves ACP (`goodvibes acp`). */
export function registerSelfAcpAgentCommand(command: readonly string[]): void {
  if (command.length === 0 || command.some((part) => typeof part !== 'string' || part.length === 0)) {
    throw new Error('An ACP agent command needs a program and only non-empty arguments.');
  }
  selfAcpCommand = Object.freeze([...command]);
}

/**
 * `ACP_AGENT_CMD` as a command: a JSON array of program and arguments; else a
 * whole string that names an existing file (a path with spaces); else the
 * string split on whitespace. Undefined when it is unset or empty.
 */
export function parseAcpAgentCommandEnv(value: string | undefined): string[] | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (raw.startsWith('[')) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error('ACP_AGENT_CMD starts with "[" but is not a JSON array of strings, for example ["/path/to/agent", "acp"].'); }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((part) => typeof part !== 'string' || part.length === 0)) {
      throw new Error('ACP_AGENT_CMD must be a JSON array of non-empty strings, for example ["/path/to/agent", "acp"].');
    }
    return parsed as string[];
  }
  if (existsSync(raw)) return [raw];
  return raw.split(/\s+/);
}

/**
 * The command a subagent is spawned with: `ACP_AGENT_CMD` when set, else the
 * command the product registered for itself. Throws, saying what to set, when
 * neither exists.
 */
export function getDefaultAcpAgentCommand(): string[] {
  const fromEnv = parseAcpAgentCommandEnv(process.env.ACP_AGENT_CMD);
  if (fromEnv) return fromEnv;
  if (selfAcpCommand) return [...selfAcpCommand];
  throw new Error('No ACP agent command is known for this program. Set ACP_AGENT_CMD to a JSON array such as ["/path/to/agent", "acp"].');
}

/**
 * AcpManager, Manages multiple concurrent subagent connections.
 *
 * @example
 * ```ts
 * const mgr = new AcpManager({ permissionHost });
 * const id = await mgr.spawn({ description: 'Fix the bug', context: '...', tools: ['read'] });
 * const results = await mgr.waitAll();
 * ```
 */
export class AcpManager {
  private connections = new Map<string, AcpConnection>();
  private pending = new Map<string, Promise<SubagentResult>>();
  private readonly agentCmd: readonly string[] | undefined;
  private readonly permissionHost: ExternalPermissionHost | undefined;
  private readonly runtimeBus: RuntimeEventBus | null;
  private readonly hookDispatcher: Pick<HookDispatcher, 'fire'> | null;
  private closed = false;

  constructor(options: {
    readonly permissionHost?: ExternalPermissionHost;
    /** The command a subagent is spawned with; defaults to {@link getDefaultAcpAgentCommand} at spawn. */
    readonly agentCommand?: readonly string[] | undefined;
    readonly runtimeBus?: RuntimeEventBus | null | undefined;
    readonly hookDispatcher?: Pick<HookDispatcher, 'fire'> | null | undefined;
  } = {}) {
    this.agentCmd = options.agentCommand ? [...options.agentCommand] : undefined;
    this.permissionHost = options.permissionHost;
    this.runtimeBus = options.runtimeBus ?? null;
    this.hookDispatcher = options.hookDispatcher ?? null;
  }

  /**
   * Spawn a new subagent and start running the task.
   * Returns the subagent ID immediately; the task runs in the background.
   */
  async spawn(task: SubagentTask, operation: ExternalOperationSource | undefined = currentExternalOperationSource()): Promise<string> {
    if (this.closed) throw new Error('No subagent was started: this program is shutting down, and its subagents have been stopped.');
    operation?.signal?.throwIfAborted(); operation?.assertCurrent();
    const source = operation ? captureAutonomousSource(operation.sourceOf()) : undefined;
    const sourceIsCurrent = source ? retainAutonomousSource(source) : undefined;
    const assertOperationCurrent = () => {
      operation?.signal?.throwIfAborted(); operation?.assertCurrent();
      if (operation && !sourceIsCurrent?.(operation.sourceOf())) throw new Error('ACP originating source changed');
    };
    const ownedOperation = operation && source ? { ...operation, assertCurrent: assertOperationCurrent, sourceOf: () => { assertOperationCurrent(); return source; } } : undefined;
    const command = this.agentCmd ? [...this.agentCmd] : getDefaultAcpAgentCommand();
    const id = randomUUID();
    const conn = new AcpConnection(id, task, command, {
      runtimeBus: this.runtimeBus,
      hookDispatcher: this.hookDispatcher,
      permissionHost: this.permissionHost,
      operation: ownedOperation,
    });
    this.connections.set(id, conn);

    if (this.runtimeBus) {
      // The dispatching session's id, the same one the connection's events carry.
      emitAgentSpawning(this.runtimeBus, {
        sessionId: task.sessionId ?? 'acp-connection',
        traceId: `acp-manager:${id}`,
        source: 'acp-manager',
      }, {
        agentId: id,
        task: task.description,
      });
    }

    // Start running, store the promise so waitAll() can await it
    const promise = conn.run().finally(() => {
      // Clean up tracking once done
      this.connections.delete(id);
      this.pending.delete(id);
    });
    this.pending.set(id, promise);

    return id;
  }

  /** Returns info snapshots for all active subagents. */
  getActive(): SubagentInfo[] {
    return Array.from(this.connections.values()).map((c) => c.getInfo());
  }

  /** Cancel a specific subagent by ID. No-op if not found. */
  async cancel(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (conn) {
      await conn.cancel();
      this.connections.delete(id);
      this.pending.delete(id);
    }
  }

  /** Cancel all active subagents. */
  async cancelAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.connections.keys()).map((id) => this.cancel(id)),
    );
  }

  /**
   * Stop every subagent this manager started and refuse new ones: each live
   * connection is cancelled (SIGTERM, a grace, SIGKILL) and its exit observed
   * before this resolves. The owning surface calls it at exit.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.cancelAll();
  }

  /**
   * Wait for all currently active subagents to finish.
   * Returns results in completion order.
   */
  async waitAll(): Promise<SubagentResult[]> {
    const promises = Array.from(this.pending.values());
    if (promises.length === 0) return [];
    const settled = await Promise.allSettled(promises);
    return settled
      .filter((r): r is PromiseFulfilledResult<SubagentResult> => r.status === 'fulfilled')
      .map((r) => r.value);
  }
}
