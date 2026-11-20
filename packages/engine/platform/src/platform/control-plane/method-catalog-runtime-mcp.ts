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
  EMPTY_OBJECT_SCHEMA,
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
  /** Servers a project file names that are kept but not started until the owner trusts this workspace (/security trust-folder). */
  heldForTrust: arraySchema(STRING_SCHEMA),
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
/** The change made (the /mcp action's word), where it was written, whether the file changed, and the reload that applied it. */
export const MCP_TOOL_RULE_RESPONSE_SCHEMA = objectSchema({
  serverName: STRING_SCHEMA,
  toolName: STRING_SCHEMA,
  rule: enumSchema(['block', 'unblock', 'exempt', 'unexempt']),
  scope: MCP_SCOPE_SCHEMA,
  path: STRING_SCHEMA,
  changed: BOOLEAN_SCHEMA,
  reload: MCP_RELOAD_RESULT_SCHEMA,
  config: MCP_CONFIG_RESPONSE_SCHEMA,
}, ['serverName', 'toolName', 'rule', 'scope', 'path', 'changed', 'reload', 'config']);
/** A server's trust level or role kept with its entry: where, whether the file changed, and the reload that applied it. */
export const MCP_SERVER_POLICY_RESPONSE_SCHEMA = objectSchema({
  serverName: STRING_SCHEMA,
  scope: MCP_SCOPE_SCHEMA,
  path: STRING_SCHEMA,
  changed: BOOLEAN_SCHEMA,
  reload: MCP_RELOAD_RESULT_SCHEMA,
  config: MCP_CONFIG_RESPONSE_SCHEMA,
}, ['serverName', 'scope', 'path', 'changed', 'reload', 'config']);
export const MCP_TRUST_MODE_SCHEMA = enumSchema(['constrained', 'ask-on-risk', 'blocked', 'allow-all']);
export const MCP_ROLE_SCHEMA = enumSchema(['general', 'docs', 'filesystem', 'git', 'database', 'browser', 'automation', 'ops', 'remote']);
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
 * The /mcp actions the daemon runs, one method each and named by the action's
 * word. block tightens and is any admin's to set; unblock and exempt loosen,
 * so they are the owner's own acts (`owner.act`), which the Agent's model is
 * refused on every route. unexempt tightens. Trust may loosen (ask-on-risk,
 * allow-all) and accepting changed tools offers tools nobody has reviewed, so
 * both are the owner's; a role and a reload change no protection.
 */
export const MCP_ACTION_METHOD_DESCRIPTORS: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'mcp.servers.tools.block',
    repeat: 'safe',
    title: 'Block an MCP Tool',
    description: 'Keep a block of one tool with its MCP server\'s entry in the config file that holds it (global or this project\'s .goodvibes/mcp.json) and apply it at once: every call to the tool is refused, whatever the server\'s trust level and limits allow, and a call not yet sent ends. A block replaces a kept exemption of the same tool. Refused for a server whose entry is in a file another program owns. The same as /mcp block <server> <tool> --keep.',
    category: 'mcp',
    effects: ['mcp.administer'],
    http: { method: 'POST', path: '/api/mcp/config/servers/{serverName}/tools/{toolName}/block' },
    events: [runtimeEventId('mcp')],
    inputSchema: MCP_TOOL_RULE_INPUT_SCHEMA,
    outputSchema: MCP_TOOL_RULE_RESPONSE_SCHEMA,
  }),
  methodDescriptor({
    id: 'mcp.servers.tools.unblock',
    repeat: 'safe',
    effects: ['mcp.administer', 'owner.act'],
    title: 'Stop Blocking an MCP Tool',
    description: 'Drop the block kept for one tool with its MCP server\'s entry, and this daemon\'s block of it for its session, and apply it at once, so the server\'s trust level and limits decide the tool again. A kept exemption of the tool stays. Refused when the tool is not blocked. Loosens what the server may do, so it is the owner\'s own act: refused for the Agent\'s model. The same as /mcp unblock <server> <tool>.',
    category: 'mcp',
    http: { method: 'POST', path: '/api/mcp/config/servers/{serverName}/tools/{toolName}/unblock' },
    events: [runtimeEventId('mcp')],
    inputSchema: MCP_TOOL_RULE_INPUT_SCHEMA,
    outputSchema: MCP_TOOL_RULE_RESPONSE_SCHEMA,
  }),
  methodDescriptor({
    id: 'mcp.servers.tools.exempt',
    repeat: 'safe',
    effects: ['mcp.administer', 'owner.act'],
    title: 'Let an MCP Tool Go Beyond Its Server\'s Limits',
    description: 'Keep an exemption of one tool with its MCP server\'s entry in the owner\'s global MCP config and apply it at once: calls to the tool pass the server\'s folder and site limits. A blocked server, held-back tools and a block of the same tool still refuse. Loosens what the server may do, so it is the owner\'s own act: refused for the Agent\'s model and for a server kept in a project file. The same as /mcp exempt <server> <tool>.',
    category: 'mcp',
    http: { method: 'POST', path: '/api/mcp/config/servers/{serverName}/tools/{toolName}/exempt' },
    events: [runtimeEventId('mcp')],
    inputSchema: MCP_TOOL_RULE_INPUT_SCHEMA,
    outputSchema: MCP_TOOL_RULE_RESPONSE_SCHEMA,
  }),
  methodDescriptor({
    id: 'mcp.servers.tools.unexempt',
    repeat: 'safe',
    effects: ['mcp.administer'],
    title: 'Make an MCP Tool Follow Its Server\'s Limits Again',
    description: 'Drop the exemption kept for one tool with its MCP server\'s entry and apply it at once, so the server\'s folder and site limits hold the tool again. A kept block of the tool stays. Refused when the tool has no exemption. The same as /mcp unexempt <server> <tool>.',
    category: 'mcp',
    http: { method: 'POST', path: '/api/mcp/config/servers/{serverName}/tools/{toolName}/unexempt' },
    events: [runtimeEventId('mcp')],
    inputSchema: MCP_TOOL_RULE_INPUT_SCHEMA,
    outputSchema: MCP_TOOL_RULE_RESPONSE_SCHEMA,
  }),
  methodDescriptor({
    id: 'mcp.servers.trust.set',
    repeat: 'safe',
    effects: ['mcp.administer', 'owner.act'],
    title: 'Set an MCP Server\'s Trust Level',
    description: 'Keep a server\'s trust level with its entry in the MCP config file that holds it and apply it at once, after a restart too; a level set for this daemon\'s session ends. allow-all is kept only in the owner\'s global file. A looser level loosens what the server may do, so it is the owner\'s own act: refused for the Agent\'s model. The same as /mcp trust <server> <mode>.',
    category: 'mcp',
    http: { method: 'POST', path: '/api/mcp/config/servers/{serverName}/trust' },
    events: [runtimeEventId('mcp')],
    inputSchema: objectSchema({ serverName: STRING_SCHEMA, trustMode: MCP_TRUST_MODE_SCHEMA }, ['serverName', 'trustMode']),
    outputSchema: MCP_SERVER_POLICY_RESPONSE_SCHEMA,
  }),
  methodDescriptor({
    id: 'mcp.servers.role.set',
    repeat: 'safe',
    effects: ['mcp.administer'],
    title: 'Set an MCP Server\'s Role',
    description: 'Keep a server\'s role (what kind of server it is) with its entry in the MCP config file that holds it and apply it at once, after a restart too; a role set for this daemon\'s session ends. The same as /mcp role <server> <role>.',
    category: 'mcp',
    http: { method: 'POST', path: '/api/mcp/config/servers/{serverName}/role' },
    events: [runtimeEventId('mcp')],
    inputSchema: objectSchema({ serverName: STRING_SCHEMA, role: MCP_ROLE_SCHEMA }, ['serverName', 'role']),
    outputSchema: MCP_SERVER_POLICY_RESPONSE_SCHEMA,
  }),
  methodDescriptor({
    id: 'mcp.servers.reload',
    repeat: 'safe',
    title: 'Reconnect Every MCP Server From Its Config',
    description: 'Read every MCP config file again and reconnect the servers that were added, removed or changed, without restarting the daemon. The same as /mcp reload.',
    category: 'mcp',
    effects: ['mcp.administer'],
    http: { method: 'POST', path: '/api/mcp/reload' },
    events: [runtimeEventId('mcp')],
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: objectSchema({
      reload: MCP_RELOAD_RESULT_SCHEMA,
      config: MCP_CONFIG_RESPONSE_SCHEMA,
    }, ['reload', 'config']),
  }),
  methodDescriptor({
    id: 'mcp.servers.quarantine.accept',
    repeat: 'safe',
    effects: ['mcp.administer', 'owner.act'],
    title: 'Accept an MCP Server\'s Changed Tools',
    description: 'Accept the tools of a server whose tools were held back because they changed since they were last accepted, and offer them again on this daemon. Refused when its tools are not held back. Offers tools nobody has reviewed, so it is the owner\'s own act: refused for the Agent\'s model. The same as /mcp accept-tools <server>.',
    category: 'mcp',
    http: { method: 'POST', path: '/api/mcp/servers/{serverName}/accept-tools' },
    events: [runtimeEventId('mcp')],
    inputSchema: objectSchema({ serverName: STRING_SCHEMA }, ['serverName']),
    outputSchema: objectSchema({ serverName: STRING_SCHEMA, accepted: BOOLEAN_SCHEMA }, ['serverName', 'accepted']),
  }),
];
