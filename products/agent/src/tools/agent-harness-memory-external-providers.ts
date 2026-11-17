import type { CommandContext } from '../input/command-registry.ts';
import type { CatalogRankingOptions } from '@goodvibes-jev/engine/terminal-shell/agent-turn/catalog-ranking';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools/input-projection';
import { mcpServerRecords, mcpToolRecords, mcpToolSchema, qualifiedToolName, schemaObject } from './agent-harness-personal-ops-discovery.ts';
import type { McpToolRecord, McpToolSchema } from './agent-harness-personal-ops-types.ts';

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
  /** For one tool that serves several operations (a tool named `memory` with an `action` argument): the arguments that pick this one. */
  readonly arguments?: Readonly<Record<string, string>>;
}

export interface ExternalMemoryProviderRecord {
  readonly id: string;
  readonly label: string;
  readonly source: 'mcp';
  readonly serverName: string;
  readonly connected: boolean;
  readonly trustMode: string | null;
  readonly status: 'available' | 'read-only' | 'write-only' | 'needs-connection' | 'no-memory-tools';
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

/** Checked in this order, so `delete_memory` is a forget and not a read. */
const OPERATION_VERBS: readonly (readonly [ExternalMemoryOperation, ReadonlySet<string>])[] = [
  ['forget', new Set(['delete', 'forget', 'remove', 'purge', 'erase', 'clear'])],
  ['sync', new Set(['sync', 'import', 'export'])],
  ['write', new Set(['add', 'store', 'save', 'create', 'remember', 'write', 'ingest', 'update', 'upsert', 'put', 'insert', 'append'])],
  ['read', new Set(['search', 'query', 'recall', 'get', 'list', 'retrieve', 'find', 'fetch', 'read', 'lookup'])],
];

/** The words of a tool name: `addMemory`, `add_memory`, `add-memory` and `MCPSearch` all split into their words. */
function nameWords(name: string): readonly string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The operation a memory tool performs, from its name; null when its name names none. */
export function externalMemoryOperation(toolName: string): ExternalMemoryOperation | null {
  const words = nameWords(toolName);
  for (const [operation, verbs] of OPERATION_VERBS) if (words.some(word => verbs.has(word))) return operation;
  return null;
}

/** Arguments a single memory tool takes to choose what it does (`memory` with `action: "add" | "search"`). */
const OPERATION_SELECTOR_FIELDS = ['action', 'operation', 'op', 'command', 'method', 'mode', 'type'] as const;

/**
 * The operations one tool serves through a selector argument, read from its
 * input schema: each enum value of the selector that names an operation.
 */
function selectorOperations(inputSchema: unknown): readonly (readonly [ExternalMemoryOperation, Readonly<Record<string, string>>])[] {
  const schema = schemaObject(inputSchema);
  const properties = schema ? schemaObject(schema.properties) : null;
  if (!properties) return [];
  const found: (readonly [ExternalMemoryOperation, Readonly<Record<string, string>>])[] = [];
  for (const field of OPERATION_SELECTOR_FIELDS) {
    const property = schemaObject(properties[field]);
    if (!property || !Array.isArray(property.enum)) continue;
    for (const value of property.enum) {
      if (typeof value !== 'string') continue;
      const operation = externalMemoryOperation(value);
      if (operation) found.push([operation, { [field]: value }]);
    }
  }
  return found;
}

/** A route as the agent calls it: the tool, plus the selector argument when one tool serves several operations. */
function routeText(route: ExternalMemoryRoute): string {
  const selector = route.arguments ? Object.entries(route.arguments).map(([field, value]) => `${field}:${JSON.stringify(value)}`).join(' ') : '';
  return selector ? `${route.qualifiedName} with ${selector}` : route.qualifiedName;
}

function knownService(serverName: string): { readonly id: string; readonly label: string } | undefined {
  const name = serverName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return KNOWN_MEMORY_SERVICES.find(service => name.includes(service.id));
}

/** A tool's schema for reading its selector argument; a schema the server serves malformed leaves the tool without operations rather than failing the status. */
async function selectorSchema(context: CommandContext, tool: McpToolRecord, options: CatalogRankingOptions): Promise<McpToolSchema | null> {
  try {
    return await mcpToolSchema(context, qualifiedToolName(tool), options);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof ToolInputProjectionError) return null;
    throw error;
  }
}

function mentionsMemory(tool: McpToolRecord): boolean {
  return /memor/i.test(tool.toolName) || /memor/i.test(tool.description ?? '');
}

/**
 * The registered MCP servers that are memory providers: a known memory
 * service by name, or any server whose tools read and write something they
 * call memory. One read of the server list and one of the tool list, plus
 * one catalog schema read for each memory tool whose name names no operation.
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
    const unnamed: McpToolRecord[] = [];
    for (const tool of memoryTools) {
      const operation = externalMemoryOperation(tool.toolName);
      if (!operation) { unnamed.push(tool); continue; }
      if (!routes[operation]) routes[operation] = { toolName: tool.toolName, qualifiedName: qualifiedToolName(tool) };
    }
    // A tool whose name names no operation (`memory`, `mem0`) may still choose one by an argument; its schema says which.
    for (const tool of unnamed) {
      const schema = await selectorSchema(context, tool, options);
      for (const [operation, args] of selectorOperations(schema?.inputSchema)) {
        if (!routes[operation]) routes[operation] = { toolName: tool.toolName, qualifiedName: qualifiedToolName(tool), arguments: args };
      }
    }
    if (!known && !(routes.read && routes.write)) continue;
    const canRead = Boolean(routes.read), canWrite = Boolean(routes.write);
    const status: ExternalMemoryProviderRecord['status'] = !server.connected ? 'needs-connection'
      : canRead && canWrite ? 'available' : canRead ? 'read-only' : canWrite ? 'write-only' : 'no-memory-tools';
    const label = known ? known.label : server.name;
    records.push({
      id: `mcp:${server.name}`, label, source: 'mcp', serverName: server.name, connected: server.connected, trustMode: server.trustMode || null,
      status, routes, canRead, canWrite, canForget: Boolean(routes.forget), canSync: Boolean(routes.sync), promptEligible: false,
      summary: status === 'available' ? `${label} is connected through MCP server "${server.name}" with read and write memory tools.`
        : status === 'read-only' ? `${label} is connected through MCP server "${server.name}"; it offers a read tool and no write tool.`
          : status === 'write-only' ? `${label} is connected through MCP server "${server.name}"; it offers a write tool and no read tool, so what is stored there cannot be read back through it.`
            : status === 'needs-connection' ? `${label} is registered as MCP server "${server.name}" but is not connected.`
              : `${label} is connected through MCP server "${server.name}", but none of its tools reads or writes memory by its name or by an action argument.`,
      nextStep: status === 'needs-connection'
        ? `Reconnect the server (agent_harness mode:"mcp_server" mcpServerId:"${server.name}" shows why it is down).`
        : status === 'no-memory-tools'
          ? `Inspect its tools with agent_harness mode:"mcp_server" mcpServerId:"${server.name}".`
          : status === 'write-only'
            ? `Write with the MCP tool ${routeText(routes.write!)} when the user asks; nothing can be read back through this server.`
            : `Read with the MCP tool ${routeText(routes.read!)}${routes.write ? `; write with ${routeText(routes.write)} when the user asks` : ''}. External records never enter the prompt on their own.`,
    });
  }
  return records;
}
