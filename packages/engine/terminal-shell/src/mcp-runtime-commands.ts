import type { McpApi, McpConfigScope, McpReloadResult, McpServerConfig, McpStoredToolRuleResult, McpToolRule } from '@goodvibes-jev/engine/platform/platform/mcp';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { commandRefusal, stripYesFlag, type CommandConfirmationContext } from './command-confirmation.js';
import { maskLaunchArgs } from './renderer/mcp-form-rows.js';
import { quoteSlashCommandArg } from './slash-command-parser.js';
import type { TerminalCommandRegistry } from './command-registry.js';
export interface McpCommandContext extends CommandConfirmationContext {
  readonly renderRequest: () => void;
  /** The line came from the model's command runner: a loosening line (allow, clear) is refused for it. */
  readonly invokedByModel?: boolean | undefined;
  readonly openMcpWorkspace?: (() => void) | undefined;
  readonly openSettingsModal?: (() => void) | undefined;
}
export function createMcpRuntimeCommands<Context extends McpCommandContext>(
  requireMcpApi: (context: Context) => McpApi,
  requireShellPaths: (context: Context) => ShellPathService,
  policy: {
    readonly hidden: boolean;
    readonly allowAllOnAdd: boolean;
    /** Product-specific wording; the defaults are the Agent's. */
    readonly wording?: {
      /** How the product names itself in "from inside ...". */
      readonly host?: string;
      /** Whose flags a server argument can be confused with. */
      readonly flagOwner?: string;
      /** Where the user adds a server outside the command line. */
      readonly addServerPointer?: string;
      /** The command that reviews connector auth. */
      readonly authReviewCommand?: string;
      /** Describes the add/remove/reload actions in the /mcp summary. */
      readonly confirmedActions?: string;
      /** States how trust, role and quarantine commands are authorised. */
      readonly commandPolicy?: string;
    };
  },
) {
  const wording = {
    host: 'Agent',
    flagOwner: 'Agent',
    addServerPointer: 'Agent Workspace -> Tools & MCP -> Add MCP server',
    authReviewCommand: '/auth review',
    confirmedActions: 'confirmed add/remove/reload actions',
    commandPolicy: 'loosening a server\'s trust mode or approving a quarantined schema asks once before it applies.',
    ...policy.wording,
  };
  const MCP_ROLES = ['general', 'docs', 'filesystem', 'git', 'database', 'browser', 'automation', 'ops', 'remote'] as const;
  const MCP_TRUST_MODES = ['constrained', 'ask-on-risk', 'allow-all', 'blocked'] as const;
  const MCP_COMMAND_TRUST_MODES = ['constrained', 'ask-on-risk', 'blocked'] as const;
  const MCP_ADD_COMMAND_USAGE =
    '/mcp add <name> <command|https-url> ...; options: --scope project|global, --role <role>, --trust constrained|ask-on-risk|blocked, --env KEY=VALUE (command servers), --header Name=Value (url servers), --path <path>, --host <host>';
  const MCP_TRUST_COMMAND_USAGE = '/mcp trust <server> <constrained|ask-on-risk|blocked|config>';
  const MCP_ROLE_COMMAND_USAGE = '/mcp role <server> <general|docs|filesystem|git|database|browser|automation|ops|remote|config>';
  const MCP_DENY_COMMAND_USAGE = '/mcp deny <server> <tool> [--keep|config]  (this session only; --keep keeps it in the server\'s MCP config past a restart; config lifts this session\'s denial)';
  const MCP_ALLOW_COMMAND_USAGE = '/mcp allow <server> <tool>  (kept in your global MCP config; lets the tool past the server\'s path and host scope; asks once)';
  const MCP_CLEAR_COMMAND_USAGE = '/mcp clear <server> <tool>  (drops the allow or denial kept in the server\'s MCP config; asks once)';
  interface ParsedMcpAddArgs {
    readonly scope: McpConfigScope;
    readonly server: McpServerConfig;
  }
  type McpSecurityServer = ReturnType<McpApi['listServerSecurity']>[number];
  type McpDisplayTrustMode = NonNullable<McpServerConfig['trustMode']> | McpSecurityServer['trustMode'];
  type McpDisplayRole = NonNullable<McpServerConfig['role']> | McpSecurityServer['role'];
  type McpDisplayFreshness = McpSecurityServer['schemaFreshness'];
  function isMcpRole(value: string): value is NonNullable<McpServerConfig['role']> {
    return MCP_ROLES.includes(value as NonNullable<McpServerConfig['role']>);
  }
  function isMcpTrustMode(value: string): value is NonNullable<McpServerConfig['trustMode']> {
    return MCP_TRUST_MODES.includes(value as NonNullable<McpServerConfig['trustMode']>);
  }
  function isMcpCommandTrustMode(value: string): value is Exclude<NonNullable<McpServerConfig['trustMode']>, 'allow-all'> {
    return MCP_COMMAND_TRUST_MODES.includes(value as Exclude<NonNullable<McpServerConfig['trustMode']>, 'allow-all'>);
  }
  function isMcpScope(value: string): value is McpConfigScope {
    return value === 'project' || value === 'global';
  }
  function stripMcpAddYesFlag(args: readonly string[]): { readonly rest: readonly string[] } {
    const rest: string[] = [];
    let passthrough = false;
    for (const token of args) {
      if (passthrough) {
        rest.push(token);
        continue;
      }
      if (token === '--') {
        passthrough = true;
        rest.push(token);
        continue;
      }
      if (token === '--yes') continue;
      rest.push(token);
    }
    return { rest };
  }
  function formatMcpTrustMode(mode: McpDisplayTrustMode): string {
    if (mode === 'ask-on-risk') return 'allow inside scope, deny outside';
    if (mode === 'allow-all') return 'allow all actions';
    return mode.replace(/[_-]+/g, ' ');
  }
  function formatMcpFreshness(value: McpDisplayFreshness): string {
    if (value === 'quarantined') return 'needs review';
    return value.replace(/[_-]+/g, ' ');
  }
  function formatMcpRole(value: McpDisplayRole): string {
    return value.replace(/[_-]+/g, ' ');
  }
  function validateServerName(name: string): string | null {
    if (!name.trim()) return 'MCP server name is required.';
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      return 'MCP server names may contain letters, numbers, dot, underscore, and dash only.';
    }
    return null;
  }
  function readFlagValue(tokens: string[], index: number, flag: string): string {
    const value = tokens[index + 1];
    if (!value) {
      throw new Error(`Missing value after ${flag}.`);
    }
    return value;
  }
  /** Where a url server is, without the userinfo or query values a credential can ride in. */
  function displayMcpUrl(value: string): string {
    try {
      const parsed = new URL(value);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return '(url)';
    }
  }
  function describeMcpEndpoint(server: McpServerConfig): string {
    if (server.url) {
      const headerKeys = Object.keys(server.headers ?? {});
      return `url ${displayMcpUrl(server.url)}${headerKeys.length ? ` headerKeys=${headerKeys.join(',')}` : ''}`;
    }
    const envKeys = Object.keys(server.env ?? {});
    return `command ${server.command ?? ''}${server.args?.length ? ` ${maskLaunchArgs(server.args).join(' ')}` : ''}${envKeys.length ? ` envKeys=${envKeys.join(',')}` : ''}`;
  }
  function parseAddServerArgs(args: string[]): ParsedMcpAddArgs {
    const name = args[1]?.trim();
    const target = args[2]?.trim();
    if (!name || !target) {
      throw new Error(`Usage: ${MCP_ADD_COMMAND_USAGE}`);
    }
    const nameError = validateServerName(name);
    if (nameError) throw new Error(nameError);
    const url = /^https?:\/\//i.test(target) ? target : undefined;
    const serverArgs: string[] = [];
    const env: Record<string, string> = {};
    const headers: Record<string, string> = {};
    const allowedPaths: string[] = [];
    const allowedHosts: string[] = [];
    let role: McpServerConfig['role'];
    let trustMode: McpServerConfig['trustMode'];
    let scope: McpConfigScope = 'project';
    let passthrough = false;
    const tokens = args.slice(3);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (passthrough) {
        serverArgs.push(token);
        continue;
      }
      if (token === '--') {
        passthrough = true;
        continue;
      }
      if (token === '--role') {
        const value = readFlagValue(tokens, index, token);
        if (!isMcpRole(value)) throw new Error(`Invalid MCP role "${value}". Expected one of ${MCP_ROLES.join(', ')}.`);
        role = value;
        index += 1;
        continue;
      }
      if (token === '--scope') {
        const value = readFlagValue(tokens, index, token);
        if (!isMcpScope(value)) throw new Error(`Invalid MCP scope "${value}". Expected project or global.`);
        scope = value;
        index += 1;
        continue;
      }
      if (token === '--trust') {
        const value = readFlagValue(tokens, index, token);
        if (!isMcpTrustMode(value)) throw new Error(`Invalid MCP trust mode "${value}". Expected one of ${MCP_TRUST_MODES.join(', ')}.`);
        if (!policy.allowAllOnAdd && !isMcpCommandTrustMode(value)) {
          throw new Error(`Use /settings -> MCP to explicitly enable allow-all.\nUsage: ${MCP_ADD_COMMAND_USAGE}`);
        }
        trustMode = value;
        index += 1;
        continue;
      }
      if (token === '--env') {
        const value = readFlagValue(tokens, index, token);
        const eq = value.indexOf('=');
        if (eq <= 0) throw new Error('MCP env entries must use KEY=VALUE.');
        env[value.slice(0, eq)] = value.slice(eq + 1);
        index += 1;
        continue;
      }
      if (token === '--header') {
        const value = readFlagValue(tokens, index, token);
        const eq = value.indexOf('=');
        if (eq <= 0) throw new Error('MCP headers must use Name=Value, for example --header "Authorization=Bearer <token>".');
        headers[value.slice(0, eq).trim()] = value.slice(eq + 1);
        index += 1;
        continue;
      }
      if (token === '--path') {
        allowedPaths.push(readFlagValue(tokens, index, token));
        index += 1;
        continue;
      }
      if (token === '--host') {
        allowedHosts.push(readFlagValue(tokens, index, token));
        index += 1;
        continue;
      }
      serverArgs.push(token);
    }
    if (url && (serverArgs.length > 0 || Object.keys(env).length > 0)) {
      throw new Error('A url MCP server takes no launch arguments or --env; send credentials with --header Name=Value.');
    }
    if (!url && Object.keys(headers).length > 0) {
      throw new Error('--header is sent only to a url (HTTP) MCP server; this server has a command. Use --env for a command server.');
    }
    return {
      scope,
      server: {
        name,
        ...(url ? { url } : { command: target }),
        ...(serverArgs.length > 0 ? { args: serverArgs } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(role ? { role } : {}),
        ...(trustMode ? { trustMode } : {}),
        ...(allowedPaths.length > 0 ? { allowedPaths } : {}),
        ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
      },
    };
  }
  async function reloadMcpRuntime(ctx: Context): Promise<McpReloadResult> {
    const result = await requireMcpApi(ctx).reload(requireShellPaths(ctx));
    ctx.renderRequest();
    return result;
  }
  function registerMcpRuntimeCommands(registry: Pick<TerminalCommandRegistry<Context>, 'register'>): void {
    registry.register({
      name: 'mcp',
      effect: 'mixed',
      aliases: [],
      // Env values and request headers carry credentials; the input history keeps neither.
      secretArgs: { flags: ['--env', '--header'] },
      description: 'Manage MCP servers and their tools; /mcp deny lasts this session, deny --keep, allow and clear are kept in the MCP config',
      ...(policy.hidden ? { hidden: true } : {}),
      usage: '[servers|review|tools [<server>]|config|add|remove|reload|auth-review|repair [server]|trust|role|deny <server> <tool> [--keep|config]|allow <server> <tool>|clear <server> <tool>]',
      argsHint: '[servers|review|tools|config|add|remove]',
      async handler(args, ctx) {
        const print = (message: string) => ctx.print(message);
        /** A line that did not do what was asked: thrown, so the terminal and a model caller both see it refused. */
        const refuse: (message: string, next?: string) => never = (message, next) => { throw commandRefusal(message, next); };
        const mcpApi = requireMcpApi(ctx);
        const listServerSecurity = () => mcpApi.listServerSecurity();
        /** The configured or connected server a change names; an unknown name is refused before anything is asked or changed. */
        const knownServer = (name: string, change: string): McpSecurityServer | undefined => {
          const server = listServerSecurity().find((entry) => entry.name === name);
          if (!server) refuse(`No MCP server named ${name}, so its ${change} was not changed.`, 'Run /mcp servers to list configured servers.');
          return server;
        };
        /** Return a server to its configured trust mode or role and say which value applies now. */
        const clearSessionPolicy = (serverName: string, field: 'trustMode' | 'role'): void => {
          const what = field === 'trustMode' ? 'trust mode' : 'role';
          if (!mcpApi.clearServerSessionPolicy) refuse(`MCP ${what} not changed: this runtime cannot clear a session ${what}.`, 'Restart to return to the configured value.');
          let cleared: boolean;
          try {
            cleared = mcpApi.clearServerSessionPolicy(serverName, field);
          } catch (error) {
            refuse(`MCP ${what} not changed: ${summarizeError(error)}`);
          }
          const now = listServerSecurity().find((server) => server.name === serverName);
          const value = now ? (field === 'trustMode' ? formatMcpTrustMode(now.trustMode) : formatMcpRole(now.role)) : 'its configured value';
          print(cleared
            ? `${serverName} is back on its configured MCP ${what}: ${value}.`
            : `${serverName} had no MCP ${what} set for this session; it runs on its configured ${what}: ${value}.`);
        };
        /** The rule kept for a tool in the server's config, from the runtime's record; undefined when none is kept. */
        const keptRule = (serverName: string, toolName: string): 'allow' | 'deny' | undefined =>
          listServerSecurity().find((server) => server.name === serverName)?.toolRules
            ?.find((rule) => rule.source === 'stored' && rule.toolName === toolName)?.rule;
        /** Keep (or clear) one tool's rule with the server's entry in its MCP config file and say what holds now. */
        const storeToolRule = async (serverName: string, toolName: string, rule: McpToolRule): Promise<void> => {
          if (!mcpApi.storeServerToolRule) {
            refuse(`MCP tool ${toolName} not changed: this runtime cannot keep a per-tool rule.`, rule === 'deny' ? `Use /mcp deny ${serverName} ${toolName} to deny it for this session.` : undefined);
          }
          let result: McpStoredToolRuleResult;
          try {
            result = await mcpApi.storeServerToolRule(serverName, toolName, rule, requireShellPaths(ctx));
          } catch (error) {
            refuse(`MCP tool ${toolName} on ${serverName} not changed: ${summarizeError(error)}`);
          }
          ctx.renderRequest();
          const where = `${result.scope} MCP config ${result.path}`;
          const sessionDenied = listServerSecurity().find((server) => server.name === serverName)?.toolRules
            ?.some((entry) => entry.source === 'session' && entry.toolName === toolName) === true;
          const sessionNoteText = sessionDenied ? ` This session's denial of it still applies until \`/mcp deny ${serverName} ${toolName} config\`.` : '';
          if (!result.changed) {
            print(rule === 'clear'
              ? `No rule is kept for ${toolName} on ${serverName} in ${where}; nothing changed.${sessionNoteText}`
              : `${serverName} tool ${toolName} is already ${rule === 'allow' ? 'allowed' : 'denied'} in ${where}; nothing changed.${sessionNoteText}`);
            return;
          }
          if (rule === 'deny') {
            print(`Denied MCP tool ${toolName} on ${serverName}, kept in ${where}: every call to it is refused, whatever the server's trust mode and scope allow, after a restart too. \`/mcp clear ${serverName} ${toolName}\` lifts it.`);
          } else if (rule === 'allow') {
            print(`Allowed MCP tool ${toolName} on ${serverName}, kept in ${where}: calls to it pass the server's path and host scope. A blocked server, a quarantined schema or a denial of the tool still refuses it. \`/mcp clear ${serverName} ${toolName}\` removes the allow.${sessionNoteText}`);
          } else {
            print(`Cleared the rule kept for ${toolName} on ${serverName} in ${where}; its trust mode and scope decide each call again.${sessionNoteText}`);
          }
        };
        // A --yes typed out of habit is dropped and never read as a server
        // argument; only tokens after -- are passed on as typed.
        const stripped = args[0] === 'add' ? stripMcpAddYesFlag(args) : stripYesFlag(args);
        const commandArgs = [...stripped.rest];
        const subcommand = commandArgs[0];
        if (!subcommand && ctx.openMcpWorkspace) {
          ctx.openMcpWorkspace();
          return;
        }
        if (subcommand === 'review') {
          const servers = listServerSecurity();
          const authRequired = servers.filter((server) => !server.connected || server.schemaFreshness === 'quarantined');
          print(
            [
              'MCP Review',
              `  servers: ${servers.length}`,
              `  connected: ${servers.filter((server) => server.connected).length}`,
              `  auth or repair attention: ${authRequired.length}`,
              ...servers.map(
                (server) =>
                  `  ${server.name}  trust=${formatMcpTrustMode(server.trustMode)}  role=${formatMcpRole(server.role)}  status=${formatMcpFreshness(server.schemaFreshness)}  connected=${server.connected ? 'yes' : server.phase === 'restart-wait' ? 'reconnecting' : 'no'}`,
              ),
              '  next: /mcp auth-review',
              '  next: /mcp repair <server>',
            ].join('\n'),
          );
          return;
        }
        if (subcommand === 'servers') {
          const servers = listServerSecurity();
          if (servers.length === 0) {
            print(
              'No MCP servers configured.\n' +
                'Add servers to one of these locations (scanned in order):\n' +
                '  ~/.config/mcp/mcp.json               (global XDG)\n' +
                '  ~/.mcp/mcp.json                      (global dotdir)\n' +
                '  ~/.config/claude/claude_desktop_config.json  (Claude Desktop)\n' +
                '  .mcp/mcp.json                        (project-local)\n' +
                '  .goodvibes/mcp.json                  (goodvibes project)\n' +
                `\nOpen /mcp and choose Add or update server, or use ${wording.addServerPointer}.`,
            );
            return;
          }
          print(formatMcpServerList(servers));
          return;
        }
        if (subcommand === 'tools') {
          const filterServer = commandArgs[1];
          print('Fetching MCP tool list...');
          let allTools;
          try {
            allTools = await mcpApi.listAllTools();
          } catch (e) {
            refuse(`Listing MCP tools failed: ${summarizeError(e)}`);
          }
          const tools = filterServer ? allTools.filter((t) => t.serverName === filterServer) : allTools;
          if (tools.length === 0) {
            print(
              filterServer
                ? `No tools found for server "${filterServer}". Is it connected? Run /mcp to see server status.`
                : 'No MCP tools available. Configure servers in .goodvibes/mcp.json or ~/.config/mcp/mcp.json.',
            );
            return;
          }
          const lines: string[] = [`MCP Tools (${tools.length} total):`];
          let lastServer = '';
          for (const tool of tools) {
            if (tool.serverName !== lastServer) {
              lines.push(`\n  [${tool.serverName}]`);
              lastServer = tool.serverName;
            }
            lines.push(`    ${tool.toolName}${tool.description ? `: ${tool.description}` : ''}`);
          }
          print(lines.join('\n'));
          return;
        }
        if (subcommand === 'auth-review') {
          const servers = listServerSecurity();
          const needingAttention = servers.filter((server) => !server.connected || server.schemaFreshness === 'quarantined');
          print(
            needingAttention.length > 0
              ? [
                  'MCP Auth Review',
                  ...needingAttention.map(
                    (server) =>
                      `  ${server.name}  connected ${server.connected ? 'yes' : 'no'}  status ${formatMcpFreshness(server.schemaFreshness)}  trust ${formatMcpTrustMode(server.trustMode)}`,
                  ),
                  `  next: ${wording.authReviewCommand}`,
                  '  next: /mcp repair <server>',
                ].join('\n')
              : 'MCP Auth Review\n  No MCP servers currently need auth or quarantine recovery.',
          );
          return;
        }
        if (subcommand === 'repair') {
          const serverName = commandArgs[1];
          const servers = listServerSecurity();
          const selected = serverName
            ? servers.find((server) => server.name === serverName)
            : servers.find((server) => !server.connected || server.schemaFreshness === 'quarantined');
          if (!selected) {
            if (serverName) refuse(`Unknown MCP server ${serverName}.`, 'Run /mcp servers to list configured servers.');
            print('MCP Repair\n  No MCP server currently needs repair.');
            return;
          }
          const nextSteps = [
            selected.schemaFreshness === 'quarantined'
              ? `/mcp quarantine ${quoteSlashCommandArg(selected.name)} approve operator`
              : null,
            !selected.connected ? wording.authReviewCommand : null,
            '/mcp review',
            '/health review',
          ].filter((entry): entry is string => entry !== null);
          print(
            [
              `MCP Repair: ${selected.name}`,
              `  connected: ${selected.connected ? 'yes' : 'no'}`,
              `  trust: ${formatMcpTrustMode(selected.trustMode)}`,
              `  role: ${formatMcpRole(selected.role)}`,
              `  status: ${formatMcpFreshness(selected.schemaFreshness)}`,
              ...(selected.quarantineReason ? [`  quarantine: ${selected.quarantineReason}`] : []),
              ...(selected.quarantineDetail ? [`  detail: ${selected.quarantineDetail}`] : []),
              '  next:',
              ...nextSteps.map((step) => `    ${step}`),
            ].join('\n'),
          );
          return;
        }
        if (subcommand === 'trust') {
          const serverName = commandArgs[1];
          const requestedMode = commandArgs[2];
          if (serverName && requestedMode === 'config') {
            if (!knownServer(serverName, 'trust mode')) return;
            clearSessionPolicy(serverName, 'trustMode');
            return;
          }
          if (serverName && requestedMode) {
            if (!isMcpTrustMode(requestedMode)) {
              refuse(`Invalid MCP trust mode "${requestedMode}". Expected constrained, ask-on-risk, blocked, config (back to the configured mode), or allow-all.`,
                `Usage: ${MCP_TRUST_COMMAND_USAGE}. Use /settings -> MCP to explicitly enable allow-all.`);
            }
            const mode = requestedMode;
            if (mode === 'allow-all') {
              ctx.openSettingsModal?.();
              refuse(`The trust mode of ${serverName} was not changed: allow-all is not set by a command.`, `Use /settings → MCP to explicitly enable allow-all for ${serverName}.`);
            }
            if (!knownServer(serverName, 'trust mode')) return;
            try {
              mcpApi.setServerTrustMode(serverName, mode);
            } catch (error) {
              refuse(`MCP trust mode not changed: ${summarizeError(error)}`);
            }
            print(`Updated MCP trust mode for ${serverName} to ${formatMcpTrustMode(mode)} for this session only: it stays through reconnects and config reloads until \`/mcp trust ${serverName} config\` or a restart. Edit the server in /mcp to keep it after a restart.`);
            return;
          }
          refuse(`Usage: ${MCP_TRUST_COMMAND_USAGE}`, 'Use /settings -> MCP to explicitly enable allow-all.');
        }
        if (subcommand === 'role') {
          const serverName = commandArgs[1];
          const requestedRole = commandArgs[2];
          if (serverName && requestedRole === 'config') {
            if (!knownServer(serverName, 'role')) return;
            clearSessionPolicy(serverName, 'role');
            return;
          }
          if (serverName && requestedRole) {
            if (!isMcpRole(requestedRole)) {
              refuse(`Invalid MCP role "${requestedRole}". Expected one of ${MCP_ROLES.join(', ')}, or config (back to the configured role).`, `Usage: ${MCP_ROLE_COMMAND_USAGE}`);
            }
            const role = requestedRole;
            if (!knownServer(serverName, 'role')) return;
            try {
              mcpApi.setServerRole(serverName, role);
            } catch (error) {
              refuse(`MCP role not changed: ${summarizeError(error)}`);
            }
            print(`Updated MCP role for ${serverName} to ${formatMcpRole(role)} for this session only: it stays through reconnects and config reloads until \`/mcp role ${serverName} config\` or a restart. Edit the server in /mcp to keep it after a restart.`);
            return;
          }
          refuse(`Usage: ${MCP_ROLE_COMMAND_USAGE}`);
        }
        if (subcommand === 'deny') {
          const serverName = commandArgs[1];
          const toolName = commandArgs[2];
          const tail = commandArgs[3];
          if (!serverName || !toolName || (tail !== undefined && tail !== 'config' && tail !== '--keep') || commandArgs.length > 4) refuse(`Usage: ${MCP_DENY_COMMAND_USAGE}`);
          if (!knownServer(serverName, `tool ${toolName}`)) return;
          if (tail === '--keep') {
            await storeToolRule(serverName, toolName, 'deny');
            return;
          }
          if (!mcpApi.denyServerTool || !mcpApi.clearServerToolDenial) refuse(`MCP tool ${toolName} not changed: this runtime cannot deny a single tool.`, `Use /mcp trust ${serverName} blocked to refuse the whole server.`);
          if (tail === 'config') {
            let cleared: boolean;
            try {
              cleared = mcpApi.clearServerToolDenial(serverName, toolName);
            } catch (error) {
              refuse(`MCP tool ${toolName} not changed: ${summarizeError(error)}`);
            }
            const kept = keptRule(serverName, toolName);
            const after = kept === 'deny'
              ? `a denial kept in its MCP config still refuses it (/mcp clear ${serverName} ${toolName} lifts that).`
              : 'its trust mode and scope decide each call.';
            print(cleared
              ? `${serverName} tool ${toolName} is no longer denied for this session; ${after}`
              : `${serverName} tool ${toolName} was not denied this session; ${after}`);
            return;
          }
          try {
            mcpApi.denyServerTool(serverName, toolName);
          } catch (error) {
            refuse(`MCP tool ${toolName} not denied: ${summarizeError(error)}`);
          }
          print(`Denied MCP tool ${toolName} on ${serverName} for this session only: every call to it is refused, whatever the server's trust mode, scope and kept rules allow, until \`/mcp deny ${serverName} ${toolName} config\` or a restart. Add --keep to keep the denial in its MCP config past a restart.`);
          return;
        }
        if (subcommand === 'allow' || subcommand === 'clear') {
          const serverName = commandArgs[1];
          const toolName = commandArgs[2];
          if (!serverName || !toolName || commandArgs.length > 3) refuse(`Usage: ${subcommand === 'allow' ? MCP_ALLOW_COMMAND_USAGE : MCP_CLEAR_COMMAND_USAGE}`);
          // The confirmation rule refuses a model-run line before this; a surface that registers the command without it is held here too.
          if (ctx.invokedByModel === true) {
            refuse(`/mcp ${subcommand} ${serverName} ${toolName} is the owner's own act: it loosens what an MCP server may do. Nothing was changed.`, `Ask the owner to type /mcp ${subcommand} ${serverName} ${toolName}, or to set it in Settings.`);
          }
          if (!knownServer(serverName, `tool ${toolName}`)) return;
          await storeToolRule(serverName, toolName, subcommand);
          return;
        }
        if (subcommand === 'add') {
          let parsedAdd: ParsedMcpAddArgs;
          try {
            parsedAdd = parseAddServerArgs(commandArgs);
          } catch (error) {
            refuse(summarizeError(error), `Usage: ${MCP_ADD_COMMAND_USAGE}`);
          }
          const shellPaths = requireShellPaths(ctx);
          try {
            const result = await mcpApi.upsertServerConfig(shellPaths, parsedAdd.scope, parsedAdd.server);
            const connected = listServerSecurity().find((entry) => entry.name === parsedAdd.server.name)?.connected ?? false;
            print(
              [
                `MCP server "${parsedAdd.server.name}" saved`,
                `  scope ${parsedAdd.scope}`,
                `  path ${result.path}`,
                ...(parsedAdd.scope === 'global' ? ['  global config'] : []),
                `  Runtime reload: ${connected ? 'connected' : 'server saved; connection needs attention'} (+${result.reload.added} ~${result.reload.changed} -${result.reload.removed}, unchanged ${result.reload.unchanged})`,
                `  ${describeMcpEndpoint(parsedAdd.server)}`,
                '  next /mcp tools',
              ].join('\n'),
            );
          } catch (error) {
            refuse(`MCP add failed: ${summarizeError(error)}`);
          }
          return;
        }
        if (subcommand === 'remove') {
          const serverName = commandArgs[1]?.trim();
          if (!serverName) refuse('Usage: /mcp remove <server> [--scope project|global]');
          let scope: McpConfigScope = 'project';
          try {
            for (let index = 2; index < commandArgs.length; index += 1) {
              if (commandArgs[index] === '--scope') {
                const value = readFlagValue(commandArgs, index, '--scope');
                if (!isMcpScope(value)) refuse(`Invalid MCP scope "${value}". Expected project or global.`);
                scope = value;
                index += 1;
              }
            }
          } catch (error) {
            refuse(summarizeError(error));
          }
          const shellPaths = requireShellPaths(ctx);
          try {
            const result = await mcpApi.removeServerConfig(shellPaths, scope, serverName);
            print(
              result.removed
                ? `Removed MCP server "${serverName}" from ${scope} config ${result.path}. Reload +${result.reload.added} ~${result.reload.changed} -${result.reload.removed}, unchanged ${result.reload.unchanged}.`
                : `No ${scope} MCP server named "${serverName}" exists in ${result.path}.\nIf it still appears, it is coming from another config scope or external MCP config.`,
            );
          } catch (error) {
            refuse(`MCP remove failed: ${summarizeError(error)}`);
          }
          return;
        }
        if (subcommand === 'reload') {
          try {
            const result = await reloadMcpRuntime(ctx);
            const servers = listServerSecurity();
            print(
              `Reloaded MCP runtime from config. ${servers.filter((server) => server.connected).length}/${servers.length} server(s) connected. Result +${result.added} ~${result.changed} -${result.removed}, unchanged ${result.unchanged}.`,
            );
          } catch (error) {
            refuse(`MCP reload failed: ${summarizeError(error)}`);
          }
          return;
        }
        if (subcommand === 'config') {
          const shellPaths = requireShellPaths(ctx);
          try {
            const effective = mcpApi.getEffectiveConfig(shellPaths);
            print(
              [
                'MCP Config',
                '  locations',
                ...effective.locations.map(
                  (location) => `    ${location.scope}/${location.kind}${location.writable ? ' writable' : ' read-only'}  ${location.path}`,
                ),
                `  effective servers ${effective.servers.length}`,
                ...effective.servers.map((entry) => {
                  const server = entry.server;
                  return `  - ${server.name}: ${describeMcpEndpoint(server)}  origin ${entry.source.scope}/${entry.source.kind}`;
                }),
                '',
                `Add or update from inside ${wording.host} with explicit confirmation`,
                `  Open /mcp and choose Add or update server, or use ${wording.addServerPointer}.`,
                '  Use Settings -> MCP for allow-all decisions.',
                `  Use -- before server args that look like ${wording.flagOwner} flags.`,
                'Automation equivalent',
                `  ${MCP_ADD_COMMAND_USAGE}`,
              ].join('\n'),
            );
          } catch (error) {
            refuse(`MCP config read failed: ${summarizeError(error)}`);
          }
          return;
        }
        if (subcommand === 'quarantine') {
          const serverName = commandArgs[1];
          const action = commandArgs[2];
          if (!serverName) refuse('Usage: /mcp quarantine <server> [detail] | /mcp quarantine <server> approve [operatorId]');
          const target = knownServer(serverName, action === 'approve' ? 'quarantine override' : 'quarantine');
          if (!target) return;
          if (action === 'approve') {
            if (target.schemaFreshness !== 'quarantined') refuse(`MCP server ${serverName} is not quarantined (status ${formatMcpFreshness(target.schemaFreshness)}). Nothing was approved.`);
            const operatorId = commandArgs[3] || 'operator';
            mcpApi.approveSchemaQuarantine(serverName, operatorId);
            print(`Approved MCP tool-definition quarantine override for ${serverName} as ${operatorId}. Refresh is still recommended.`);
            return;
          }
          const detail = commandArgs.slice(2).join(' ') || 'quarantined by operator';
          mcpApi.quarantineSchema(serverName, 'operator_flagged', detail);
          print(`Quarantined MCP tool definitions for ${serverName}.\nReason: ${detail}`);
          return;
        }
        const servers = listServerSecurity();
        if (servers.length === 0) {
          print(
            'No MCP servers configured.\n' +
              'Add servers to one of these locations (scanned in order):\n' +
              '  ~/.config/mcp/mcp.json               (global XDG)\n' +
              '  ~/.mcp/mcp.json                      (global dotdir)\n' +
              '  ~/.config/claude/claude_desktop_config.json  (Claude Desktop)\n' +
              '  .mcp/mcp.json                        (project-local)\n' +
              '  .goodvibes/mcp.json                  (goodvibes project)\n' +
              `\nOpen /mcp and choose Add or update server, or use ${wording.addServerPointer}.\n` +
              '\nFormat: { "servers": [{ "name": "my-server", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }] }',
          );
          return;
        }
        print(formatMcpServerList(servers));
      },
    });
  }
  /** ` (this session; config: X)` beside a value the owner set for this session, else nothing. */
  function sessionNote<T extends string>(session: T | undefined, configured: T | undefined, format: (value: T) => string): string {
    if (session === undefined) return '';
    return configured === undefined ? ' (this session)' : ` (this session; config: ${format(configured)})`;
  }

  /** ` tools deny x (this session), allow y (config)` for the per-tool rules on a server, else nothing. */
  function formatToolRules(rules: McpSecurityServer['toolRules']): string {
    if (!rules?.length) return '';
    return ` tools ${rules.map((rule) => `${rule.rule} ${rule.toolName} (${rule.source === 'session' ? 'this session' : 'config'}${rule.inEffect ? '' : ', overridden by a deny'})`).join(', ')}`;
  }

  /** The bracketed state of one server and, when it is not connected, what is happening to it. */
  function formatMcpConnection(s: McpSecurityServer): { readonly label: string; readonly detail: readonly string[] } {
    if (s.connected) return { label: '[connected]   ', detail: [] };
    const detail: string[] = [];
    if (s.lastError) detail.push(`      last error: ${s.lastError}`);
    if (s.phase === 'restart-wait') {
      const reconnect = s.reconnect;
      const wait = reconnect?.nextAttemptAt !== undefined ? ` in ${Math.max(1, Math.ceil((reconnect.nextAttemptAt - Date.now()) / 1000))} s` : '';
      detail.push(reconnect
        ? `      reconnecting on its own: attempt ${reconnect.attempt} of ${reconnect.maxAttempts}${wait}`
        : '      restarting on its own');
      return { label: '[reconnecting]', detail };
    }
    if (s.phase === 'starting' || s.phase === 'negotiating') return { label: '[starting]    ', detail };
    if (s.reconnect?.stoppedReason) detail.push(`      ${s.reconnect.stoppedReason}; fix the server or its entry, then run /mcp reload`);
    return { label: '[disconnected]', detail };
  }

  function formatMcpServerList(servers: readonly McpSecurityServer[]): string {
    const connected = servers.filter((s) => s.connected);
    const recovering = servers.filter((s) => !s.connected && (s.phase === 'restart-wait' || s.phase === 'starting' || s.phase === 'negotiating'));
    const disconnected = servers.filter((s) => !s.connected && !recovering.includes(s));
    const lines: string[] = [`MCP Servers (${connected.length}/${servers.length} connected):`];
    for (const s of servers) {
      const pathScope = s.allowedPaths.length > 0 ? ` paths ${s.allowedPaths.length}` : '';
      const hostScope = s.allowedHosts.length > 0 ? ` hosts ${s.allowedHosts.length}` : '';
      const freshness = ` status ${formatMcpFreshness(s.schemaFreshness)}`;
      const quarantine = s.schemaFreshness === 'quarantined' ? ` review reason ${s.quarantineReason ?? 'unknown'}` : '';
      const connection = formatMcpConnection(s);
      lines.push(
        `  ${connection.label}  ${s.name}  trust=${formatMcpTrustMode(s.trustMode)}${sessionNote(s.sessionTrustMode, s.configuredTrustMode, formatMcpTrustMode)}  role=${formatMcpRole(s.role)}${sessionNote(s.sessionRole, s.configuredRole, formatMcpRole)}${freshness}${quarantine}${pathScope}${hostScope}${formatToolRules(s.toolRules)}`,
        ...connection.detail,
      );
    }
    if (connected.length > 0) {
      lines.push('');
      lines.push(
        `Open "/mcp" for the fullscreen MCP workspace with server status, tools, config paths, and ${wording.confirmedActions}.`,
      );
      lines.push('Use "/mcp tools" for a compact tool list, or "/mcp tools <server>" for one server.');
      lines.push(
        `Use Settings -> MCP for allow-all decisions; ${wording.commandPolicy}`,
      );
      lines.push('Use /settings -> MCP to explicitly enable allow-all for a server.');
      lines.push('Per-tool rules: /mcp deny <server> <tool> for this session (--keep keeps it in the MCP config); /mcp allow <server> <tool> and /mcp clear <server> <tool> are kept in the MCP config and ask once.');
    }
    if (recovering.length > 0) {
      lines.push('');
      lines.push(`${recovering.length} server(s) starting or reconnecting on their own; run /mcp servers again to follow them.`);
    }
    if (disconnected.length > 0) {
      lines.push('');
      lines.push(`${disconnected.length} server(s) not connected. Check the server command and args in your config, then run /mcp reload.`);
    }
    return lines.join('\n');
  }
  return { registerMcpRuntimeCommands };
}
