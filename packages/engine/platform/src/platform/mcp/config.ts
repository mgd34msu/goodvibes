/**
 * MCP server configuration, scans multiple locations in precedence order.
 */
import { existsSync, readFileSync } from 'fs';
import { acquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
import { readJsonFileOrQuarantine, writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import type { ShellPathService } from '../runtime/shell-paths.js';
import { summarizeError } from '../utils/error-display.js';
import { isRecord } from '../utils/record-coerce.js';

export interface McpServerConfig {
  /** Unique server name, used as namespace prefix: mcp:<name>:<tool> */
  name: string;
  /** Executable command to start a stdio MCP server process. Exactly one of command/url. */
  command?: string | undefined;
  /** Streamable HTTP endpoint of a remote MCP server. Exactly one of command/url. */
  url?: string | undefined;
  /** Arguments to pass to the command */
  args?: string[] | undefined;
  /** Optional environment variables to merge with process.env */
  env?: Record<string, string> | undefined;
  /** Optional HTTP headers sent to a `url` server on every request, such as `Authorization`. Read routes list the names only; the admin reveal route shows the values. */
  headers?: Record<string, string> | undefined;
  /** Optional role used by runtime coherence checks. */
  role?: 'general' | 'docs' | 'filesystem' | 'git' | 'database' | 'browser' | 'automation' | 'ops' | 'remote' | undefined;
  /** Optional initial trust mode for the runtime MCP trust layer. */
  trustMode?: 'constrained' | 'ask-on-risk' | 'allow-all' | 'blocked' | undefined;
  /** Optional allowed path prefixes for filesystem-oriented tools. */
  allowedPaths?: string[] | undefined;
  /** Optional allowed network hostnames for network-oriented tools. */
  allowedHosts?: string[] | undefined;
  /**
   * How long one tool call may wait for this server's answer, in milliseconds,
   * before it is cancelled and the server told. Absent: 120 s. 0: no deadline.
   */
  toolTimeoutMs?: number | undefined;
}

export interface McpConfig {
  servers: McpServerConfig[];
}

export type McpConfigRoots = Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>;
export type McpConfigScope = 'project' | 'global';

export interface McpConfigLocation {
  readonly scope: McpConfigScope | 'external';
  readonly kind: 'global-xdg' | 'global-dotdir' | 'claude-desktop' | 'project-mcp' | 'project-goodvibes';
  readonly path: string;
  readonly writable: boolean;
}

export interface McpServerConfigEntry {
  readonly server: McpServerConfig;
  readonly source: McpConfigLocation;
}

export interface McpEffectiveConfig {
  readonly servers: readonly McpServerConfigEntry[];
  readonly locations: readonly McpConfigLocation[];
}


function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? [...value]
    : undefined;
}

function optionalStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** The roles and trust modes the MCP permission manager implements; the Records keep them in step with the types. */
const MCP_SERVER_ROLES = new Set(Object.keys({
  general: true, docs: true, filesystem: true, git: true, database: true, browser: true, automation: true,
  ops: true, remote: true,
} satisfies Record<NonNullable<McpServerConfig['role']>, true>));
const MCP_TRUST_MODES = new Set(Object.keys({
  constrained: true, 'ask-on-risk': true, 'allow-all': true, blocked: true,
} satisfies Record<NonNullable<McpServerConfig['trustMode']>, true>));

/** The trust mode a server runs with when its configuration names none; every surface shows and edits this same value. */
export const MCP_DEFAULT_TRUST_MODE = 'ask-on-risk' as const satisfies NonNullable<McpServerConfig['trustMode']>;

/**
 * A configured role or trust mode, or undefined (the permission manager's
 * default) when absent. A value the manager does not implement is reported
 * and treated as absent rather than passed on as an unknown mode.
 */
function knownValue<T extends string>(server: string, field: string, value: unknown, known: ReadonlySet<string>): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && known.has(value)) return value as T;
  logger.warn('MCP server config: unknown value ignored, the default applies', { server, field, value: String(value), known: [...known] });
  return undefined;
}

/** A tool-call deadline as written in a file: a whole, non-negative number of milliseconds, or absent. */
function isToolTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function optionalToolTimeout(server: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (isToolTimeout(value)) return value;
  logger.warn('MCP server config: toolTimeoutMs must be a whole number of milliseconds (0 for no deadline); the default applies', { server, value: String(value) });
  return undefined;
}

function normalizeServerConfig(name: string, raw: Record<string, unknown>): McpServerConfig | null {
  const command = typeof raw.command === 'string' && raw.command.trim() ? raw.command : undefined;
  const url = typeof raw.url === 'string' && raw.url.trim() ? raw.url : undefined;
  if (!command && !url) return null;
  return {
    name,
    command,
    url,
    args: optionalStringArray(raw.args) ?? [],
    env: optionalStringRecord(raw.env),
    headers: optionalStringRecord(raw.headers),
    role: knownValue<NonNullable<McpServerConfig['role']>>(name, 'role', raw.role, MCP_SERVER_ROLES),
    trustMode: knownValue<NonNullable<McpServerConfig['trustMode']>>(name, 'trustMode', raw.trustMode, MCP_TRUST_MODES),
    allowedPaths: optionalStringArray(raw.allowedPaths),
    allowedHosts: optionalStringArray(raw.allowedHosts),
    toolTimeoutMs: optionalToolTimeout(name, raw.toolTimeoutMs),
  };
}

export function getMcpConfigLocations(roots: McpConfigRoots): readonly McpConfigLocation[] {
  const cwd = roots.workingDirectory;
  const home = roots.homeDirectory;
  return [
    {
      scope: 'global',
      kind: 'global-xdg',
      path: join(home, '.config', 'mcp', 'mcp.json'),
      writable: true,
    },
    {
      scope: 'external',
      kind: 'global-dotdir',
      path: join(home, '.mcp', 'mcp.json'),
      writable: false,
    },
    {
      scope: 'external',
      kind: 'claude-desktop',
      path: join(home, '.config', 'claude', 'claude_desktop_config.json'),
      writable: false,
    },
    {
      scope: 'external',
      kind: 'project-mcp',
      path: join(cwd, '.mcp', 'mcp.json'),
      writable: false,
    },
    {
      scope: 'project',
      kind: 'project-goodvibes',
      path: join(cwd, '.goodvibes', 'mcp.json'),
      writable: true,
    },
  ];
}

function writableMcpConfigLocation(roots: McpConfigRoots, scope: McpConfigScope): McpConfigLocation {
  const location = getMcpConfigLocations(roots).find((entry) => entry.scope === scope && entry.writable);
  if (!location) throw new Error(`No writable MCP config location is available for scope '${scope}'.`);
  return location;
}

function parseMcpServers(raw: unknown): McpServerConfig[] | null {
  if (!isRecord(raw)) return null;

  if (isRecord(raw.mcpServers)) {
    const servers: McpServerConfig[] = [];
    for (const [name, value] of Object.entries(raw.mcpServers)) {
      if (!isRecord(value)) continue;
      const server = normalizeServerConfig(name, value);
      if (server) servers.push(server);
    }
    return servers;
  }

  if (Array.isArray(raw.servers)) {
    const servers: McpServerConfig[] = [];
    for (const entry of raw.servers) {
      const server = readServerEntry(entry);
      if (server) servers.push(server);
      else logger.warn('[MCP] Skipped a server entry that is missing a name, or a command or url; fix it in the file', { entry: describeEntry(entry) });
    }
    return servers;
  }
  return null;
}

function describeEntry(entry: unknown): string {
  return isRecord(entry) && typeof entry.name === 'string' && entry.name ? entry.name : JSON.stringify(entry)?.slice(0, 120) ?? String(entry);
}

/** One goodvibes-format entry, or null when it lacks a name, or a command or url, or has a field of the wrong type. */
function readServerEntry(entry: unknown): McpServerConfig | null {
  if (!isServerEntry(entry)) return null;
  const { role, trustMode, headers, ...rest } = entry;
  const knownHeaders = optionalStringRecord(headers);
  const knownRole = knownValue<NonNullable<McpServerConfig['role']>>(entry.name, 'role', role, MCP_SERVER_ROLES);
  const knownTrust = knownValue<NonNullable<McpServerConfig['trustMode']>>(entry.name, 'trustMode', trustMode, MCP_TRUST_MODES);
  return {
    ...rest,
    ...(knownHeaders !== undefined ? { headers: knownHeaders } : {}),
    ...(knownRole !== undefined ? { role: knownRole } : {}),
    ...(knownTrust !== undefined ? { trustMode: knownTrust } : {}),
  };
}

/** Fields this module models; anything else in a file is the user's and is carried through a rewrite. */
const MODELLED_SERVER_FIELDS = new Set(['name', 'command', 'url', 'args', 'env', 'headers', 'role', 'trustMode', 'allowedPaths', 'allowedHosts', 'toolTimeoutMs']);

function readUnmodelledFields(path: string): Map<string, Record<string, unknown>> {
  const found = new Map<string, Record<string, unknown>>();
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return found; }
  if (!isRecord(raw)) return found;
  const entries: [string, unknown][] = isRecord(raw.mcpServers)
    ? Object.entries(raw.mcpServers)
    : Array.isArray(raw.servers) ? raw.servers.map((value): [string, unknown] => [isRecord(value) && typeof value.name === 'string' ? value.name : '', value]) : [];
  for (const [name, value] of entries) {
    if (!name || !isRecord(value)) continue;
    const extra = Object.fromEntries(Object.entries(value).filter(([key]) => !MODELLED_SERVER_FIELDS.has(key)));
    if (Object.keys(extra).length > 0) found.set(name, extra);
  }
  return found;
}

/**
 * Entries this module could not read (a missing command, a wrong field type),
 * kept verbatim so a rewrite of the file does not delete what the user wrote.
 * An entry under a name in `replaced` is dropped: the write replaces or removes it.
 */
function readUnparsedEntries(path: string, replaced: ReadonlySet<string>): Record<string, unknown>[] {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  if (!isRecord(raw)) return [];
  const kept: Record<string, unknown>[] = [];
  if (isRecord(raw.mcpServers)) {
    for (const [name, value] of Object.entries(raw.mcpServers)) {
      if (replaced.has(name) || !isRecord(value) || normalizeServerConfig(name, value)) continue;
      kept.push({ name, ...value });
    }
  } else if (Array.isArray(raw.servers)) {
    for (const entry of raw.servers) {
      if (!isRecord(entry) || readServerEntry(entry)) continue;
      if (typeof entry.name === 'string' && replaced.has(entry.name)) continue;
      kept.push(entry);
    }
  }
  return kept;
}

/** A name the registry cannot address (it splits qualified tool names on ':' and '/'). */
function serverNameProblem(name: string): string | null {
  if (!name.trim()) return 'MCP server name is required.';
  if (name.includes(':') || name.includes('/')) return 'MCP server name may not contain ":" or "/".';
  return null;
}

/** Paths already reported as unreadable, so a file another program owns is warned about once per process, not on every reload. */
const reportedExternalFiles = new Set<string>();

/**
 * A settings file another program owns (Claude Desktop, a project's
 * `.mcp/mcp.json`): read only. A file that cannot be read or holds no server
 * list in a recognised shape is skipped with one warning; it is never moved,
 * renamed or rewritten.
 */
function readExternalMcpConfig(path: string): McpConfig {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    reportExternalFile(path, `it could not be read as JSON (${summarizeError(error)})`);
    return { servers: [] };
  }
  const servers = parseMcpServers(raw);
  // A settings file with no server list at all (Claude Desktop with none configured) simply contributes none.
  if (!servers) {
    if (isRecord(raw) && raw.servers !== undefined) reportExternalFile(path, 'its "servers" value is not a list of servers');
    return { servers: [] };
  }
  return { servers };
}

function reportExternalFile(path: string, problem: string): void {
  if (reportedExternalFiles.has(path)) return;
  reportedExternalFiles.add(path);
  logger.warn('[MCP] Skipped an MCP settings file owned by another program; it was left as it is', { path, problem });
}

function readMcpConfigAtPath(path: string): McpConfig {
  // This file is read-modify-written by every add/remove, so an unparseable
  // one would be destroyed by the next write. Quarantine it instead: the
  // operator keeps the file to recover server definitions from, and this
  // reader reports the same empty config it reports for "no file yet". One
  // malformed entry is skipped (and carried through a rewrite), not the file.
  const servers = readJsonFileOrQuarantine<McpServerConfig[]>(path, {
    label: 'mcp/config',
    recovery: 'No MCP servers are configured from this file; each server must be added again, and the next add recreates the file.',
    validate: (raw) => {
      const parsed = parseMcpServers(raw);
      if (!parsed) throw new Error('MCP config file does not hold a recognized server list');
      return parsed;
    },
  });
  return { servers: servers ?? [] };
}

function assertServerConfig(server: McpServerConfig): void {
  const nameProblem = serverNameProblem(server.name);
  if (nameProblem) throw new Error(nameProblem);
  if (server.role !== undefined && !MCP_SERVER_ROLES.has(server.role)) {
    throw new Error(`MCP server role '${server.role}' is not one of: ${[...MCP_SERVER_ROLES].join(', ')}.`);
  }
  if (server.trustMode !== undefined && !MCP_TRUST_MODES.has(server.trustMode)) {
    throw new Error(`MCP server trustMode '${server.trustMode}' is not one of: ${[...MCP_TRUST_MODES].join(', ')}.`);
  }
  if (server.toolTimeoutMs !== undefined && !isToolTimeout(server.toolTimeoutMs)) {
    throw new Error('MCP server toolTimeoutMs must be a whole number of milliseconds, 0 for no deadline.');
  }
  const hasCommand = Boolean(server.command?.trim());
  const hasUrl = Boolean(server.url?.trim());
  if (!hasCommand && !hasUrl) throw new Error('MCP server needs a command (stdio) or a url (HTTP).');
  if (hasCommand && hasUrl) throw new Error('MCP server may set command (stdio) or url (HTTP), not both.');
}

/**
 * Entries other than the one being written are carried through as read: an
 * entry this module would refuse to add (an unaddressable name) must not make
 * every later add or remove fail, and must not be deleted by one.
 */
function writeMcpConfigFile(path: string, config: McpConfig, removedName?: string): void {
  const exists = existsSync(path);
  const unmodelled = exists ? readUnmodelledFields(path) : new Map<string, Record<string, unknown>>();
  const replaced = new Set(config.servers.map((server) => server.name));
  if (removedName !== undefined) replaced.add(removedName);
  const unparsed = exists ? readUnparsedEntries(path, replaced) : [];
  const normalized = {
    servers: [...config.servers.map((server) => {
      return {
        ...(unmodelled.get(server.name) ?? {}),
        name: server.name,
        ...(server.command !== undefined ? { command: server.command } : {}),
        ...(server.url !== undefined ? { url: server.url } : {}),
        ...(server.args !== undefined ? { args: [...server.args] } : {}),
        ...(server.env !== undefined ? { env: { ...server.env } } : {}),
        ...(server.headers !== undefined ? { headers: { ...server.headers } } : {}),
        ...(server.role !== undefined ? { role: server.role } : {}),
        ...(server.trustMode !== undefined ? { trustMode: server.trustMode } : {}),
        ...(server.allowedPaths !== undefined ? { allowedPaths: [...server.allowedPaths] } : {}),
        ...(server.allowedHosts !== undefined ? { allowedHosts: [...server.allowedHosts] } : {}),
        ...(server.toolTimeoutMs !== undefined ? { toolTimeoutMs: server.toolTimeoutMs } : {}),
      };
    }), ...unparsed],
  };
  writeJsonFileAtomic(path, normalized);
}

/**
 * loadMcpConfig - Scan multiple locations in precedence order (later wins).
 * Returns merged config from all found files. Returns empty config on failure.
 */
export function loadMcpConfig(roots: McpConfigRoots): McpConfig {
  return { servers: loadMcpEffectiveConfig(roots).servers.map((entry) => entry.server) };
}

export function loadMcpEffectiveConfig(roots: McpConfigRoots): McpEffectiveConfig {
  const locations = getMcpConfigLocations(roots);
  const serversByName = new Map<string, McpServerConfigEntry>();

  for (const location of locations) {
    try {
      if (!existsSync(location.path)) continue;
      const config = location.writable ? readMcpConfigAtPath(location.path) : readExternalMcpConfig(location.path);
      const projectScope = location.kind === 'project-mcp' || location.kind === 'project-goodvibes';
      for (const parsed of config.servers) {
        const nameProblem = serverNameProblem(parsed.name);
        if (nameProblem) {
          logger.warn('[MCP] Skipped a server entry that cannot be addressed; rename it in the file', { path: location.path, server: parsed.name, problem: nameProblem });
          continue;
        }
        let server = parsed;
        if (projectScope && server.trustMode === 'allow-all') {
          // A checked-out repository must not grant its own servers unrestricted trust; the user's global config can.
          logger.warn('[MCP] Ignored trustMode allow-all from a project file; the default trust mode applies', { path: location.path, server: server.name });
          server = { ...server, trustMode: undefined };
        }
        serversByName.set(server.name, { server, source: location });
      }
    } catch (err) {
      logger.warn(`[MCP] Failed to read ${location.path}`, { error: summarizeError(err) });
    }
  }

  return {
    servers: [...serversByName.values()],
    locations,
  };
}

export function loadWritableMcpConfig(roots: McpConfigRoots, scope: McpConfigScope): McpConfig {
  const location = writableMcpConfigLocation(roots, scope);
  return readMcpConfigAtPath(location.path);
}

/**
 * Write a server entry, creating or replacing it by name.
 *
 * `args`, `env` and `headers` are the fields an omitted value PRESERVES rather
 * than clears.
 *
 * Every other field is a full replacement, which is right: the caller can see
 * what it is replacing. These three it cannot: the read side redacts args and
 * reports only the names of env variables and headers, so an admin editing an
 * unrelated field (a URL, an allowedHost) round-trips the server object
 * without them and would destroy credentials nobody could have known to
 * resend.
 *
 * Supplying one still replaces it wholesale, so clearing stays possible and
 * explicit: send the list or map you want (an empty one clears it).
 */
export function upsertMcpServerConfig(
  roots: McpConfigRoots,
  scope: McpConfigScope,
  server: McpServerConfig,
): { readonly path: string; readonly config: McpConfig } {
  assertServerConfig(server);
  const location = writableMcpConfigLocation(roots, scope);
  const current = readMcpConfigAtPath(location.path);
  const existing = current.servers.find((entry) => entry.name === server.name);
  const nextServers = current.servers.filter((entry) => entry.name !== server.name);
  const preservedArgs = server.args === undefined ? existing?.args : undefined;
  const preservedEnv = server.env === undefined ? existing?.env : undefined;
  const preservedHeaders = server.headers === undefined ? existing?.headers : undefined;
  nextServers.push({
    ...server,
    ...(preservedArgs === undefined ? {} : { args: [...preservedArgs] }),
    ...(preservedEnv === undefined ? {} : { env: { ...preservedEnv } }),
    ...(preservedHeaders === undefined ? {} : { headers: { ...preservedHeaders } }),
  });
  nextServers.sort((a, b) => a.name.localeCompare(b.name));
  const config = { servers: nextServers };
  writeMcpConfigFile(location.path, config);
  return { path: location.path, config };
}

/**
 * Run a read-modify-write of one writable config file while holding a lock on it,
 * so two processes (the terminal and the daemon, or two sessions) cannot each
 * read the same file and lose the other's change.
 */
export async function withMcpConfigLock<T>(roots: McpConfigRoots, scope: McpConfigScope, work: () => T): Promise<T> {
  const location = writableMcpConfigLocation(roots, scope);
  const release = await acquireCrossProcessLock(`${location.path}.lock`);
  try { return work(); } finally { release(); }
}

export function removeMcpServerConfig(
  roots: McpConfigRoots,
  scope: McpConfigScope,
  serverName: string,
): { readonly path: string; readonly removed: boolean; readonly config: McpConfig } {
  if (!serverName.trim()) throw new Error('MCP server name is required.');
  const location = writableMcpConfigLocation(roots, scope);
  const current = readMcpConfigAtPath(location.path);
  const config = { servers: current.servers.filter((entry) => entry.name !== serverName) };
  const removed = config.servers.length !== current.servers.length;
  if (removed || existsSync(location.path)) writeMcpConfigFile(location.path, config, serverName);
  return { path: location.path, removed, config };
}

/** Type guard for one goodvibes-format server entry. */
function isServerEntry(s: unknown): s is McpServerConfig {
  if (typeof s !== 'object' || s === null) return false;
  const srv = s as Record<string, unknown>;
  if (typeof srv['name'] !== 'string' || !srv['name']) return false;
  const hasCommand = typeof srv['command'] === 'string' && srv['command'].length > 0;
  const hasUrl = typeof srv['url'] === 'string' && srv['url'].length > 0;
  if (!hasCommand && !hasUrl) return false;
  if (srv['command'] !== undefined && typeof srv['command'] !== 'string') return false;
  if (srv['url'] !== undefined && typeof srv['url'] !== 'string') return false;
  if (srv['args'] !== undefined) {
    if (!Array.isArray(srv['args'])) return false;
    if (!srv['args'].every((a: unknown) => typeof a === 'string')) return false;
  }
  if (srv['env'] !== undefined && (typeof srv['env'] !== 'object' || srv['env'] === null)) return false;
  if (srv['role'] !== undefined && typeof srv['role'] !== 'string') return false;
  if (srv['trustMode'] !== undefined && typeof srv['trustMode'] !== 'string') return false;
  if (srv['allowedPaths'] !== undefined && (!Array.isArray(srv['allowedPaths']) || !srv['allowedPaths'].every((a: unknown) => typeof a === 'string'))) return false;
  if (srv['allowedHosts'] !== undefined && (!Array.isArray(srv['allowedHosts']) || !srv['allowedHosts'].every((a: unknown) => typeof a === 'string'))) return false;
  if (srv['toolTimeoutMs'] !== undefined && !isToolTimeout(srv['toolTimeoutMs'])) return false;
  return true;
}
