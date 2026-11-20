/**
 * `/mcp`, described once (command-actions/): its actions, their blanks, what
 * each says before and after it runs, and what it touches. Both terminal apps
 * register this one description, so their guided path, typed line, help,
 * completion, confirmation and the model's catalogue entry are the same.
 */
import type { McpApi, McpConfigScope, McpServerConfig, McpStoredToolRuleResult, McpToolRule } from '@goodvibes-jev/engine/platform/platform/mcp';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { commandRefusal } from './command-confirmation.js';
import { maskLaunchArgs } from './renderer/mcp-form-rows.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionValues, CommandActionContext, CommandDescription, CommandReport, FixedChoice, InputDescription } from './command-actions/types.js';

export interface McpCommandContext extends CommandActionContext {
  readonly renderRequest: () => void;
  readonly clients?: { readonly mcpApi?: McpApi | undefined } | undefined;
  readonly workspace: { readonly shellPaths?: ShellPathService | null | undefined };
  readonly openMcpWorkspace?: (() => void) | undefined;
}

type McpSecurityServer = ReturnType<McpApi['listServerSecurity']>[number];
type McpTrustMode = NonNullable<McpServerConfig['trustMode']>;
type McpRole = NonNullable<McpServerConfig['role']>;

function mcpApiOf(ctx: McpCommandContext): McpApi {
  const api = ctx.clients?.mcpApi;
  if (!api) throw commandRefusal('MCP is not available in this session.', 'Restart the app; MCP servers load with it.');
  return api;
}
function shellPathsOf(ctx: McpCommandContext): ShellPathService {
  const paths = ctx.workspace.shellPaths;
  if (!paths) throw commandRefusal('MCP config files cannot be found: this session has no working directory.');
  return paths;
}
function refuse(message: string, next?: string): never {
  throw commandRefusal(message, next);
}

const ROLES: readonly FixedChoice[] = [
  { value: 'general', label: 'General' },
  { value: 'docs', label: 'Documentation' },
  { value: 'filesystem', label: 'Files' },
  { value: 'git', label: 'Git' },
  { value: 'database', label: 'Database' },
  { value: 'browser', label: 'Browser' },
  { value: 'automation', label: 'Automation' },
  { value: 'ops', label: 'Operations' },
  { value: 'remote', label: 'Remote machines' },
];
const TRUST_MODES: readonly FixedChoice[] = [
  { value: 'constrained', label: 'Ask before anything outside its limits', help: 'Calls inside its folders and sites run; anything else is put to you.' },
  { value: 'ask-on-risk', label: 'Act inside its limits without asking', help: 'Calls inside its scope run without asking; a call outside is put to you.', risk: 'loosens-a-protection' },
  { value: 'blocked', label: 'Refuse every call', help: 'No tool of the server runs.' },
  { value: 'allow-all', label: 'Allow every call', help: 'Every call runs, inside its limits or not.', risk: 'loosens-a-protection' },
];
const SCOPES: readonly FixedChoice[] = [
  { value: 'project', label: 'This project', help: 'Kept in this project\'s .goodvibes/mcp.json.' },
  { value: 'global', label: 'All your projects', help: 'Kept in ~/.config/mcp/mcp.json.' },
];

function formatTrust(mode: McpSecurityServer['trustMode'] | McpTrustMode): string {
  if (mode === 'ask-on-risk') return 'acts inside its limits without asking';
  if (mode === 'allow-all') return 'allows every call';
  if (mode === 'constrained') return 'asks outside its limits';
  return String(mode).replace(/[_-]+/g, ' ');
}
function formatFreshness(value: McpSecurityServer['schemaFreshness']): string {
  return value === 'quarantined' ? 'tools held back for review' : value.replace(/[_-]+/g, ' ');
}
function formatRole(value: McpSecurityServer['role'] | McpRole): string {
  return value.replace(/[_-]+/g, ' ');
}
function serverState(server: McpSecurityServer): string {
  const parts = [server.connected ? 'connected' : server.phase === 'restart-wait' ? 'reconnecting' : 'not connected'];
  if (server.schemaFreshness === 'quarantined') parts.push('tools held back');
  const blocked = server.toolRules?.filter((rule) => rule.rule === 'deny').length ?? 0;
  if (blocked > 0) parts.push(`${blocked} blocked`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Live lists, read only when a guided step or a completion asks
// ---------------------------------------------------------------------------

const MCP_SERVERS = defineList<McpCommandContext>({
  name: 'mcp.servers',
  async read(ctx) {
    const api = mcpApiOf(ctx);
    const running = api.listServerSecurity().map((server): ListRow => ({
      value: server.name,
      label: server.name,
      detail: `Trust: ${formatTrust(server.trustMode)}; role: ${formatRole(server.role)}.`,
      state: serverState(server),
    }));
    // A configured server that has not started yet (it starts when first used) is still one you have.
    const paths = ctx.workspace.shellPaths;
    const configured = paths ? api.getEffectiveConfig(paths).servers.map((entry) => entry.server.name) : [];
    const known = new Set(running.map((row) => row.value));
    return [...running, ...configured.filter((name) => !known.has(name)).map((name): ListRow => ({ value: name, label: name, state: 'not started yet' }))];
  },
  // Every configured server, started or not, from the daemon's effective config.
  operator: { method: 'mcp.config.get', input: {}, rows: { from: 'servers', value: 'name', label: 'name', detail: 'source.path' } },
});

const MCP_QUARANTINED_SERVERS = defineList<McpCommandContext>({
  name: 'mcp.servers.held-back',
  async read(ctx) {
    return mcpApiOf(ctx).listServerSecurity().filter((server) => server.schemaFreshness === 'quarantined').map((server): ListRow => ({
      value: server.name,
      label: server.name,
      detail: server.quarantineDetail ?? server.quarantineReason ?? 'Its tools changed since you last accepted them.',
      state: 'tools held back',
    }));
  },
  operator: { method: 'mcp.servers.list', input: {}, rows: { from: 'security', where: { field: 'schemaFreshness', equals: 'quarantined' }, value: 'name', label: 'name', detail: 'quarantineReason' } },
});

const MCP_TOOLS = defineList<McpCommandContext>({
  name: 'mcp.tools',
  async read(ctx, earlier) {
    const api = mcpApiOf(ctx);
    const server = api.listServerSecurity().find((entry) => entry.name === earlier.server);
    const rules = server?.toolRules ?? [];
    const tools = (await api.listAllTools()).filter((tool) => tool.serverName === earlier.server);
    return tools.map((tool): ListRow => {
      const held = rules.filter((rule) => rule.toolName === tool.toolName);
      const state = held.map((rule) => `${rule.rule === 'deny' ? 'blocked' : 'past its limits'}${rule.source === 'session' ? ' this session' : ', kept'}`).join('; ');
      return { value: tool.toolName, label: tool.toolName, ...(tool.description ? { detail: tool.description } : {}), ...(state ? { state } : {}) };
    });
  },
  operator: { method: 'mcp.tools.list', input: {}, rows: { from: 'tools', where: { field: 'serverName', equals: '{server}' }, value: 'toolName', label: 'toolName', detail: 'description' } },
});

const MCP_BLOCKED_TOOLS = defineList<McpCommandContext>({
  name: 'mcp.tools.blocked',
  async read(ctx, earlier) {
    const server = mcpApiOf(ctx).listServerSecurity().find((entry) => entry.name === earlier.server);
    return (server?.toolRules ?? []).filter((rule) => rule.rule === 'deny').map((rule): ListRow => ({
      value: rule.toolName,
      label: rule.toolName,
      state: rule.source === 'session' ? 'blocked for this session only' : 'blocked, kept',
    }));
  },
  // The web UI sees kept blocks; a block for this session belongs to the terminal app that set it.
  operator: { method: 'mcp.config.get', input: {}, rows: { from: 'servers', where: { field: 'name', equals: '{server}' }, each: 'deniedTools', value: '.', label: '.' } },
});

const MCP_EXEMPT_TOOLS = defineList<McpCommandContext>({
  name: 'mcp.tools.exempt',
  async read(ctx, earlier) {
    const server = mcpApiOf(ctx).listServerSecurity().find((entry) => entry.name === earlier.server);
    return (server?.toolRules ?? []).filter((rule) => rule.rule === 'allow').map((rule): ListRow => ({
      value: rule.toolName,
      label: rule.toolName,
      state: rule.inEffect ? 'goes past its server\'s limits' : 'past its limits, but blocked',
    }));
  },
  operator: { method: 'mcp.config.get', input: {}, rows: { from: 'servers', where: { field: 'name', equals: '{server}' }, each: 'allowedTools', value: '.', label: '.' } },
});

const SERVER: InputDescription = {
  id: 'server', label: 'Server', help: 'The MCP servers you have', kind: 'choice',
  choices: { list: MCP_SERVERS }, required: true, typed: { position: 1 },
};
const TOOL: InputDescription = {
  id: 'tool', label: 'Tool', help: 'Tools this server offers right now', kind: 'choice',
  choices: { list: MCP_TOOLS, dependsOn: 'server', allowOther: { reason: 'a tool the server has not listed (it is not connected now)' } },
  required: true, typed: { position: 2 },
};
const SCOPE: InputDescription = {
  id: 'scope', label: 'Kept for', help: 'Which MCP config file keeps it', kind: 'choice', choices: SCOPES,
  required: { default: 'project', defaultMeans: 'this project only' }, typed: { flag: '--scope' },
};

// ---------------------------------------------------------------------------
// What the actions do
// ---------------------------------------------------------------------------

function knownServer(api: McpApi, name: string, change: string): McpSecurityServer {
  const server = api.listServerSecurity().find((entry) => entry.name === name);
  if (!server) refuse(`No MCP server named ${name}, so its ${change} was not changed.`, 'Run /mcp servers to list your servers.');
  return server;
}

function where(result: McpStoredToolRuleResult): string {
  return `${result.scope} MCP config ${result.path}`;
}

async function keepToolRule(ctx: McpCommandContext, server: string, tool: string, rule: McpToolRule): Promise<McpStoredToolRuleResult> {
  const api = mcpApiOf(ctx);
  if (!api.storeServerToolRule) refuse(`MCP tool ${tool} not changed: this runtime cannot keep a per-tool rule.`, rule === 'block' ? `Block it for this session only: /mcp block ${server} ${tool}.` : undefined);
  try {
    const result = await api.storeServerToolRule(server, tool, rule, shellPathsOf(ctx));
    ctx.renderRequest();
    return result;
  } catch (error) {
    refuse(`MCP tool ${tool} on ${server} not changed: ${summarizeError(error)}`);
  }
}

async function keepServerPolicy(ctx: McpCommandContext, server: string, policy: { readonly trustMode: McpTrustMode } | { readonly role: McpRole }): Promise<string> {
  const api = mcpApiOf(ctx);
  const what = 'trustMode' in policy ? 'trust level' : 'role';
  const sessionOnly = (why: string): string => {
    try {
      if ('trustMode' in policy) api.setServerTrustMode(server, policy.trustMode);
      else api.setServerRole(server, policy.role);
    } catch (error) {
      refuse(`MCP ${what} not changed: ${summarizeError(error)}`);
    }
    return `It is set for this session only (${why}).`;
  };
  if (!api.storeServerPolicy) return sessionOnly('this runtime cannot keep it in the MCP config');
  try {
    const result = await api.storeServerPolicy(server, policy, shellPathsOf(ctx));
    ctx.renderRequest();
    return result.changed ? `Kept in ${where(result)}; it applies now and after a restart.` : `It was already kept in ${where(result)}.`;
  } catch (error) {
    return sessionOnly(summarizeError(error));
  }
}

function restoreSessionPolicy(ctx: McpCommandContext, server: string, field: 'trustMode' | 'role'): string {
  const api = mcpApiOf(ctx);
  const what = field === 'trustMode' ? 'trust level' : 'role';
  if (!api.clearServerSessionPolicy) refuse(`MCP ${what} not changed: this runtime cannot end a value set for this session.`, 'A restart returns it to the saved value.');
  let cleared: boolean;
  try {
    cleared = api.clearServerSessionPolicy(server, field);
  } catch (error) {
    refuse(`MCP ${what} not changed: ${summarizeError(error)}`);
  }
  const now = api.listServerSecurity().find((entry) => entry.name === server);
  const value = now ? (field === 'trustMode' ? formatTrust(now.trustMode) : formatRole(now.role)) : 'its saved value';
  return cleared ? `Its saved ${what} applies: ${value}.` : `It had no ${what} set for this session; its saved ${what} applies: ${value}.`;
}

function describeEndpoint(server: McpServerConfig): string {
  if (server.url) {
    let shown = '(url)';
    try { const parsed = new URL(server.url); shown = `${parsed.origin}${parsed.pathname}`; } catch { /* shown as (url) */ }
    const headerKeys = Object.keys(server.headers ?? {});
    return `url ${shown}${headerKeys.length ? ` headerKeys=${headerKeys.join(',')}` : ''}`;
  }
  const envKeys = Object.keys(server.env ?? {});
  return `command ${server.command ?? ''}${server.args?.length ? ` ${maskLaunchArgs(server.args).join(' ')}` : ''}${envKeys.length ? ` envKeys=${envKeys.join(',')}` : ''}`;
}

function pairs(text: string | undefined, label: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of (text ?? '').split('\n').filter(Boolean)) {
    const eq = entry.indexOf('=');
    if (eq <= 0) refuse(`${label} entries are NAME=VALUE; "${entry.slice(0, Math.max(0, eq)) || '(empty)'}=" was not.`);
    out[entry.slice(0, eq).trim()] = entry.slice(eq + 1);
  }
  return out;
}

/** A name for a new server from its command or address: `npx -y @acme/weather-mcp` → weather. */
function suggestServerName(earlier: ActionValues): { readonly value: string; readonly from: string } | undefined {
  if (earlier.start === 'url' && earlier.address) {
    try {
      const labels = new URL(earlier.address).hostname.split('.').filter((label) => !['mcp', 'www', 'api'].includes(label));
      const value = labels[0];
      return value ? { value, from: 'address' } : undefined;
    } catch { return undefined; }
  }
  const words = (earlier.command ?? '').split('\n').filter((word) => word && !word.startsWith('-'));
  const last = words.at(-1);
  if (!last) return undefined;
  const base = last.replace(/^@[^/]+\//, '').split('/').at(-1)!.replace(/\.(m?js|ts|py)$/, '')
    .replace(/^(mcp-server-|server-|mcp-)/, '').replace(/(-mcp-server|-mcp|-server)$/, '').replace(/[^a-zA-Z0-9._-]/g, '');
  return base ? { value: base, from: 'command' } : undefined;
}

function serverFromValues(values: ActionValues): McpServerConfig {
  const name = values.name ?? '';
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) refuse('MCP server names may contain letters, numbers, dot, underscore and dash only.');
  const url = values.start === 'url' ? values.address : undefined;
  if (values.start === 'url' && !/^https?:\/\//i.test(url ?? '')) refuse('A web address starts with https:// (or http:// on this machine).');
  const words = url ? [] : (values.command ?? '').split('\n').filter(Boolean);
  const target = url ?? words[0] ?? '';
  if (!target) refuse('Give the command that starts the server, or its web address.');
  const args = words.slice(1);
  const env = pairs(values.env, 'Environment');
  const headers = pairs(values.header, 'Header');
  if (url && Object.keys(env).length > 0) refuse('A server at a web address takes no environment; send credentials as a header.');
  if (!url && Object.keys(headers).length > 0) refuse('Headers are sent only to a server at a web address; a command takes environment entries.');
  const paths = (values.path ?? '').split('\n').filter(Boolean);
  const hosts = (values.host ?? '').split('\n').filter(Boolean);
  return {
    name,
    ...(url ? { url } : { command: target }),
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(values.role ? { role: values.role as McpRole } : {}),
    ...(values.trust ? { trustMode: values.trust as McpTrustMode } : {}),
    ...(paths.length > 0 ? { allowedPaths: paths } : {}),
    ...(hosts.length > 0 ? { allowedHosts: hosts } : {}),
  };
}

const NO_SERVERS = [
  'No MCP servers configured. Servers are read from (in order):',
  '  ~/.config/mcp/mcp.json               (global)',
  '  ~/.mcp/mcp.json                      (global dotdir)',
  '  ~/.config/claude/claude_desktop_config.json  (Claude Desktop)',
  '  .mcp/mcp.json                        (project)',
  '  .goodvibes/mcp.json                  (this program, project)',
  'Add one with /mcp, "Add a server".',
].join('\n');

function serverList(servers: readonly McpSecurityServer[]): string {
  const connected = servers.filter((server) => server.connected).length;
  const lines = [`MCP servers (${connected} of ${servers.length} connected):`];
  for (const server of servers) {
    const session = server.sessionTrustMode !== undefined ? ' (this session)' : '';
    const rules = server.toolRules?.length
      ? `; ${server.toolRules.map((rule) => `${rule.rule === 'deny' ? 'blocked' : 'past its limits'} ${rule.toolName} (${rule.source === 'session' ? 'this session' : 'kept'}${rule.inEffect ? '' : ', a block wins'})`).join(', ')}`
      : '';
    lines.push(`  ${server.name}: ${serverState(server)}; trust: ${formatTrust(server.trustMode)}${session}; role: ${formatRole(server.role)}${server.sessionRole !== undefined ? ' (this session)' : ''}${server.allowedPaths.length ? `; ${server.allowedPaths.length} folder(s)` : ''}${server.allowedHosts.length ? `; ${server.allowedHosts.length} site(s)` : ''}${rules}`);
    if (!server.connected && server.lastError) lines.push(`      last error: ${server.lastError}`);
    if (!server.connected && server.reconnect?.stoppedReason) lines.push(`      ${server.reconnect.stoppedReason}; fix the server or its entry, then /mcp reload`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The description
// ---------------------------------------------------------------------------

export const MCP_COMMAND: CommandDescription<McpCommandContext> = {
  name: 'mcp',
  title: 'MCP servers and tools',
  summary: 'Connect tools from other programs',
  group: 'Tools',
  report: 'see-servers',
  firstScreenRows: [
    'see-servers',
    'add-server',
    { label: 'Choose what a server may do', actions: ['block-tool', 'unblock-tool', 'exempt-tool', 'unexempt-tool', 'set-trust', 'restore-trust', 'set-role', 'restore-role', 'remove-server'] },
    { label: 'Check a server that isn\'t working', actions: ['review', 'repair', 'see-tools', 'reload', 'hold-back', 'accept-tools', 'see-config-files', 'open-screen'] },
  ],
  actions: [
    {
      id: 'see-servers', label: 'See your servers', word: 'servers', inputs: [],
      async rowValue(ctx) {
        const servers = mcpApiOf(ctx).listServerSecurity();
        const connected = servers.filter((server) => server.connected).length;
        const broken = servers.filter((server) => !server.connected && (server.lastError || server.reconnect?.stoppedReason)).length;
        const paths = ctx.workspace.shellPaths;
        const configured = paths ? new Set([...servers.map((server) => server.name), ...mcpApiOf(ctx).getEffectiveConfig(paths).servers.map((entry) => entry.server.name)]).size : servers.length;
        if (configured === 0) return 'none yet';
        const parts = [connected === 0 ? 'none connected yet' : `${connected} connected`];
        if (broken > 0) parts.push(`${broken} not working`);
        return parts.join(', ');
      },
      sentence: 'Shows every MCP server, whether it is connected, its trust level, role and tool rules.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'mcp.servers.list', fields: {} }, example: {},
      async run(_values, ctx) {
        const servers = mcpApiOf(ctx).listServerSecurity();
        ctx.print(servers.length === 0 ? NO_SERVERS : serverList(servers));
      },
    },
    {
      id: 'see-tools', label: 'See a server\'s tools', word: 'tools',
      inputs: [{ ...SERVER, required: { default: '', defaultMeans: 'every server' } }],
      sentence: 'Lists the tools {server} offers right now.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'mcp.tools.list', fields: {} }, example: { server: 'github' },
      async run(values, ctx) {
        let all;
        try { all = await mcpApiOf(ctx).listAllTools(); } catch (error) { refuse(`Listing MCP tools failed: ${summarizeError(error)}`); }
        const tools = values.server ? all.filter((tool) => tool.serverName === values.server) : all;
        if (tools.length === 0) {
          ctx.print(values.server ? `${values.server} offers no tools right now. Is it connected? /mcp servers shows its state.` : 'No MCP tools are available. Add a server with /mcp, "Add a server".');
          return;
        }
        const lines = [`MCP tools (${tools.length}):`];
        let last = '';
        for (const tool of tools) {
          if (tool.serverName !== last) { lines.push(`  ${tool.serverName}`); last = tool.serverName; }
          lines.push(`    ${tool.toolName}${tool.description ? `: ${tool.description}` : ''}`);
        }
        ctx.print(lines.join('\n'));
      },
    },
    {
      id: 'block-tool', label: 'Block a tool', word: 'block',
      inputs: [SERVER, TOOL, {
        id: 'lasts', label: 'How long', help: 'For this session, or kept with the server\'s settings', kind: 'choice',
        choices: [
          { value: 'session', label: 'This session only', help: 'Ends when you close this app.', lasts: 'session' },
          { value: 'kept', label: 'Until I unblock it', help: 'Kept with the server\'s entry in its MCP config, after a restart too.', lasts: 'kept' },
        ],
        required: { default: 'session', defaultMeans: 'this session only' }, typed: { flag: '--keep', switchOn: 'kept' },
      }],
      sentence: 'Every call to {tool} on {server} will be refused {lasts}.',
      done: 'Blocked {tool} on {server} {lasts}.',
      touches: 'this-machine', lasts: { byInput: 'lasts' }, risk: 'none', undoneBy: 'unblock-tool',
      operator: { method: 'mcp.servers.tools.block', fields: { serverName: 'server', toolName: 'tool' } },
      example: { server: 'github', tool: 'create_issue', lasts: 'kept' },
      async run(values, ctx) {
        const api = mcpApiOf(ctx);
        const server = values.server!, tool = values.tool!;
        knownServer(api, server, `tool ${tool}`);
        if (values.lasts === 'kept') {
          const result = await keepToolRule(ctx, server, tool, 'block');
          return result.changed ? `Kept in ${where(result)}.` : `It was already kept in ${where(result)}.`;
        }
        if (!api.denyServerTool) refuse(`MCP tool ${tool} not changed: this runtime cannot block a single tool.`, `Refuse the whole server instead: /mcp trust ${server} blocked.`);
        try { api.denyServerTool(server, tool); } catch (error) { refuse(`MCP tool ${tool} not blocked: ${summarizeError(error)}`); }
        ctx.renderRequest();
        return undefined;
      },
    },
    {
      id: 'unblock-tool', label: 'Stop blocking a tool', word: 'unblock',
      inputs: [SERVER, { ...TOOL, help: 'Tools blocked on this server', choices: { list: MCP_BLOCKED_TOOLS, dependsOn: 'server' } }],
      sentence: '{tool} on {server} will be callable again, under {server}\'s usual trust and limits, until you change it.',
      done: 'Stopped blocking {tool} on {server}.',
      touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'block-tool',
      ownerOnly: { reason: 'it loosens what an MCP server may do', instead: 'Ask the owner to unblock it from /mcp or Settings.' },
      operator: { method: 'mcp.servers.tools.unblock', fields: { serverName: 'server', toolName: 'tool' } },
      example: { server: 'github', tool: 'create_issue' },
      async run(values, ctx) {
        const api = mcpApiOf(ctx);
        const server = knownServer(api, values.server!, `tool ${values.tool!}`);
        const tool = values.tool!;
        const rules = (server.toolRules ?? []).filter((rule) => rule.toolName === tool && rule.rule === 'deny');
        if (rules.length === 0) refuse(`${tool} on ${server.name} is not blocked; nothing changed.`, `/mcp servers shows ${server.name}'s tool rules.`);
        const removed: string[] = [];
        if (rules.some((rule) => rule.source === 'stored')) {
          const result = await keepToolRule(ctx, server.name, tool, 'unblock');
          if (result.changed) removed.push(`the block kept in ${where(result)}`);
        }
        if (rules.some((rule) => rule.source === 'session')) {
          if (!api.clearServerToolDenial) refuse(`MCP tool ${tool} not changed: this runtime cannot lift a block set for this session.`, 'A restart ends it.');
          try { if (api.clearServerToolDenial(server.name, tool)) removed.push('this session\'s block'); } catch (error) { refuse(`This session's block of ${tool} was not lifted: ${summarizeError(error)}`); }
        }
        ctx.renderRequest();
        return removed.length > 0 ? `Removed ${removed.join(' and ')}.` : undefined;
      },
    },
    {
      id: 'exempt-tool', label: 'Let a tool go beyond its server\'s limits', word: 'exempt', button: 'Let it go beyond',
      inputs: [SERVER, TOOL],
      sentence: 'Calls to {tool} on {server} will pass {server}\'s folder and site limits until you change it. A block of {tool}, a held-back server or a server set to refuse every call still refuses it.',
      done: '{tool} on {server} now goes past {server}\'s limits, until you change it.',
      touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'unexempt-tool',
      ownerOnly: { reason: 'it loosens what an MCP server may do', instead: 'Ask the owner; it is kept in the global MCP config.' },
      operator: { method: 'mcp.servers.tools.exempt', fields: { serverName: 'server', toolName: 'tool' } },
      example: { server: 'github', tool: 'get_file_contents' },
      async run(values, ctx) {
        knownServer(mcpApiOf(ctx), values.server!, `tool ${values.tool!}`);
        const result = await keepToolRule(ctx, values.server!, values.tool!, 'exempt');
        return result.changed ? `Kept in ${where(result)}.` : `It was already kept in ${where(result)}.`;
      },
    },
    {
      id: 'unexempt-tool', label: 'Make a tool follow its server\'s limits again', word: 'unexempt', button: 'Make it follow',
      inputs: [SERVER, { ...TOOL, help: 'Tools that go past this server\'s limits', choices: { list: MCP_EXEMPT_TOOLS, dependsOn: 'server' } }],
      sentence: 'Calls to {tool} on {server} will be held to {server}\'s folder and site limits again, until you change it.',
      done: '{tool} on {server} follows {server}\'s limits again.',
      touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'exempt-tool',
      operator: { method: 'mcp.servers.tools.unexempt', fields: { serverName: 'server', toolName: 'tool' } },
      example: { server: 'github', tool: 'get_file_contents' },
      async run(values, ctx) {
        const api = mcpApiOf(ctx);
        const server = knownServer(api, values.server!, `tool ${values.tool!}`);
        const kept = server.toolRules?.find((rule) => rule.source === 'stored' && rule.toolName === values.tool);
        if (kept?.rule !== 'allow') refuse(`${values.tool} on ${server.name} does not go past its limits; nothing changed.`);
        const result = await keepToolRule(ctx, server.name, values.tool!, 'unexempt');
        return `Removed from ${where(result)}.`;
      },
    },
    {
      id: 'add-server', label: 'Add a server', word: 'add',
      stepTitles: ['', 'What may it do?'],
      inputs: [
        {
          id: 'start', label: 'How it starts', help: 'How do you start it?', kind: 'choice', step: 1,
          choices: [{ value: 'command', label: 'A command on this computer' }, { value: 'url', label: 'A web address' }],
          required: { default: 'command', defaultMeans: 'a command on this computer' },
          typed: { impliedBy: { input: 'address', ifGiven: 'url', ifNot: 'command' } },
        },
        { id: 'command', label: 'Command', help: 'The program to start and its own arguments, as you would type them', kind: 'list', freeTextReason: 'the program and its arguments', required: true, typed: { tail: true }, step: 1, showWhen: { input: 'start', is: 'command' } },
        { id: 'address', label: 'Address', help: 'The https:// address the server answers at', kind: 'text', freeTextReason: 'the address the server answers at', required: true, typed: { flag: '--url' }, step: 1, showWhen: { input: 'start', is: 'url' } },
        { id: 'name', label: 'Name', help: 'A short name you choose for it', kind: 'text', freeTextReason: 'a name you choose', required: true, typed: { position: 1 }, step: 1, suggest: suggestServerName },
        { id: 'trust', label: 'Trust', help: 'What it may do without asking', kind: 'choice', choices: TRUST_MODES, required: { default: '', defaultMeans: 'ask before anything outside its limits' }, typed: { flag: '--trust' }, step: 2 },
        { id: 'role', label: 'Role', help: 'What kind of server it is', kind: 'choice', choices: ROLES, required: { default: '', defaultMeans: 'general' }, typed: { flag: '--role' }, step: 2 },
        { ...SCOPE, step: 2 },
        { id: 'path', label: 'Folders it may use', help: 'Folders, separated by commas', kind: 'path', freeTextReason: 'a folder on this machine', required: { default: '', defaultMeans: 'none besides the project' }, typed: { flag: '--path', repeats: true }, step: 2 },
        { id: 'host', label: 'Sites it may reach', help: 'Host names, separated by commas', kind: 'text', freeTextReason: 'a host name such as api.github.com', required: { default: '', defaultMeans: 'none' }, typed: { flag: '--host', repeats: true }, step: 2 },
        { id: 'env', label: 'Environment', help: 'NAME=VALUE for a command, separated by commas; hidden as you type', kind: 'secret', required: { default: '', defaultMeans: 'none' }, typed: { flag: '--env', repeats: true }, step: 2, showWhen: { input: 'start', is: 'command' } },
        { id: 'header', label: 'Request header', help: 'Name=Value for a web address (an Authorization header); hidden as you type', kind: 'secret', required: { default: '', defaultMeans: 'none' }, typed: { flag: '--header', repeats: true }, step: 2, showWhen: { input: 'start', is: 'url' } },
      ],
      sentence: '{name} will be added to the {scope} MCP config and started now, until you change it.',
      done: 'Added {name}.',
      touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'remove-server',
      // The command line splits into the program and its arguments; NAME=VALUE lines become the environment or headers.
      operator: {
        method: 'mcp.servers.upsert',
        fields: {
          scope: 'scope', 'server.name': 'name', 'server.command': 'command:first', 'server.args': 'command:rest', 'server.url': 'address',
          'server.trustMode': 'trust', 'server.role': 'role', 'server.allowedPaths': 'path:lines', 'server.allowedHosts': 'host:lines',
          'server.env': 'env:pairs', 'server.headers': 'header:pairs',
        },
      },
      example: { name: 'weather', command: 'npx\n-y\n@acme/weather-mcp' },
      async run(values, ctx) {
        const api = mcpApiOf(ctx);
        const server = serverFromValues(values);
        const scope = (values.scope || 'project') as McpConfigScope;
        try {
          const result = await api.upsertServerConfig(shellPathsOf(ctx), scope, server);
          const connected = api.listServerSecurity().find((entry) => entry.name === server.name)?.connected ?? false;
          return [
            `Kept in ${scope} MCP config ${result.path}; ${connected ? 'connected' : 'saved, but not connected yet (/mcp servers shows why)'}.`,
            `  ${describeEndpoint(server)}`,
          ].join('\n');
        } catch (error) {
          refuse(`MCP server ${server.name} was not added: ${summarizeError(error)}`);
        }
      },
    },
    {
      id: 'remove-server', label: 'Remove a server', word: 'remove',
      inputs: [SERVER, { ...SCOPE, label: 'From', help: 'Which MCP config file to remove it from' }],
      sentence: '{server}\'s entry (its command, arguments, environment and trust) will be deleted from the {scope} MCP config and its tools stop being offered.',
      done: 'Removed {server}.',
      touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
      operator: { method: 'mcp.servers.remove', fields: { serverName: 'server', scope: 'scope' } },
      example: { server: 'files', scope: 'project' },
      async run(values, ctx) {
        const scope = (values.scope || 'project') as McpConfigScope;
        let result: Awaited<ReturnType<McpApi['removeServerConfig']>>;
        try {
          result = await mcpApiOf(ctx).removeServerConfig(shellPathsOf(ctx), scope, values.server!);
        } catch (error) {
          refuse(`MCP server ${values.server} was not removed: ${summarizeError(error)}`);
        }
        if (!result.removed) refuse(`No ${scope} MCP server named ${values.server} is in ${result.path}; nothing was removed.`, 'If it still shows, it comes from another config file: /mcp files lists them.');
        return `Deleted from ${result.path}.`;
      },
    },
    {
      id: 'reload', label: 'Reconnect every server from its config', word: 'reload', inputs: [],
      sentence: 'Every MCP server is read again from its config file and reconnected.', done: '',
      touches: 'this-machine', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'mcp.servers.reload', fields: {} }, example: {},
      async run(_values, ctx) {
        const api = mcpApiOf(ctx);
        try {
          const result = await api.reload(shellPathsOf(ctx));
          ctx.renderRequest();
          const servers = api.listServerSecurity();
          ctx.print(`Reconnected MCP servers from config: ${servers.filter((server) => server.connected).length} of ${servers.length} connected (added ${result.added}, changed ${result.changed}, removed ${result.removed}, unchanged ${result.unchanged}).`);
        } catch (error) {
          refuse(`MCP reload failed: ${summarizeError(error)}`);
        }
      },
    },
    {
      id: 'set-trust', label: 'Set a server\'s trust level', word: 'trust',
      inputs: [SERVER, { id: 'mode', label: 'Trust', help: 'What it may do without asking', kind: 'choice', choices: TRUST_MODES, required: true, typed: { position: 2 } }],
      sentence: '{server} will be set to "{mode}" until you change it.',
      done: '{server} is set to "{mode}".',
      touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'restore-trust',
      operator: { method: 'mcp.servers.trust.set', fields: { serverName: 'server', trustMode: 'mode' } },
      example: { server: 'github', mode: 'constrained' },
      async run(values, ctx) {
        knownServer(mcpApiOf(ctx), values.server!, 'trust level');
        return keepServerPolicy(ctx, values.server!, { trustMode: values.mode as McpTrustMode });
      },
    },
    {
      id: 'restore-trust', label: 'Go back to the saved trust level', word: 'restore-trust', inputs: [SERVER],
      sentence: '{server} goes back to the trust level saved in its MCP config, which may allow more than the level set for this session, until you change it.',
      done: '{server} is back on its saved trust level.',
      touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection',
      ownerOnly: { reason: 'the saved level may allow more than the one set for this session', instead: 'Ask the owner to choose "Go back to the saved trust level" in /mcp.' },
      operator: { terminalOnly: 'A trust level set for this session belongs to that terminal app\'s session.' },
      example: { server: 'github' },
      async run(values, ctx) {
        knownServer(mcpApiOf(ctx), values.server!, 'trust level');
        return restoreSessionPolicy(ctx, values.server!, 'trustMode');
      },
    },
    {
      id: 'set-role', label: 'Set a server\'s role', word: 'role',
      inputs: [SERVER, { id: 'role', label: 'Role', help: 'What kind of server it is', kind: 'choice', choices: ROLES, required: true, typed: { position: 2 } }],
      sentence: '{server} will be treated as a {role} server until you change it.',
      done: '{server} is a {role} server.',
      touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'restore-role',
      operator: { method: 'mcp.servers.role.set', fields: { serverName: 'server', role: 'role' } },
      example: { server: 'github', role: 'git' },
      async run(values, ctx) {
        knownServer(mcpApiOf(ctx), values.server!, 'role');
        return keepServerPolicy(ctx, values.server!, { role: values.role as McpRole });
      },
    },
    {
      id: 'restore-role', label: 'Go back to the saved role', word: 'restore-role', inputs: [SERVER],
      sentence: '{server} goes back to the role saved in its MCP config, until you change it.',
      done: '{server} is back on its saved role.',
      touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: { terminalOnly: 'A role set for this session belongs to that terminal app\'s session.' },
      example: { server: 'github' },
      async run(values, ctx) {
        knownServer(mcpApiOf(ctx), values.server!, 'role');
        return restoreSessionPolicy(ctx, values.server!, 'role');
      },
    },
    {
      id: 'hold-back', label: 'Hold back a server\'s tools for review', word: 'quarantine',
      inputs: [SERVER, { id: 'reason', label: 'Why', help: 'A note you will see when you review it', kind: 'text', freeTextReason: 'your own words', required: { default: 'held back by you', defaultMeans: 'no note' }, typed: { tail: true } }],
      sentence: '{server}\'s tools will not be offered {lasts}, until you accept them again.',
      done: 'Held back {server}\'s tools.',
      touches: 'this-machine', lasts: 'session', risk: 'none', undoneBy: 'accept-tools',
      operator: { terminalOnly: 'Holding back tools applies to the terminal app\'s own MCP connections.' },
      example: { server: 'github', reason: 'its tools changed' },
      async run(values, ctx) {
        const api = mcpApiOf(ctx);
        knownServer(api, values.server!, 'quarantine');
        api.quarantineSchema(values.server!, 'operator_flagged', values.reason || 'held back by you');
        ctx.renderRequest();
        return `Reason: ${values.reason || 'held back by you'}.`;
      },
    },
    {
      id: 'accept-tools', label: 'Accept a server\'s changed tools', word: 'accept-tools',
      inputs: [{ ...SERVER, help: 'Servers whose tools are held back', choices: { list: MCP_QUARANTINED_SERVERS } }],
      sentence: '{server}\'s changed tools will be accepted and offered again {lasts}.',
      done: 'Accepted {server}\'s tools.',
      touches: 'this-machine', lasts: 'session', risk: 'loosens-a-protection', undoneBy: 'hold-back',
      ownerOnly: { reason: 'it offers tools that changed since they were last accepted', instead: 'Ask the owner to accept them from /mcp.' },
      operator: { method: 'mcp.servers.quarantine.accept', fields: { serverName: 'server' } },
      example: { server: 'github' },
      async run(values, ctx) {
        const api = mcpApiOf(ctx);
        const server = knownServer(api, values.server!, 'held-back tools');
        if (server.schemaFreshness !== 'quarantined') refuse(`${server.name}'s tools are not held back (${formatFreshness(server.schemaFreshness)}); nothing changed.`);
        api.approveSchemaQuarantine(server.name, 'owner');
        ctx.renderRequest();
        return 'Run /mcp reload to read its tools again.';
      },
    },
    {
      id: 'review', label: 'See which servers need attention', word: 'review', inputs: [],
      sentence: 'Shows the servers that are not connected or whose tools are held back, with what to do next.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'mcp.servers.list', fields: {} }, example: {},
      async run(_values, ctx): Promise<CommandReport> {
        const servers = mcpApiOf(ctx).listServerSecurity();
        const attention = servers.filter((server) => !server.connected || server.schemaFreshness === 'quarantined');
        if (attention.length === 0) return { verdict: 'ok', headline: servers.length === 0 ? 'No MCP servers yet.' : 'Every MCP server is working.', items: [] };
        return {
          verdict: 'attention',
          headline: `${attention.length} of ${servers.length} MCP server(s) need attention:`,
          items: attention.map((server) => ({
            sentence: server.schemaFreshness === 'quarantined'
              ? `${server.name}'s tools are held back for review${server.quarantineReason ? ` (${server.quarantineReason})` : ''}.`
              : `${server.name} is not connected${server.lastError ? `: ${server.lastError}` : '.'}`,
            fix: { label: 'See how to fix it', line: `/mcp repair ${server.name}` },
          })),
        };
      },
    },
    {
      id: 'repair', label: 'See how to fix a server', word: 'repair',
      inputs: [{ ...SERVER, required: { default: '', defaultMeans: 'the first one that needs attention' } }],
      sentence: 'Shows {server}\'s state and the steps that fix it.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'The steps name terminal commands.' }, example: { server: 'github' },
      async run(values, ctx) {
        const servers = mcpApiOf(ctx).listServerSecurity();
        const selected = values.server
          ? servers.find((server) => server.name === values.server)
          : servers.find((server) => !server.connected || server.schemaFreshness === 'quarantined');
        if (!selected) {
          if (values.server) refuse(`No MCP server named ${values.server}.`, 'Run /mcp servers to list your servers.');
          ctx.print('No MCP server needs repair.');
          return;
        }
        const steps = [
          ...(selected.schemaFreshness === 'quarantined' ? [`/mcp accept-tools ${selected.name}  (after checking what changed)`] : []),
          ...(!selected.connected ? ['fix its command or address, then /mcp reload'] : []),
          '/mcp review',
        ];
        ctx.print([
          `MCP repair: ${selected.name}`,
          `  ${serverState(selected)}; trust: ${formatTrust(selected.trustMode)}; role: ${formatRole(selected.role)}; ${formatFreshness(selected.schemaFreshness)}`,
          ...(selected.quarantineReason ? [`  held back: ${selected.quarantineReason}`] : []),
          ...(selected.quarantineDetail ? [`  detail: ${selected.quarantineDetail}`] : []),
          ...(selected.lastError ? [`  last error: ${selected.lastError}`] : []),
          '  next:',
          ...steps.map((step) => `    ${step}`),
        ].join('\n'));
      },
    },
    {
      id: 'see-config-files', label: 'See where servers are configured', word: 'files', inputs: [],
      sentence: 'Shows each MCP config file in use, whether it can be written, and which servers come from it.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'mcp.config.get', fields: {} }, example: {},
      async run(_values, ctx) {
        let effective;
        try { effective = mcpApiOf(ctx).getEffectiveConfig(shellPathsOf(ctx)); } catch (error) { refuse(`Reading the MCP config failed: ${summarizeError(error)}`); }
        ctx.print([
          'MCP config files',
          ...effective.locations.map((location) => `  ${location.scope}/${location.kind}${location.writable ? '' : ' (read-only)'}  ${location.path}`),
          `Servers (${effective.servers.length})`,
          ...effective.servers.map((entry) => `  ${entry.server.name}: ${describeEndpoint(entry.server)}  from ${entry.source.scope}/${entry.source.kind}`),
        ].join('\n'));
      },
    },
    {
      id: 'open-screen', label: 'Open the MCP screen', word: 'open', inputs: [],
      sentence: 'Opens the full-screen view of servers, tools and config files.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'It is a terminal screen.' }, example: {},
      async run(_values, ctx) {
        if (!ctx.openMcpWorkspace) refuse('This surface has no MCP screen.', '/mcp servers lists the servers.');
        ctx.openMcpWorkspace();
      },
    },
  ],
};

const MCP_SLASH_COMMAND = defineCommand(MCP_COMMAND);

/** Register `/mcp` (the one description) in a terminal app's registry. */
export function registerMcpCommand<Context extends McpCommandContext>(registry: Pick<TerminalCommandRegistry<Context>, 'register'>): void {
  registry.register(MCP_SLASH_COMMAND);
}
