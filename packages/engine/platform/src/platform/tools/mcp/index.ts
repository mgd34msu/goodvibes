import type { Tool } from '../../types/tools.js';
import type { McpDecisionRecord } from '../../runtime/mcp/types.js';
import type { McpRegistry } from '../../mcp/registry.js';
import { MCP_TOOL_SCHEMA, type McpToolInput } from './schema.js';
import { currentTurnActor } from '../../security/turn-boundary.js';

type McpServerSecurity = ReturnType<McpRegistry['listServerSecurity']>[number];

function summarizeServer(server: McpServerSecurity) {
  return {
    name: server.name,
    connected: server.connected,
    transport: server.transport,
    protocolVersion: server.protocolVersion,
    protocolEra: server.protocolEra,
    role: server.role,
    trustMode: server.trustMode,
    schemaFreshness: server.schemaFreshness,
    quarantined: server.schemaFreshness === 'quarantined',
  };
}

function previewServer(server: McpServerSecurity) {
  return {
    ...summarizeServer(server),
    allowedPathCount: server.allowedPaths.length,
    allowedHostCount: server.allowedHosts.length,
    quarantineReason: server.quarantineReason,
    quarantineDetail: server.quarantineDetail,
    quarantineApprovedBy: server.quarantineApprovedBy,
  };
}

function summarizeDecision(decision: McpDecisionRecord) {
  return {
    serverName: decision.serverName,
    toolName: decision.toolName,
    verdict: decision.verdict,
    reason: decision.reason,
    evaluatedAt: decision.evaluatedAt,
  };
}

export function createMcpTool(mcpRegistry: McpRegistry): Tool {
  return {
    definition: {
      name: 'mcp',
      description: 'Inspect MCP servers, tools, schemas, and trust state. set-trust, set-role and approve-quarantine change what a server is allowed to do.',
      parameters: MCP_TOOL_SCHEMA.parameters,
      sideEffects: ['state'],
      concurrency: 'serial',
    },

    async execute(args: Record<string, unknown>) {
    if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
      return { success: false, error: 'Invalid args: mode is required.' };
    }
    const input = args as unknown as McpToolInput;
    const view = input.view ?? 'descriptor';

    if (input.mode === 'servers') {
      const security = mcpRegistry.listServerSecurity();
      const filtered = input.serverName
        ? security.filter((server) => server.name === input.serverName)
        : security;
      const payload = filtered.map((server) => {
        if (view === 'full') return server;
        if (view === 'preview') return previewServer(server);
        return summarizeServer(server);
      });
      return { success: true, output: JSON.stringify({ view, count: payload.length, servers: payload }) };
    }

    if (input.mode === 'tools') {
      const tools = await mcpRegistry.listAllTools();
      const filtered = input.serverName
        ? tools.filter((tool) => tool.serverName === input.serverName)
        : tools;
      const summarized = filtered.map((tool) => ({
        qualifiedName: tool.qualifiedName,
        serverName: tool.serverName,
        toolName: tool.toolName,
        description: tool.description,
      }));
      return { success: true, output: JSON.stringify({ view, count: summarized.length, tools: summarized }) };
    }

    if (input.mode === 'schema') {
      if (!input.qualifiedName) return { success: false, error: 'schema requires qualifiedName.' };
      const schema = await mcpRegistry.getToolSchema(input.qualifiedName);
      if (!schema) {
        const parsed = /^mcp:([^:]+):(.+)$/.exec(input.qualifiedName);
        const server = parsed ? mcpRegistry.listServerSecurity().find((entry) => entry.name === parsed[1]) : undefined;
        const cause = !parsed
          ? 'it is not a qualified name of the form mcp:<server>:<tool>'
          : !server
            ? `no MCP server named '${parsed[1]}' is configured`
            : 'that server does not list this tool now (it may be disconnected, or the tool was removed)';
        return { success: false, error: `Unknown MCP tool: ${input.qualifiedName}: ${cause}. List current names with mode=tools.` };
      }
      return { success: true, output: JSON.stringify(schema) };
    }

    if (input.mode === 'resources') {
      // The registry does not expose resource inventories here; reporting zero would read as "none".
      return {
        success: false,
        error: 'resources mode is not available: this tool cannot list MCP resources, so it cannot say whether a server has any. Use mode=tools for tools and mode=servers for server state.',
      };
    }

    if (input.mode === 'security') {
      const servers = mcpRegistry.listServerSecurity();
      const filtered = input.serverName
        ? servers.filter((server) => server.name === input.serverName)
        : servers;
      const recentDecisions = mcpRegistry.listRecentSecurityDecisions();
      return {
        success: true,
        output: JSON.stringify({
          view,
          servers: filtered.map((server) => {
            if (view === 'full') return server;
            if (view === 'preview') return previewServer(server);
            return summarizeServer(server);
          }),
          recentDecisions: view === 'full'
            ? recentDecisions
            : recentDecisions.slice(0, 8).map(summarizeDecision),
        }),
      };
    }

    if (input.mode === 'auth') {
      const servers = mcpRegistry.listServerSecurity();
      const filtered = input.serverName
        ? servers.filter((server) => server.name === input.serverName)
        : servers;
      const recentDecisions = mcpRegistry.listRecentSecurityDecisions();
      return {
        success: true,
        output: JSON.stringify({
          view,
          servers: filtered.map((server) => {
            if (view === 'full') {
              return {
                ...server,
                allowedPaths: server.allowedPaths,
                allowedHosts: server.allowedHosts,
              };
            }
            if (view === 'preview') return previewServer(server);
            return summarizeServer(server);
          }),
          recentDecisions: view === 'full'
            ? recentDecisions
            : recentDecisions.slice(0, 8).map(summarizeDecision),
        }),
      };
    }

    if (input.mode === 'approve-quarantine') {
      if (!input.serverName) {
        return { success: false, error: 'approve-quarantine requires serverName.' };
      }
      // The approver is who is acting in this turn (the owner, or the surface
      // the turn arrived on), taken from the turn boundary, never from the
      // model's arguments. The call itself went through the gate first.
      const servers = mcpRegistry.listServerSecurity();
      const server = servers.find((entry) => entry.name === input.serverName);
      if (!server) {
        return { success: false, error: `Unknown MCP server: ${input.serverName}. Known servers: ${servers.map((entry) => entry.name).join(', ') || '(none)'}.` };
      }
      // Approving re-arms the server's policy lifetime, which cancels its
      // in-flight calls; a server that is not quarantined gains nothing from it.
      if (server.schemaFreshness !== 'quarantined') {
        return { success: false, error: `MCP server ${input.serverName} is not quarantined (schema ${server.schemaFreshness}); there is nothing to approve. Nothing was changed.` };
      }
      const approvedBy = currentTurnActor();
      mcpRegistry.approveSchemaQuarantine(input.serverName, approvedBy);
      return { success: true, output: JSON.stringify({ serverName: input.serverName, approvedBy }) };
    }

    if (input.mode === 'set-trust' || input.mode === 'set-role') {
      if (!input.serverName || (input.mode === 'set-trust' ? !input.trustMode : !input.role)) {
        return { success: false, error: input.mode === 'set-trust' ? 'set-trust requires serverName and trustMode.' : 'set-role requires serverName and role.' };
      }
      // Changing a server's trust or role re-arms its policy lifetime and cancels in-flight calls, so the
      // name is checked first: a typo must not touch anything.
      const servers = mcpRegistry.listServerSecurity();
      if (!servers.some((entry) => entry.name === input.serverName)) {
        return { success: false, error: `Unknown MCP server: ${input.serverName}. Known servers: ${servers.map((entry) => entry.name).join(', ') || '(none)'}. Nothing was changed.` };
      }
      if (input.mode === 'set-trust') {
        mcpRegistry.setServerTrustMode(input.serverName, input.trustMode!);
        return { success: true, output: JSON.stringify({ serverName: input.serverName, trustMode: input.trustMode }) };
      }
      // 'deploy' is the name this tool offers for the registry's 'ops' role; report what was stored.
      const stored = input.role === 'deploy' ? 'ops' : input.role!;
      mcpRegistry.setServerRole(input.serverName, stored);
      return { success: true, output: JSON.stringify({ serverName: input.serverName, role: stored, ...(stored !== input.role ? { requested: input.role } : {}) }) };
    }

      return { success: false, error: `Unknown mode: ${input.mode}` };
    },
  };
}
