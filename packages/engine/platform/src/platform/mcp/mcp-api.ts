import type { McpToolSchema } from './client.js';
import type { McpClientPhase, McpExcludedTool, McpToolCallOptions } from './client-types.js';
import type { McpServerHealth, RegisteredTool } from './registry.js';
import type { McpConfigRoots, McpConfigScope, McpEffectiveConfig, McpServerConfig, McpToolRule } from './config.js';
import type { McpReloadResult } from './registry.js';
import type { McpDecisionRecord, McpReconnectStatus, McpServerRole, McpToolRuleRecord, McpTrustMode, QuarantineReason, SchemaFreshness } from '../runtime/mcp/types.js';

export interface McpServerRecord {
  readonly name: string;
  readonly connected: boolean;
  readonly transport?: 'stdio' | 'http' | undefined;
  readonly protocolVersion?: string | undefined;
  readonly protocolEra?: 'modern' | 'legacy' | undefined;
  /** Where the connection is: `restart-wait` comes back on its own, `gave-up` needs a configuration reload. */
  readonly phase?: McpClientPhase | undefined;
  /** Why the last connect, handshake or restart failed, when it did. */
  readonly lastError?: string | undefined;
  /** The automatic reconnect cycle: attempt, limit, when the next one starts, or why it stopped. */
  readonly reconnect?: McpReconnectStatus | undefined;
  /** Tools the server listed that cannot be called, each with the reason. */
  readonly excludedTools?: readonly McpExcludedTool[] | undefined;
}

export interface McpServerSecurityRecord {
  readonly name: string;
  readonly connected: boolean;
  /** Where the connection is: `restart-wait` comes back on its own, `gave-up` needs a configuration reload. */
  readonly phase?: McpClientPhase | undefined;
  /** Why the last connect, handshake, restart or reconnect failed, when it did. */
  readonly lastError?: string | undefined;
  /** The automatic reconnect cycle: attempt, limit, when the next one starts, or why it stopped. */
  readonly reconnect?: McpReconnectStatus | undefined;
  readonly transport?: 'stdio' | 'http' | undefined;
  readonly protocolVersion?: string | undefined;
  readonly protocolEra?: 'modern' | 'legacy' | undefined;
  readonly role: McpServerRole;
  readonly trustMode: McpTrustMode;
  readonly allowedPaths: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly schemaFreshness: SchemaFreshness;
  readonly quarantineReason?: QuarantineReason | undefined;
  readonly quarantineDetail?: string | undefined;
  readonly quarantineApprovedBy?: string | undefined;
  /** A trust mode or role set for this session; it outlives reconnects and reloads until cleared or the process exits. */
  readonly sessionTrustMode?: McpTrustMode | undefined;
  readonly sessionRole?: McpServerRole | undefined;
  /** Per-tool allows and denials, each with where it came from (this session or the server's MCP config); absent when none. A deny wins. */
  readonly toolRules?: readonly McpToolRuleRecord[] | undefined;
  /** The values the server's config gives, which apply again once a session value is cleared. */
  readonly configuredTrustMode?: McpTrustMode | undefined;
  readonly configuredRole?: McpServerRole | undefined;
}

/** Where a kept per-tool rule was written, whether the file changed, and the reload that applied it. */
export interface McpStoredToolRuleResult {
  readonly scope: McpConfigScope;
  readonly path: string;
  readonly changed: boolean;
  readonly reload: McpReloadResult;
}

export interface McpSandboxBindingRecord {
  readonly name: string;
  readonly sessionId?: string | undefined;
  readonly profileId?: 'mcp-server' | undefined;
  readonly state?: import('../runtime/sandbox/types.js').SandboxSessionState | undefined;
  readonly backend?: import('../runtime/sandbox/types.js').SandboxResolvedBackend | undefined;
  readonly startupStatus?: 'verified' | 'planned' | 'failed' | undefined;
}

export interface McpApi {
  callTool?(qualifiedName: string, args: Readonly<Record<string, unknown>>, options?: McpToolCallOptions): Promise<unknown>;
  getToolSchema?(qualifiedName: string, options?: McpToolCallOptions): Promise<McpToolSchema | null>;
  getEffectiveConfig(roots: McpConfigRoots): McpEffectiveConfig;
  reload(roots: McpConfigRoots): Promise<McpReloadResult>;
  /** `byOwner`: the owner added it with their own command or form; a project file's entry then starts without the trust question. */
  upsertServerConfig(
    roots: McpConfigRoots,
    scope: McpConfigScope,
    serverConfig: McpServerConfig,
    options?: { readonly byOwner?: boolean | undefined },
  ): Promise<{ readonly path: string; readonly reload: McpReloadResult }>;
  removeServerConfig(
    roots: McpConfigRoots,
    scope: McpConfigScope,
    serverName: string,
  ): Promise<{ readonly path: string; readonly removed: boolean; readonly reload: McpReloadResult }>;
  listServerNames(): readonly string[];
  listServers(): readonly McpServerRecord[];
  listServerSecurity(): readonly McpServerSecurityRecord[];
  listSandboxBindings(): readonly McpSandboxBindingRecord[];
  listRecentSecurityDecisions(limit?: number): readonly McpDecisionRecord[];
  listAllTools(): Promise<readonly RegisteredTool[]>;
  /** Probe one server with a short ping; null when no such server is connected or configured. */
  checkServerHealth?(serverName: string, signal?: AbortSignal): Promise<McpServerHealth | null>;
  captureToolCatalog(options?: McpToolCallOptions): {
    readonly listAllTools: () => Promise<readonly RegisteredTool[]>;
    readonly assertCurrent: () => void;
  };
  setServerTrustMode(serverName: string, mode: McpTrustMode): void;
  setServerRole(serverName: string, role: McpServerRole): void;
  /** End this session's trust mode or role so the configured one applies; false when none was set. */
  clearServerSessionPolicy?(serverName: string, field: 'trustMode' | 'role'): boolean;
  /** Refuse one of the server's tools for this session, whatever its trust mode and scope allow. */
  denyServerTool?(serverName: string, toolName: string): void;
  /** End this session's deny of one tool; false when it had none. */
  clearServerToolDenial?(serverName: string, toolName: string): boolean;
  /**
   * Keep one tool's block or exemption with the server's entry in its MCP
   * config file, or drop it, and apply it. An exemption is the owner's act only.
   */
  storeServerToolRule?(serverName: string, toolName: string, rule: McpToolRule, roots?: McpConfigRoots): Promise<McpStoredToolRuleResult>;
  /**
   * Keep a server's trust mode or role with its entry in its MCP config file
   * and apply it, past a restart. A looser trust mode is the owner's act only.
   */
  storeServerPolicy?(serverName: string, policy: McpStoredServerPolicy, roots?: McpConfigRoots): Promise<McpStoredToolRuleResult>;
  quarantineSchema(serverName: string, reason: QuarantineReason, detail?: string): void;
  approveSchemaQuarantine(serverName: string, operatorId: string): void;
}

/** A trust mode or a role kept with a server's entry in its MCP config file. */
export type McpStoredServerPolicy =
  | { readonly trustMode: NonNullable<McpServerConfig['trustMode']> }
  | { readonly role: NonNullable<McpServerConfig['role']> };

export interface McpApiRegistry {
  callTool?(qualifiedName: string, args: Readonly<Record<string, unknown>>, options?: McpToolCallOptions): Promise<unknown>;
  getToolSchema?(qualifiedName: string, options?: McpToolCallOptions): Promise<McpToolSchema | null>;
  readonly serverNames: readonly string[];
  getEffectiveConfig(roots: McpConfigRoots): McpEffectiveConfig;
  reload(roots: McpConfigRoots): Promise<McpReloadResult>;
  upsertServerConfig(
    roots: McpConfigRoots,
    scope: McpConfigScope,
    serverConfig: McpServerConfig,
    options?: { readonly byOwner?: boolean | undefined },
  ): Promise<{ readonly path: string; readonly reload: McpReloadResult }>;
  removeServerConfig(
    roots: McpConfigRoots,
    scope: McpConfigScope,
    serverName: string,
  ): Promise<{ readonly path: string; readonly removed: boolean; readonly reload: McpReloadResult }>;
  listServers(): readonly McpServerRecord[];
  listServerSecurity(): readonly McpServerSecurityRecord[];
  listServerSandboxBindings(): readonly McpSandboxBindingRecord[];
  listRecentSecurityDecisions(limit?: number): readonly McpDecisionRecord[];
  listAllTools(): Promise<readonly RegisteredTool[]>;
  checkServerHealth?(serverName: string, signal?: AbortSignal): Promise<McpServerHealth | null>;
  captureToolCatalog(options?: McpToolCallOptions): ReturnType<McpApi['captureToolCatalog']>;
  setServerTrustMode(serverName: string, mode: McpTrustMode): void;
  setServerRole(serverName: string, role: McpServerRole): void;
  /** End this session's trust mode or role so the configured one applies; false when none was set. */
  clearServerSessionPolicy?(serverName: string, field: 'trustMode' | 'role'): boolean;
  /** Refuse one of the server's tools for this session, whatever its trust mode and scope allow. */
  denyServerTool?(serverName: string, toolName: string): void;
  /** End this session's deny of one tool; false when it had none. */
  clearServerToolDenial?(serverName: string, toolName: string): boolean;
  /**
   * Keep one tool's block or exemption with the server's entry in its MCP
   * config file, or drop it, and apply it. An exemption is the owner's act only.
   */
  storeServerToolRule?(serverName: string, toolName: string, rule: McpToolRule, roots?: McpConfigRoots): Promise<McpStoredToolRuleResult>;
  /**
   * Keep a server's trust mode or role with its entry in its MCP config file
   * and apply it, past a restart. A looser trust mode is the owner's act only.
   */
  storeServerPolicy?(serverName: string, policy: McpStoredServerPolicy, roots?: McpConfigRoots): Promise<McpStoredToolRuleResult>;
  quarantineSchema(serverName: string, reason: QuarantineReason, detail?: string): void;
  approveSchemaQuarantine(serverName: string, operatorId: string): void;
}

export function createMcpApi(registry: McpApiRegistry): McpApi {
  return {
    ...(registry.callTool ? { callTool: (name: string, args: Readonly<Record<string, unknown>>, options?: McpToolCallOptions) => registry.callTool!(name, args, options) } : {}),
    ...(registry.getToolSchema ? { getToolSchema: (name: string, options?: McpToolCallOptions) => registry.getToolSchema!(name, options) } : {}),
    getEffectiveConfig(roots) {
      return registry.getEffectiveConfig(roots);
    },
    reload(roots) {
      return registry.reload(roots);
    },
    upsertServerConfig(roots, scope, serverConfig, options) {
      return registry.upsertServerConfig(roots, scope, serverConfig, options);
    },
    removeServerConfig(roots, scope, serverName) {
      return registry.removeServerConfig(roots, scope, serverName);
    },
    listServerNames(): readonly string[] {
      return registry.serverNames;
    },
    listServers(): readonly McpServerRecord[] {
      return registry.listServers();
    },
    listServerSecurity() {
      return registry.listServerSecurity();
    },
    listSandboxBindings() {
      return registry.listServerSandboxBindings();
    },
    listRecentSecurityDecisions(limit = 8) {
      return registry.listRecentSecurityDecisions(limit);
    },
    listAllTools() {
      return registry.listAllTools();
    },
    captureToolCatalog(options) {
      return registry.captureToolCatalog(options);
    },
    ...(registry.checkServerHealth ? { checkServerHealth: (name: string, signal?: AbortSignal) => registry.checkServerHealth!(name, signal) } : {}),
    setServerTrustMode(serverName, mode) {
      registry.setServerTrustMode(serverName, mode);
    },
    setServerRole(serverName, role) {
      registry.setServerRole(serverName, role);
    },
    ...(registry.clearServerSessionPolicy
      ? { clearServerSessionPolicy: (serverName: string, field: 'trustMode' | 'role') => registry.clearServerSessionPolicy!(serverName, field) }
      : {}),
    ...(registry.denyServerTool
      ? { denyServerTool: (serverName: string, toolName: string) => registry.denyServerTool!(serverName, toolName) }
      : {}),
    ...(registry.clearServerToolDenial
      ? { clearServerToolDenial: (serverName: string, toolName: string) => registry.clearServerToolDenial!(serverName, toolName) }
      : {}),
    ...(registry.storeServerToolRule
      ? { storeServerToolRule: (serverName: string, toolName: string, rule: McpToolRule, roots?: McpConfigRoots) => registry.storeServerToolRule!(serverName, toolName, rule, roots) }
      : {}),
    ...(registry.storeServerPolicy
      ? { storeServerPolicy: (serverName: string, policy: McpStoredServerPolicy, roots?: McpConfigRoots) => registry.storeServerPolicy!(serverName, policy, roots) }
      : {}),
    quarantineSchema(serverName, reason, detail) {
      registry.quarantineSchema(serverName, reason, detail);
    },
    approveSchemaQuarantine(serverName, operatorId) {
      registry.approveSchemaQuarantine(serverName, operatorId);
    },
  };
}
