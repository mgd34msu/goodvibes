import type { CommandContext } from '../input/command-registry.ts';
import type { CatalogRankingOptions } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { mcpServerRecords, mcpToolRecords, qualifiedToolName } from './agent-harness-personal-ops-discovery.ts';
import type { McpToolRecord } from './agent-harness-personal-ops-types.ts';

/**
 * External memory providers, through the one interface they publish: an MCP
 * server. Mem0, Supermemory, Honcho and the others ship MCP servers; once the
 * owner registers one (`/mcp add`), its memory tools are what the Agent can
 * read, write, forget and sync with. Everything here is decided in code from
 * the registered servers and their tool lists; no model is asked what a field
 * or a tool is.
 */

export type ExternalMemoryOperation = 'read' | 'write' | 'forget' | 'sync';

export interface ExternalMemoryRoute {
  readonly toolName: string;
  /** The MCP tool to call for this operation; writes, forgets and syncs keep the owner's admission for an outward effect. */
  readonly qualifiedName: string;
}

export interface ExternalMemoryProviderRecord {
  readonly id: string;
  readonly label: string;
  readonly source: 'mcp';
  readonly serverName: string;
  readonly connected: boolean;
  readonly trustMode: string | null;
  readonly status: 'available' | 'read-only' | 'needs-connection' | 'no-memory-tools';
  readonly routes: Readonly<Partial<Record<ExternalMemoryOperation, ExternalMemoryRoute>>>;
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly canForget: boolean;
  readonly canSync: boolean;
  /** External records never enter the Agent prompt on their own; the model reads them through the read route when a task needs them. */
  readonly promptEligible: false;
  readonly summary: string;
  readonly nextStep: string;
}

export interface MemoryPostureProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: 'embedding' | 'external-memory';
  readonly status: string;
  readonly summary: string;
  readonly modelRoute: string;
  readonly setupRoute?: string;
  readonly configured?: boolean;
  readonly active?: boolean;
  readonly dimensions?: number;
  readonly deterministic?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly external?: ExternalMemoryProviderRecord;
}

export type MemoryProviderResolution =
  | { readonly status: 'found'; readonly provider: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

/** Memory services known to publish an MCP server, matched by the registered server's name. */
const KNOWN_MEMORY_SERVICES: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'mem0', label: 'Mem0' },
  { id: 'supermemory', label: 'Supermemory' },
  { id: 'honcho', label: 'Honcho' },
  { id: 'openviking', label: 'OpenViking' },
  { id: 'hindsight', label: 'Hindsight' },
  { id: 'holographic', label: 'Holographic' },
  { id: 'retaindb', label: 'RetainDB' },
  { id: 'byterover', label: 'ByteRover' },
];

export const EXTERNAL_MEMORY_SETUP_STEP = 'Register the memory service\'s MCP server with /mcp add (Mem0, Supermemory, Honcho, OpenViking, Hindsight, Holographic, RetainDB and ByteRover publish one); its memory tools then appear here with their read, write, forget and sync routes.';

const OPERATION_PATTERNS: readonly (readonly [ExternalMemoryOperation, RegExp])[] = [
  ['forget', /(^|[_\-.])(delete|forget|remove|purge|erase)([_\-.]|$)/i],
  ['sync', /(^|[_\-.])(sync|import|export)([_\-.]|$)/i],
  ['write', /(^|[_\-.])(add|store|save|create|remember|write|ingest|update|upsert|put)([_\-.]|$)/i],
  ['read', /(^|[_\-.])(search|query|recall|get|list|retrieve|find|fetch|read)([_\-.]|$)/i],
];

/** The operation a memory tool performs, from its name; null when its name names none. */
export function externalMemoryOperation(toolName: string): ExternalMemoryOperation | null {
  for (const [operation, pattern] of OPERATION_PATTERNS) if (pattern.test(toolName)) return operation;
  return null;
}

function knownService(serverName: string): { readonly id: string; readonly label: string } | undefined {
  const name = serverName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return KNOWN_MEMORY_SERVICES.find(service => name.includes(service.id));
}

function mentionsMemory(tool: McpToolRecord): boolean {
  return /memor/i.test(tool.toolName) || /memor/i.test(tool.description ?? '');
}

/**
 * The registered MCP servers that are memory providers: a known memory
 * service by name, or any server whose tools read and write something they
 * call memory. One read of the server list and one of the tool list.
 */
export async function externalMemoryProviders(context: CommandContext, options: CatalogRankingOptions = {}): Promise<readonly ExternalMemoryProviderRecord[]> {
  const servers = mcpServerRecords(context);
  if (servers.length === 0) return [];
  const tools = await mcpToolRecords(context, options);
  const records: ExternalMemoryProviderRecord[] = [];
  for (const server of servers) {
    const serverTools = tools.filter(tool => tool.serverName === server.name);
    const known = knownService(server.name);
    const memoryTools = known ? serverTools : serverTools.filter(mentionsMemory);
    const routes: Partial<Record<ExternalMemoryOperation, ExternalMemoryRoute>> = {};
    for (const tool of memoryTools) {
      const operation = externalMemoryOperation(tool.toolName);
      if (operation && !routes[operation]) routes[operation] = { toolName: tool.toolName, qualifiedName: qualifiedToolName(tool) };
    }
    if (!known && !(routes.read && routes.write)) continue;
    const canRead = Boolean(routes.read), canWrite = Boolean(routes.write);
    const status: ExternalMemoryProviderRecord['status'] = !server.connected ? 'needs-connection'
      : canRead && canWrite ? 'available' : canRead ? 'read-only' : 'no-memory-tools';
    const label = known ? known.label : server.name;
    records.push({
      id: `mcp:${server.name}`, label, source: 'mcp', serverName: server.name, connected: server.connected, trustMode: server.trustMode || null,
      status, routes, canRead, canWrite, canForget: Boolean(routes.forget), canSync: Boolean(routes.sync), promptEligible: false,
      summary: status === 'available' ? `${label} is connected through MCP server "${server.name}" with read and write memory tools.`
        : status === 'read-only' ? `${label} is connected through MCP server "${server.name}"; it offers a read tool and no write tool.`
          : status === 'needs-connection' ? `${label} is registered as MCP server "${server.name}" but is not connected.`
            : `${label} is connected through MCP server "${server.name}", but none of its tools is named as a memory read or write.`,
      nextStep: status === 'needs-connection'
        ? `Reconnect the server (agent_harness mode:"mcp_server" mcpServerId:"${server.name}" shows why it is down).`
        : status === 'no-memory-tools'
          ? `Inspect its tools with agent_harness mode:"mcp_server" mcpServerId:"${server.name}".`
          : `Read with the MCP tool ${routes.read?.qualifiedName}${routes.write ? `; write with ${routes.write.qualifiedName} when the user asks` : ''}. External records never enter the prompt on their own.`,
    });
  }
  return records;
}
