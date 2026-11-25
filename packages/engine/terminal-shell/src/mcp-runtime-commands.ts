/**
 * `/mcp`, described once (command-actions/) for both terminal apps. Typed bare
 * it opens Tools and extensions, where the servers are; its actions are the
 * capabilities of capabilities/builtin/mcp.ts:
 *
 *  - what the MCP config files keep (adding and removing a server, a tool kept
 *    past its server's limits or back inside them, a kept trust level or role,
 *    where servers are configured) runs in the daemon, on this program's
 *    project; this program then reads its config again, so its own servers
 *    follow at once;
 *  - this program's own connections and its session's settings (its servers
 *    and their tools, a block, holding back and accepting changed tools, going
 *    back to the saved trust level or role, reconnecting, which servers need a
 *    look) run here.
 *
 * The live lists the inputs choose from read this program's registry.
 */
import {
  MCP_ACCEPT_TOOLS, MCP_ADD, MCP_BLOCK, MCP_BLOCKED_TOOLS_LIST, MCP_EXEMPT, MCP_EXEMPT_TOOLS_LIST, MCP_FILES, MCP_HELD_BACK_LIST, MCP_HOLD_BACK,
  MCP_RELOAD, MCP_REMOVE, MCP_REPAIR, MCP_RESTORE_ROLE, MCP_RESTORE_TRUST, MCP_REVIEW, MCP_ROLE, MCP_SERVERS, MCP_SERVERS_LIST, MCP_TOOLS,
  MCP_TOOLS_LIST, MCP_TRUST, MCP_UNBLOCK, MCP_UNEXEMPT, mcpLimitWords, mcpRoleWords, mcpServerState, mcpTrustWords,
  type CapabilityDefinition, type McpSessionServices,
} from '@goodvibes/engine/platform/platform/capabilities';
import type { McpApi } from '@goodvibes/engine/platform/platform/mcp';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import { daemonCapabilityAction, sessionCapabilityAction, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import type { ActionDescription, CommandActionContext, CommandDescription } from './command-actions/types.js';

export interface McpCommandContext extends CommandActionContext {
  readonly renderRequest: () => void;
  readonly clients?: { readonly mcpApi?: McpApi | undefined } | undefined;
  readonly workspace: { readonly shellPaths?: ShellPathService | null | undefined };
}

type McpSecurityServer = ReturnType<McpApi['listServerSecurity']>[number];

const apiOf = (ctx: McpCommandContext): McpApi | undefined => ctx.clients?.mcpApi;

// ---------------------------------------------------------------------------
// Live lists, read only when a form or a completion asks
// ---------------------------------------------------------------------------

defineList<McpCommandContext>({
  name: MCP_SERVERS_LIST,
  async read(ctx) {
    const api = apiOf(ctx);
    if (!api) throw commandRefusal('Tool servers are not available in this program.', 'Restart it; tool servers load with it.');
    const running = api.listServerSecurity().map((server): ListRow => ({
      value: server.name,
      label: server.name,
      detail: `Trust: ${mcpTrustWords(server.trustMode)}; limits: ${mcpLimitWords(server)}; role: ${mcpRoleWords(server.role)}.`,
      state: mcpServerState(server),
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

defineList<McpCommandContext>({
  name: MCP_HELD_BACK_LIST,
  async read(ctx) {
    return (apiOf(ctx)?.listServerSecurity() ?? []).filter((server) => server.schemaFreshness === 'quarantined').map((server): ListRow => ({
      value: server.name,
      label: server.name,
      detail: server.quarantineDetail ?? server.quarantineReason ?? 'Its tools changed since you last accepted them.',
      state: 'tools held back',
    }));
  },
  operator: { method: 'mcp.servers.list', input: {}, rows: { from: 'security', where: { field: 'schemaFreshness', equals: 'quarantined' }, value: 'name', label: 'name', detail: 'quarantineReason' } },
});

defineList<McpCommandContext>({
  name: MCP_TOOLS_LIST,
  async read(ctx, earlier) {
    const api = apiOf(ctx);
    if (!api) return [];
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

defineList<McpCommandContext>({
  name: MCP_BLOCKED_TOOLS_LIST,
  async read(ctx, earlier) {
    const server = apiOf(ctx)?.listServerSecurity().find((entry) => entry.name === earlier.server);
    return (server?.toolRules ?? []).filter((rule) => rule.rule === 'deny').map((rule): ListRow => ({
      value: rule.toolName,
      label: rule.toolName,
      state: rule.source === 'session' ? 'blocked for this session only' : 'blocked, kept',
    }));
  },
  // The web UI sees kept blocks; a block for this session belongs to the program that set it.
  operator: { method: 'mcp.config.get', input: {}, rows: { from: 'servers', where: { field: 'name', equals: '{server}' }, each: 'deniedTools', value: '.', label: '.' } },
});

defineList<McpCommandContext>({
  name: MCP_EXEMPT_TOOLS_LIST,
  async read(ctx, earlier) {
    const server = apiOf(ctx)?.listServerSecurity().find((entry) => entry.name === earlier.server);
    return (server?.toolRules ?? []).filter((rule) => rule.rule === 'allow').map((rule): ListRow => ({
      value: rule.toolName,
      label: rule.toolName,
      state: rule.inEffect ? 'goes past its server\'s limits' : 'past its limits, but blocked',
    }));
  },
  operator: { method: 'mcp.config.get', input: {}, rows: { from: 'servers', where: { field: 'name', equals: '{server}' }, each: 'allowedTools', value: '.', label: '.' } },
});

// ---------------------------------------------------------------------------
// This program's registry, as the capabilities take it
// ---------------------------------------------------------------------------

/** This program's own tool server connections and its project's config roots (builtin/mcp.ts `McpSessionServices`). */
export function mcpLiveServices(ctx: McpCommandContext): McpSessionServices['mcpLive'] {
  const paths = ctx.workspace.shellPaths;
  return {
    api: apiOf(ctx),
    roots: paths ? { workingDirectory: paths.workingDirectory, homeDirectory: paths.homeDirectory } : undefined,
    changed: () => ctx.renderRequest(),
  };
}

/** After the daemon wrote a config file this program reads, it reads its config again so its servers follow at once. */
async function followConfig(ctx: McpCommandContext): Promise<void> {
  const api = apiOf(ctx);
  const paths = ctx.workspace.shellPaths;
  if (!api || !paths) return;
  try { await api.reload(paths); } catch { /* The next tool server call reads it again. */ }
  ctx.renderRequest();
}

function daemonAction<Ctx extends McpCommandContext>(definition: CapabilityDefinition<never>, binding: DaemonCapabilityBinding<Ctx>, extra: Partial<ActionDescription<Ctx>> = {}): ActionDescription<Ctx> {
  const action = daemonCapabilityAction<Ctx>(definition, binding);
  return {
    ...action,
    ...extra,
    async run(values, ctx) {
      const said = await action.run(values, ctx);
      await followConfig(ctx);
      return said;
    },
  };
}

function sessionAction<Ctx extends McpCommandContext>(definition: CapabilityDefinition<McpSessionServices>): ActionDescription<Ctx> {
  return sessionCapabilityAction<Ctx, McpSessionServices>(definition, (ctx) => ({ mcpLive: mcpLiveServices(ctx) }), {
    terminalOnly: 'It acts on the tool server connections of the program holding the conversation.',
  });
}

/** The servers of this program, for the Tools and extensions place (a session source: the web UI reads the daemon's own). */
export function mcpServersPlaceSource(ctx: () => McpCommandContext | undefined): { read(): unknown; subscribe(onChange: () => void): () => void } {
  return {
    read() {
      const context = ctx();
      const api = context ? apiOf(context) : undefined;
      if (!api) return [];
      const servers = api.listServerSecurity();
      const paths = context?.workspace.shellPaths;
      const running = new Set(servers.map((server) => server.name));
      const notStarted = paths ? api.getEffectiveConfig(paths).servers.filter((entry) => !running.has(entry.server.name)) : [];
      return [
        ...servers.map((server: McpSecurityServer) => ({
          name: server.name, connected: server.connected, phase: server.phase ?? '', state: mcpServerState(server),
          trust: server.trustMode, trustWords: mcpTrustWords(server.trustMode), limitWords: mcpLimitWords(server), sessionTrust: server.sessionTrustMode !== undefined,
          role: server.role, roleWords: mcpRoleWords(server.role), sessionRole: server.sessionRole !== undefined,
          heldBack: server.schemaFreshness === 'quarantined', heldBackBecause: server.quarantineReason ?? '',
          folders: server.allowedPaths.length, sites: server.allowedHosts.length,
          rules: (server.toolRules ?? []).map((rule) => ({ tool: rule.toolName, blocked: rule.rule === 'deny', kept: rule.source !== 'session', inEffect: rule.inEffect })),
          lastError: server.connected ? '' : (server.lastError ?? server.reconnect?.stoppedReason ?? ''),
        })),
        ...notStarted.map((entry) => ({
          name: entry.server.name, connected: false, phase: 'not-started', state: 'not started yet', trust: entry.server.trustMode ?? '', trustWords: mcpTrustWords(entry.server.trustMode ?? 'ask-on-risk'),
          limitWords: mcpLimitWords({ allowedPaths: entry.server.allowedPaths ?? [], allowedHosts: entry.server.allowedHosts ?? [] }),
          sessionTrust: false, role: entry.server.role ?? 'general', roleWords: mcpRoleWords(entry.server.role ?? 'general'), sessionRole: false, heldBack: false, heldBackBecause: '',
          folders: entry.server.allowedPaths?.length ?? 0, sites: entry.server.allowedHosts?.length ?? 0, rules: [], lastError: '', from: entry.source.path,
        })),
      ];
    },
    // Each change made through this program's actions is drawn when its action ends (the place reads its lists again).
    subscribe: () => () => {},
  };
}

// ---------------------------------------------------------------------------
// The description
// ---------------------------------------------------------------------------

function describeMcp<Ctx extends McpCommandContext>(binding: DaemonCapabilityBinding<Ctx>): CommandDescription<Ctx> {
  return {
    name: 'mcp',
    // --yes confirms only right after the action word: the same word in the text is text.
    leadingFlagsOnly: true,
    title: 'MCP servers and tools',
    summary: 'Opens Tools and extensions, where your tool servers (MCP) are',
    group: 'Tools',
    // Unlisted: typed bare by a person, it opens Tools and extensions on its Servers tab (the command-level `opens`);
    // from a model or a script, bare, it is the servers report. Every action is a control in that place.
    firstScreen: false,
    opens: 'tools/servers',
    report: 'see-servers',
    actions: [
      sessionAction<Ctx>(MCP_SERVERS),
      sessionAction<Ctx>(MCP_TOOLS),
      daemonAction<Ctx>(MCP_ADD as CapabilityDefinition<never>, binding, { stepTitles: ['', 'What may it do?'] }),
      daemonAction<Ctx>(MCP_REMOVE as CapabilityDefinition<never>, binding),
      sessionAction<Ctx>(MCP_BLOCK),
      sessionAction<Ctx>(MCP_UNBLOCK),
      daemonAction<Ctx>(MCP_EXEMPT as CapabilityDefinition<never>, binding),
      daemonAction<Ctx>(MCP_UNEXEMPT as CapabilityDefinition<never>, binding),
      daemonAction<Ctx>(MCP_TRUST as CapabilityDefinition<never>, binding),
      sessionAction<Ctx>(MCP_RESTORE_TRUST),
      daemonAction<Ctx>(MCP_ROLE as CapabilityDefinition<never>, binding),
      sessionAction<Ctx>(MCP_RESTORE_ROLE),
      sessionAction<Ctx>(MCP_HOLD_BACK),
      sessionAction<Ctx>(MCP_ACCEPT_TOOLS),
      sessionAction<Ctx>(MCP_RELOAD),
      sessionAction<Ctx>(MCP_REVIEW),
      sessionAction<Ctx>(MCP_REPAIR),
      daemonAction<Ctx>(MCP_FILES as CapabilityDefinition<never>, binding),
    ],
  };
}

/**
 * Register `/mcp` (the one description) in a terminal app's registry; `binding`
 * is how this program reaches the daemon, which writes the MCP config files.
 */
export function registerMcpCommand<Context extends McpCommandContext>(registry: Pick<TerminalCommandRegistry<Context>, 'register'>, binding: DaemonCapabilityBinding<Context>): void {
  registry.register(defineCommand(describeMcp<Context>(binding)));
}
