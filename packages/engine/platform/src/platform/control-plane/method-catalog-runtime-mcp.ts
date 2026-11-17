/**
 * method-catalog-runtime-mcp.ts, the MCP wire schemas for the runtime method
 * catalog.
 *
 * Lifted out of method-catalog-runtime.ts, which is a grandfathered
 * shrink-only file: the MCP block is a self-contained cluster of schemas with
 * exactly one consumer, so it is the natural seam. Nothing here changed in the
 * move except `MCP_REVEAL_RESPONSE_SCHEMA`, which is new.
 */
import {
  BOOLEAN_SCHEMA,
  STRING_SCHEMA,
  NUMBER_SCHEMA,
  objectSchema,
  arraySchema,
  branchedSchema,
  requirementBranch,
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
  source: MCP_CONFIG_SOURCE_SCHEMA,
}, ['name', 'command', 'url', 'args', 'envKeys', 'headerKeys', 'role', 'trustMode', 'allowedPaths', 'allowedHosts', 'source']);
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
  source: MCP_CONFIG_SOURCE_SCHEMA,
}, ['name', 'command', 'url', 'args', 'envKeys', 'env', 'headerKeys', 'headers', 'role', 'trustMode', 'allowedPaths', 'allowedHosts', 'source']);
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
