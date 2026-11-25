/**
 * Tool servers (MCP), the line between the daemon and the program holding the
 * conversation drawn as the trace drew it:
 *
 *  - The daemon manages what is kept in a project's MCP config files (the
 *    files every program's registry reads): adding and removing a server, a
 *    tool kept past its server's limits or back inside them, a server's kept
 *    trust level and role, and where servers are configured. It writes the
 *    caller's project's files; a program running turns there reads a changed
 *    file again before its next MCP call. For the daemon's own folder its own
 *    registry applies the change at once.
 *  - The program holding the conversation keeps its own live connections and
 *    what is set for its session: seeing its servers and their tools, a block,
 *    holding back and accepting a server's changed tools, going back to the
 *    saved trust level or role, reconnecting, and which servers need a look.
 *    A block "until I unblock it" is written by that program's registry into
 *    the same project file, as before (the block and its lifting act on both
 *    the session and the file, so they stay with the program).
 */
import type { McpConfigRoots, McpConfigScope, McpEffectiveConfig, McpServerConfig } from '../../mcp/config.js';
import type { McpApi } from '../../mcp/mcp-api.js';
import { MCP_TRUST_LEVEL_WORDS, mcpLimitWords, mcpTrustWords } from '../../mcp/trust-words.js';
import { MCP_CREDENTIALS_REFUSED } from '../../runtime/mcp/manager.js';
import { noteListChanged } from '../../runtime/list-changes.js';
import { summarizeError } from '../../utils/error-display.js';
import { CapabilityRefusal, type ActionValues, type CapabilityDefinition, type FixedChoice, type InputDescription, type ListName } from '../types.js';

type McpTrustMode = NonNullable<McpServerConfig['trustMode']>;
type McpRole = NonNullable<McpServerConfig['role']>;
type McpSecurityServer = ReturnType<McpApi['listServerSecurity']>[number];

/** A project's MCP config files, as the daemon writes them. */
export interface McpProjectConfig {
  readonly roots: McpConfigRoots;
  effective(): McpEffectiveConfig;
  /** The servers a project file names that wait for the folder's trust. */
  heldForTrust(): Promise<readonly string[]>;
  upsert(scope: McpConfigScope, server: McpServerConfig): Promise<{ readonly path: string; readonly connected?: boolean | undefined }>;
  remove(scope: McpConfigScope, name: string): Promise<{ readonly path: string; readonly removed: boolean }>;
  storeToolRule(server: string, tool: string, rule: 'exempt' | 'unexempt'): Promise<{ readonly scope: McpConfigScope; readonly path: string; readonly changed: boolean }>;
  storePolicy(server: string, policy: { readonly trustMode: McpTrustMode } | { readonly role: McpRole }): Promise<{ readonly scope: McpConfigScope; readonly path: string; readonly changed: boolean }>;
}

/** What the daemon's MCP capabilities need: the config files of the caller's project. */
export interface McpCapabilityServices {
  readonly mcp: {
    forProject(workingDirectory: string | undefined): McpProjectConfig;
  };
}

/** What this program's MCP capabilities need: its own registry and the folder its config files are read for. */
export interface McpSessionServices {
  readonly mcpLive: {
    readonly api: McpApi | undefined;
    readonly roots: McpConfigRoots | undefined;
    /** Told after a change, so this program's screens draw it. */
    changed(): void;
  };
}

/** The live lists the inputs choose from (registered in terminal-shell mcp-runtime-commands.ts). */
export const MCP_SERVERS_LIST = 'mcp.servers' as ListName;
export const MCP_HELD_BACK_LIST = 'mcp.servers.held-back' as ListName;
export const MCP_TOOLS_LIST = 'mcp.tools' as ListName;
export const MCP_BLOCKED_TOOLS_LIST = 'mcp.tools.blocked' as ListName;
export const MCP_EXEMPT_TOOLS_LIST = 'mcp.tools.exempt' as ListName;

export const MCP_ROLES: readonly FixedChoice[] = [
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
/** What each kept level does with a call (mcp/trust-words.ts, which reads the runtime's decision). */
export const MCP_TRUST_MODES: readonly FixedChoice[] = MCP_TRUST_LEVEL_WORDS.map((level) => ({
  value: level.value, label: level.label, help: level.help, ...(level.loosens ? { risk: 'loosens-a-protection' as const } : {}),
}));
const SCOPES: readonly FixedChoice[] = [
  { value: 'project', label: 'This project', help: 'Kept in this project\'s .goodvibes/mcp.json; it starts once this folder is trusted.' },
  { value: 'global', label: 'All your projects', help: 'Kept in ~/.config/mcp/mcp.json.' },
];

const SERVER: InputDescription = {
  id: 'server', label: 'Server', help: 'The tool servers (MCP) you have', kind: 'choice', choices: { list: MCP_SERVERS_LIST }, required: true, typed: { position: 1 },
};
const TOOL: InputDescription = {
  id: 'tool', label: 'Tool', help: 'Tools this server offers right now', kind: 'choice',
  choices: { list: MCP_TOOLS_LIST, dependsOn: 'server', allowOther: { reason: 'a tool the server has not listed (it is not connected now)' } },
  required: true, typed: { position: 2 },
};
const SCOPE: InputDescription = {
  id: 'scope', label: 'Kept for', help: 'Which MCP config file keeps it', kind: 'choice', choices: SCOPES,
  required: { default: 'project', defaultMeans: 'this project only' }, typed: { flag: '--scope' },
};

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export { mcpLimitWords, mcpTrustWords };
/** Why a server's tools are held back, in words (the runtime's quarantine reasons). */
const HELD_BACK_REASON_WORDS: Readonly<Record<string, string>> = {
  operator_flagged: 'you held them back', stale_threshold: 'its tool list could not be read again for too long', unsupported: 'its tool list is in a form this version does not take',
};
const freshnessWords = (value: McpSecurityServer['schemaFreshness']): string => value === 'quarantined' ? 'tools held back for review' : value.replace(/[_-]+/g, ' ');
export const mcpRoleWords = (value: string): string => value.replace(/[_-]+/g, ' ');

/** A server's state in a few words: connected or not, held back, blocked tools. */
export function mcpServerState(server: McpSecurityServer): string {
  const parts = [server.connected ? 'connected' : server.phase === 'restart-wait' ? 'reconnecting' : 'not connected'];
  if (server.schemaFreshness === 'quarantined') parts.push('tools held back');
  const blocked = server.toolRules?.filter((rule) => rule.rule === 'deny').length ?? 0;
  if (blocked > 0) parts.push(`${blocked} blocked`);
  return parts.join(', ');
}

const REDACTED = '***';
const CREDENTIAL_NAME = /token|secret|key|passw|auth|credential|bearer|cookie|session/i;
/** A launch line or address with its secrets hidden: credential-looking flags and every query value. */
function shownEndpoint(server: McpServerConfig): string {
  if (server.url) {
    let shown = '(url)';
    try { const parsed = new URL(server.url); shown = `${parsed.origin}${parsed.pathname}`; } catch { /* shown as (url) */ }
    const headerKeys = Object.keys(server.headers ?? {});
    return `url ${shown}${headerKeys.length ? ` headerKeys=${headerKeys.join(',')}` : ''}`;
  }
  const args: string[] = [];
  let hideNext = false;
  for (const arg of server.args ?? []) {
    if (hideNext) { args.push(REDACTED); hideNext = false; continue; }
    const flag = /^(-{1,2}[^=\s]+)(=(.*))?$/s.exec(arg);
    if (flag && CREDENTIAL_NAME.test(flag[1]!)) {
      if (flag[2] !== undefined) args.push(`${flag[1]}=${REDACTED}`);
      else { args.push(arg); hideNext = true; }
      continue;
    }
    args.push(arg.replace(/([?&][^=&#]*=)[^&#]*/g, `$1${REDACTED}`));
  }
  const envKeys = Object.keys(server.env ?? {});
  return `command ${server.command ?? ''}${args.length ? ` ${args.join(' ')}` : ''}${envKeys.length ? ` envKeys=${envKeys.join(',')}` : ''}`;
}

function refuse(message: string, next?: string): never {
  throw new CapabilityRefusal(message, next);
}

// ---------------------------------------------------------------------------
// The daemon's: what is kept in the config files
// ---------------------------------------------------------------------------

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
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) refuse('Tool server names may contain letters, numbers, dot, underscore and dash only.');
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

/** A configured server by name, refused when no config file names it. */
function configured(config: McpProjectConfig, name: string, change: string): McpEffectiveConfig['servers'][number] {
  const entry = config.effective().servers.find((candidate) => candidate.server.name === name);
  if (!entry) refuse(`No tool server named ${name} is configured here, so its ${change} was not changed.`, 'The Servers list shows the servers you have.');
  return entry;
}

const changed = (): void => noteListChanged({ list: 'tools', change: 'changed' });

export const MCP_ADD: CapabilityDefinition<McpCapabilityServices> = {
  capability: { id: 'mcp.add', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'add-server', label: 'Add a server', word: 'add',
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
    { id: 'trust', label: 'Trust', help: 'What happens to a call outside its limits', kind: 'choice', choices: MCP_TRUST_MODES, required: { default: '', defaultMeans: 'ask me about calls outside its limits' }, typed: { flag: '--trust' }, step: 2 },
    { id: 'role', label: 'Role', help: 'What kind of server it is', kind: 'choice', choices: MCP_ROLES, required: { default: '', defaultMeans: 'general' }, typed: { flag: '--role' }, step: 2 },
    { ...SCOPE, step: 2 },
    { id: 'path', label: 'Folders it may use', help: 'Folders, separated by commas', kind: 'path', freeTextReason: 'a folder on this machine', required: { default: '', defaultMeans: 'no folder limit: the folders it is called with are not checked' }, typed: { flag: '--path', repeats: true }, step: 2 },
    { id: 'host', label: 'Sites it may reach', help: 'Host names, separated by commas', kind: 'text', freeTextReason: 'a host name such as api.github.com', required: { default: '', defaultMeans: 'no site limit: the addresses it is called with are not checked' }, typed: { flag: '--host', repeats: true }, step: 2 },
    { id: 'env', label: 'Environment', help: 'NAME=VALUE for a command, separated by commas; hidden as you type', kind: 'secret', required: { default: '', defaultMeans: 'none' }, typed: { flag: '--env', repeats: true }, step: 2, showWhen: { input: 'start', is: 'command' } },
    { id: 'header', label: 'Request header', help: 'Name=Value for a web address (an Authorization header); hidden as you type', kind: 'secret', required: { default: '', defaultMeans: 'none' }, typed: { flag: '--header', repeats: true }, step: 2, showWhen: { input: 'start', is: 'url' } },
  ],
  sentence: '{name} will be added to the {scope} MCP config and started, until you change it.',
  done: 'Added {name}.',
  // Adding a server installs a program that each program starts by itself (a command on this computer, or an address
  // its tools are fetched from): it loosens a protection, asked of the owner and opening on No.
  touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'remove-server',
  example: { name: 'weather', command: 'npx\n-y\n@acme/weather-mcp' },
  async run(values, services, caller) {
    const config = services.mcp.forProject(caller.workingDirectory);
    const server = serverFromValues(values);
    const scope = (values.scope || 'project') as McpConfigScope;
    let result;
    try {
      result = await config.upsert(scope, server);
    } catch (error) {
      refuse(`Tool server ${server.name} was not added: ${summarizeError(error)}`);
    }
    changed();
    return {
      text: [`Kept in ${scope} MCP config ${result.path}; ${result.connected === true ? 'connected' : 'each program starts it when it is first used'}.`, `Starts with: ${shownEndpoint(server)}.`].join('\n'),
      data: { server: server.name, scope, path: result.path },
    };
  },
};

export const MCP_REMOVE: CapabilityDefinition<McpCapabilityServices> = {
  capability: { id: 'mcp.remove', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'remove-server', label: 'Remove a server', word: 'remove',
  inputs: [SERVER, { ...SCOPE, label: 'From', help: 'Which MCP config file to remove it from' }],
  sentence: '{server}\'s entry (its command, arguments, environment and trust) will be deleted from the {scope} MCP config and its tools stop being offered.',
  done: 'Removed {server}.',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
  example: { server: 'files', scope: 'project' },
  async run(values, services, caller) {
    const config = services.mcp.forProject(caller.workingDirectory);
    const scope = (values.scope || 'project') as McpConfigScope;
    let result;
    try {
      result = await config.remove(scope, values.server!);
    } catch (error) {
      refuse(`Tool server ${values.server} was not removed: ${summarizeError(error)}`);
    }
    if (!result.removed) refuse(`No ${scope} tool server named ${values.server} is in ${result.path}; nothing was removed.`, 'If it still shows, it comes from another config file: "See where servers are configured" lists them.');
    changed();
    return { text: `Deleted from ${result.path}.`, data: { server: values.server, scope, path: result.path } };
  },
};

function exemption(exempt: boolean): CapabilityDefinition<McpCapabilityServices> {
  return {
    capability: { id: exempt ? 'mcp.exempt' : 'mcp.unexempt', group: 'tools', home: 'daemon', repeat: 'safe' },
    actionId: exempt ? 'exempt-tool' : 'unexempt-tool',
    label: exempt ? 'Let a tool go beyond its server\'s limits' : 'Make a tool follow its server\'s limits again',
    word: exempt ? 'exempt' : 'unexempt',
    button: exempt ? 'Let it go beyond' : 'Make it follow',
    inputs: exempt ? [SERVER, TOOL] : [SERVER, { ...TOOL, help: 'Tools that go past this server\'s limits', choices: { list: MCP_EXEMPT_TOOLS_LIST, dependsOn: 'server' } }],
    sentence: exempt
      ? 'Calls to {tool} on {server} will pass {server}\'s folder and site limits until you change it. A block of {tool}, a held-back server or a server set to refuse every call still refuses it.'
      : 'Calls to {tool} on {server} will be held to {server}\'s folder and site limits again, until you change it.',
    done: exempt ? '{tool} on {server} now goes past {server}\'s limits, until you change it.' : '{tool} on {server} follows {server}\'s limits again.',
    touches: 'this-machine', lasts: 'kept', risk: exempt ? 'loosens-a-protection' : 'none', undoneBy: exempt ? 'unexempt-tool' : 'exempt-tool',
    ...(exempt ? { ownerOnly: { reason: 'it loosens what a tool server may do', instead: 'Ask the owner; it is kept in the global MCP config.' } } : {}),
    example: { server: 'github', tool: 'get_file_contents' },
    async run(values, services, caller) {
      const config = services.mcp.forProject(caller.workingDirectory);
      const entry = configured(config, values.server!, `tool ${values.tool}`);
      if (!exempt && !(entry.server.allowedTools ?? []).includes(values.tool!)) refuse(`${values.tool} on ${values.server} does not go past its limits; nothing changed.`);
      let result;
      try {
        result = await config.storeToolRule(values.server!, values.tool!, exempt ? 'exempt' : 'unexempt');
      } catch (error) {
        refuse(`Tool ${values.tool} on ${values.server} not changed: ${summarizeError(error)}`);
      }
      changed();
      const where = `${result.scope} MCP config ${result.path}`;
      return { text: exempt ? (result.changed ? `Kept in ${where}.` : `It was already kept in ${where}.`) : `Removed from ${where}.`, data: { server: values.server, tool: values.tool, ...result } };
    },
  };
}
export const MCP_EXEMPT = exemption(true);
export const MCP_UNEXEMPT = exemption(false);

function policy(field: 'trust' | 'role'): CapabilityDefinition<McpCapabilityServices> {
  const trust = field === 'trust';
  return {
    capability: { id: trust ? 'mcp.trust' : 'mcp.role', group: 'tools', home: 'daemon', repeat: 'safe' },
    actionId: trust ? 'set-trust' : 'set-role', label: trust ? 'Set a server\'s trust level' : 'Set a server\'s role', word: trust ? 'trust' : 'role',
    inputs: [SERVER, trust
      ? { id: 'mode', label: 'Trust', help: 'What happens to a call outside its limits', kind: 'choice', choices: MCP_TRUST_MODES, required: true, typed: { position: 2 } }
      : { id: 'role', label: 'Role', help: 'What kind of server it is', kind: 'choice', choices: MCP_ROLES, required: true, typed: { position: 2 } }],
    // The trust level in words in the answer (the value itself, "ask-on-risk", is the setting's, not a person's).
    sentence: trust ? 'The trust level chosen is kept for {server} until you change it.' : '{server} will be treated as a {role} server until you change it.',
    done: trust ? '' : '{server} is a {role} server.',
    touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: trust ? 'restore-trust' : 'restore-role',
    example: trust ? { server: 'github', mode: 'constrained' } : { server: 'github', role: 'git' },
    async run(values, services, caller) {
      const config = services.mcp.forProject(caller.workingDirectory);
      configured(config, values.server!, trust ? 'trust level' : 'role');
      let result;
      try {
        result = await config.storePolicy(values.server!, trust ? { trustMode: values.mode as McpTrustMode } : { role: values.role as McpRole });
      } catch (error) {
        refuse(`The ${trust ? 'trust level' : 'role'} of ${values.server} was not kept: ${summarizeError(error)}`);
      }
      changed();
      const where = `${result.scope} MCP config ${result.path}`;
      return {
        text: [...(trust ? [`${values.server} now ${mcpTrustWords(values.mode as McpTrustMode)}.`] : []),
          result.changed ? `Kept in ${where}; it applies now and after a restart.` : `It was already kept in ${where}.`].join('\n'),
        data: { server: values.server, ...(trust ? { trustMode: values.mode } : { role: values.role }), ...result },
      };
    },
  };
}
export const MCP_TRUST = policy('trust');
export const MCP_ROLE = policy('role');

export const MCP_FILES: CapabilityDefinition<McpCapabilityServices> = {
  capability: { id: 'mcp.files', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'see-config-files', label: 'See where servers are configured', word: 'files', inputs: [],
  sentence: 'Shows each MCP config file in use, whether it can be written, and which servers come from it.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) {
    const config = services.mcp.forProject(caller.workingDirectory);
    let effective: McpEffectiveConfig;
    try { effective = config.effective(); } catch (error) { refuse(`Reading the MCP config failed: ${summarizeError(error)}`); }
    const held = new Set(await config.heldForTrust().catch(() => [] as readonly string[]));
    const servers = effective.servers.map((entry) => ({
      name: entry.server.name, endpoint: shownEndpoint(entry.server), scope: entry.source.scope, kind: entry.source.kind, path: entry.source.path,
      writable: entry.source.writable, trustMode: entry.server.trustMode ?? null, role: entry.server.role ?? null,
      blocked: [...(entry.server.deniedTools ?? [])], exempt: [...(entry.server.allowedTools ?? [])], waitsForTrust: held.has(entry.server.name),
    }));
    return {
      text: [
        'MCP config files',
        ...effective.locations.map((location) => `  ${location.scope}/${location.kind}${location.writable ? '' : ' (read-only)'}  ${location.path}`),
        `Servers (${servers.length})`,
        ...servers.map((server) => `  ${server.name}: ${server.endpoint}  from ${server.scope}/${server.kind}${server.waitsForTrust ? ' (waits until this folder is trusted)' : ''}`),
      ].join('\n'),
      data: { locations: effective.locations.map((location) => ({ ...location })), servers },
    };
  },
};

// ---------------------------------------------------------------------------
// This program's: its live connections and what is set for its session
// ---------------------------------------------------------------------------

function liveOf(services: McpSessionServices): McpApi {
  const api = services.mcpLive.api;
  if (!api) refuse('Tool servers are not available in this program.', 'Restart it; tool servers load with it.');
  return api;
}
function rootsOf(services: McpSessionServices): McpConfigRoots {
  const roots = services.mcpLive.roots;
  if (!roots) refuse('The MCP config files cannot be found: this program has no working folder.');
  return roots;
}
function knownServer(api: McpApi, name: string, change: string): McpSecurityServer {
  const server = api.listServerSecurity().find((entry) => entry.name === name);
  if (!server) refuse(`No tool server named ${name} is running here, so its ${change} was not changed.`, 'The Servers list shows your servers.');
  return server;
}

const NO_SERVERS = [
  'No tool servers (MCP) are configured. Servers are read from (in order):',
  '  ~/.config/mcp/mcp.json               (global)',
  '  ~/.mcp/mcp.json                      (global dotdir)',
  '  ~/.config/claude/claude_desktop_config.json  (Claude Desktop)',
  '  .mcp/mcp.json                        (project)',
  '  .goodvibes/mcp.json                  (this program, project)',
  'Add one with "Add a server".',
].join('\n');

/** One server as a screen and a script read it. */
function serverFacts(server: McpSecurityServer) {
  return {
    name: server.name, connected: server.connected, state: mcpServerState(server), trustMode: server.trustMode, role: server.role,
    sessionTrust: server.sessionTrustMode !== undefined, sessionRole: server.sessionRole !== undefined,
    heldBack: server.schemaFreshness === 'quarantined', ...(server.quarantineReason ? { heldBackBecause: server.quarantineReason } : {}),
    folders: server.allowedPaths.length, sites: server.allowedHosts.length,
    rules: (server.toolRules ?? []).map((rule) => ({ tool: rule.toolName, rule: rule.rule === 'deny' ? 'blocked' : 'past its limits', kept: rule.source !== 'session', inEffect: rule.inEffect })),
    ...(!server.connected && server.lastError ? { lastError: server.lastError } : {}),
    ...(!server.connected && server.reconnect?.stoppedReason ? { stoppedReason: server.reconnect.stoppedReason } : {}),
  };
}

export const MCP_SERVERS: CapabilityDefinition<McpSessionServices> = {
  capability: { id: 'mcp.servers', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'see-servers', label: 'See your servers', word: 'servers', inputs: [],
  sentence: 'Shows every tool server (MCP), whether it is connected, its trust level, role and tool rules.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const api = liveOf(services);
    const servers = api.listServerSecurity();
    const roots = services.mcpLive.roots;
    const running = new Set(servers.map((server) => server.name));
    const notStarted = roots ? api.getEffectiveConfig(roots).servers.map((entry) => entry.server.name).filter((name) => !running.has(name)) : [];
    const data = { servers: servers.map(serverFacts), notStarted };
    if (servers.length === 0 && notStarted.length === 0) return { text: NO_SERVERS, data };
    const connected = servers.filter((server) => server.connected).length;
    const lines = [`Tool servers (${connected} of ${servers.length} connected):`];
    for (const server of servers) {
      const session = server.sessionTrustMode !== undefined ? ' (this session)' : '';
      const rules = server.toolRules?.length
        ? `; ${server.toolRules.map((rule) => `${rule.rule === 'deny' ? 'blocked' : 'past its limits'} ${rule.toolName} (${rule.source === 'session' ? 'this session' : 'kept'}${rule.inEffect ? '' : ', a block wins'})`).join(', ')}`
        : '';
      lines.push(`  ${server.name}: ${mcpServerState(server)}; trust: ${mcpTrustWords(server.trustMode)}${session}; role: ${mcpRoleWords(server.role)}${server.sessionRole !== undefined ? ' (this session)' : ''}; limits: ${mcpLimitWords(server)}${rules}`);
      if (!server.connected && server.lastError) lines.push(`      last error: ${server.lastError}`);
      if (!server.connected && server.reconnect?.stoppedReason) {
        lines.push(server.reconnect.stoppedReason === MCP_CREDENTIALS_REFUSED
          ? `      ${server.reconnect.stoppedReason}`
          : `      ${server.reconnect.stoppedReason}; fix the server or its entry, then reconnect`);
      }
    }
    for (const name of notStarted) lines.push(`  ${name}: not started yet (it starts when first used)`);
    return { text: lines.join('\n'), data };
  },
};

export const MCP_TOOLS: CapabilityDefinition<McpSessionServices> = {
  capability: { id: 'mcp.tools', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'see-tools', label: 'See a server\'s tools', word: 'tools',
  inputs: [{ ...SERVER, required: { default: '', defaultMeans: 'every server' } }],
  sentence: 'Lists the tools {server} offers right now.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { server: 'github' },
  async run(values, services) {
    let all;
    try { all = await liveOf(services).listAllTools(); } catch (error) { refuse(`Listing tool server tools failed: ${summarizeError(error)}`); }
    const tools = values.server ? all.filter((tool) => tool.serverName === values.server) : all;
    const data = { tools: tools.map((tool) => ({ server: tool.serverName, tool: tool.toolName, description: tool.description ?? '' })) };
    if (tools.length === 0) return { text: values.server ? `${values.server} offers no tools right now. Is it connected? The Servers list shows its state.` : 'No tool server tools are available. Add a server with "Add a server".', data };
    const lines = [values.server ? `${values.server} offers ${tools.length} tool${tools.length === 1 ? '' : 's'}:` : `Your tool servers offer ${tools.length} tool${tools.length === 1 ? '' : 's'}:`];
    let last = '';
    for (const tool of tools) {
      // A heading per server only when more than one is listed.
      if (!values.server && tool.serverName !== last) { lines.push(`${tool.serverName}:`); last = tool.serverName; }
      lines.push(`${tool.toolName}${tool.description ? `: ${tool.description}` : ''}`);
    }
    return { text: lines.join('\n'), data };
  },
};

export const MCP_BLOCK: CapabilityDefinition<McpSessionServices> = {
  capability: { id: 'mcp.block', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'block-tool', label: 'Block a tool', word: 'block',
  inputs: [SERVER, TOOL, {
    id: 'lasts', label: 'How long', help: 'For this session, or kept with the server\'s settings', kind: 'choice',
    choices: [
      { value: 'session', label: 'This session only', help: 'Ends when you close this program.', lasts: 'session' },
      { value: 'kept', label: 'Until I unblock it', help: 'Kept with the server\'s entry in its MCP config, after a restart too.', lasts: 'kept' },
    ],
    required: { default: 'session', defaultMeans: 'this session only' }, typed: { flag: '--keep', switchOn: 'kept' },
  }],
  sentence: 'Every call to {tool} on {server} will be refused {lasts}.',
  done: 'Blocked {tool} on {server} {lasts}.',
  touches: 'this-machine', lasts: { byInput: 'lasts' }, risk: 'none', undoneBy: 'unblock-tool',
  example: { server: 'github', tool: 'create_issue', lasts: 'kept' },
  async run(values, services) {
    const api = liveOf(services);
    const server = values.server!, tool = values.tool!;
    knownServer(api, server, `tool ${tool}`);
    if (values.lasts === 'kept') {
      if (!api.storeServerToolRule) refuse(`Tool ${tool} not changed: this program cannot keep a per-tool rule.`, 'Block it for this session only.');
      let result;
      try { result = await api.storeServerToolRule(server, tool, 'block', rootsOf(services)); } catch (error) { refuse(`Tool ${tool} on ${server} not changed: ${summarizeError(error)}`); }
      services.mcpLive.changed();
      const where = `${result.scope} MCP config ${result.path}`;
      return { text: result.changed ? `Kept in ${where}.` : `It was already kept in ${where}.`, data: { server, tool, kept: true } };
    }
    if (!api.denyServerTool) refuse(`Tool ${tool} not changed: this program cannot block a single tool.`, `Set ${server} to refuse every call instead.`);
    try { api.denyServerTool(server, tool); } catch (error) { refuse(`Tool ${tool} not blocked: ${summarizeError(error)}`); }
    services.mcpLive.changed();
    return { text: '', data: { server, tool, kept: false } };
  },
};

export const MCP_UNBLOCK: CapabilityDefinition<McpSessionServices> = {
  capability: { id: 'mcp.unblock', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'unblock-tool', label: 'Stop blocking a tool', word: 'unblock',
  inputs: [SERVER, { ...TOOL, help: 'Tools blocked on this server', choices: { list: MCP_BLOCKED_TOOLS_LIST, dependsOn: 'server' } }],
  sentence: '{tool} on {server} will be callable again, under {server}\'s usual trust and limits, until you change it.',
  done: 'Stopped blocking {tool} on {server}.',
  touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'block-tool',
  ownerOnly: { reason: 'it loosens what a tool server may do', instead: 'Ask the owner to unblock it in Tools and extensions.' },
  example: { server: 'github', tool: 'create_issue' },
  async run(values, services) {
    const api = liveOf(services);
    const server = knownServer(api, values.server!, `tool ${values.tool!}`);
    const tool = values.tool!;
    const rules = (server.toolRules ?? []).filter((rule) => rule.toolName === tool && rule.rule === 'deny');
    if (rules.length === 0) refuse(`${tool} on ${server.name} is not blocked; nothing changed.`, `The Servers list shows ${server.name}'s tool rules.`);
    const removed: string[] = [];
    if (rules.some((rule) => rule.source === 'stored')) {
      if (!api.storeServerToolRule) refuse(`Tool ${tool} not changed: this program cannot change a kept per-tool rule.`);
      let result;
      try { result = await api.storeServerToolRule(server.name, tool, 'unblock', rootsOf(services)); } catch (error) { refuse(`Tool ${tool} on ${server.name} not changed: ${summarizeError(error)}`); }
      if (result.changed) removed.push(`the block kept in ${result.scope} MCP config ${result.path}`);
    }
    if (rules.some((rule) => rule.source === 'session')) {
      if (!api.clearServerToolDenial) refuse(`Tool ${tool} not changed: this program cannot lift a block set for this session.`, 'A restart ends it.');
      try { if (api.clearServerToolDenial(server.name, tool)) removed.push('this session\'s block'); } catch (error) { refuse(`This session's block of ${tool} was not lifted: ${summarizeError(error)}`); }
    }
    services.mcpLive.changed();
    return { text: removed.length > 0 ? `Removed ${removed.join(' and ')}.` : '', data: { server: server.name, tool } };
  },
};

export const MCP_RELOAD: CapabilityDefinition<McpSessionServices> = {
  capability: { id: 'mcp.reload', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'reload', label: 'Reconnect every server from its config', word: 'reload', inputs: [],
  sentence: 'Every tool server of this program is read again from its config file and reconnected.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const api = liveOf(services);
    let result;
    try { result = await api.reload(rootsOf(services)); } catch (error) { refuse(`Reconnecting failed: ${summarizeError(error)}`); }
    services.mcpLive.changed();
    const servers = api.listServerSecurity();
    return {
      text: `Reconnected tool servers from config: ${servers.filter((server) => server.connected).length} of ${servers.length} connected (added ${result.added}, changed ${result.changed}, removed ${result.removed}, unchanged ${result.unchanged}).`,
      data: { added: result.added, changed: result.changed, removed: result.removed, unchanged: result.unchanged, connected: servers.filter((server) => server.connected).length, servers: servers.length },
    };
  },
};

function restore(field: 'trustMode' | 'role'): CapabilityDefinition<McpSessionServices> {
  const trust = field === 'trustMode';
  const what = trust ? 'trust level' : 'role';
  return {
    capability: { id: trust ? 'mcp.restore-trust' : 'mcp.restore-role', group: 'tools', home: 'session', repeat: 'safe' },
    actionId: trust ? 'restore-trust' : 'restore-role', label: trust ? 'Go back to the saved trust level' : 'Go back to the saved role', word: trust ? 'restore-trust' : 'restore-role',
    inputs: [SERVER],
    sentence: trust
      ? '{server} goes back to the trust level saved in its MCP config, which may allow more than the level set for this session, until you change it.'
      : '{server} goes back to the role saved in its MCP config, until you change it.',
    done: trust ? '{server} is back on its saved trust level.' : '{server} is back on its saved role.',
    touches: 'this-machine', lasts: 'kept', risk: trust ? 'loosens-a-protection' : 'none',
    ...(trust ? { ownerOnly: { reason: 'the saved level may allow more than the one set for this session', instead: 'Ask the owner to choose "Go back to the saved trust level" in Tools and extensions.' } } : {}),
    example: { server: 'github' },
    async run(values, services) {
      const api = liveOf(services);
      knownServer(api, values.server!, what);
      if (!api.clearServerSessionPolicy) refuse(`The ${what} was not changed: this program cannot end a value set for this session.`, 'A restart returns it to the saved value.');
      let cleared: boolean;
      try { cleared = api.clearServerSessionPolicy(values.server!, field); } catch (error) { refuse(`The ${what} was not changed: ${summarizeError(error)}`); }
      services.mcpLive.changed();
      const now = api.listServerSecurity().find((entry) => entry.name === values.server);
      const value = now ? (trust ? mcpTrustWords(now.trustMode) : mcpRoleWords(now.role)) : 'its saved value';
      return { text: cleared ? `Its saved ${what} applies: ${value}.` : `It had no ${what} set for this session; its saved ${what} applies: ${value}.`, data: { server: values.server, cleared } };
    },
  };
}
export const MCP_RESTORE_TRUST = restore('trustMode');
export const MCP_RESTORE_ROLE = restore('role');

export const MCP_HOLD_BACK: CapabilityDefinition<McpSessionServices> = {
  capability: { id: 'mcp.quarantine', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'hold-back', label: 'Hold back a server\'s tools for review', word: 'quarantine',
  inputs: [SERVER, { id: 'reason', label: 'Why', help: 'A note you will see when you review it', kind: 'text', freeTextReason: 'your own words', required: { default: 'held back by you', defaultMeans: 'no note' }, typed: { tail: true } }],
  sentence: '{server}\'s tools will not be offered {lasts}, until you accept them again.',
  done: 'Held back {server}\'s tools.',
  touches: 'this-machine', lasts: 'session', risk: 'none', undoneBy: 'accept-tools',
  example: { server: 'github', reason: 'its tools changed' },
  async run(values, services) {
    const api = liveOf(services);
    knownServer(api, values.server!, 'held-back tools');
    api.quarantineSchema(values.server!, 'operator_flagged', values.reason || 'held back by you');
    services.mcpLive.changed();
    return { text: `Reason: ${values.reason || 'held back by you'}.`, data: { server: values.server } };
  },
};

export const MCP_ACCEPT_TOOLS: CapabilityDefinition<McpSessionServices> = {
  capability: { id: 'mcp.accept-tools', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'accept-tools', label: 'Accept a server\'s changed tools', word: 'accept-tools',
  inputs: [{ ...SERVER, help: 'Servers whose tools are held back', choices: { list: MCP_HELD_BACK_LIST } }],
  sentence: '{server}\'s changed tools will be accepted and offered again {lasts}.',
  done: 'Accepted {server}\'s changed tools.',
  touches: 'this-machine', lasts: 'session', risk: 'loosens-a-protection', riskDone: 'This loosened a protection: its tools are no longer held back.', undoneBy: 'hold-back',
  ownerOnly: { reason: 'it offers tools that changed since they were last accepted', instead: 'Ask the owner to accept them in Tools and extensions.' },
  example: { server: 'github' },
  async run(values, services) {
    const api = liveOf(services);
    const server = knownServer(api, values.server!, 'held-back tools');
    if (server.schemaFreshness !== 'quarantined') refuse(`${server.name}'s tools are not held back (${freshnessWords(server.schemaFreshness)}); nothing changed.`);
    api.approveSchemaQuarantine(server.name, 'owner');
    // Its tools are read again as part of accepting them.
    const tools = (await api.listAllTools()).filter((tool) => tool.serverName === server.name);
    services.mcpLive.changed();
    const after = api.listServerSecurity().find((entry) => entry.name === server.name);
    if (!after?.connected) return { text: `${server.name}'s tools are accepted; it is not connected now, so they are read when it connects (the Servers list shows why).`, data: { server: server.name, tools: 0 } };
    return {
      text: tools.length > 0
        ? `Read ${server.name}'s tools again: ${tools.length} offered (${tools.slice(0, 8).map((tool) => tool.toolName).join(', ')}${tools.length > 8 ? ', ...' : ''}).`
        : `Read ${server.name}'s tools again: it offers none${after.lastError ? ` (${after.lastError})` : ''}.`,
      data: { server: server.name, tools: tools.length },
    };
  },
};

/** What fixes a server, in words naming the controls (never a command to type). */
function fixSteps(server: McpSecurityServer): readonly string[] {
  return [
    ...(server.schemaFreshness === 'quarantined' ? ['check what changed, then "Accept its changed tools"'] : []),
    ...(!server.connected ? ['fix its command or address, then "Reconnect every server"'] : []),
  ];
}

export const MCP_REVIEW: CapabilityDefinition<McpSessionServices> = {
  capability: { id: 'mcp.review', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'review', label: 'See which servers need attention', word: 'review', inputs: [],
  sentence: 'Shows the tool servers that are not connected or whose tools are held back, with what to do next.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const servers = liveOf(services).listServerSecurity();
    const attention = servers.filter((server) => !server.connected || server.schemaFreshness === 'quarantined');
    const data = { attention: attention.map((server) => ({ ...serverFacts(server), fix: fixSteps(server) })) };
    if (attention.length === 0) return { text: servers.length === 0 ? 'No tool servers yet.' : 'Every tool server is working.', data };
    return {
      text: [
        `${attention.length} of ${servers.length} tool server(s) need attention:`,
        ...attention.map((server) => `  ${server.schemaFreshness === 'quarantined'
          ? `${server.name}'s tools are held back for review${server.quarantineReason ? ` (${server.quarantineReason})` : ''}.`
          : `${server.name} is not connected${server.lastError ? `: ${server.lastError}` : '.'}`} To fix it: ${fixSteps(server).join('; ')}.`),
      ].join('\n'),
      data,
    };
  },
};

export const MCP_REPAIR: CapabilityDefinition<McpSessionServices> = {
  capability: { id: 'mcp.repair', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'repair', label: 'See how to fix a server', word: 'repair',
  inputs: [{ ...SERVER, required: { default: '', defaultMeans: 'the first one that needs attention' } }],
  sentence: 'Shows {server}\'s state and the steps that fix it.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { server: 'github' },
  async run(values, services) {
    const servers = liveOf(services).listServerSecurity();
    const selected = values.server
      ? servers.find((server) => server.name === values.server)
      : servers.find((server) => !server.connected || server.schemaFreshness === 'quarantined');
    if (!selected) {
      if (values.server) refuse(`No tool server named ${values.server}.`, 'The Servers list shows your servers.');
      return { text: 'No tool server needs repair.', data: {} };
    }
    const steps = fixSteps(selected);
    return {
      text: [
        `How to fix ${selected.name}`,
        `State: ${mcpServerState(selected)}; trust: ${mcpTrustWords(selected.trustMode)}; role: ${mcpRoleWords(selected.role)}; ${freshnessWords(selected.schemaFreshness)}`,
        ...(selected.quarantineReason || selected.quarantineDetail
          ? [`Tools held back: ${selected.quarantineDetail || HELD_BACK_REASON_WORDS[selected.quarantineReason ?? ''] || selected.quarantineReason}`] : []),
        ...(selected.lastError ? [`Last error: ${selected.lastError}`] : []),
        steps.length > 0 ? 'What to do:' : 'Nothing needs fixing.',
        ...steps.map((step) => `  ${step}`),
      ].join('\n'),
      data: { ...serverFacts(selected), fix: steps },
    };
  },
};

/** The daemon's MCP capabilities: what is kept in the config files. */
export const MCP_DAEMON_CAPABILITIES: readonly CapabilityDefinition<McpCapabilityServices>[] = [
  MCP_ADD, MCP_REMOVE, MCP_EXEMPT, MCP_UNEXEMPT, MCP_TRUST, MCP_ROLE, MCP_FILES,
];
/** This program's MCP capabilities: its live connections and its session's settings. */
export const MCP_SESSION_CAPABILITIES: readonly CapabilityDefinition<McpSessionServices>[] = [
  MCP_SERVERS, MCP_TOOLS, MCP_BLOCK, MCP_UNBLOCK, MCP_RELOAD, MCP_RESTORE_TRUST, MCP_RESTORE_ROLE, MCP_HOLD_BACK, MCP_ACCEPT_TOOLS, MCP_REVIEW, MCP_REPAIR,
];
