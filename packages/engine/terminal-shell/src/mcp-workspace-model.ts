import type { McpConfigScope, McpEffectiveConfig, McpServerConfig, McpServerConfigEntry, McpServerSecurityRecord } from '@goodvibes-jev/engine/sdk/platform/mcp';
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
}
export interface McpWorkspaceActionRow {
    readonly type: 'action';
    readonly id: 'add' | 'reload' | 'refresh-tools' | 'config';
    readonly label: string;
    readonly detail: string;
}
export type McpWorkspaceRow = {
    readonly type: 'server';
    readonly server: McpWorkspaceServerRow;
} | McpWorkspaceActionRow;
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
            if (ch === quote)
                quote = null;
            else
                current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (/\s/.test(ch)) {
            if (current.length > 0) {
                args.push(current);
                current = '';
            }
            continue;
        }
        current += ch;
    }
    if (escaping)
        current += '\\';
    if (current.length > 0)
        args.push(current);
    return args;
}
export function parseEnv(value: string): Record<string, string> | undefined {
    const entries: Array<[
        string,
        string
    ]> = [];
    for (const raw of splitList(value)) {
        const eq = raw.indexOf('=');
        if (eq <= 0)
            throw new Error(`Invalid env entry "${raw}". Use KEY=VALUE.`);
        entries.push([raw.slice(0, eq).trim(), raw.slice(eq + 1)]);
    }
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
export function serverConfigToForm(server?: McpServerConfig | undefined): McpWorkspaceFormBase {
    return {
        scope: 'project',
        name: server?.name ?? '',
        command: server?.command ?? '',
        args: server?.args?.join(' ') ?? '',
        role: server?.role ?? 'general',
        trustMode: server?.trustMode === 'blocked' || server?.trustMode === 'ask-on-risk' ? server.trustMode : 'constrained',
        env: server?.env ? Object.entries(server.env).map(([key, value]) => `${key}=${value}`).join(', ') : '',
        allowedPaths: server?.allowedPaths?.join(', ') ?? '',
        allowedHosts: server?.allowedHosts?.join(', ') ?? '',
    };
}
export function formToServerConfig(form: McpWorkspaceFormBase): McpServerConfig & {
    command: string;
} {
    const name = form.name.trim();
    const command = form.command.trim();
    if (!name)
        throw new Error('Server name is required.');
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
        throw new Error('Server names may contain letters, numbers, dot, underscore, and dash only.');
    }
    if (!command)
        throw new Error('Command is required.');
    const args = parseArgs(form.args.trim());
    const env = parseEnv(form.env);
    const allowedPaths = splitList(form.allowedPaths);
    const allowedHosts = splitList(form.allowedHosts);
    return {
        name,
        command,
        ...(args.length > 0 ? { args } : {}),
        role: form.role,
        trustMode: form.trustMode,
        ...(env ? { env } : {}),
        ...(allowedPaths.length > 0 ? { allowedPaths } : {}),
        ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    };
}
export function nextEnumValue<T extends readonly string[]>(values: T, current: T[number], direction: 1 | -1): T[number] {
    const index = values.indexOf(current);
    const next = (index + direction + values.length) % values.length;
    const value = values[next];
    if (value === undefined)
        throw new RangeError('Cannot cycle an empty option list');
    return value;
}
export function mergeServers(effectiveConfig: McpEffectiveConfig, runtimeServers: readonly McpServerSecurityRecord[]): McpWorkspaceServerRow[] {
    const configByName = new Map<string, McpServerConfigEntry>();
    for (const entry of effectiveConfig.servers)
        configByName.set(entry.server.name, entry);
    const runtimeByName = new Map(runtimeServers.map((server) => [server.name, server]));
    const names = new Set<string>([
        ...effectiveConfig.servers.map((entry) => entry.server.name),
        ...runtimeServers.map((server) => server.name),
    ]);
    return [...names].sort((a, b) => a.localeCompare(b)).map((name) => {
        const entry = configByName.get(name);
        const config = entry?.server;
        const runtime = runtimeByName.get(name);
        return {
            name,
            connected: runtime?.connected ?? false,
            role: runtime?.role ?? config?.role ?? 'general',
            trustMode: runtime?.trustMode ?? config?.trustMode ?? 'constrained',
            freshness: runtime?.schemaFreshness ?? 'unknown',
            source: entry?.source.scope === 'project' ? 'project' : entry?.source.scope === 'global' ? 'global' : config ? 'external' : 'runtime',
            command: config?.command,
            args: config?.args,
            allowedPaths: runtime?.allowedPaths ?? config?.allowedPaths ?? [],
            allowedHosts: runtime?.allowedHosts ?? config?.allowedHosts ?? [],
            quarantineReason: runtime?.quarantineReason,
            quarantineDetail: runtime?.quarantineDetail,
        };
    });
}
