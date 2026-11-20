import { MCP_DEFAULT_TRUST_MODE } from '@goodvibes-jev/engine/platform/platform/mcp/config';
import type { McpConfigScope, McpEffectiveConfig, McpServerConfig, McpServerConfigEntry, McpServerSecurityRecord } from '@goodvibes-jev/engine/platform/platform/mcp';
export const MCP_WORKSPACE_MODAL_NAME = 'mcpWorkspace';
export const MCP_ROLES = ['general', 'docs', 'filesystem', 'git', 'database', 'browser', 'automation', 'ops', 'remote'] as const;
export const MCP_FORM_TRUST_MODES = ['constrained', 'ask-on-risk', 'blocked'] as const;
export interface McpWorkspaceServerRow {
  readonly name: string;
  readonly connected: boolean;
  readonly role: string;
  readonly trustMode: string;
  readonly freshness: string;
  readonly source: 'project' | 'global' | 'external' | 'runtime';
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly allowedPaths: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly quarantineReason?: string | undefined;
  readonly quarantineDetail?: string | undefined;
  /** Per-tool allows and denials and where each came from (this session or the config); absent when none. */
  readonly toolRules?: McpServerSecurityRecord['toolRules'];
  /** Short connection state for a server that is not connected: `starting`, `reconnecting 2/5`, `offline`. */
  readonly connectionState?: string | undefined;
  /** Why it is not connected and what happens next (the last error, the next attempt, or why reconnecting stopped). */
  readonly connectionDetail?: string | undefined;
}
export interface McpWorkspaceActionRow {
  readonly type: 'action';
  readonly id: 'add' | 'reload' | 'refresh-tools' | 'config';
  readonly label: string;
  readonly detail: string;
}
export type McpWorkspaceRow =
  | {
      readonly type: 'server';
      readonly server: McpWorkspaceServerRow;
    }
  | McpWorkspaceActionRow;
export interface McpWorkspaceFormBase {
  scope: McpConfigScope;
  name: string;
  command: string;
  args: string;
  role: NonNullable<McpServerConfig['role']>;
  trustMode: Exclude<NonNullable<McpServerConfig['trustMode']>, 'allow-all'>;
  env: string;
  allowedPaths: string;
  allowedHosts: string;
  /** Comma-separated tools refused on every call, kept with the entry. Kept exemptions are not edited here: they ask once, in Settings or with /mcp exempt. */
  deniedTools: string;
  /**
   * The saved config this form was opened from. The text fields cannot encode every
   * saved value (a comma inside an env value or path, allow-all trust), so a field
   * the user has not changed keeps the saved value instead of its re-parsed text.
   */
  origin?: McpServerConfig | undefined;
  /** Set once the user moves the trust mode; until then saving keeps the saved mode (allow-all, or none for the default). */
  trustTouched?: boolean | undefined;
}
export interface McpWorkspaceSnapshot {
  readonly projectPath: string;
  readonly globalPath: string;
  readonly effectiveConfig: McpEffectiveConfig;
  readonly servers: readonly McpWorkspaceServerRow[];
}
export function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
export function parseArgs(value: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;
  // A quoted empty string ("") is an argument even though it adds no characters.
  let started = false;
  for (const ch of value) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current.length > 0) {
        args.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += '\\';
  if (started || current.length > 0) args.push(current);
  return args;
}
/** The inverse of parseArgs: a token that parseArgs would split or unquote is written quoted. */
export function formatArgs(args: readonly string[]): string {
  return args.map((arg) => (arg.length > 0 && !/[\s"'\\]/.test(arg) ? arg : `"${arg.replace(/[\\"]/g, '\\$&')}"`)).join(' ');
}
export function parseEnv(value: string): Record<string, string> | undefined {
  const entries: Array<[string, string]> = [];
  // A comma only separates entries when another KEY= follows, so a value may contain commas.
  for (const raw of value.split(/,(?=\s*[A-Za-z_][A-Za-z0-9_.-]*=)/).map((entry) => entry.trim()).filter(Boolean)) {
    const eq = raw.indexOf('=');
    if (eq <= 0) throw new Error(`Invalid env entry "${raw}". Use KEY=VALUE.`);
    entries.push([raw.slice(0, eq).trim(), raw.slice(eq + 1)]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
function envText(env: McpServerConfig['env']): string {
  return env
    ? Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ')
    : '';
}
export function serverConfigToForm(server?: McpServerConfig | undefined): McpWorkspaceFormBase {
  return {
    ...(server ? { origin: server } : {}),
    scope: 'project',
    name: server?.name ?? '',
    command: server?.command ?? '',
    args: server?.args ? formatArgs(server.args) : '',
    role: server?.role ?? 'general',
    // The form cannot show allow-all; an unset mode shows the default the server actually runs with.
    trustMode: server?.trustMode === 'blocked' || server?.trustMode === 'ask-on-risk' || server?.trustMode === 'constrained'
      ? server.trustMode : MCP_DEFAULT_TRUST_MODE,
    env: envText(server?.env),
    allowedPaths: server?.allowedPaths?.join(', ') ?? '',
    allowedHosts: server?.allowedHosts?.join(', ') ?? '',
    deniedTools: server?.deniedTools?.join(', ') ?? '',
  };
}
export function formToServerConfig(form: McpWorkspaceFormBase): McpServerConfig & {
  command: string;
} {
  const name = form.name.trim();
  const command = form.command.trim();
  if (!name) throw new Error('Server name is required.');
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error('Server names may contain letters, numbers, dot, underscore, and dash only.');
  }
  if (!command) throw new Error('Command is required.');
  const origin = form.origin;
  const unedited = (text: string, saved: string): boolean => origin !== undefined && text === saved;
  const args = origin?.args && unedited(form.args, formatArgs(origin.args)) ? [...origin.args] : parseArgs(form.args.trim());
  const env = origin?.env && unedited(form.env, envText(origin.env)) ? { ...origin.env } : parseEnv(form.env);
  const allowedPaths = origin?.allowedPaths && unedited(form.allowedPaths, origin.allowedPaths.join(', ')) ? [...origin.allowedPaths] : splitList(form.allowedPaths);
  const allowedHosts = origin?.allowedHosts && unedited(form.allowedHosts, origin.allowedHosts.join(', ')) ? [...origin.allowedHosts] : splitList(form.allowedHosts);
  const deniedTools = origin?.deniedTools && unedited(form.deniedTools, origin.deniedTools.join(', ')) ? [...origin.deniedTools] : splitList(form.deniedTools);
  // Saving another field never changes the trust mode: an untouched trust field keeps what was saved
  // (allow-all, which the form cannot show, or nothing, which runs as the default).
  const trustMode = form.trustTouched ? form.trustMode : origin ? origin.trustMode : form.trustMode === MCP_DEFAULT_TRUST_MODE ? undefined : form.trustMode;
  return {
    name,
    command,
    ...(args.length > 0 ? { args } : {}),
    role: form.role,
    ...(trustMode !== undefined ? { trustMode } : {}),
    ...(env ? { env } : {}),
    ...(allowedPaths.length > 0 ? { allowedPaths } : {}),
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    // An emptied field clears the kept denials; a field never filled leaves the entry's as they are. Kept allows are never sent from here.
    ...(deniedTools.length > 0 || origin?.deniedTools?.length ? { deniedTools } : {}),
  };
}
export function nextEnumValue<T extends readonly string[]>(values: T, current: T[number], direction: 1 | -1): T[number] {
  const index = values.indexOf(current);
  const next = (index + direction + values.length) % values.length;
  const value = values[next];
  if (value === undefined) throw new RangeError('Cannot cycle an empty option list');
  return value;
}
export function mergeServers(
  effectiveConfig: McpEffectiveConfig,
  runtimeServers: readonly McpServerSecurityRecord[],
): McpWorkspaceServerRow[] {
  const configByName = new Map<string, McpServerConfigEntry>();
  for (const entry of effectiveConfig.servers) configByName.set(entry.server.name, entry);
  const runtimeByName = new Map(runtimeServers.map((server) => [server.name, server]));
  const names = new Set<string>([
    ...effectiveConfig.servers.map((entry) => entry.server.name),
    ...runtimeServers.map((server) => server.name),
  ]);
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const entry = configByName.get(name);
      const config = entry?.server;
      const runtime = runtimeByName.get(name);
      return {
        name,
        connected: runtime?.connected ?? false,
        role: runtime?.role ?? config?.role ?? 'general',
        trustMode: runtime?.trustMode ?? config?.trustMode ?? MCP_DEFAULT_TRUST_MODE,
        freshness: runtime?.schemaFreshness ?? 'unknown',
        source:
          entry?.source.scope === 'project' ? 'project' : entry?.source.scope === 'global' ? 'global' : config ? 'external' : 'runtime',
        command: config?.command,
        args: config?.args,
        allowedPaths: runtime?.allowedPaths ?? config?.allowedPaths ?? [],
        allowedHosts: runtime?.allowedHosts ?? config?.allowedHosts ?? [],
        toolRules: runtime?.toolRules ?? keptToolRules(config),
        quarantineReason: runtime?.quarantineReason,
        quarantineDetail: runtime?.quarantineDetail,
        ...describeConnection(runtime),
      };
    });
}

/** The rules a configured server keeps, for a server the runtime has no record of. */
function keptToolRules(config: McpServerConfig | undefined): McpServerSecurityRecord['toolRules'] {
  if (!config?.deniedTools?.length && !config?.allowedTools?.length) return undefined;
  const denied = new Set(config.deniedTools ?? []);
  return [
    ...(config.deniedTools ?? []).map((toolName) => ({ toolName, rule: 'deny' as const, source: 'stored' as const, inEffect: true })),
    ...(config.allowedTools ?? []).map((toolName) => ({ toolName, rule: 'allow' as const, source: 'stored' as const, inEffect: !denied.has(toolName) })),
  ];
}

/** The connection state the workspace shows for a server that is not connected, from the runtime's own record. */
function describeConnection(runtime: McpServerSecurityRecord | undefined): { connectionState?: string; connectionDetail?: string } {
  if (!runtime || runtime.connected) return {};
  const reconnect = runtime.reconnect;
  const parts: string[] = [];
  if (runtime.lastError) parts.push(runtime.lastError);
  if (runtime.phase === 'restart-wait') {
    if (reconnect?.nextAttemptAt !== undefined) {
      parts.push(`reconnect attempt ${reconnect.attempt} of ${reconnect.maxAttempts} in ${Math.max(1, Math.ceil((reconnect.nextAttemptAt - Date.now()) / 1000))} s`);
    }
    return { connectionState: reconnect ? `reconnecting ${reconnect.attempt}/${reconnect.maxAttempts}` : 'restarting', connectionDetail: parts.join(' · ') };
  }
  if (runtime.phase === 'starting' || runtime.phase === 'negotiating') return { connectionState: 'starting', ...(parts.length ? { connectionDetail: parts.join(' · ') } : {}) };
  if (reconnect?.stoppedReason) parts.push(`${reconnect.stoppedReason}; fix the server, then reload`);
  return { connectionState: 'offline', ...(parts.length ? { connectionDetail: parts.join(' · ') } : {}) };
}

export interface McpWorkspaceFormField<Extra extends string = never> {
  readonly id: keyof McpWorkspaceFormBase | 'save' | 'cancel' | Extra;
  readonly label: string;
  readonly value: string;
  readonly help: string;
  readonly editable: boolean;
}
export function buildMcpWorkspaceFormFields(form: McpWorkspaceFormBase): readonly McpWorkspaceFormField[] {
  return [
    {
      id: 'name',
      label: 'Server name',
      value: form.name,
      help: 'Unique MCP server id. Project config overrides matching global server names.',
      editable: true,
    },
    {
      id: 'scope',
      label: 'Scope',
      value: form.scope,
      help: 'Cycle with Left/Right. Project writes to this workspace; global writes to your user MCP config.',
      editable: false,
    },
    {
      id: 'command',
      label: 'Command',
      value: form.command,
      help: 'Executable to launch, for example npx, node, uvx, python, or an absolute path.',
      editable: true,
    },
    {
      id: 'args',
      label: 'Arguments',
      value: form.args,
      help: 'Command arguments. Quotes are supported for values with spaces.',
      editable: true,
    },
    {
      id: 'role',
      label: 'Role',
      value: form.role,
      help: `Cycle with Left/Right. Values: ${MCP_ROLES.join(', ')}.`,
      editable: false,
    },
    {
      id: 'trustMode',
      label: 'Trust mode',
      value: form.trustMode,
      help: 'Cycle with Left/Right. allow-all is intentionally not offered here; use Settings MCP for explicit escalation.',
      editable: false,
    },
    {
      id: 'env',
      label: 'Environment',
      value: form.env,
      help: 'Comma-separated KEY=VALUE entries. Prefer env var references or secure secrets for sensitive values.',
      editable: true,
    },
    {
      id: 'allowedPaths',
      label: 'Allowed paths',
      value: form.allowedPaths,
      help: 'Comma-separated path prefixes for filesystem-oriented servers.',
      editable: true,
    },
    {
      id: 'allowedHosts',
      label: 'Allowed hosts',
      value: form.allowedHosts,
      help: 'Comma-separated hostnames for network-oriented servers.',
      editable: true,
    },
    {
      id: 'deniedTools',
      label: 'Denied tools',
      value: form.deniedTools,
      help: 'Comma-separated tool names refused on every call, kept in this config past a restart. /mcp block <server> <tool> blocks one for this session only; letting a tool past its server\'s limits is set in Settings MCP or with /mcp exempt.',
      editable: true,
    },
  ];
}
