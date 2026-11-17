/**
 * method-catalog-runtime-mcp.ts, the MCP wire schemas for the runtime method
 * catalog, and the descriptors of the per-tool rule methods.
 *
 * Lifted out of method-catalog-runtime.ts, which is a grandfathered
 * shrink-only file: the MCP block is a self-contained cluster of schemas with
 * exactly one consumer, so it is the natural seam, and new MCP methods are
 * declared here rather than there.
 */
import {
  BOOLEAN_SCHEMA,
  STRING_SCHEMA,
  NUMBER_SCHEMA,
  objectSchema,
  arraySchema,
  branchedSchema,
  methodDescriptor,
  requirementBranch,
  runtimeEventId,
  type GatewayMethodDescriptor,
} from './method-catalog-shared.js';
import { enumSchema, nullableSchema } from './operator-contract-schemas-shared.js';

/** Header name to value; every value is a string. */
const STRING_RECORD_SCHEMA: Record<string, unknown> = { type: 'object', additionalProperties: STRING_SCHEMA };

export const MCP_SCOPE_SCHEMA = enumSchema(['project', 'global']);
/**
 * A server to write: `command` starts a stdio process, `url` names a remote
 * HTTP endpoint, and exactly one of them is given (the route refuses both and
 * neither), so the schema requires at least one.
 */
export const MCP_SERVER_CONFIG_SCHEMA = branchedSchema(objectSchema({
  name: STRING_SCHEMA,
  command: STRING_SCHEMA,
  url: STRING_SCHEMA,
  args: arraySchema(STRING_SCHEMA),
  env: objectSchema({}, [], { additionalProperties: true }),
  envKeys: arraySchema(STRING_SCHEMA),
  // Request headers sent to a url server (an Authorization header, for one); refused on a command server.
  headers: STRING_RECORD_SCHEMA,
  role: nullableSchema(STRING_SCHEMA),
  trustMode: nullableSchema(STRING_SCHEMA),
  allowedPaths: arraySchema(STRING_SCHEMA),
  allowedHosts: arraySchema(STRING_SCHEMA),
  // Absent: the kept per-tool rules stay. A list replaces them; an empty one clears them. allowedTools is refused for scope project.
  deniedTools: arraySchema(STRING_SCHEMA),
  allowedTools: arraySchema(STRING_SCHEMA),
}, ['name']), [
  requirementBranch({ command: STRING_SCHEMA }, ['command']),
  requirementBranch({ url: STRING_SCHEMA }, ['url']),
]);
export const MCP_CONFIG_SOURCE_SCHEMA = objectSchema({
  scope: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  path: STRING_SCHEMA,
  writable: BOOLEAN_SCHEMA,
}, ['scope', 'kind', 'path', 'writable']);
/** `command` is null for an HTTP server and `url` is null for a stdio one; credentials in `url` and `args` read as `***` here, and env and header values are named only. */
export const MCP_CONFIG_SERVER_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  command: nullableSchema(STRING_SCHEMA),
  url: nullableSchema(STRING_SCHEMA),
  args: arraySchema(STRING_SCHEMA),
  envKeys: arraySchema(STRING_SCHEMA),
  headerKeys: arraySchema(STRING_SCHEMA),
  role: nullableSchema(STRING_SCHEMA),
  trustMode: nullableSchema(STRING_SCHEMA),
  allowedPaths: arraySchema(STRING_SCHEMA),
  allowedHosts: arraySchema(STRING_SCHEMA),
  /** Tools refused on every call, kept with this entry. */
  deniedTools: arraySchema(STRING_SCHEMA),
  /** Tools allowed past the path and host scope, kept with this entry (never from a project file). */
  allowedTools: arraySchema(STRING_SCHEMA),
  source: MCP_CONFIG_SOURCE_SCHEMA,
}, ['name', 'command', 'url', 'args', 'envKeys', 'headerKeys', 'role', 'trustMode', 'allowedPaths', 'allowedHosts', 'deniedTools', 'allowedTools', 'source']);
export const MCP_RELOAD_SERVER_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  action: enumSchema(['added', 'changed', 'removed', 'unchanged']),
  connected: BOOLEAN_SCHEMA,
}, ['name', 'action', 'connected']);
export const MCP_RELOAD_RESULT_SCHEMA = objectSchema({
  added: NUMBER_SCHEMA,
  changed: NUMBER_SCHEMA,
  removed: NUMBER_SCHEMA,
  unchanged: NUMBER_SCHEMA,
  servers: arraySchema(MCP_RELOAD_SERVER_SCHEMA),
}, ['added', 'changed', 'removed', 'unchanged', 'servers']);
export const MCP_CONFIG_RESPONSE_SCHEMA = objectSchema({
  locations: arraySchema(MCP_CONFIG_SOURCE_SCHEMA),
  servers: arraySchema(MCP_CONFIG_SERVER_SCHEMA),
}, ['locations', 'servers']);
/** The redacted server record plus its env and header VALUES. Admin-only, see mcp.servers.reveal. */
export const MCP_REVEALED_SERVER_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  command: nullableSchema(STRING_SCHEMA),
  url: nullableSchema(STRING_SCHEMA),
  args: arraySchema(STRING_SCHEMA),
  envKeys: arraySchema(STRING_SCHEMA),
  env: objectSchema({}, [], { additionalProperties: true }),
  headerKeys: arraySchema(STRING_SCHEMA),
  headers: STRING_RECORD_SCHEMA,
  role: nullableSchema(STRING_SCHEMA),
  trustMode: nullableSchema(STRING_SCHEMA),
  allowedPaths: arraySchema(STRING_SCHEMA),
  allowedHosts: arraySchema(STRING_SCHEMA),
  deniedTools: arraySchema(STRING_SCHEMA),
  allowedTools: arraySchema(STRING_SCHEMA),
  source: MCP_CONFIG_SOURCE_SCHEMA,
}, ['name', 'command', 'url', 'args', 'envKeys', 'env', 'headerKeys', 'headers', 'role', 'trustMode', 'allowedPaths', 'allowedHosts', 'deniedTools', 'allowedTools', 'source']);
export const MCP_REVEAL_RESPONSE_SCHEMA = objectSchema({
  locations: arraySchema(MCP_CONFIG_SOURCE_SCHEMA),
  servers: arraySchema(MCP_REVEALED_SERVER_SCHEMA),
}, ['locations', 'servers']);
export const MCP_CONFIG_MUTATION_RESPONSE_SCHEMA = objectSchema({
  scope: MCP_SCOPE_SCHEMA,
  path: STRING_SCHEMA,
  removed: BOOLEAN_SCHEMA,
  reload: MCP_RELOAD_RESULT_SCHEMA,
  config: MCP_CONFIG_RESPONSE_SCHEMA,
}, ['scope', 'path', 'reload', 'config']);
/** One tool's kept rule, by server and tool name (both are path segments). */
export const MCP_TOOL_RULE_INPUT_SCHEMA = objectSchema({
  serverName: STRING_SCHEMA,
  toolName: STRING_SCHEMA,
}, ['serverName', 'toolName']);
/** The rule kept or cleared, where it was written, whether the file changed, and the reload that applied it. */
export const MCP_TOOL_RULE_RESPONSE_SCHEMA = objectSchema({
  serverName: STRING_SCHEMA,
  toolName: STRING_SCHEMA,
  rule: enumSchema(['allow', 'deny', 'clear']),
  scope: MCP_SCOPE_SCHEMA,
  path: STRING_SCHEMA,
  changed: BOOLEAN_SCHEMA,
  reload: MCP_RELOAD_RESULT_SCHEMA,
  config: MCP_CONFIG_RESPONSE_SCHEMA,
}, ['serverName', 'toolName', 'rule', 'scope', 'path', 'changed', 'reload', 'config']);
export const MCP_SERVER_STATUS_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  connected: BOOLEAN_SCHEMA,
  transport: enumSchema(['stdio', 'http']),
  protocolVersion: STRING_SCHEMA,
  protocolEra: enumSchema(['modern', 'legacy']),
  /** Where the client is in its connect/restart cycle; `gave-up` means it stopped retrying. */
  phase: enumSchema(['idle', 'starting', 'negotiating', 'ready', 'restart-wait', 'gave-up', 'closed']),
  /** The last connect or runtime failure, while it still describes the server. */
  lastError: STRING_SCHEMA,
  /** The automatic reconnect cycle; absent while none ran. `stoppedReason` says why reconnecting stopped. */
  reconnect: objectSchema({
    state: enumSchema(['configured', 'connecting', 'connected', 'degraded', 'auth_required', 'reconnecting', 'disconnected']),
    attempt: NUMBER_SCHEMA,
    maxAttempts: NUMBER_SCHEMA,
    nextAttemptAt: NUMBER_SCHEMA,
    stoppedReason: STRING_SCHEMA,
  }, ['state', 'attempt', 'maxAttempts']),
}, ['name', 'connected']);
export const MCP_SERVERS_RESPONSE_SCHEMA = objectSchema({
  servers: arraySchema(MCP_SERVER_STATUS_SCHEMA),
  security: arraySchema(objectSchema({}, [], { additionalProperties: true })),
  sandboxBindings: arraySchema(objectSchema({}, [], { additionalProperties: true })),
}, ['servers', 'security', 'sandboxBindings']);
export const MCP_TOOL_SCHEMA = objectSchema({
  qualifiedName: STRING_SCHEMA,
  serverName: STRING_SCHEMA,
  toolName: STRING_SCHEMA,
  description: STRING_SCHEMA,
}, ['qualifiedName', 'serverName', 'toolName', 'description']);
export const MCP_TOOLS_RESPONSE_SCHEMA = objectSchema({
  tools: arraySchema(MCP_TOOL_SCHEMA),
}, ['tools']);

/**
 * One tool's kept rule: deny tightens and is any admin's to set; allow and
 * clear loosen (clearing may lift a denial), so they are the owner's own acts
 * (`ownerOnly`), which the Agent's model is refused on every route.
 */
export const MCP_TOOL_RULE_METHOD_DESCRIPTORS: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'mcp.servers.tools.deny',
    title: 'Deny MCP Tool',
    description: 'Keep a denial of one tool with its MCP server\'s entry in the config file that holds it (global or this project\'s .goodvibes/mcp.json) and apply it at once: every call to the tool is refused, whatever the server\'s trust mode and scope allow, and a call not yet sent ends. A denial replaces a kept allow of the same tool. Refused for a server whose entry is in a file another program owns.',
    category: 'mcp',
    scopes: ['write:mcp'],
    access: 'admin',
    http: { method: 'POST', path: '/api/mcp/config/servers/{serverName}/tools/{toolName}/deny' },
    events: [runtimeEventId('mcp')],
    inputSchema: MCP_TOOL_RULE_INPUT_SCHEMA,
    outputSchema: MCP_TOOL_RULE_RESPONSE_SCHEMA,
  }),
  methodDescriptor({
    id: 'mcp.servers.tools.allow',
    ownerOnly: true,
    title: 'Allow MCP Tool',
    description: 'Keep an allow of one tool with its MCP server\'s entry in the owner\'s global MCP config and apply it at once: calls to the tool pass the server\'s path and host scope. A blocked server, a quarantined schema and a denial of the same tool still refuse. Loosens what the server may do, so it is the owner\'s own act: refused for the Agent\'s model and for a server kept in a project file.',
    category: 'mcp',
    scopes: ['write:mcp'],
    access: 'admin',
    http: { method: 'POST', path: '/api/mcp/config/servers/{serverName}/tools/{toolName}/allow' },
    events: [runtimeEventId('mcp')],
    inputSchema: MCP_TOOL_RULE_INPUT_SCHEMA,
    outputSchema: MCP_TOOL_RULE_RESPONSE_SCHEMA,
  }),
  methodDescriptor({
    id: 'mcp.servers.tools.clear',
    ownerOnly: true,
    title: 'Clear MCP Tool Rule',
    description: 'Drop the allow or denial kept for one tool with its MCP server\'s entry and apply it at once, so the server\'s trust mode and scope decide the tool again. Lifting a denial loosens what the server may do, so it is the owner\'s own act: refused for the Agent\'s model.',
    category: 'mcp',
    scopes: ['write:mcp'],
    access: 'admin',
    http: { method: 'DELETE', path: '/api/mcp/config/servers/{serverName}/tools/{toolName}' },
    events: [runtimeEventId('mcp')],
    inputSchema: MCP_TOOL_RULE_INPUT_SCHEMA,
    outputSchema: MCP_TOOL_RULE_RESPONSE_SCHEMA,
  }),
];
