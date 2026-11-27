import { getCorrelationContext } from '../runtime/correlation.js';
import { prepareExternalExecution, prepareExternalWorkspaceRevision } from '../permissions/external-execution.js';
import { captureExternalRequestEvidence } from '../permissions/external-request-evidence.js';
import { admitExternalRequest, type ExternalPermissionHost } from '../permissions/external-request.js';
import { executePolicyCheck } from '../gate/execute-policy-check.js';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import { currentExternalOperationSource } from '../permissions/external-operation-scope.js';
/**
 * McpRegistry, manages all connected MCP servers.
 *
 * Tool catalog: connect loads no tool data; each client loads its one catalog
 * (names, descriptions and schemas from one paged tools/list) on first use.
 *
 * One call is governed by one signal composed from the owners of the facts it
 * depends on: the connection's life, the server's policy lifetime (ended by
 * every trust, role, quarantine or host change), configuration invalidation,
 * the caller and a default deadline. It is checked before admission and
 * immediately before the request is sent; the abort reason says what changed.
 *
 * Connection state: one McpLifecycleManager owns it. A server whose connect
 * fails or whose process exits is reconnected with exponential back-off
 * (bounded attempts, then a refusal naming why it stopped) while the
 * `runtime.mcpLifecycle` setting is on; a reload starts a fresh cycle.
 *
 * Tool namespace: mcp:<server-name>:<tool-name>
 */
import { logger } from '../utils/logger.js';
import { fileChangeStamp } from '../utils/file-change-stamp.js';
import {
  MCP_DEFAULT_TRUST_MODE,
  getMcpConfigLocations,
  loadMcpEffectiveConfig,
  removeMcpServerConfig,
  setMcpServerToolRule,
  setMcpServerPolicy,
  upsertMcpServerConfig,
  withMcpConfigLock,
} from './config.js';
import { forgetOwnerAddedServer, ownerAddedServers, recordOwnerAddedServer } from './owner-added.js';
import { McpClient } from './client.js';
import type {
  McpClientNotification,
  McpClientServerRequest,
  McpClientUnhandledResponse,
  McpProcessSpec,
} from './client.js';
import type { McpToolInfo, McpToolSchema } from './client.js';
import type { McpClientPhase, McpExcludedTool, McpToolCallOptions } from './client-types.js';
import {
  parseElicitationParams,
  type McpElicitationHandler,
} from './elicitation.js';
import type {
  McpConfigRoots,
  McpConfigScope,
  McpEffectiveConfig,
  McpServerConfig,
  McpServerConfigEntry,
  McpToolRule,
} from './config.js';
import type { HookDispatcher } from '../hooks/dispatcher.js';
import type { RepositoryFileGate } from '../runtime/workspace-trust.js';
import type { HookEvent } from '../hooks/types.js';
import { McpPermissionManager } from '../runtime/mcp/permissions.js';
import { McpSchemaFreshnessTracker } from '../runtime/mcp/schema-freshness.js';
import { MCP_CREDENTIALS_REFUSED, McpLifecycleManager } from '../runtime/mcp/manager.js';
import { McpHttpAuthError } from './http-connection.js';
import type { McpDecisionRecord, McpReconnectStatus, McpServerRole, McpToolPermission, McpToolRuleRecord, McpTrustMode, QuarantineReason, SchemaFreshness } from '../runtime/mcp/types.js';
import type { McpEvent } from '../../events/mcp.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import {
  emitMcpAuthRequired,
  emitMcpConfigured,
  emitMcpConnected,
  emitMcpConnecting,
  emitMcpDegraded,
  emitMcpDisconnected,
  emitMcpPolicyUpdated,
  emitMcpReconnecting,
  emitMcpSchemaQuarantineApproved,
  emitMcpSchemaQuarantined,
} from '../runtime/emitters/mcp.js';
import type { ConfigManager } from '../config/manager.js';
import { getSandboxConfigSnapshot } from '../runtime/sandbox/manager.js';
import {
  type SandboxSessionRegistry,
} from '../runtime/sandbox/session-registry.js';
import { sandboxCommandWrapper } from '../runtime/sandbox/backend.js';
import { summarizeError } from '../utils/error-display.js';

/** Every MCP config file's change stamp, in one string: what tells a hand edit since the last read. */
function mcpConfigStamp(roots: McpConfigRoots): string {
  return getMcpConfigLocations(roots).map((location) => `${location.path}=${fileChangeStamp(location.path)}`).join('\n');
}

function compactEnv(env: NodeJS.ProcessEnv | Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

export interface RegisteredTool {
  /** Fully-qualified tool name: mcp:<server>:<tool> */
  qualifiedName: string;
  serverName: string;
  toolName: string;
  description: string;
}

export interface McpReloadServerResult {
  readonly name: string;
  readonly action: 'added' | 'changed' | 'removed' | 'unchanged';
  readonly connected: boolean;
  /** Why a configured server is not connected; absent when it is connected or was removed. */
  readonly error?: string;
}

/** What a change to `sandbox.mcpIsolation` did to the running stdio servers. */
export interface McpIsolationChange {
  readonly mode: 'contained' | 'disabled';
  /** Restarted now under the new isolation. */
  readonly restarted: readonly string[];
  /** In the middle of a call: restarted as soon as that call ends. */
  readonly afterCall: readonly string[];
}

export interface McpReloadResult {
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly unchanged: number;
  readonly servers: readonly McpReloadServerResult[];
}

interface PendingMcpConnection {
  readonly lifetime: AbortController;
  done: Promise<void>;
  readonly cleanupErrors: unknown[];
}

/**
 * The same server to run: every field but the per-tool rules, which the
 * registry applies in place, so changing one neither restarts the server nor
 * ends a call already sent.
 */
function sameServerConfig(a: McpServerConfig | undefined, b: McpServerConfig | undefined): boolean {
  return JSON.stringify(withoutToolRules(a)) === JSON.stringify(withoutToolRules(b));
}

function withoutToolRules(config: McpServerConfig | undefined): McpServerConfig | null {
  if (!config) return null;
  const copy = { ...config };
  delete copy.deniedTools;
  delete copy.allowedTools;
  return copy;
}

/**
 * The program a server name stands for: the file that defines it and how it is
 * started or reached. A trust mode or role set this session belongs to this,
 * not to the name; its own trust, role and scope fields are left out so a
 * config edit to those does not end a session value that still applies.
 */
function launchIdentity(config: McpServerConfig, source: string | undefined): string {
  return JSON.stringify([
    source ?? null,
    config.command ?? null,
    config.args ?? [],
    config.env ?? {},
    config.url ?? null,
    config.headers ?? {},
  ]);
}

function sameToolRules(a: McpServerConfig, b: McpServerConfig): boolean {
  return JSON.stringify([a.deniedTools ?? [], a.allowedTools ?? []]) === JSON.stringify([b.deniedTools ?? [], b.allowedTools ?? []]);
}

/** The reason a refused call names for each kind of per-tool rule. */
const TOOL_RULE_NOTES = {
  storedAllow: 'goes past the server\'s folder and site limits, kept in your MCP config (/mcp unexempt ends it)',
  storedDeny: 'blocked in the server\'s MCP config; /mcp unblock <server> <tool> lifts it',
  sessionDeny: 'blocked by the owner for this session only; /mcp unblock <server> <tool> lifts it',
} as const;

/** Servers connected at once while applying a configuration. */
const MCP_CONNECT_CONCURRENCY = 4;

/** The MCP files in the person's home folder (config.ts getMcpConfigLocations): their own, never a workspace's. */
const USER_CONTEXT_KINDS: ReadonlySet<string> = new Set(['global-xdg', 'global-dotdir', 'claude-desktop']);

/** The credential refusal behind a failed connect, if that is what it was (also inside a cause or an aggregate). */
function mcpAuthRefusal(error: unknown, depth = 0): McpHttpAuthError | undefined {
  if (error instanceof McpHttpAuthError) return error;
  if (depth >= 4 || !(error instanceof Error)) return undefined;
  if (error instanceof AggregateError) {
    for (const inner of error.errors) { const found = mcpAuthRefusal(inner, depth + 1); if (found) return found; }
  }
  return mcpAuthRefusal(error.cause, depth + 1);
}
/** How long a server may take to answer one tool call before the call is cancelled and the server told. */
const DEFAULT_TOOL_CALL_DEADLINE_MS = 120_000;
/** How long a shutdown waits, for all servers together, on the HTTP session ends it sent. */
const SHUTDOWN_SESSION_END_MS = 1_500;

/** Health of one server: whether it answered a short probe, and how long it took. */
export interface McpServerHealth {
  readonly name: string;
  readonly responsive: boolean;
  readonly elapsedMs: number;
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export class McpRegistry {
  /** Bumped on every change to what the catalog can list: servers configured, connected or dropped, a policy or quarantine change. */
  #revision = 0;
  private clients = new Map<string, McpClient>();
  private readonly executionByClient = new WeakMap<McpClient, { assertCurrent: () => void; close: () => void }>();
  private serverConfigs = new Map<string, McpServerConfig>();
  /** Holds back a project MCP file until the owner trusts the workspace; null when the product binds none. */
  private repositoryGate: RepositoryFileGate | null = null;
  /** The roots the configured servers were last started from, so trusting the workspace starts the ones it held. */
  private startedRoots: McpConfigRoots | null = null;
  private readonly pendingConnections = new Map<string, PendingMcpConnection>();
  /** Why a configured server's last connect attempt failed; a failed client is not kept, so this is the only record. */
  private readonly connectFailures = new Map<string, string>();
  private permissions = new McpPermissionManager();
  /**
   * Trust and role the owner set this session, each bound to the program it
   * was set for (`launch`, from launchIdentity). They outlive a reconnect or a
   * reload that keeps that program, and end with the process, the server's
   * removal, or a reload that puts a different program (another file, command,
   * address or environment) behind the name.
   */
  private readonly sessionPolicy = new Map<string, { trustMode?: McpTrustMode; role?: McpServerRole; launch: string }>();
  /** The file each configured server was read from, as the last reload found it. */
  private serverSources = new Map<string, string>();
  /**
   * The servers the last reload read from the person's own files in their home folder (added for all their projects, or
   * read from another program's file there), not from the workspace. Such a server is theirs, not the folder's: it
   * starts in their home folder, and the workspace's trust (a restricted daemon folder) does not hold it back.
   */
  #userContextServers = new Set<string>();
  /** Tools the owner denied this session, by server. Like the session trust mode, they outlive a reconnect or reload. */
  private readonly sessionToolDenials = new Map<string, Set<string>>();
  /** The policy a server runs under: what the owner set this session, else its config, else the defaults. */
  private policyProfile(name: string, config: McpServerConfig | undefined): { role: McpServerRole; mode: McpTrustMode; allowedPaths: string[]; allowedHosts: string[] } {
    const session = this.sessionPolicy.get(name);
    return {
      role: session?.role ?? config?.role ?? 'general',
      mode: session?.trustMode ?? config?.trustMode ?? MCP_DEFAULT_TRUST_MODE,
      allowedPaths: config?.allowedPaths ?? [],
      allowedHosts: config?.allowedHosts ?? [],
    };
  }
  private readonly policyLifetimes = new Map<string, AbortController>();
  private policyLifetime(serverName: string): AbortController {
    let lifetime = this.policyLifetimes.get(serverName);
    if (!lifetime) { lifetime = new AbortController(); this.policyLifetimes.set(serverName, lifetime); }
    return lifetime;
  }
  /** Ends every call admitted under the server's current policy, with a reason the caller can act on. */
  private invalidatePolicyLifetime(serverName: string, change: string): void {
    this.#revision++;
    this.pendingConnections.get(serverName)?.lifetime.abort();
    this.policyLifetimes.get(serverName)?.abort(new Error(`MCP server '${serverName}': ${change} while the call was in progress, so nothing more was sent. Call the tool again.`));
    this.policyLifetimes.set(serverName, new AbortController());
  }
  private freshness = new McpSchemaFreshnessTracker();
  /**
   * The one owner of each server's connection state and of reconnecting a
   * server that dropped: every connect outcome below is reported to it, and its
   * attempts come back through `_connectServer`, so a reconnect passes the same
   * checks as the first connect. Whether to reconnect is the
   * `runtime.mcpLifecycle` setting, read when a server drops.
   */
  readonly #lifecycle = new McpLifecycleManager({
    connector: (name) => this.#reconnect(name),
    enabled: () => this.sandboxConfigManager?.get('runtime.mcpLifecycle') ?? true,
    onEvent: (event) => this.#publishLifecycleEvent(event),
  });
  private runtimeBus: RuntimeEventBus | null = null;
  private sandboxConfigManager: ConfigManager | null = null;
  private sandboxSessions: SandboxSessionRegistry;
  private sandboxSessionByServer = new Map<string, string>();
  private readonly hookDispatcher: Pick<HookDispatcher, 'fire'>;
  private permissionHost: ExternalPermissionHost | undefined;
  setPermissionHost(host: ExternalPermissionHost): void {
    for (const pending of this.pendingConnections.values()) pending.lifetime.abort();
    for (const [name, client] of this.clients) { this.executionByClient.get(client)?.close(); this.invalidatePolicyLifetime(name, 'the permission owner was replaced'); }
    this.permissionHost = host;
    // A revoked owner ends every scheduled reconnect; a replaced one no longer speaks for this registry.
    const revoked = () => { if (this.permissionHost === host) this.#lifecycle.stopAll('the MCP connection owner was revoked'); };
    // The owner's signal outlives a project's registry (the daemon's): the listener goes when the owner is replaced or
    // the registry is let go (`release`), so a let-go registry is not kept by it.
    this.#forgetHost?.();
    this.#forgetHost = undefined;
    if (host.signal.aborted) revoked();
    else {
      host.signal.addEventListener('abort', revoked, { once: true });
      this.#forgetHost = () => { host.signal.removeEventListener('abort', revoked); };
    }
  }
  #forgetHost: (() => void) | undefined;

  /**
   * Stops every server (disconnectAll) and lets go of what this registry hung on the host's own long-lived things (its
   * permission owner's signal, the sandbox setting's subscription): a project's registry is let go with its project.
   */
  async release(): Promise<void> {
    this.#forgetHost?.();
    this.#forgetHost = undefined;
    this.#unsubscribeIsolation?.();
    this.#unsubscribeIsolation = undefined;
    await this.disconnectAll();
  }
  private elicitationHandler: McpElicitationHandler | null = null;

  constructor(options: {
    readonly hookDispatcher: Pick<HookDispatcher, 'fire'>;
    readonly sandboxSessions: SandboxSessionRegistry;
  }) {
    this.hookDispatcher = options.hookDispatcher;
    this.sandboxSessions = options.sandboxSessions;
  }

  setRuntimeBus(runtimeBus: RuntimeEventBus | null): void {
    this.runtimeBus = runtimeBus;
  }

  /**
   * Wire the resolver for MCP `elicitation/create` requests. When set, connected
   * clients advertise the elicitation capability and route incoming elicitation
   * requests through this handler (the approval broker) instead of rejecting
   * them. Set once at composition; applies to servers connected afterwards.
   */
  setElicitationHandler(handler: McpElicitationHandler | null): void {
    for (const pending of this.pendingConnections.values()) pending.lifetime.abort();
    for (const name of this.clients.keys()) this.invalidatePolicyLifetime(name, 'its input handler was replaced');
    this.elicitationHandler = handler;
  }

  setSandboxRuntime(configManager: ConfigManager, sessions: SandboxSessionRegistry): void {
    this.#unsubscribeIsolation?.();
    this.sandboxConfigManager = configManager;
    this.sandboxSessions = sessions;
    // A change to sandbox.mcpIsolation restarts the running stdio servers under it.
    this.#unsubscribeIsolation = configManager.subscribe('sandbox.mcpIsolation', () => { this.#applyMcpIsolation(); });
  }

  #unsubscribeIsolation: (() => void) | undefined;
  /** Whether each stdio client was started inside the sandbox boundary. */
  readonly #startedIsolated = new WeakMap<McpClient, boolean>();
  /** Tool calls in progress, by server, so an isolation restart waits for the call to end. */
  readonly #callsInFlight = new Map<string, number>();
  /** Servers to restart under the current isolation as soon as their calls in progress end. */
  readonly #restartAfterCall = new Set<string>();
  #isolationChange: McpIsolationChange | null = null;
  /** Servers that were not started because this host could not give them the boundary `contained` asks for. */
  readonly #failedForIsolation = new Set<string>();
  /** Counts disconnectAll calls, so an isolation restart in flight starts nothing after a shutdown. */
  #shutdowns = 0;

  /** What the last change to sandbox.mcpIsolation did to the running servers; null before any change. */
  mcpIsolationChange(): McpIsolationChange | null {
    return this.#isolationChange;
  }

  /**
   * Restart every running stdio server started under the other isolation: at
   * once when it has no call in progress, else as soon as its calls end.
   */
  #applyMcpIsolation(): void {
    const configManager = this.sandboxConfigManager;
    if (!configManager) return;
    const contained = getSandboxConfigSnapshot(configManager).mcpIsolation !== 'disabled';
    const restarted: string[] = [];
    const afterCall: string[] = [];
    for (const [name, config] of this.serverConfigs) {
      if (!config.command) continue;
      const client = this.clients.get(name);
      const starting = this.pendingConnections.has(name);
      // A server that could not start inside the boundary is started once the change lets it.
      const failedForIsolation = !client && !starting && !contained && this.#failedForIsolation.has(name);
      if (!starting && !failedForIsolation && (!client || this.#startedIsolated.get(client) === contained)) continue;
      if (!starting && (this.#callsInFlight.get(name) ?? 0) > 0) {
        this.#restartAfterCall.add(name);
        afterCall.push(name);
        continue;
      }
      this.#restartAfterCall.delete(name);
      restarted.push(name);
      this.#restartUnderIsolation(name);
    }
    this.#isolationChange = Object.freeze({ mode: contained ? 'contained' : 'disabled', restarted, afterCall });
  }

  /** Stop one server and start it again from its configuration, so it runs under the isolation in force now. */
  #restartUnderIsolation(name: string): void {
    const config = this.serverConfigs.get(name);
    if (!config) return;
    // A shutdown (disconnectAll) that lands meanwhile wins: nothing is started after it.
    const shutdowns = this.#shutdowns;
    void this.disconnectServer(name, 'sandbox-isolation-changed')
      .then(() => (this.serverConfigs.get(name) === config && this.#shutdowns === shutdowns ? this._connectServer(config) : undefined))
      .catch((error: unknown) => {
        logger.warn('McpRegistry: a server was not restarted under the new sandbox isolation', { server: name, error: summarizeError(error) });
      });
  }

  /**
   * connectAll, Load config from .goodvibes/mcp.json and connect to all servers.
   * Errors on individual servers are logged but do not abort the whole startup.
   */
  async connectAll(roots: McpConfigRoots): Promise<void> {
    await this.reload(roots);
  }

  /**
   * connectServer, Connect a single MCP server by config.
   * Exposed for programmatic use (testing, dynamic registration).
   */
  async connectServer(serverConfig: McpServerConfig): Promise<void> {
    this.permissionHost?.signal.throwIfAborted();
    serverConfig = structuredClone(serverConfig);
    // Added by a program, not read from the person's own files: the workspace's trust applies to it.
    this.#userContextServers.delete(serverConfig.name);
    const previous = this.serverConfigs.get(serverConfig.name);
    this.serverConfigs.set(serverConfig.name, serverConfig); this.#revision++;
    this.syncToolRules(serverConfig.name);
    if (previous && !sameServerConfig(previous, serverConfig)) await this.disconnectServer(serverConfig.name, 'config-changed');
    await this._connectServer(serverConfig);
  }

  /**
   * removeServer, Disconnect a server added with connectServer and drop its
   * config, so its tools leave the tool surface and a reload does not bring it
   * back. Leaves the name alone, and answers false, when it now holds another
   * config; otherwise answers whether a connection was closed.
   */
  async removeServer(serverConfig: McpServerConfig): Promise<boolean> {
    if (!sameServerConfig(this.serverConfigs.get(serverConfig.name), serverConfig)) return false;
    this.serverConfigs.delete(serverConfig.name); this.#revision++;
    try {
      return await this.disconnectServer(serverConfig.name, 'config-removed');
    } finally {
      this.forgetServer(serverConfig.name);
    }
  }

  /**
   * Start no server a project file names, and let none of them stand in for an
   * owner's server of the same name, until the owner trusts the workspace; start
   * them the moment the owner does, and stop them the moment the workspace is
   * restricted again (here or in another process). Returns the unbinding.
   */
  bindRepositoryTrust(gate: RepositoryFileGate): () => void {
    this.repositoryGate = gate;
    const unsubscribe = gate.onLevelChanged((level) => {
      const roots = this.startedRoots;
      if (roots === null || this.permissionHost?.signal.aborted === true) return;
      this.reload(roots).catch((error: unknown) => {
        logger.warn('McpRegistry: the workspace\'s MCP servers were not brought in line with its trust after it changed', { level, error: summarizeError(error) });
      });
    });
    return () => { unsubscribe(); if (this.repositoryGate === gate) this.repositoryGate = null; };
  }

  /** The MCP config files' modification times and sizes when they were last read; null before any read. */
  #configStamp: string | null = null;
  #configRereading: Promise<unknown> | null = null;

  /**
   * Before an MCP call: when an MCP config file was edited (by hand) since it
   * was last read, read the configuration again first, so a changed entry is
   * reconnected and a removed one dropped (the same reload `/mcp reload` runs;
   * unchanged servers are left alone). One stat per config file; no watcher.
   */
  async #rereadConfigIfChanged(): Promise<void> {
    const roots = this.startedRoots;
    if (roots === null || this.#configStamp === null || mcpConfigStamp(roots) === this.#configStamp) return;
    this.#configRereading ??= this.reload(roots).catch((error: unknown) => {
      logger.warn('McpRegistry: an MCP config file changed, but it could not be read again', { error: summarizeError(error) });
    }).finally(() => { this.#configRereading = null; });
    await this.#configRereading;
  }

  /** The workspace the servers start from on first use, for a product that starts none at launch. */
  #workspaceRoots: McpConfigRoots | null = null;

  /**
   * Name the workspace the servers start from, without starting any: a change
   * kept in a server's MCP config before anything started them (a trust mode,
   * a per-tool rule) writes there and starts them on that first use.
   */
  setWorkspaceRoots(roots: McpConfigRoots): void {
    this.#workspaceRoots = roots;
  }

  /** The configuration the start paths read: the files, with a project file the owner has not trusted held back. */
  private async startableConfig(roots: McpConfigRoots): Promise<McpEffectiveConfig> {
    this.startedRoots = roots;
    // Stamped before the read, so an edit that lands during it is read at the next call.
    this.#configStamp = mcpConfigStamp(roots);
    const gate = this.repositoryGate;
    if (gate === null) return loadMcpEffectiveConfig(roots);
    await gate.load();
    return loadMcpEffectiveConfig(roots, { holdProjectFile: (path) => gate.holds(path), ownerAdded: ownerAddedServers(roots.homeDirectory) });
  }

  /** The servers a project file names that wait on the owner's trust of the workspace; empty when none wait. */
  async heldForWorkspaceTrust(roots: McpConfigRoots): Promise<readonly string[]> {
    const gate = this.repositoryGate;
    if (gate === null) return [];
    await gate.load();
    return (loadMcpEffectiveConfig(roots, { holdProjectFile: (path) => gate.holds(path), ownerAdded: ownerAddedServers(roots.homeDirectory) }).held ?? []).map((entry) => entry.server.name);
  }

  async reload(roots: McpConfigRoots): Promise<McpReloadResult> {
    const effective = await this.startableConfig(roots);
    return this.applyConfig(effective.servers);
  }

  getEffectiveConfig(roots: McpConfigRoots): McpEffectiveConfig {
    return loadMcpEffectiveConfig(roots);
  }

  /**
   * Write a server's entry and bring the running servers in line. `byOwner`:
   * the owner added it with their own command or form, so a project file's entry
   * is their request and starts without the workspace trust question
   * (mcp/owner-added.ts); a model's or a script's write is not.
   */
  async upsertServerConfig(
    roots: McpConfigRoots,
    scope: McpConfigScope,
    serverConfig: McpServerConfig,
    options: { readonly byOwner?: boolean | undefined } = {},
  ): Promise<{ readonly path: string; readonly reload: McpReloadResult }> {
    const written = await withMcpConfigLock(roots, scope, () => {
      const result = upsertMcpServerConfig(roots, scope, serverConfig);
      const entry = result.config.servers.find((server) => server.name === serverConfig.name);
      if (scope === 'project' && entry) {
        if (options.byOwner === true) recordOwnerAddedServer(roots.homeDirectory, result.path, entry);
        else forgetOwnerAddedServer(roots.homeDirectory, result.path, entry.name);
      }
      return result;
    });
    return { path: written.path, reload: await this.reload(roots) };
  }

  async removeServerConfig(
    roots: McpConfigRoots,
    scope: McpConfigScope,
    serverName: string,
  ): Promise<{ readonly path: string; readonly removed: boolean; readonly reload: McpReloadResult }> {
    const written = await withMcpConfigLock(roots, scope, () => {
      const result = removeMcpServerConfig(roots, scope, serverName);
      if (scope === 'project' && result.removed) forgetOwnerAddedServer(roots.homeDirectory, result.path, serverName);
      return result;
    });
    return { path: written.path, removed: written.removed, reload: await this.reload(roots) };
  }

  async applyConfig(entries: readonly McpServerConfigEntry[]): Promise<McpReloadResult> {
    this.permissionHost?.signal.throwIfAborted();
    const next = new Map(entries.map((entry) => [entry.server.name, structuredClone(entry.server)] as const));
    const previousConfigs = this.serverConfigs;
    // Publish the complete new intent before any drain. An older reload may
    // never delete or reconnect a destination installed while it was awaiting.
    this.serverConfigs = new Map(next); this.#revision++;
    this.serverSources = new Map(entries.map((entry) => [entry.server.name, entry.source.path] as const));
    this.#userContextServers = new Set(entries.filter((entry) => USER_CONTEXT_KINDS.has(entry.source.kind)).map((entry) => entry.server.name));
    // A trust mode or role set this session for a name now standing for a
    // different program no longer applies, before anything connects under it.
    for (const [name, session] of [...this.sessionPolicy]) {
      const serverConfig = next.get(name);
      if (!serverConfig || launchIdentity(serverConfig, this.serverSources.get(name)) === session.launch) continue;
      this.sessionPolicy.delete(name);
      logger.info('MCP server changed behind its name; the trust mode and role set for it this session no longer apply', { server: name });
      if (this.permissions.getServerPermissions(name)) {
        const profile = this.policyProfile(name, serverConfig);
        this.invalidatePolicyLifetime(name, 'the server behind its name changed, so the trust mode and role set for it this session no longer apply');
        this.permissions.setTrustMode(name, profile.mode);
        this.permissions.setServerRole(name, profile.role);
        this._emitPolicyUpdate(name);
      }
    }
    // A per-tool rule that changed applies now, before any drain: a call not yet sent to a newly denied tool ends here.
    for (const name of next.keys()) this.syncToolRules(name);
    const disconnecting: Promise<boolean>[] = [];
    for (const [name, previous] of previousConfigs) {
      if (!sameServerConfig(previous, next.get(name))) disconnecting.push(this.disconnectServer(name, next.has(name) ? 'config-changed' : 'config-removed'));
    }
    // Revoke every changed/removed transport synchronously before waiting for
    // any one server's drain; no other old intent gets an admission window.
    for (const pending of this.pendingConnections.values()) pending.lifetime.abort();
    const disconnected = await Promise.allSettled(disconnecting);
    const cleanupErrors = disconnected.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : []);
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'MCP configuration cleanup failed');
    const results: McpReloadServerResult[] = [];
    let added = 0;
    let changed = 0;
    let removed = 0;
    let unchanged = 0;

    for (const name of previousConfigs.keys()) {
      if (next.has(name)) continue;
      this.forgetServer(name);
      removed += 1;
      results.push({ name, action: 'removed', connected: false });
    }

    const plan: { readonly name: string; readonly serverConfig: McpServerConfig; readonly action: 'added' | 'changed' | 'unchanged'; readonly connect: boolean }[] = [];
    for (const [name, serverConfig] of next) {
      if (this.serverConfigs.get(name) !== serverConfig) throw new Error('MCP configuration intent changed');
      const previous = previousConfigs.get(name);
      if (previous && sameServerConfig(previous, serverConfig)) {
        // Only its per-tool rules changed (applied above, without a restart), or nothing did.
        const rulesChanged = !sameToolRules(previous, serverConfig);
        if (rulesChanged) changed += 1; else unchanged += 1;
        plan.push({ name, serverConfig, action: rulesChanged ? 'changed' : 'unchanged', connect: !this.clients.get(name)?.isConnected });
        continue;
      }
      if (previous) changed += 1; else added += 1;
      plan.push({ name, serverConfig, action: previous ? 'changed' : 'added', connect: true });
    }

    // A few at a time rather than one after another: a server that never
    // answers its handshake costs its own bound and no longer every server
    // configured after it. Reported in configuration order either way.
    const waiting = plan.filter((entry) => entry.connect);
    let failure: { readonly error: unknown } | null = null;
    const connectNext = async (): Promise<void> => {
      for (let entry = waiting.shift(); entry; entry = waiting.shift()) {
        try { await this._connectServer(entry.serverConfig); }
        catch (error) { failure ??= { error }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MCP_CONNECT_CONCURRENCY, waiting.length) }, connectNext));
    if (failure) throw (failure as { readonly error: unknown }).error;
    for (const { name, action } of plan) {
      const connected = this.clients.get(name)?.isConnected ?? false;
      const error = connected ? undefined : (this.clients.get(name)?.lastError ?? this.connectFailures.get(name) ?? undefined);
      results.push({ name, action, connected, ...(error ? { error } : {}) });
    }

    return { added, changed, removed, unchanged, servers: results };
  }

  /**
   * Connect one configured server on first use and leave the others alone.
   * A server already connected or connecting is not started again; a name with
   * no configuration is left for the call to report.
   */
  async connectConfigured(roots: McpConfigRoots, serverName: string): Promise<void> {
    if (this.clients.get(serverName)?.isConnected) return;
    const pending = this.pendingConnections.get(serverName);
    if (pending) { await pending.done; return; }
    const effective = await this.startableConfig(roots);
    const entry = effective.servers.find((candidate) => candidate.server.name === serverName);
    if (!entry) {
      const held = effective.held?.find((candidate) => candidate.server.name === serverName);
      if (held) throw new Error(`it is named in ${held.source.path}, a file in this workspace, which you have not trusted, so it is not started. "Trust this folder" in Permissions and safety, This folder, starts it.`);
      return;
    }
    await this.connectServer(entry.server);
  }

  /** Start every configured server that is not connected or connecting, without waiting; each reports `starting` meanwhile. */
  startConfigured(roots: McpConfigRoots, onSettled?: (name: string, error?: unknown) => void): void {
    this.startableConfig(roots).then((effective) => {
      for (const { server } of effective.servers) {
        if (this.clients.get(server.name)?.isConnected || this.pendingConnections.has(server.name)) continue;
        this.connectServer(server).then(
          () => onSettled?.(server.name),
          (error: unknown) => { logger.info('McpRegistry: background connect failed', { server: server.name, err: summarizeError(error) }); onSettled?.(server.name, error); },
        );
      }
    }, (error: unknown) => { logger.info('McpRegistry: the configured servers could not be read', { err: summarizeError(error) }); });
  }

  /**
   * Load one client's catalog and keep the server's schema freshness: a failed
   * listing counts toward its quarantine, a successful one clears the count.
   * A cancelled wait says nothing about the server and is not counted.
   */
  async #loadCatalog<T>(serverName: string, client: McpClient, load: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      const value = await load();
      if (!this.freshness.isQuarantined(serverName) && this.freshness.getFreshness(serverName) !== 'fresh') {
        this.freshness.markFresh(serverName); this.#lifecycle.recovered(serverName);
      }
      return value;
    } catch (error) {
      if (!signal?.aborted && !isAbortLike(error) && client.isConnected) {
        const wasQuarantined = this.freshness.isQuarantined(serverName);
        this.freshness.markFailed(serverName, summarizeError(error));
        if (!wasQuarantined && this.freshness.isQuarantined(serverName)) this.invalidatePolicyLifetime(serverName, 'it was quarantined after its tool list failed to load repeatedly');
        else this.#lifecycle.degraded(serverName, `its tool list could not be read: ${summarizeError(error)}`);
      }
      throw error;
    }
  }

  /**
   * The tool catalog as one read: `listAllTools` lists every server connected
   * at the capture at once, and `assertCurrent` refuses once anything the
   * listing depended on changed (one of those servers dropped, was replaced or
   * changed its tools, a policy or quarantine change, a configuration change),
   * so a caller never acts on a mixed view. A server that finishes starting
   * after the capture is not part of it and does not refuse it: its tools are
   * listed by the next read, and the caller reports it as still starting.
   */
  captureToolCatalog(options?: McpToolCallOptions): { readonly listAllTools: () => Promise<readonly RegisteredTool[]>; readonly assertCurrent: () => void } {
    const revision = this.#revision;
    const sources = [...this.clients].filter(([, client]) => client.isConnected)
      .map(([name, client]) => ({ name, client, revision: client.catalogRevision }));
    const assertCurrent = () => {
      options?.signal?.throwIfAborted(); options?.assertCurrent?.();
      if (this.#revision !== revision || sources.some((source) => this.clients.get(source.name) !== source.client
        || source.client.catalogRevision !== source.revision || !source.client.isConnected))
        throw new Error('The MCP tool catalog changed while it was being read (a listed server disconnected or changed its tools, or a server\'s policy or configuration changed). List the tools again.');
    };
    assertCurrent();
    let pending: Promise<readonly RegisteredTool[]> | undefined;
    const listAllTools = () => {
      assertCurrent();
      pending ??= (async () => {
        const listed = await Promise.all(sources.map(async (source) => {
          const tools = await this.#loadCatalog(source.name, source.client, () => source.client.listTools(options?.signal), options?.signal);
          return tools.map((tool) => ({ qualifiedName: `mcp:${source.name}:${tool.name}`, serverName: source.name, toolName: tool.name, description: tool.description }));
        }));
        assertCurrent();
        return listed.flat();
      })();
      return pending;
    };
    return Object.freeze({ listAllTools, assertCurrent });
  }

  /**
   * listAllTools, Return all registered tools (name + description) from all connected servers.
   * A server that fails to list is skipped and logged, so the list can be partial;
   * `captureToolCatalog` is the all-or-nothing variant for callers that must not act on a partial catalog.
   */
  async listAllTools(): Promise<RegisteredTool[]> {
    const listed = await Promise.all([...this.clients].filter(([, client]) => client.isConnected).map(async ([serverName, client]) => {
      try {
        const tools: McpToolInfo[] = await this.#loadCatalog(serverName, client, () => client.listTools());
        return tools.map((tool) => ({ qualifiedName: `mcp:${serverName}:${tool.name}`, serverName, toolName: tool.name, description: tool.description }));
      } catch (err) {
        logger.info('McpRegistry: failed to list tools from server', { server: serverName, err: summarizeError(err) });
        return [];
      }
    }));
    return listed.flat();
  }

  /**
   * Whether the connected server marks this tool read-only (`readOnlyHint`),
   * from the catalog already loaded: no request. False when the catalog is not
   * loaded, the server is not connected or is quarantined. Says how the call
   * may run beside others; never a permission grant.
   */
  isToolReadOnly(qualifiedName: string): boolean {
    const parsed = this._parseQualifiedName(qualifiedName);
    if (!parsed) return false;
    const client = this.clients.get(parsed.serverName);
    if (!client || !client.isConnected || this.freshness.isQuarantined(parsed.serverName)) return false;
    return client.getCachedToolSchema(parsed.toolName)?.annotations?.readOnlyHint === true;
  }

  /**
   * getToolSchema, Fetch full JSON schema for a qualified tool name.
   * Reads the server's tool catalog, loading it on first use.
   */
  async getToolSchema(qualifiedName: string, options?: McpToolCallOptions): Promise<McpToolSchema | null> {
    const parsed = this._parseQualifiedName(qualifiedName);
    if (!parsed) return null;
    const client = this.clients.get(parsed.serverName);
    if (!client || !client.isConnected) return null;
    options?.signal?.throwIfAborted(); options?.assertCurrent?.();
    const schema = await this.#loadCatalog(parsed.serverName, client, () => client.getToolSchema(parsed.toolName, options?.signal), options?.signal);
    if (options?.expectedSchema !== undefined && schema !== options.expectedSchema) throw new Error(this.schemaChangedMessage(qualifiedName));
    options?.assertCurrent?.();
    return schema;
  }

  private schemaChangedMessage(qualifiedName: string): string {
    return `The definition of MCP tool '${qualifiedName}' changed after it was read; nothing was sent. Read its schema again, then call it.`;
  }

  /** Why a server's tools cannot be used now, naming the state and what lifts it. */
  private quarantineMessage(qualifiedName: string, serverName: string): string {
    const record = this.freshness.getRecord(serverName);
    const detail = record?.quarantine?.detail ? `: ${record.quarantine.detail}` : '';
    return `MCP call '${qualifiedName}' refused: server '${serverName}' is quarantined (${record?.quarantine?.reason ?? 'unknown'})${detail}. `
      + 'Approve it with the mcp tool (mode approve-quarantine) or reload the MCP configuration to reconnect it.';
  }

  /** Probe one connected server with a short ping; null when there is no such server. */
  async checkServerHealth(serverName: string, signal?: AbortSignal): Promise<McpServerHealth | null> {
    const client = this.clients.get(serverName);
    if (!client) return null;
    const started = performance.now();
    const responsive = await client.ping(signal);
    return { name: serverName, responsive, elapsedMs: Math.round(performance.now() - started) };
  }

  /**
   * callTool, Execute a tool by its qualified name.
   * Loads the server's tool catalog on first use.
   */
  async callTool(qualifiedName: string, args: Record<string, unknown>, options?: McpToolCallOptions): Promise<unknown> {
    const source = currentExternalOperationSource();
    // An MCP config file edited by hand is read again before the call.
    await this.#rereadConfigIfChanged();
    args = snapshotJudgmentInput(args, qualifiedName) as Record<string, unknown>;
    const parsed = this._parseQualifiedName(qualifiedName);
    if (!parsed) {
      throw new Error(`McpRegistry: invalid qualified tool name '${qualifiedName}'`);
    }
    const serverName = parsed.serverName;
    const client = this.clients.get(serverName);
    if (!client) {
      // A configured server whose connect failed has no client; say why rather than that it does not exist.
      if (this.serverConfigs.has(serverName)) throw new Error(this.notConnectedMessage(serverName));
      throw new Error(`McpRegistry: no server named '${serverName}'`);
    }
    if (!client.isConnected) {
      throw new Error(this.notConnectedMessage(serverName));
    }
    if (this.freshness.isQuarantined(serverName)) throw new Error(this.quarantineMessage(qualifiedName, serverName));
    const sessionId = options?.sessionId ?? getCorrelationContext().sessionId ?? '';
    const host = this.permissionHost;
    const transport = client.captureToolScope();
    const configLife = new AbortController();
    // A permission or configuration change refuses a call that has not been sent.
    // Once its request is written it no longer ends the wait: the tool may already
    // be doing its work, and abandoning the answer would invite a duplicate call.
    // Only the caller, the connection and the deadline end a sent call.
    const staleBeforeSend = AbortSignal.any([this.policyLifetime(serverName).signal, configLife.signal]);
    const unsent = new AbortController();
    const forwardStale = () => unsent.abort(staleBeforeSend.reason);
    if (staleBeforeSend.aborted) forwardStale(); else staleBeforeSend.addEventListener('abort', forwardStale, { once: true });
    const signal = AbortSignal.any([unsent.signal, transport.signal,
      ...(host ? [host.signal] : []), ...(source?.signal ? [source.signal] : []), ...(options?.signal ? [options.signal] : [])]);
    const record = this.permissions.getServerPermissions(serverName);
    const serverPolicy = snapshotJudgmentInput(record ? {
      profile: { role: record.profile.role, mode: record.profile.mode,
        allowedPaths: record.profile.allowedPaths, allowedHosts: record.profile.allowedHosts }, toolOverrides: [...record.toolOverrides],
    } : null) as Readonly<Record<string, unknown>>;
    const externalRequestEvidence = captureExternalRequestEvidence({ destination: transport.destination, serverPolicy });
    const execution = this.executionByClient.get(client);
    let assertWorkspaceCurrent: (() => void) | undefined;
    // The caller's and the source's own checks run at admission and again just before sending;
    // everything else this call depends on ends the composed signal when it changes before sending.
    const assertCurrent = () => {
      signal.throwIfAborted(); options?.assertCurrent?.(); source?.assertCurrent();
    };
    const operation = source ? { ...source, inputFacts: [args, ...(source.inputFacts ?? [])], assertCurrent: () => signal.throwIfAborted(), signal } : undefined;
    let admission: Awaited<ReturnType<typeof admitExternalRequest>> | undefined;
    const unsubscribe = host?.config.onDidInvalidate(() => configLife.abort(new Error(`MCP call '${qualifiedName}': the configuration changed during the call, so nothing more was sent. Call the tool again.`)));
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let callSettled = false;
    this.#callsInFlight.set(serverName, (this.#callsInFlight.get(serverName) ?? 0) + 1);
    try {
      assertCurrent();
      if (host && !operation) throw new Error(`MCP call '${qualifiedName}' has unresolved permission: original operation source is unavailable`);
      const schema = await this.#loadCatalog(serverName, client, () => client.getToolSchema(parsed.toolName, signal), signal);
      if (!schema) throw new Error(client.describeUnavailableTool(parsed.toolName));
      if (options?.expectedSchema !== undefined && schema !== options.expectedSchema) throw new Error(this.schemaChangedMessage(qualifiedName));
      if (host) assertWorkspaceCurrent = await prepareExternalWorkspaceRevision(host, signal);

      // The tool's own schema says which arguments are paths; it is already loaded for this call.
      const permission = await this.permissions.evaluateToolCall(serverName, parsed.toolName, args, { externalRequestEvidence, inputSchema: schema.inputSchema });
      signal.throwIfAborted();
      // An ask-on-risk server called outside its scope: the owner decides this call through the gate, in every mode.
      const ownerAsk = permission.askOwner;
      if (ownerAsk !== undefined && !(host && operation)) {
        throw new Error(`MCP call '${qualifiedName}' denied: ${permission.reason} Nobody can be asked from here, so it was not sent.`);
      }
      if (permission.verdict === 'deny' && ownerAsk === undefined) {
        throw new Error(`MCP call '${qualifiedName}' denied: ${permission.reason}`);
      }
      // Enforcement answers allow, deny or ask the owner; any other answer is not a grant.
      if (permission.verdict !== 'allow' && ownerAsk === undefined)
        throw new Error(`MCP call '${qualifiedName}' has unresolved permission: ${permission.reason}`);
      // Deterministic server allows constrain policy; they never replace the
      // canonical recorded admission of an actual autonomous caller's source.
      if (host && operation) {
        admission = await admitExternalRequest(host, { ...transport, signal, assertCurrent: () => signal.throwIfAborted() }, operation, {
          tool: qualifiedName, args, serverPolicy, supportingDecisionIds: [], ...(ownerAsk !== undefined ? { ownerAsk } : {}),
        });
        signal.throwIfAborted();
        if (!admission.result.approved) {
          throw new Error(ownerAsk !== undefined
            ? `MCP call '${qualifiedName}' was not allowed: ${admission.result.detail ?? admission.result.userReason ?? 'the owner did not allow a call outside the server\'s scope'}`
            : `MCP call '${qualifiedName}' autonomous admission did not act`);
        }
      }

      // Pre:mcp:call hook
      const dispatcher = this.hookDispatcher;
      const preEvent: HookEvent = {
        path: 'Pre:mcp:call',
        phase: 'Pre',
        category: 'mcp',
        specific: 'call',
        sessionId, timestamp: Date.now(),
        payload: { tool: qualifiedName, args },
      };
      const preResult = await dispatcher.fire(preEvent).catch((error) => {
        throw new Error(`MCP call '${qualifiedName}' pre-call hook failed: ${summarizeError(error)}`);
      });
      if (preResult.ok === false) {
        throw new Error(`MCP call '${qualifiedName}' pre-call hook failed: ${preResult.error ?? 'unknown error'}`);
      }
      if (preResult.decision === 'deny') {
        throw new Error(`MCP call '${qualifiedName}' denied by hook: ${(preResult as { reason?: string }).reason ?? 'no reason'}`);
      }

      const deadlineMs = options?.deadlineMs ?? this.serverConfigs.get(serverName)?.toolTimeoutMs ?? DEFAULT_TOOL_CALL_DEADLINE_MS;
      const deadline = new AbortController();
      const sentAt = performance.now();
      // The deadline counts the server's time only: while a question the server
      // asked during this call waits on an answer (a person may be reading it),
      // the timer stops, and it starts again with what was left once answered.
      let deadlineLeftMs = deadlineMs;
      let deadlineArmedAt = 0;
      let questionsWaiting = 0;
      let questionStartedAt = 0;
      let questionMs = 0;
      const armDeadline = () => {
        deadlineArmedAt = performance.now();
        deadlineTimer = setTimeout(() => deadline.abort(new Error(
          `MCP tool '${parsed.toolName}' on server '${serverName}' gave no answer within ${Math.round(deadlineMs / 1000)} s `
          + `(waited ${Math.round(performance.now() - sentAt - questionMs)} ms`
          + `${questionMs > 0 ? `, not counting ${Math.round(questionMs)} ms spent answering its questions` : ''}); `
          + 'the call was cancelled and the server was told.')), Math.max(0, deadlineLeftMs));
        deadlineTimer.unref?.();
      };
      if (deadlineMs > 0) armDeadline();
      const onServerQuestion = (): (() => void) => {
        if (questionsWaiting++ === 0) {
          questionStartedAt = performance.now();
          if (deadlineTimer !== undefined) {
            clearTimeout(deadlineTimer); deadlineTimer = undefined;
            deadlineLeftMs -= performance.now() - deadlineArmedAt;
          }
        }
        let answered = false;
        return () => {
          if (answered) return;
          answered = true;
          if (--questionsWaiting > 0) return;
          questionMs += performance.now() - questionStartedAt;
          if (deadlineMs > 0 && !callSettled && !deadline.signal.aborted) armDeadline();
        };
      };
      const callSignal = AbortSignal.any([signal, deadline.signal]);
      let sent = false;
      try {
        assertCurrent();
        const result = await client.callTool(parsed.toolName, args, {
          signal: callSignal,
          ...(operation ? { operation } : {}),
          onServerQuestion,
          beforeSend: () => {
            if (staleBeforeSend.aborted) {
              const reason: unknown = staleBeforeSend.reason;
              if (!sent) throw reason instanceof Error ? reason : new Error(String(reason));
              // A later request of a call whose first request already went out.
              throw new Error(`MCP call '${qualifiedName}': the server's permissions or the configuration changed after the call was sent, `
                + 'so its next request was not sent. The tool may have done part of its work; check its state before calling it again.');
            }
            callSignal.throwIfAborted(); options?.assertCurrent?.(); source?.assertCurrent();
            assertWorkspaceCurrent?.(); execution?.assertCurrent();
            if (!sent) { admission?.claim(); sent = true; staleBeforeSend.removeEventListener('abort', forwardStale); }
          },
        });
        // The tool has already run: a policy, configuration or caller change after
        // dispatch must not turn a completed call into a failure the caller would
        // retry. A quarantine that landed meanwhile is kept, not cleared as fresh.
        if (!this.freshness.isQuarantined(serverName) && this.freshness.getFreshness(serverName) !== 'fresh') {
          this.freshness.markFresh(serverName); this.#lifecycle.recovered(serverName);
        }
        // Post:mcp:call hook (fire-and-forget)
        const postEvent: HookEvent = {
          path: 'Post:mcp:call',
          phase: 'Post',
          category: 'mcp',
          specific: 'call',
          sessionId, timestamp: Date.now(),
          payload: { tool: qualifiedName, args },
        };
        dispatcher.fire(postEvent).catch((err: unknown) => { logger.warn('Post:mcp:call hook error', { error: summarizeError(err) }); });
        return result;
      } catch (err) {
        // An error answer from the server is the caller's result, not evidence about the schema,
        // so it never counts toward the server's quarantine.
        let failure = err;
        if (deadline.signal.aborted && err === deadline.signal.reason) {
          const health = await this.checkServerHealth(serverName).catch(() => null);
          failure = new Error(`${summarizeError(err)} ${health?.responsive
            ? `The server still answers a health check (${health.elapsedMs} ms), so the tool itself is slow and may still finish what it was asked; call it again with less work, or raise toolTimeoutMs for '${serverName}' in its MCP settings file.`
            : 'The server did not answer a health check either; run /mcp reload (or reload the MCP configuration) to restart it.'}`);
        }
        // Fail:mcp:call hook (fire-and-forget)
        const failEvent: HookEvent = {
          path: 'Fail:mcp:call',
          phase: 'Fail',
          category: 'mcp',
          specific: 'call',
          sessionId, timestamp: Date.now(),
          payload: { tool: qualifiedName, args, error: summarizeError(failure) },
        };
        dispatcher.fire(failEvent).catch((hookErr: unknown) => { logger.warn('Fail:mcp:call hook error', { error: String(hookErr) }); });
        throw failure;
      }
    } finally {
      callSettled = true; clearTimeout(deadlineTimer);
      staleBeforeSend.removeEventListener('abort', forwardStale);
      // Ends anything still holding this call's signal, such as a question left unanswered.
      unsent.abort(new Error(`MCP call '${qualifiedName}' has ended.`));
      admission?.close(); unsubscribe?.(); configLife.abort();
      const left = (this.#callsInFlight.get(serverName) ?? 1) - 1;
      if (left > 0) this.#callsInFlight.set(serverName, left);
      else {
        this.#callsInFlight.delete(serverName);
        // A server that was mid-call when sandbox.mcpIsolation changed restarts now that its calls have ended.
        if (this.#restartAfterCall.delete(serverName)) this.#restartUnderIsolation(serverName);
      }
    }
  }

  /**
   * disconnectAll, Stop all connected MCP server processes. This is the
   * shutdown path: the process usually exits right after, so it also waits,
   * together and briefly, for the HTTP session ends it started to leave, so a
   * stateful server is told to release its session instead of holding it until
   * its own expiry. A single reconnect or reload never waits on them.
   */
  async disconnectAll(): Promise<void> {
    this.#shutdowns++;
    this.#restartAfterCall.clear();
    // A server waiting for a reconnect has no client or pending connect to stop; its timer is ended here.
    this.#lifecycle.stopAll('the MCP servers were disconnected');
    const names = new Set([...this.clients.keys(), ...this.pendingConnections.keys()]);
    const closing = [...this.clients.values()];
    // Each disconnect synchronously revokes admission, then owns both the
    // published transport and any still-negotiating transport until cleanup.
    const outcomes = await Promise.allSettled([...names].map(name => this.disconnectServer(name)));
    let bound: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(closing.map(client => client.sessionEnded())),
      new Promise<void>(resolve => { bound = setTimeout(resolve, SHUTDOWN_SESSION_END_MS); bound.unref?.(); }),
    ]);
    clearTimeout(bound);
    const errors = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'MCP connection cleanup failed');
  }

  async disconnectServer(serverName: string, reason = 'manual'): Promise<boolean> {
    const pending = this.pendingConnections.get(serverName);
    const client = this.clients.get(serverName);
    this.#lifecycle.stop(serverName, reason);
    this.invalidatePolicyLifetime(serverName, 'it was disconnected');
    const outcomes = await Promise.allSettled([
      pending?.done.catch(() => {}),
      client ? this.disconnectClient(serverName, client, reason) : undefined,
    ]);
    const errors = [...(pending?.cleanupErrors ?? []), ...outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : [])];
    if (errors.length) throw new AggregateError(errors, 'MCP server cleanup failed');
    return !!pending || !!client;
  }

  /** A removed server leaves nothing behind, so one later added under the same name starts clean. */
  private forgetServer(name: string): void {
    if (this.serverConfigs.has(name) || this.clients.has(name) || this.pendingConnections.has(name)) return;
    this.permissions.removeServer(name);
    this.#lifecycle.forget(name);
    this.sessionPolicy.delete(name);
    this.sessionToolDenials.delete(name);
    this.freshness.removeServer(name);
    this.connectFailures.delete(name);
    this.policyLifetimes.delete(name);
    this.#failedForIsolation.delete(name);
  }

  private async disconnectClient(serverName: string, client: McpClient, reason: string): Promise<void> {
    const sessionId = this.sandboxSessionByServer.get(serverName);
    this.executionByClient.get(client)?.close();
    await client.disconnect();
    this.#releaseClient(serverName, client, reason, sessionId);
    if (this.runtimeBus) {
      emitMcpDisconnected(this.runtimeBus, {
        sessionId: 'mcp-registry',
        traceId: `mcp-registry:${serverName}:disconnected`,
        source: 'mcp-registry',
      }, { serverId: serverName, reason, willRetry: reason === 'reconnect' });
    }
  }

  /**
   * What a client leaves behind once it is gone: its registration, its
   * sandbox session and the `Lifecycle:mcp:disconnected` hook. Runs once per
   * client, from a deliberate disconnect or from the server dropping it.
   */
  #releaseClient(serverName: string, client: McpClient, reason: string, sessionId: string | undefined): void {
    if (this.clients.get(serverName) === client) { this.clients.delete(serverName); this.#revision++; }
    if (sessionId) {
      this.sandboxSessions.stop(sessionId);
      if (this.sandboxSessionByServer.get(serverName) === sessionId) this.sandboxSessionByServer.delete(serverName);
    }
    const disconnectedEvent: HookEvent = {
      path: 'Lifecycle:mcp:disconnected',
      phase: 'Lifecycle',
      category: 'mcp',
      specific: 'disconnected',
      sessionId: '',
      timestamp: Date.now(),
      payload: { server: serverName, reason },
    };
    this.hookDispatcher.fire(disconnectedEvent).catch((err: unknown) => {
      logger.warn('Lifecycle:mcp:disconnected hook error', { error: summarizeError(err) });
    });
  }

  /**
   * getClient, Get the McpClient for a given server name (for advanced use).
   */
  getClient(serverName: string): McpClient | undefined {
    return this.clients.get(serverName);
  }

  /** Connected server names. */
  get serverNames(): string[] {
    return Array.from(new Set([...this.serverConfigs.keys(), ...this.clients.keys()])).sort();
  }

  /**
   * listServers, Return status info for all known servers (connected or not).
   * Includes the negotiated protocol (era + version) and transport so
   * diagnostics surfaces show what each server is actually speaking.
   */
  listServers(): Array<{
    name: string;
    connected: boolean;
    transport?: 'stdio' | 'http' | undefined;
    protocolVersion?: string | undefined;
    protocolEra?: 'modern' | 'legacy' | undefined;
    phase: McpClientPhase;
    lastError?: string | undefined;
    reconnect?: McpReconnectStatus | undefined;
    excludedTools?: readonly McpExcludedTool[] | undefined;
  }> {
    return this.serverNames.map((name) => {
      const client = this.clients.get(name);
      const negotiated = client?.protocolInfo ?? null;
      const excludedTools = client?.excludedTools ?? [];
      const reconnect = this.#lifecycle.reconnectStatus(name);
      return {
        name,
        connected: client?.isConnected ?? false,
        transport: negotiated?.transport ?? (this.serverConfigs.get(name)?.url ? 'http' as const : 'stdio' as const),
        protocolVersion: negotiated?.version,
        protocolEra: negotiated?.era,
        phase: this.serverPhase(name),
        lastError: this.serverLastError(name),
        ...(reconnect ? { reconnect } : {}),
        ...(excludedTools.length > 0 ? { excludedTools } : {}),
      };
    });
  }

  private serverPhase(name: string): McpClientPhase {
    const client = this.clients.get(name);
    if (client?.isConnected) return client.phase;
    // A reconnect scheduled by the lifecycle owner comes back on its own, like a client restart.
    if (this.#lifecycle.isReconnecting(name)) return 'restart-wait';
    if (this.pendingConnections.has(name)) return 'starting';
    if (client) return client.phase;
    return this.connectFailures.has(name) ? 'gave-up' : 'idle';
  }

  private serverLastError(name: string): string | undefined {
    const client = this.clients.get(name);
    if (client?.isConnected) return client.lastError ?? undefined;
    return this.#lifecycle.getServer(name)?.lastError ?? client?.lastError ?? this.connectFailures.get(name);
  }

  /** A refusal that names the state, why, and what gets the server back. */
  private notConnectedMessage(name: string): string {
    const phase = this.serverPhase(name);
    const why = this.serverLastError(name);
    const reconnect = this.#lifecycle.reconnectStatus(name);
    let next: string;
    if (phase === 'restart-wait' && reconnect?.nextAttemptAt !== undefined) {
      const seconds = Math.max(1, Math.ceil((reconnect.nextAttemptAt - Date.now()) / 1000));
      next = `reconnect attempt ${reconnect.attempt} of ${reconnect.maxAttempts} starts in ${seconds} s; call the tool again after that`;
    } else if (phase === 'restart-wait' || phase === 'starting' || phase === 'negotiating') {
      next = 'it is being restarted; retry in a few seconds';
    } else if (this.#lifecycle.getState(name) === 'auth_required') {
      next = MCP_CREDENTIALS_REFUSED;
    } else {
      next = `${reconnect?.stoppedReason ? `${reconnect.stoppedReason}; ` : ''}fix the server or its entry in mcp.json, then run /mcp reload (or reload the MCP configuration) to reconnect it`;
    }
    return `McpRegistry: server '${name}' is not connected (${phase}${why ? `: ${why}` : ''}); ${next}`;
  }

  listServerSecurity(): Array<{
    name: string;
    connected: boolean;
    transport?: 'stdio' | 'http' | undefined;
    protocolVersion?: string | undefined;
    protocolEra?: 'modern' | 'legacy' | undefined;
    role: import('../runtime/mcp/types.js').McpServerRole;
    trustMode: import('../runtime/mcp/types.js').McpTrustMode;
    allowedPaths: string[];
    allowedHosts: string[];
    schemaFreshness: SchemaFreshness;
    quarantineReason?: QuarantineReason | undefined;
    quarantineDetail?: string | undefined;
    quarantineApprovedBy?: string | undefined;
    sessionTrustMode?: McpTrustMode | undefined;
    sessionRole?: McpServerRole | undefined;
    toolRules?: McpToolRuleRecord[] | undefined;
    configuredTrustMode: McpTrustMode;
    configuredRole: McpServerRole;
    phase: McpClientPhase;
    lastError?: string | undefined;
    reconnect?: McpReconnectStatus | undefined;
  }> {
    return this.listServers().map((server) => {
      const permissions = this.permissions.getServerPermissions(server.name);
      const freshnessRecord = this.freshness.getRecord(server.name);
      const config = this.serverConfigs.get(server.name);
      const session = this.sessionPolicy.get(server.name);
      const toolRules = this.toolRuleRecords(server.name);
      return {
        ...(session?.trustMode !== undefined ? { sessionTrustMode: session.trustMode } : {}),
        ...(session?.role !== undefined ? { sessionRole: session.role } : {}),
        ...(toolRules.length > 0 ? { toolRules } : {}),
        configuredTrustMode: config?.trustMode ?? MCP_DEFAULT_TRUST_MODE,
        configuredRole: config?.role ?? 'general',
        name: server.name,
        connected: server.connected,
        phase: server.phase,
        ...(server.lastError !== undefined ? { lastError: server.lastError } : {}),
        ...(server.reconnect ? { reconnect: server.reconnect } : {}),
        transport: server.transport,
        protocolVersion: server.protocolVersion,
        protocolEra: server.protocolEra,
        role: permissions?.profile.role ?? this.policyProfile(server.name, this.serverConfigs.get(server.name)).role,
        trustMode: permissions?.profile.mode ?? this.policyProfile(server.name, this.serverConfigs.get(server.name)).mode,
        allowedPaths: permissions?.profile.allowedPaths ?? [],
        allowedHosts: permissions?.profile.allowedHosts ?? [],
        schemaFreshness: this.freshness.getFreshness(server.name),
        quarantineReason: freshnessRecord?.quarantine?.reason,
        quarantineDetail: freshnessRecord?.quarantine?.detail,
        quarantineApprovedBy: freshnessRecord?.quarantine?.overrideAcknowledgedBy,
      };
    });
  }

  listServerSandboxBindings(): Array<{
    name: string;
    sessionId?: string | undefined;
    profileId?: 'mcp-server' | undefined;
    state?: import('../runtime/sandbox/types.js').SandboxSessionState | undefined;
    backend?: import('../runtime/sandbox/types.js').SandboxResolvedBackend | undefined;
    startupStatus?: 'verified' | 'planned' | 'failed' | undefined;
  }> {
    return this.serverNames.map((name) => {
      const sessionId = this.sandboxSessionByServer.get(name);
      const session = sessionId ? this.sandboxSessions.get(sessionId) : null;
      return {
        name,
        sessionId: sessionId ?? undefined,
        profileId: session?.profileId === 'mcp-server' ? session.profileId : undefined,
        state: session?.state,
        backend: session?.backend,
        startupStatus: session?.startupStatus,
      };
    });
  }

  /**
   * A policy change names a configured or connected server; an unknown name is
   * refused before anything in flight is cancelled. A configured server that
   * has not connected gets its policy record here, so it can be blocked or
   * given a role before it ever runs.
   */
  private ensurePolicyOwner(serverName: string, change: string): void {
    if (this.permissions.getServerPermissions(serverName)) return;
    const config = this.serverConfigs.get(serverName);
    if (!config) {
      throw new Error(`No MCP server named '${serverName}', so its ${change} was not changed. `
        + `Known servers: ${this.serverNames.join(', ') || '(none)'}. Run /mcp servers to list them.`);
    }
    this.permissions.registerServer(serverName, this.policyProfile(serverName, config));
    this.permissions.replaceToolOverrides(serverName, this.toolOverridesFor(serverName));
  }

  /** This session's values for a server, bound to the program now configured under its name. */
  private sessionPolicyFor(serverName: string): { trustMode?: McpTrustMode; role?: McpServerRole; launch: string } {
    const config = this.serverConfigs.get(serverName);
    const launch = config ? launchIdentity(config, this.serverSources.get(serverName)) : '';
    const session = this.sessionPolicy.get(serverName);
    return session && session.launch === launch ? session : { launch };
  }

  setServerTrustMode(serverName: string, mode: McpTrustMode): void {
    this.ensurePolicyOwner(serverName, 'trust mode');
    this.invalidatePolicyLifetime(serverName, 'its trust mode was changed');
    this.permissions.setTrustMode(serverName, mode);
    this.sessionPolicy.set(serverName, { ...this.sessionPolicyFor(serverName), trustMode: mode });
    this._emitPolicyUpdate(serverName);
  }

  setServerRole(serverName: string, role: McpServerRole): void {
    this.ensurePolicyOwner(serverName, 'role');
    this.invalidatePolicyLifetime(serverName, 'its role was changed');
    this.permissions.setServerRole(serverName, role);
    this.sessionPolicy.set(serverName, { ...this.sessionPolicyFor(serverName), role });
    this._emitPolicyUpdate(serverName);
  }

  /**
   * Refuse one of a server's tools for this session, whatever its trust mode,
   * scope and a kept allow say. The deny outlives reconnects and config
   * reloads, like a session trust mode, and ends with the process, the
   * server's removal or {@link clearServerToolDenial}. A call to the tool not
   * yet sent is refused. {@link storeServerToolRule} keeps one past a restart.
   */
  denyServerTool(serverName: string, toolName: string): void {
    this.ensurePolicyOwner(serverName, `tool '${toolName}'`);
    const denied = this.sessionToolDenials.get(serverName) ?? new Set<string>();
    denied.add(toolName);
    this.sessionToolDenials.set(serverName, denied);
    this.syncToolRules(serverName);
  }

  /**
   * End this session's deny of one tool; false when it had none. A deny kept
   * in the server's config still applies; otherwise its trust mode and scope
   * (or a kept allow) decide the tool again.
   */
  clearServerToolDenial(serverName: string, toolName: string): boolean {
    const denied = this.sessionToolDenials.get(serverName);
    if (!denied?.delete(toolName)) return false;
    if (denied.size === 0) this.sessionToolDenials.delete(serverName);
    this.syncToolRules(serverName);
    return true;
  }

  /**
   * Keep one tool's rule with the server's entry in its MCP config file, then
   * apply it: `block` refuses every call to the tool, `exempt` lets it past the
   * server's path and host scope, `unblock` and `unexempt` drop a kept block or
   * exemption (only that kind). The entry must be
   * in a file this program writes (the owner's global file or the project's
   * `.goodvibes/mcp.json`); an exemption only in the global one. The roots are the
   * workspace the servers were started from unless given.
   *
   * An exemption loosens what a server may do: every caller that reaches this
   * method for one is the owner's own act (Settings, the owner's own command,
   * an owner-only operator method), never a model's.
   */
  async storeServerToolRule(
    serverName: string,
    toolName: string,
    rule: McpToolRule,
    workspace?: McpConfigRoots,
  ): Promise<{ readonly scope: McpConfigScope; readonly path: string; readonly changed: boolean; readonly reload: McpReloadResult }> {
    const roots = workspace ?? this.startedRoots ?? this.#workspaceRoots;
    if (!roots) throw new Error(`This program names no workspace for its MCP servers, so no rule for ${serverName} tool '${toolName}' was kept.`);
    const entry = loadMcpEffectiveConfig(roots).servers.find((candidate) => candidate.server.name === serverName);
    if (!entry) {
      throw new Error(`No MCP server named '${serverName}' is configured, so no rule for its tool '${toolName}' was kept. `
        + `Known servers: ${this.serverNames.join(', ') || '(none)'}. Run /mcp servers to list them.`);
    }
    const source = entry.source;
    if (!source.writable || source.scope === 'external') {
      throw new Error(`${serverName} is configured in ${source.path}, a file another program owns, so no rule for its tool '${toolName}' can be kept there. `
        + `Add ${serverName} to your own MCP config (/mcp add with --scope global) to keep per-tool rules, or block it for this session only: /mcp block ${serverName} ${toolName}.`);
    }
    const scope = source.scope;
    const written = await withMcpConfigLock(roots, scope, () => setMcpServerToolRule(roots, scope, serverName, toolName, rule));
    return { scope, path: written.path, changed: written.changed, reload: await this.reload(roots) };
  }

  /**
   * Keep a server's trust mode or role with its entry in its MCP config file,
   * then apply it: this session's value for that field ends and the kept one
   * decides, after a restart too. The entry must be in a file this program
   * writes (the owner's global file or the project's `.goodvibes/mcp.json`);
   * `allow-all` only in the global one. The roots are the workspace the
   * servers were started from unless given.
   *
   * A looser trust mode loosens what a server may do: every caller that
   * reaches this method for one is the owner's own act (Settings, their own
   * command, which asks once when a model runs it), never a model's tool.
   */
  async storeServerPolicy(
    serverName: string,
    policy: { readonly trustMode: NonNullable<McpServerConfig['trustMode']> } | { readonly role: NonNullable<McpServerConfig['role']> },
    workspace?: McpConfigRoots,
  ): Promise<{ readonly scope: McpConfigScope; readonly path: string; readonly changed: boolean; readonly reload: McpReloadResult }> {
    const what = 'trustMode' in policy ? 'trust mode' : 'role';
    const roots = workspace ?? this.startedRoots ?? this.#workspaceRoots;
    if (!roots) throw new Error(`This program names no workspace for its MCP servers, so the ${what} of ${serverName} was not kept.`);
    const entry = loadMcpEffectiveConfig(roots).servers.find((candidate) => candidate.server.name === serverName);
    if (!entry) {
      throw new Error(`No MCP server named '${serverName}' is configured, so its ${what} was not kept. `
        + `Known servers: ${this.serverNames.join(', ') || '(none)'}. Run /mcp servers to list them.`);
    }
    const source = entry.source;
    if (!source.writable || source.scope === 'external') {
      throw new Error(`${serverName} is configured in ${source.path}, a file another program owns, so its ${what} cannot be kept there. `
        + `Add ${serverName} to your own MCP config (/mcp add with --scope global) to keep it.`);
    }
    const scope = source.scope;
    const written = await withMcpConfigLock(roots, scope, () => setMcpServerPolicy(roots, scope, serverName, policy));
    // The kept value decides from now on: this session's value for the field ends.
    this.clearServerSessionPolicy(serverName, 'trustMode' in policy ? 'trustMode' : 'role');
    return { scope, path: written.path, changed: written.changed, reload: await this.reload(roots) };
  }

  /** The per-tool overrides in force: kept allows, then kept denials, then this session's denials; a deny wins. */
  private toolOverridesFor(serverName: string): McpToolPermission[] {
    const config = this.serverConfigs.get(serverName);
    const overrides = new Map<string, McpToolPermission>();
    for (const toolName of config?.allowedTools ?? []) overrides.set(toolName, { toolName, verdict: 'allow', note: TOOL_RULE_NOTES.storedAllow });
    for (const toolName of config?.deniedTools ?? []) overrides.set(toolName, { toolName, verdict: 'deny', note: TOOL_RULE_NOTES.storedDeny });
    for (const toolName of this.sessionToolDenials.get(serverName) ?? []) {
      if (overrides.get(toolName)?.verdict !== 'deny') overrides.set(toolName, { toolName, verdict: 'deny', note: TOOL_RULE_NOTES.sessionDeny });
    }
    return [...overrides.values()];
  }

  /** Every per-tool rule on a server, each with where it came from, for the surfaces that show them. */
  private toolRuleRecords(serverName: string): McpToolRuleRecord[] {
    const config = this.serverConfigs.get(serverName);
    const session = this.sessionToolDenials.get(serverName) ?? new Set<string>();
    const denied = new Set([...(config?.deniedTools ?? []), ...session]);
    return [
      ...(config?.deniedTools ?? []).map((toolName): McpToolRuleRecord => ({ toolName, rule: 'deny', source: 'stored', inEffect: true })),
      ...[...session].map((toolName): McpToolRuleRecord => ({ toolName, rule: 'deny', source: 'session', inEffect: true })),
      ...(config?.allowedTools ?? []).map((toolName): McpToolRuleRecord => ({ toolName, rule: 'allow', source: 'stored', inEffect: !denied.has(toolName) })),
    ];
  }

  /**
   * Bring a registered server's per-tool overrides in line with its config and
   * this session's denials. When they change, calls not yet sent end (the
   * policy lifetime) and the policy update is emitted. A server with no policy
   * record yet gets its overrides when it registers.
   */
  private syncToolRules(serverName: string): void {
    const record = this.permissions.getServerPermissions(serverName);
    if (!record) return;
    const next = this.toolOverridesFor(serverName);
    const same = next.length === record.toolOverrides.size && next.every((override) => {
      const current = record.toolOverrides.get(override.toolName);
      return current?.verdict === override.verdict && current.note === override.note;
    });
    if (same) return;
    this.invalidatePolicyLifetime(serverName, 'its per-tool allows or denials changed');
    this.permissions.replaceToolOverrides(serverName, next);
    this._emitPolicyUpdate(serverName);
  }

  /**
   * End this session's trust mode or role for a server, so it runs under its
   * configured value again. False when the server had no such session value.
   */
  clearServerSessionPolicy(serverName: string, field: 'trustMode' | 'role'): boolean {
    const session = this.sessionPolicy.get(serverName);
    if (session?.[field] === undefined) return false;
    const rest = { ...session };
    delete rest[field];
    if (rest.trustMode === undefined && rest.role === undefined) this.sessionPolicy.delete(serverName);
    else this.sessionPolicy.set(serverName, rest);
    const profile = this.policyProfile(serverName, this.serverConfigs.get(serverName));
    if (this.permissions.getServerPermissions(serverName)) {
      this.invalidatePolicyLifetime(serverName, field === 'trustMode' ? 'its trust mode was changed' : 'its role was changed');
      if (field === 'trustMode') this.permissions.setTrustMode(serverName, profile.mode);
      else this.permissions.setServerRole(serverName, profile.role);
      this._emitPolicyUpdate(serverName);
    }
    return true;
  }

  listRecentSecurityDecisions(limit = 8): McpDecisionRecord[] {
    return this.permissions.listRecentDecisions(limit);
  }

  /** Be told whenever a security decision is recorded; read `listRecentSecurityDecisions` again. Returns the unsubscribe. */
  subscribeSecurityDecisions(listener: () => void): () => void {
    return this.permissions.subscribeDecisions(listener);
  }

  quarantineSchema(serverName: string, reason: QuarantineReason, detail?: string): void {
    this.invalidatePolicyLifetime(serverName, 'it was quarantined');
    this.freshness.markQuarantined(serverName, reason, detail);
    if (this.runtimeBus) {
      emitMcpSchemaQuarantined(this.runtimeBus, {
        sessionId: 'mcp-registry',
        traceId: `mcp-registry:${serverName}:schema-quarantined`,
        source: 'mcp-registry',
      }, { serverId: serverName, reason, ...(detail ? { detail } : {}) });
    }
  }

  approveSchemaQuarantine(serverName: string, operatorId: string): void {
    this.invalidatePolicyLifetime(serverName, 'its quarantine was approved');
    this.freshness.approveQuarantine(serverName, operatorId);
    // Accepting a server's changed tools reads them again: the next listing asks the server, not the held catalog.
    this.clients.get(serverName)?.forgetToolCatalog();
    if (this.runtimeBus) {
      emitMcpSchemaQuarantineApproved(this.runtimeBus, {
        sessionId: 'mcp-registry',
        traceId: `mcp-registry:${serverName}:schema-approved`,
        source: 'mcp-registry',
      }, { serverId: serverName, operatorId });
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** One connect attempt. `reconnect` marks an attempt the lifecycle owner scheduled, which continues its cycle instead of starting a new one. */
  private _connectServer(serverConfig: McpServerConfig, reconnect = false): Promise<void> {
    if (this.serverConfigs.get(serverConfig.name) !== serverConfig) return Promise.reject(new Error('MCP configuration intent changed'));
    if (!reconnect) this.#lifecycle.requested(serverConfig.name);
    const previous = this.pendingConnections.get(serverConfig.name);
    previous?.lifetime.abort();
    const pending: PendingMcpConnection = { lifetime: new AbortController(), done: Promise.resolve(), cleanupErrors: [] };
    this.pendingConnections.set(serverConfig.name, pending);
    pending.done = Promise.resolve().then(async () => {
      await previous?.done.catch(() => {});
      if (previous?.cleanupErrors.length) {
        pending.cleanupErrors.push(...previous.cleanupErrors);
        throw new AggregateError(previous.cleanupErrors, 'Previous MCP connection cleanup failed');
      }
      await this.connectAttempt(serverConfig, pending);
    }).finally(() => {
      // A failed cleanup remains owned and blocks replacement; later close
      // must report it even when the original registration caller is gone.
      if (!pending.cleanupErrors.length && this.pendingConnections.get(serverConfig.name) === pending) this.pendingConnections.delete(serverConfig.name);
    });
    return pending.done;
  }

  private async connectAttempt(serverConfig: McpServerConfig, pending: PendingMcpConnection): Promise<void> {
    const host = this.permissionHost;
    const configuration = new AbortController();
    let releaseConfiguration = host?.config.onDidInvalidate(() => configuration.abort()) ?? (() => {});
    const signal = AbortSignal.any([pending.lifetime.signal, configuration.signal, ...(host ? [host.signal] : [])]);
    // Once connected, a configuration write no longer ends the connection: each
    // call already carries its own configuration fence. Only disconnect, owner
    // revocation and workspace changes end it.
    const closed = new AbortController();
    const connectionSignal = AbortSignal.any([pending.lifetime.signal, closed.signal, ...(host ? [host.signal] : [])]);
    let established = false;
    try {
    const assertHostCurrent = (): void => {
      signal.throwIfAborted();
      if (this.permissionHost !== host) throw new Error('MCP connection owner changed');
      if (this.serverConfigs.get(serverConfig.name) !== serverConfig || this.pendingConnections.get(serverConfig.name) !== pending)
        throw new Error('MCP configuration intent changed');
    };
    assertHostCurrent();
    const { name } = serverConfig;
    // Whether this attempt still speaks for the configuration; a cancelled attempt reports no outcome.
    const stillWanted = (): boolean => !signal.aborted && this.permissionHost === host
      && this.serverConfigs.get(name) === serverConfig && this.pendingConnections.get(name) === pending;
    const existing = this.clients.get(name);
    if (existing?.isConnected) {
      logger.info('McpRegistry: server already registered', { name });
      this.#lifecycle.connected(name);
      return;
    }
    if (existing) {
      try { await this.disconnectClient(name, existing, 'reconnect'); }
      catch (error) { pending.cleanupErrors.push(error); throw error; }
      assertHostCurrent();
    }
    let sandboxSessionId: string | null = null;
    let processSpec: McpProcessSpec | undefined;
    let assertExecutionCurrent: (() => void) | undefined;
    const isolated = !!serverConfig.command && !!this.sandboxConfigManager
      && getSandboxConfigSnapshot(this.sandboxConfigManager).mcpIsolation !== 'disabled';
    // A server from the person's own files in their home folder (not contained) starts there, in their home context: it is
    // not the workspace's, so the workspace's trust does not decide whether it starts (a daemon serving a restricted
    // folder still starts a server added for all your projects). Its tool calls are gated as every call is.
    const home = this.startedRoots?.homeDirectory;
    const userContext = !!serverConfig.command && !isolated && this.#userContextServers.has(serverConfig.name) && !!home;
    // A project's server starts in the workspace its files were read from (a daemon serves many projects from one
    // process, so its own working folder is no project's); a program's workspace is its own folder, as before.
    const processCwd = userContext ? home! : host && isolated ? this.sandboxSessions.getWorkspaceRoot() : this.startedRoots?.workingDirectory ?? process.cwd();
    if (userContext) processSpec = { command: serverConfig.command!, args: [...(serverConfig.args ?? [])], cwd: processCwd };
    // A host process started for a workspace that is not this process's folder starts in that workspace.
    else if (serverConfig.command && !isolated && processCwd !== process.cwd()) processSpec = { command: serverConfig.command, args: [...(serverConfig.args ?? [])], cwd: processCwd };
    if (host && serverConfig.command && !userContext) {
      assertExecutionCurrent = await prepareExternalExecution(host, processCwd, signal);
      assertHostCurrent(); assertExecutionCurrent();
    }
    if (this.sandboxConfigManager) {
      let resolved: { sessionId: string; processSpec: McpProcessSpec } | null;
      try { resolved = await this._resolveSandboxProcessSpec(serverConfig, assertExecutionCurrent); }
      catch (error) {
        // A server that asked for a boundary this host cannot give is not started; say so where its status is read.
        if (this.serverConfigs.get(name) === serverConfig) {
          this.#failedForIsolation.add(name);
          this.freshness.markFailed(name, summarizeError(error));
          this.connectFailures.set(name, summarizeError(error));
          if (stillWanted()) this.#lifecycle.failed(name, summarizeError(error));
        }
        throw error;
      }
      sandboxSessionId = resolved?.sessionId ?? null;
      processSpec = resolved?.processSpec ?? processSpec;
      try { assertHostCurrent(); }
      catch (error) {
        if (sandboxSessionId) {
          try { this.sandboxSessions.stop(sandboxSessionId); }
          catch (cleanupError) { pending.cleanupErrors.push(cleanupError); }
        }
        throw error;
      }
    }
    if (host && serverConfig.command && processSpec?.cwd && processSpec.cwd !== processCwd) {
      try { assertExecutionCurrent = await prepareExternalExecution(host, processSpec.cwd, signal); assertHostCurrent(); }
      catch (error) {
        if (sandboxSessionId) {
          try { this.sandboxSessions.stop(sandboxSessionId); }
          catch (cleanupError) { pending.cleanupErrors.push(cleanupError); }
        }
        throw error;
      }
    }
    const assertProcessCurrent = () => {
      (established ? connectionSignal : signal).throwIfAborted(); assertExecutionCurrent?.();
      if (this.permissionHost !== host || !sameServerConfig(this.serverConfigs.get(name), serverConfig))
        throw new Error('MCP process owner or configuration changed');
    };
    const elicitationHandler = this.elicitationHandler;
    const client: McpClient = new McpClient(serverConfig, {
      ...(processSpec ? { processSpec } : {}),
      onUnexpectedExit: (reason) => this.#clientDropped(name, client, reason),
      ...(host && serverConfig.command ? { beforeProcessStart: assertProcessCurrent } : {}),
      onNotification: (notification) => this._handleClientNotification(notification),
      onServerRequest: (request) => this._handleClientServerRequest(request),
      onUnhandledResponse: (response) => this._handleClientUnhandledResponse(response),
      ...(elicitationHandler
        ? {
            onElicitation: (input) => {
              const currentHandler = this.elicitationHandler;
              if (!currentHandler) return Promise.resolve({ action: 'cancel' as const });
              const scope = input.context?.scope;
              const context = scope && input.context ? { ...input.context, scope: { ...scope, assertCurrent: () => {
                scope.assertCurrent();
                if (this.elicitationHandler !== currentHandler) throw new Error('MCP input resolver changed');
              } } } : input.context;
              return currentHandler(parseElicitationParams(input.serverName, input.params, input.id), context);
            },
          }
        : {}),
    });
    this.freshness.registerServer(name);
    try {
      assertHostCurrent();
      await executePolicyCheck(() => client.connect(), signal);
      assertHostCurrent(); assertProcessCurrent();
      this.permissions.registerServer(name, this.policyProfile(name, serverConfig));
      this.permissions.replaceToolOverrides(name, this.toolOverridesFor(name));
      // A server that finishes starting does not change a catalog captured
      // before it: that read listed the servers connected then, and the client
      // it would replace is checked by identity there.
      this.clients.set(name, client);
      if (serverConfig.command) this.#startedIsolated.set(client, processSpec?.sandboxSessionId !== undefined);
      this.#failedForIsolation.delete(name);
      this.connectFailures.delete(name);
      established = true;
      releaseConfiguration(); releaseConfiguration = () => {};
      if (host && serverConfig.command) {
        this.executionByClient.set(client, { assertCurrent: assertProcessCurrent, close: () => closed.abort() });
      }
      if (sandboxSessionId) {
        this.sandboxSessionByServer.set(name, sandboxSessionId);
      }
      this.freshness.markFresh(name);
      logger.info('McpRegistry: server connected', { name });
      if (this.runtimeBus) {
        const policy = this.policyProfile(name, serverConfig);
        emitMcpConfigured(this.runtimeBus, {
          sessionId: 'mcp-registry',
          traceId: `mcp-registry:${name}:configured`,
          source: 'mcp-registry',
        }, {
          serverId: name,
          transport: client.protocolInfo?.transport ?? (serverConfig.url ? 'http' : 'stdio'),
          ...(serverConfig.url ? { url: serverConfig.url } : {}),
          role: policy.role,
          trustMode: policy.mode,
          allowedPaths: policy.allowedPaths,
          allowedHosts: policy.allowedHosts,
        });
      }
      this.#lifecycle.connected(name);
      // A process that exited between the handshake and registration was reported to no one.
      if (!client.isConnected) this.#clientDropped(name, client, client.lastError ?? 'the server process exited unexpectedly');
      // Lifecycle:mcp:connected hook (fire-and-forget)
      const connectedEvent: HookEvent = {
        path: 'Lifecycle:mcp:connected',
        phase: 'Lifecycle',
        category: 'mcp',
        specific: 'connected',
        sessionId: '', timestamp: Date.now(),
        payload: { server: name },
      };
      this.hookDispatcher.fire(connectedEvent).catch((err: unknown) => { logger.warn('Lifecycle:mcp:connected hook error', { error: summarizeError(err) }); });
    } catch (err) {
      // Kill any half-started process so a failed handshake does not leak an
      // orphan server. intentionalClose (set inside disconnect) keeps the
      // client from reporting this exit as unexpected, so the lifecycle owner
      // does not schedule a reconnect for it.
      await client.disconnect().catch((e: unknown) => {
        pending.cleanupErrors.push(e);
        logger.warn('McpRegistry: failed to clean up half-connected client', { name, err: summarizeError(e) });
      });
      if (sandboxSessionId) {
        try { this.sandboxSessions.stop(sandboxSessionId); }
        catch (error) { pending.cleanupErrors.push(error); }
        if (this.sandboxSessionByServer.get(name) === sandboxSessionId) this.sandboxSessionByServer.delete(name);
      }
      if (this.serverConfigs.get(name) === serverConfig) {
        // A start inside the boundary that failed is one the next isolation change starts again.
        if (isolated) this.#failedForIsolation.add(name);
        this.freshness.markFailed(name, summarizeError(err));
        this.connectFailures.set(name, summarizeError(err));
        if (stillWanted()) {
          // A credential refusal is not retried: the same connect would be refused again.
          const auth = mcpAuthRefusal(err);
          if (auth) this.#lifecycle.authRequired(name, summarizeError(err), auth.authType);
          else this.#lifecycle.failed(name, summarizeError(err));
        }
      }
      logger.error('McpRegistry: failed to connect server', { name, err: summarizeError(err) });
      if (pending.cleanupErrors.length) throw new AggregateError([err, ...pending.cleanupErrors], 'MCP connection cleanup failed');
      // Don't register the client, it's not usable. A revoked owner is an
      // explicit cancellation, not a successful registration with an empty row.
      assertHostCurrent(); assertProcessCurrent();
    }
    } finally { releaseConfiguration(); }
  }

  /** The lifecycle owner's attempt: connect a configured server again, unless something else already is. */
  async #reconnect(name: string): Promise<boolean> {
    const serverConfig = this.serverConfigs.get(name);
    if (!serverConfig) return false;
    if (this.clients.get(name)?.isConnected) { this.#lifecycle.connected(name); return true; }
    const pending = this.pendingConnections.get(name);
    if (pending) { await pending.done.catch(() => {}); return true; }
    await this._connectServer(serverConfig, true);
    return true;
  }

  /** A registered client's server stopped without being asked; its calls already ended with its connection. */
  #clientDropped(name: string, client: McpClient, reason: string): void {
    if (this.clients.get(name) !== client) return;
    // Retired here, once: its sandbox session stops and hook authors hear of it now, whether or
    // not a reconnect follows, and a reconnect finds no client left to disconnect again. The
    // lifecycle owner's MCP_DISCONNECTED is the one event this drop publishes.
    this.executionByClient.get(client)?.close();
    this.connectFailures.set(name, reason);
    this.#releaseClient(name, client, reason, this.sandboxSessionByServer.get(name));
    void client.disconnect().catch((error: unknown) => {
      logger.debug('McpRegistry: releasing a dropped client failed', { name, error: summarizeError(error) });
    });
    this.#lifecycle.failed(name, reason);
  }

  #publishLifecycleEvent(event: McpEvent): void {
    const bus = this.runtimeBus;
    if (!bus) return;
    const ctx = { sessionId: 'mcp-registry', traceId: `mcp-registry:${event.serverId}:${event.type.toLowerCase()}`, source: 'mcp-registry' };
    switch (event.type) {
      case 'MCP_CONNECTING': emitMcpConnecting(bus, ctx, { serverId: event.serverId }); return;
      case 'MCP_CONNECTED': emitMcpConnected(bus, ctx, { serverId: event.serverId, toolCount: event.toolCount, resourceCount: event.resourceCount }); return;
      case 'MCP_DEGRADED': emitMcpDegraded(bus, ctx, { serverId: event.serverId, reason: event.reason, availableTools: event.availableTools }); return;
      case 'MCP_RECONNECTING': emitMcpReconnecting(bus, ctx, { serverId: event.serverId, attempt: event.attempt, maxAttempts: event.maxAttempts }); return;
      case 'MCP_AUTH_REQUIRED': emitMcpAuthRequired(bus, ctx, { serverId: event.serverId, authType: event.authType }); return;
      case 'MCP_DISCONNECTED':
        emitMcpDisconnected(bus, ctx, { serverId: event.serverId, willRetry: event.willRetry, ...(event.reason !== undefined ? { reason: event.reason } : {}) });
        return;
      default: return;
    }
  }

  /**
   * With `sandbox.mcpIsolation: contained`, a stdio server starts inside its
   * own bubblewrap boundary (sandbox session profile `mcp-server`): workspace
   * writable, system files and the server's own install read-only, $HOME and
   * /tmp private, host network shared. A host that cannot give the boundary
   * refuses the start rather than run the server unconfined.
   */
  private async _resolveSandboxProcessSpec(
    serverConfig: McpServerConfig,
    assertCurrent?: () => void,
  ): Promise<{ sessionId: string; processSpec: McpProcessSpec } | null> {
    const configManager = this.sandboxConfigManager;
    if (!configManager) return null;
    // HTTP servers are remote endpoints, there is no local process to sandbox.
    if (!serverConfig.command) return null;
    if (getSandboxConfigSnapshot(configManager).mcpIsolation === 'disabled') return null;

    assertCurrent?.();
    let session: Awaited<ReturnType<SandboxSessionRegistry['start']>>;
    try { session = await this.sandboxSessions.start('mcp-server', `${serverConfig.name} MCP`, configManager); }
    catch (error) {
      throw new Error(
        `MCP server '${serverConfig.name}' was not started: sandbox.mcpIsolation is 'contained' but this host cannot contain it `
        + `(${summarizeError(error)}). Install bubblewrap, or set sandbox.mcpIsolation to disabled to run MCP servers as host processes.`,
        { cause: error },
      );
    }
    const plan = session.launchPlan;
    if (!plan || plan.backend !== 'bubblewrap') {
      this.sandboxSessions.stop(session.id);
      throw new Error(
        `MCP server '${serverConfig.name}' was not started: sandbox.mcpIsolation is 'contained' but this host has no boundary `
        + `(${plan?.summary ?? 'no launch plan'}). Install bubblewrap, or set sandbox.mcpIsolation to disabled to run MCP servers as host processes.`,
      );
    }
    const args = [...(serverConfig.args ?? [])];
    return {
      sessionId: session.id,
      processSpec: {
        command: serverConfig.command,
        args,
        env: compactEnv(serverConfig.env ?? {}),
        cwd: plan.workspaceRoot,
        summary: plan.summary,
        sandboxSessionId: session.id,
        wrapper: sandboxCommandWrapper(plan, serverConfig.command, args),
      },
    };
  }

  private _handleClientNotification(notification: McpClientNotification): void {
    const event: HookEvent = {
      path: 'Lifecycle:mcp:notification',
      phase: 'Lifecycle',
      category: 'mcp',
      specific: 'notification',
      sessionId: '',
      timestamp: Date.now(),
      payload: {
        server: notification.serverName,
        method: notification.method,
        ...(notification.params !== undefined ? { params: notification.params } : {}),
      },
    };
    this.hookDispatcher.fire(event).catch((err: unknown) => {
      logger.warn('Lifecycle:mcp:notification hook error', { error: summarizeError(err) });
    });
  }

  private _handleClientServerRequest(request: McpClientServerRequest): void {
    const event: HookEvent = {
      path: 'Lifecycle:mcp:server_request',
      phase: 'Lifecycle',
      category: 'mcp',
      specific: 'server_request',
      sessionId: '',
      timestamp: Date.now(),
      payload: {
        server: request.serverName,
        id: request.id,
        method: request.method,
        ...(request.params !== undefined ? { params: request.params } : {}),
      },
    };
    this.hookDispatcher.fire(event).catch((err: unknown) => {
      logger.warn('Lifecycle:mcp:server_request hook error', { error: summarizeError(err) });
    });
  }

  private _handleClientUnhandledResponse(response: McpClientUnhandledResponse): void {
    const event: HookEvent = {
      path: 'Lifecycle:mcp:unmatched_response',
      phase: 'Lifecycle',
      category: 'mcp',
      specific: 'unmatched_response',
      sessionId: '',
      timestamp: Date.now(),
      payload: {
        server: response.serverName,
        id: response.id,
        hasError: response.hasError,
        ...(response.error ? { error: response.error } : {}),
      },
    };
    this.hookDispatcher.fire(event).catch((err: unknown) => {
      logger.warn('Lifecycle:mcp:unmatched_response hook error', { error: summarizeError(err) });
    });
  }

  /**
   * Parse mcp:<server>:<tool> qualified name.
   * Returns null if the name doesn't match the expected format.
   */
  private _parseQualifiedName(qualifiedName: string): { serverName: string; toolName: string } | null {
    const parts = qualifiedName.split(':');
    if (parts.length < 3 || parts[0]! !== 'mcp') return null;
    // serverName is parts[1], toolName is the rest joined (tools can have colons)
    const serverName = parts[1]!;
    const toolName = parts.slice(2).join(':');
    if (!serverName || !toolName) return null;
    return { serverName, toolName };
  }

  private _emitPolicyUpdate(serverName: string): void {
    if (!this.runtimeBus) return;
    const permissions = this.permissions.getServerPermissions(serverName);
    if (!permissions) return;
    emitMcpPolicyUpdated(this.runtimeBus, {
      sessionId: 'mcp-registry',
      traceId: `mcp-registry:${serverName}:policy`,
      source: 'mcp-registry',
    }, {
      serverId: serverName,
      role: permissions.profile.role,
      trustMode: permissions.profile.mode,
      allowedPaths: [...permissions.profile.allowedPaths],
      allowedHosts: [...permissions.profile.allowedHosts],
      deniedTools: [...permissions.toolOverrides.values()].filter((override) => override.verdict === 'deny').map((override) => override.toolName),
      allowedTools: [...permissions.toolOverrides.values()].filter((override) => override.verdict === 'allow').map((override) => override.toolName),
    });
  }
}
