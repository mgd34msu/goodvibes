import type { McpRegistry } from '../../mcp/registry.js';
import type {
  McpConfigRoots,
  McpConfigScope,
  McpEffectiveConfig,
  McpServerConfig,
} from '../../mcp/config.js';
import type { JsonRecord } from '../helpers.js';
import { jsonErrorResponse } from './error-response.js';
import { isRecord } from '../../utils/record-coerce.js';
import { decodePathSegment } from './route-helpers.js';

interface McpRouteContext {
  readonly mcpRegistry: Pick<
    McpRegistry,
    | 'getEffectiveConfig'
    | 'reload'
    | 'upsertServerConfig'
    | 'removeServerConfig'
    | 'listServers'
    | 'listServerSecurity'
    | 'listServerSandboxBindings'
    | 'listAllTools'
  >;
  readonly roots: McpConfigRoots;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonRecord | null | Response>;
  readonly requireAdmin: (req: Request) => Response | null;
}


function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? [...value]
    : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')) return undefined;
  return Object.fromEntries(entries);
}

/**
 * A present field must have its documented shape; a wrong one is refused by
 * name rather than saved as "none", which would replace what is stored.
 */
function readShaped<T>(
  value: unknown,
  field: string,
  expectation: string,
  read: (value: unknown) => T | undefined,
): T | undefined | Response {
  if (value === undefined || value === null) return undefined;
  const parsed = read(value);
  if (parsed !== undefined) return parsed;
  return jsonErrorResponse({ error: `MCP server ${field} must be ${expectation}.`, code: 'INVALID_ARGUMENT', field }, { status: 400 });
}

function parseScope(value: unknown): McpConfigScope {
  return value === 'global' ? 'global' : 'project';
}

function parseServerConfig(value: unknown): McpServerConfig | Response {
  if (!isRecord(value)) {
    return jsonErrorResponse({ error: 'Missing MCP server config object.' }, { status: 400 });
  }
  if (typeof value.name !== 'string' || !value.name.trim()) {
    return jsonErrorResponse({ error: 'MCP server name is required.' }, { status: 400 });
  }
  const command = typeof value.command === 'string' && value.command.trim() ? value.command.trim() : undefined;
  const url = typeof value.url === 'string' && value.url.trim() ? value.url.trim() : undefined;
  if (!command && !url) {
    return jsonErrorResponse({ error: 'MCP server needs a command (stdio) or a url (HTTP).' }, { status: 400 });
  }
  if (command && url) {
    return jsonErrorResponse({ error: 'MCP server may set command (stdio) or url (HTTP), not both.' }, { status: 400 });
  }
  const args = readShaped(value.args, 'args', 'an array of strings', stringArray);
  if (args instanceof Response) return args;
  const env = readShaped(value.env, 'env', 'an object of string values', stringRecord);
  if (env instanceof Response) return env;
  const headers = readShaped(value.headers, 'headers', 'an object of string values', stringRecord);
  if (headers instanceof Response) return headers;
  if (headers !== undefined && !url) {
    return jsonErrorResponse({ error: 'MCP server headers are sent only to a url (HTTP) server; this server has a command.', code: 'INVALID_ARGUMENT', field: 'headers' }, { status: 400 });
  }
  return {
    name: value.name.trim(),
    command,
    url,
    args,
    env,
    headers,
    role: typeof value.role === 'string' ? value.role as McpServerConfig['role'] : undefined,
    trustMode: typeof value.trustMode === 'string' ? value.trustMode as McpServerConfig['trustMode'] : undefined,
    allowedPaths: stringArray(value.allowedPaths),
    allowedHosts: stringArray(value.allowedHosts),
  };
}

const REDACTED = '***';
const CREDENTIAL_NAME = /token|secret|key|passw|auth|credential|bearer|cookie|session/i;

/** Keeps the shape of a URL and drops userinfo and every query value, where an API key usually rides. */
export function redactMcpUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = REDACTED;
    if (parsed.password) parsed.password = REDACTED;
    for (const key of [...parsed.searchParams.keys()]) parsed.searchParams.set(key, REDACTED);
    return parsed.toString();
  } catch {
    return value.replace(/\/\/[^/@\s]*@/, `//${REDACTED}@`).replace(/([?&][^=&#]*=)[^&#]*/g, `$1${REDACTED}`);
  }
}

/** Hides the value of a credential-looking flag, in both `--flag=value` and `--flag value` form, and any URL argument's secrets. */
export function redactMcpArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      out.push(REDACTED);
      redactNext = false;
      continue;
    }
    const flag = /^(-{1,2}[^=\s]+)(=(.*))?$/s.exec(arg);
    if (flag && CREDENTIAL_NAME.test(flag[1]!)) {
      if (flag[2] !== undefined) out.push(`${flag[1]}=${REDACTED}`);
      else {
        out.push(arg);
        redactNext = true;
      }
      continue;
    }
    out.push(/^[a-z][a-z0-9+.-]*:\/\//i.test(arg) ? redactMcpUrl(arg) : arg);
  }
  return out;
}

function redactServer(server: McpServerConfig): Record<string, unknown> {
  return {
    name: server.name,
    command: server.command ?? null,
    url: server.url ? redactMcpUrl(server.url) : null,
    args: redactMcpArgs(server.args ?? []),
    envKeys: Object.keys(server.env ?? {}).sort(),
    headerKeys: Object.keys(server.headers ?? {}).sort(),
    role: server.role ?? null,
    trustMode: server.trustMode ?? null,
    allowedPaths: server.allowedPaths ?? [],
    allowedHosts: server.allowedHosts ?? [],
  };
}

/**
 * The same server record with its `env` and `headers` VALUES included.
 *
 * Admin-only, and deliberately a separate route rather than a flag on the
 * redacted one: a reader has to ask for the values by name, so a surface that
 * only ever wanted `envKeys` cannot acquire them by accident.
 *
 * `args` and `url` are redacted on the plain routes as well, since a token
 * passed as `--token=...` or `?key=` is just as secret as an env value; the
 * reveal route returns them whole so an edit can resend them.
 *
 * It exists because `envKeys` alone made env values readable by nothing at
 * all. An admin who had set them could not see what was set, could not check a
 * value against the server it authenticates to, and, since the write path is
 * a whole-object replace, had no way to resend them when editing an
 * unrelated field.
 */
function revealServer(server: McpServerConfig): Record<string, unknown> {
  return {
    ...redactServer(server),
    url: server.url ?? null,
    args: [...(server.args ?? [])],
    env: { ...(server.env ?? {}) },
    headers: { ...(server.headers ?? {}) },
  };
}

function serializeEffectiveConfig(config: McpEffectiveConfig): Record<string, unknown> {
  return {
    locations: config.locations,
    servers: config.servers.map((entry) => ({
      ...redactServer(entry.server),
      source: entry.source,
    })),
  };
}

function serializeRevealedConfig(config: McpEffectiveConfig): Record<string, unknown> {
  return {
    locations: config.locations,
    servers: config.servers.map((entry) => ({
      ...revealServer(entry.server),
      source: entry.source,
    })),
  };
}

/**
 * The paths this sub-router serves.
 * Read by the capability-route reconcile, which cannot see a sub-router that is
 * dispatched ahead of the shared route table. `{param}` is one path segment.
 */
export const MCP_ROUTES: readonly { readonly method: string; readonly path: string }[] = [
  { method: 'GET', path: '/api/mcp/config' },
  { method: 'GET', path: '/api/mcp/servers' },
  { method: 'GET', path: '/api/mcp/servers/reveal' },
  { method: 'GET', path: '/api/mcp/tools' },
  { method: 'POST', path: '/api/mcp/reload' },
  { method: 'POST', path: '/api/mcp/config/servers' },
  { method: 'DELETE', path: '/api/mcp/config/servers/{serverName}' },
];

export async function dispatchMcpRoutes(req: Request, context: McpRouteContext): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

  if (pathname === '/api/mcp/config' && req.method === 'GET') {
    return Response.json(serializeEffectiveConfig(context.mcpRegistry.getEffectiveConfig(context.roots)));
  }

  if (pathname === '/api/mcp/servers' && req.method === 'GET') {
    return Response.json({
      servers: context.mcpRegistry.listServers(),
      security: context.mcpRegistry.listServerSecurity(),
      sandboxBindings: context.mcpRegistry.listServerSandboxBindings(),
    });
  }

  if (pathname === '/api/mcp/servers/reveal' && req.method === 'GET') {
    const admin = context.requireAdmin(req);
    if (admin) return admin;
    return Response.json(serializeRevealedConfig(context.mcpRegistry.getEffectiveConfig(context.roots)));
  }

  if (pathname === '/api/mcp/tools' && req.method === 'GET') {
    return Response.json({ tools: await context.mcpRegistry.listAllTools() });
  }

  if (pathname === '/api/mcp/reload' && req.method === 'POST') {
    const admin = context.requireAdmin(req);
    if (admin) return admin;
    return Response.json({
      reload: await context.mcpRegistry.reload(context.roots),
      config: serializeEffectiveConfig(context.mcpRegistry.getEffectiveConfig(context.roots)),
    });
  }

  if (pathname === '/api/mcp/config/servers' && req.method === 'POST') {
    const admin = context.requireAdmin(req);
    if (admin) return admin;
    const body = await context.parseJsonBody(req);
    if (body instanceof Response) return body;
    const server = parseServerConfig(body.server ?? body);
    if (server instanceof Response) return server;
    const scope = parseScope(body.scope);
    const result = await context.mcpRegistry.upsertServerConfig(context.roots, scope, server);
    return Response.json({
      scope,
      path: result.path,
      removed: false,
      reload: result.reload,
      config: serializeEffectiveConfig(context.mcpRegistry.getEffectiveConfig(context.roots)),
    });
  }

  const serverMatch = pathname.match(/^\/api\/mcp\/config\/servers\/([^/]+)$/);
  if (serverMatch && req.method === 'DELETE') {
    const admin = context.requireAdmin(req);
    if (admin) return admin;
    const body = await context.parseOptionalJsonBody(req);
    if (body instanceof Response) return body;
    const scope = parseScope(body?.scope ?? url.searchParams.get('scope'));
    const serverName = decodePathSegment(serverMatch[1]!);
    if (serverName === null) return Response.json({ error: 'Malformed server name in path' }, { status: 400 });
    const result = await context.mcpRegistry.removeServerConfig(context.roots, scope, serverName);
    return Response.json({
      scope,
      path: result.path,
      removed: result.removed,
      reload: result.reload,
      config: serializeEffectiveConfig(context.mcpRegistry.getEffectiveConfig(context.roots)),
    });
  }

  return null;
}
