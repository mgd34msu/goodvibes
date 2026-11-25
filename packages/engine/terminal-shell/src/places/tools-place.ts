/**
 * tools-place.ts, the Tools and extensions place: your hooks, the hook points
 * they run at, the trace of which hooks ran and what each did, and the tools
 * the model can call here.
 *
 * Hooks, hook points and the trace are read from the daemon, which manages the
 * project's hooks file and keeps the one trace of every program's hook runs
 * (`capabilities.run` of `hooks.contracts` and `hooks.trace`; the place sends
 * this program's project with each). The trace follows LIST_CHANGED
 * `hook-trace`, and the hooks follow `tools` (a change made to the hooks file
 * through the daemon, from anywhere). The tools are this program's own (a
 * session source): the web UI has no such list.
 */
import { HOOK_TRACE_PROGRAM_WORDS, hookRunOutcome } from '@goodvibes/engine/platform/platform/hooks/trace-words';
import { definePlace, type PlaceItem } from './place-types.js';
import type { PlaceAction, PlaceList } from './place-types.js';
import { TOOLS_SKILLS_ACTIONS, TOOLS_SKILLS_LISTS } from './tools-skills-entries.js';

interface HookItem extends PlaceItem {
  readonly state: 'on' | 'off' | 'chain';
  readonly name: string;
  readonly pattern: string;
  readonly type: string;
  readonly description: string;
  readonly points: readonly string[];
  readonly file: string;
}

interface PointItem extends PlaceItem {
  readonly state: 'point';
  readonly pattern: string;
  readonly description: string;
  readonly mode: string;
  readonly mayRefuse: boolean;
  readonly mayChangeInput: boolean;
  readonly mayAddContext: boolean;
}

interface RunItem extends PlaceItem {
  readonly state: 'went-on' | 'refused' | 'asked' | 'failed';
  readonly hook: string;
  readonly point: string;
  readonly on: string;
  readonly at: number;
  readonly program: 'tui' | 'agent' | 'daemon';
  readonly did: string;
  readonly durationMs: number;
  readonly background: boolean;
}

interface ToolItem extends PlaceItem {
  readonly state: 'tool';
  readonly name: string;
  readonly description: string;
}

/** A tool server as this program holds it: connected or not, its trust and role (for this session or kept), its tool rules. */
interface ServerItem extends PlaceItem {
  readonly state: 'connected' | 'not-connected' | 'held-back' | 'not-started';
  readonly name: string;
  readonly words: string;
  readonly trust: string;
  readonly sessionTrust: boolean;
  readonly role: string;
  readonly sessionRole: boolean;
  readonly heldBackBecause: string;
  readonly folders: number;
  readonly sites: number;
  readonly rules: readonly string[];
  readonly lastError: string;
  readonly from: string;
}

/** A tool server as the MCP config files keep it (read from the daemon, for this program's project). */
interface ServerFileItem extends PlaceItem {
  readonly state: 'kept' | 'read-only' | 'waits-for-trust';
  readonly name: string;
  readonly endpoint: string;
  readonly file: string;
  readonly scope: string;
  readonly trust: string;
  readonly role: string;
  readonly blocked: readonly string[];
  readonly exempt: readonly string[];
}

/** A plugin as the daemon keeps it: switched on or off, quarantined, its trust tier. */
interface PluginItem extends PlaceItem {
  readonly state: 'on' | 'off' | 'quarantined';
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: string;
  readonly tier: string;
  readonly tierNotApplied: string;
  readonly startFailure: string;
}

/** A plugin published to the local curated catalog. */
interface CatalogPluginItem extends PlaceItem {
  readonly state: 'published';
  readonly name: string;
  readonly summary: string;
  readonly source: string;
}

type Item = HookItem | PointItem | RunItem | ToolItem | ServerItem | ServerFileItem | PluginItem | CatalogPluginItem;

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const record = (value: unknown): Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): readonly Readonly<Record<string, unknown>>[] => Array.isArray(value) ? value.map(record) : [];
/** Text from a hooks file or another process, shown on one line: control characters out. */
const plain = (value: unknown): string => text(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();

/** What `capabilities.run` answered: the capability's `data`. */
const dataOf = (output: unknown): Readonly<Record<string, unknown>> => record(record(output)['data']);

function hooks(output: unknown): readonly HookItem[] {
  const data = dataOf(output);
  const file = text(data['file']);
  const managed = list(data['managed']).filter((hook) => text(hook['name'])).map((hook): HookItem => ({
    id: `hook:${text(hook['name'])}`,
    state: hook['enabled'] === false ? 'off' : 'on',
    name: plain(hook['name']),
    pattern: plain(hook['pattern']),
    type: plain(hook['type']),
    description: plain(hook['description']),
    points: [],
    file,
  }));
  const chains = list(data['chains']).filter((chain) => text(chain['name'])).map((chain): HookItem => ({
    id: `chain:${text(chain['name'])}`,
    state: 'chain',
    name: plain(chain['name']),
    pattern: '',
    type: 'chain',
    description: plain(chain['description']),
    points: Array.isArray(chain['points']) ? (chain['points'] as unknown[]).map(plain) : [],
    file,
  }));
  return [...managed, ...chains];
}

function points(output: unknown): readonly PointItem[] {
  return list(dataOf(output)['points']).filter((point) => text(point['pattern'])).map((point): PointItem => ({
    id: text(point['pattern']),
    state: 'point',
    pattern: text(point['pattern']),
    description: plain(point['description']),
    mode: plain(point['mode']),
    mayRefuse: point['canDeny'] === true,
    mayChangeInput: point['canChangeInput'] === true,
    mayAddContext: point['canAddContext'] === true,
  }));
}

function runs(output: unknown): readonly RunItem[] {
  return list(dataOf(output)['runs']).filter((run) => text(run['id'])).map((run): RunItem => {
    const decision = text(run['decision']);
    const state: RunItem['state'] = run['ok'] !== true ? 'failed' : decision === 'deny' ? 'refused' : decision === 'ask' ? 'asked' : 'went-on';
    const program = text(run['program']);
    return {
      id: text(run['id']),
      state,
      hook: plain(run['hook']),
      point: plain(run['point']),
      on: plain(run['on']),
      at: typeof run['at'] === 'number' ? run['at'] : 0,
      program: program === 'agent' || program === 'daemon' ? program : 'tui',
      did: plain(text(run['did']) || hookRunOutcome({
        ok: run['ok'] === true,
        ...(decision === 'allow' || decision === 'deny' || decision === 'ask' ? { decision } : {}),
        ...(text(run['reason']) ? { reason: text(run['reason']) } : {}),
        ...(run['changedInput'] === true ? { changedInput: true } : {}),
        ...(run['addedContext'] === true ? { addedContext: true } : {}),
        ...(text(run['error']) ? { error: text(run['error']) } : {}),
      })),
      durationMs: typeof run['durationMs'] === 'number' ? run['durationMs'] : 0,
      background: run['background'] === true,
    };
  });
}

function tools(raw: unknown): readonly ToolItem[] {
  return list(raw).filter((tool) => text(tool['name'])).map((tool): ToolItem => ({
    id: text(tool['name']), state: 'tool', name: plain(tool['name']), description: text(tool['description']).replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim(),
  }));
}

function servers(raw: unknown): readonly ServerItem[] {
  return list(raw).filter((server) => text(server['name'])).map((server): ServerItem => {
    const rules = list(server['rules']).map((rule) => `${rule['blocked'] === true ? 'blocked' : 'past its limits'}: ${plain(rule['tool'])} (${rule['kept'] === true ? 'kept' : 'this session'}${rule['inEffect'] === false ? ', a block wins' : ''})`);
    const state: ServerItem['state'] = server['phase'] === 'not-started' ? 'not-started' : server['heldBack'] === true ? 'held-back' : server['connected'] === true ? 'connected' : 'not-connected';
    return {
      id: text(server['name']), state, name: plain(server['name']), words: plain(server['state']),
      trust: plain(server['trustWords']), sessionTrust: server['sessionTrust'] === true, role: plain(server['roleWords']), sessionRole: server['sessionRole'] === true,
      heldBackBecause: plain(server['heldBackBecause']), folders: typeof server['folders'] === 'number' ? server['folders'] : 0, sites: typeof server['sites'] === 'number' ? server['sites'] : 0,
      rules, lastError: plain(server['lastError']), from: plain(server['from']),
    };
  });
}

function serverFiles(output: unknown): readonly ServerFileItem[] {
  return list(dataOf(output)['servers']).filter((server) => text(server['name'])).map((server): ServerFileItem => ({
    id: `${text(server['path'])}#${text(server['name'])}`,
    state: server['waitsForTrust'] === true ? 'waits-for-trust' : server['writable'] === false || server['scope'] === 'external' ? 'read-only' : 'kept',
    name: plain(server['name']), endpoint: plain(server['endpoint']), file: plain(server['path']), scope: plain(server['scope']),
    trust: text(server['trustMode']) ? plain(server['trustMode']) : '', role: text(server['role']) ? plain(server['role']) : '',
    blocked: Array.isArray(server['blocked']) ? (server['blocked'] as unknown[]).map(plain) : [],
    exempt: Array.isArray(server['exempt']) ? (server['exempt'] as unknown[]).map(plain) : [],
  }));
}

function plugins(output: unknown): readonly PluginItem[] {
  return list(dataOf(output)['plugins']).filter((plugin) => text(plugin['name'])).map((plugin): PluginItem => ({
    id: text(plugin['name']),
    state: plugin['quarantined'] === true ? 'quarantined' : plugin['enabled'] === true ? 'on' : 'off',
    name: plain(plugin['name']), version: plain(plugin['version']), description: plain(plugin['description']), author: plain(plugin['author']),
    tier: plain(plugin['tier']), tierNotApplied: plain(plugin['tierNotApplied']), startFailure: plain(plugin['startFailure']),
  }));
}

function catalogPlugins(output: unknown): readonly CatalogPluginItem[] {
  return list(dataOf(output)['entries']).filter((entry) => text(entry['id'])).map((entry): CatalogPluginItem => ({
    id: text(entry['id']), state: 'published', name: plain(entry['name']) || plain(entry['id']), summary: plain(entry['summary']), source: plain(entry['source']),
  }));
}

const TIER_WORDS: Readonly<Record<string, string>> = {
  untrusted: 'untrusted: panels, commands and reading files only',
  limited: 'limited: the tools, providers and hooks it declares; nothing high-risk',
  trusted: 'trusted: everything it declares, high-risk too',
};

const SERVER_STATE_WORDS: Readonly<Record<ServerItem['state'], string>> = {
  connected: 'connected', 'not-connected': 'not connected', 'held-back': 'tools held back', 'not-started': 'not started yet',
};

/** A run's time as a person reads it: today's as the time, an older one with its date. */
function when(at: number): string {
  if (!at) return 'not said';
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString()} ${time}`;
}

const HOOK_TYPE_WORDS: Readonly<Record<string, string>> = {
  command: 'runs a command', prompt: 'asks the model', agent: 'starts an agent', http: 'calls a web address', ts: 'runs a TypeScript file', chain: 'a chain of hook points',
};
const RUN_STATE_WORDS: Readonly<Record<RunItem['state'], string>> = { 'went-on': 'let it go on', refused: 'refused it', asked: 'put it to you', failed: 'failed' };

/** The hooks file and the trace change through the daemon: both lists follow its notices. */
// LIST_CHANGED notices travel on the `workspace` domain: a list that follows one names that domain too.
const HOOKS_FOLLOW = { domains: ['workspace'], events: [], lists: ['tools', 'hook-trace'] } as const;
const run = (id: string, inputs: Readonly<Record<string, string>> = {}) => ({ id, inputs });

export const TOOLS_PLACE = definePlace<Item>({
  id: 'tools',
  group: 'tools',
  title: 'Tools and extensions',
  lists: [
    {
      id: 'hooks',
      label: 'Hooks',
      noun: 'your hooks',
      source: { kind: 'daemon', method: 'capabilities.run', input: run('hooks.contracts'), items: hooks },
      follows: HOOKS_FOLLOW,
      empty: 'No hooks yet: nothing of yours runs when a tool runs or a turn ends.',
      row: (item) => {
        const hook = item as HookItem;
        return {
          title: hook.name,
          ...(hook.state === 'off' ? { right: 'off' } : hook.state === 'chain' ? { right: 'chain' } : {}),
          mark: hook.state === 'off' ? 'paused' : 'ok',
        };
      },
      detail: (item) => {
        const hook = item as HookItem;
        return [
          ...(hook.state === 'chain'
            ? [{ label: 'Runs at', text: hook.points.join(', then ') || 'not said' }]
            : [{ label: 'Runs at', text: hook.pattern || 'not said' }, { label: 'What it does', text: HOOK_TYPE_WORDS[hook.type] ?? hook.type }]),
          { label: 'State', text: hook.state === 'off' ? 'switched off: it runs nothing' : hook.state === 'on' ? 'switched on' : 'a chain' },
          ...(hook.description ? [{ label: 'About', text: hook.description, tone: 'muted' as const }] : []),
          { label: 'Kept in', text: hook.file || 'the project\'s hooks file', tone: 'muted' as const },
        ];
      },
    },
    {
      id: 'runs',
      label: 'Hook runs',
      noun: 'the hooks that ran',
      source: { kind: 'daemon', method: 'capabilities.run', input: run('hooks.trace', { limit: '100' }), items: runs },
      follows: HOOKS_FOLLOW,
      empty: 'No hook has run here yet.',
      row: (item) => {
        const entry = item as RunItem;
        return {
          title: `${entry.hook} at ${entry.point}${entry.on ? ` on ${entry.on}` : ''}`,
          right: RUN_STATE_WORDS[entry.state],
          mark: entry.state === 'failed' ? 'attention' : entry.state === 'refused' || entry.state === 'asked' ? 'waiting' : 'ok',
        };
      },
      detail: (item) => {
        const entry = item as RunItem;
        return [
          { label: 'Hook', text: entry.hook },
          { label: 'When', text: when(entry.at) },
          { label: 'At', text: entry.point },
          ...(entry.on ? [{ label: 'On', text: entry.on }] : []),
          { label: 'In', text: HOOK_TRACE_PROGRAM_WORDS[entry.program] },
          { label: 'What it did', text: entry.did, ...(entry.state === 'failed' ? { tone: 'warning' as const } : {}) },
          { label: 'Took', text: `${entry.durationMs} ms${entry.background ? ', beside the event' : ''}`, tone: 'muted' as const },
        ];
      },
    },
    {
      id: 'points',
      label: 'Hook points',
      noun: 'the hook points',
      source: { kind: 'daemon', method: 'capabilities.run', input: run('hooks.contracts'), items: points },
      empty: 'No hook points are registered.',
      row: (item) => ({ title: (item as PointItem).pattern }),
      detail: (item) => {
        const point = item as PointItem;
        const may = [point.mayRefuse ? 'refuse it' : '', point.mayChangeInput ? 'change its input' : '', point.mayAddContext ? 'add context' : ''].filter(Boolean);
        return [
          { text: point.description },
          { text: '' },
          { label: 'A hook here may', text: may.length > 0 ? may.join(', ') : 'only see it happen' },
          { label: 'Runs', text: point.mode.replace(/_/g, ' ') || 'not said', tone: 'muted' as const },
        ];
      },
    },
    {
      id: 'tools',
      label: 'Tools',
      noun: 'the tools the model can call here',
      source: { kind: 'session', name: 'tools', items: tools },
      empty: 'No tools are registered here.',
      row: (item) => ({ title: (item as ToolItem).name }),
      detail: (item) => [{ text: (item as ToolItem).description || 'It says nothing about what it does.' }],
    },
    {
      id: 'servers',
      label: 'Servers',
      noun: 'your tool servers (MCP)',
      source: { kind: 'session', name: 'mcp.servers', items: servers },
      empty: 'No tool servers (MCP) yet: the model has only GoodVibes\' own tools.',
      row: (item) => {
        const server = item as ServerItem;
        return {
          title: server.name,
          ...(server.state === 'connected' ? {} : { right: SERVER_STATE_WORDS[server.state] }),
          mark: server.state === 'connected' ? 'ok' : server.state === 'not-started' ? 'paused' : 'attention',
        };
      },
      detail: (item) => {
        const server = item as ServerItem;
        return [
          { label: 'State', text: server.words || SERVER_STATE_WORDS[server.state] },
          { label: 'Trust', text: `${server.trust}${server.sessionTrust ? ' (for this session)' : ''}` },
          { label: 'Role', text: `${server.role}${server.sessionRole ? ' (for this session)' : ''}` },
          ...(server.folders || server.sites ? [{ label: 'Reaches', text: `${server.folders} folder(s), ${server.sites} site(s) besides the project` }] : []),
          ...(server.rules.length > 0 ? [{ label: 'Tool rules', text: server.rules.join('; ') }] : []),
          ...(server.heldBackBecause ? [{ label: 'Held back because', text: server.heldBackBecause, tone: 'warning' as const }] : []),
          ...(server.lastError ? [{ label: 'What went wrong', text: server.lastError, tone: 'warning' as const }] : []),
          ...(server.from ? [{ label: 'Kept in', text: server.from, tone: 'muted' as const }] : []),
        ];
      },
    },
    {
      id: 'server-files',
      label: 'Server files',
      noun: 'the MCP config files',
      source: { kind: 'daemon', method: 'capabilities.run', input: run('mcp.files'), items: serverFiles },
      follows: { domains: ['mcp', 'workspace'], events: [], lists: ['tools'] },
      empty: 'No MCP config file names a server yet.',
      row: (item) => {
        const server = item as ServerFileItem;
        return {
          title: server.name,
          ...(server.state === 'waits-for-trust' ? { right: 'waits for this folder\'s trust' } : server.state === 'read-only' ? { right: 'another program\'s file' } : {}),
          mark: server.state === 'kept' ? 'ok' : 'paused',
        };
      },
      detail: (item) => {
        const server = item as ServerFileItem;
        return [
          { label: 'Starts with', text: server.endpoint },
          { label: 'Kept in', text: `${server.file} (${server.scope === 'global' ? 'all your projects' : server.scope === 'project' ? 'this project' : 'another program'})` },
          ...(server.trust ? [{ label: 'Kept trust', text: server.trust.replace(/-/g, ' ') }] : []),
          ...(server.role ? [{ label: 'Kept role', text: server.role }] : []),
          ...(server.blocked.length > 0 ? [{ label: 'Blocked tools', text: server.blocked.join(', ') }] : []),
          ...(server.exempt.length > 0 ? [{ label: 'Past its limits', text: server.exempt.join(', ') }] : []),
          ...(server.state === 'waits-for-trust' ? [{ text: 'It is named by a file in this folder, which you have not trusted, so no program starts it until you do.', tone: 'warning' as const }] : []),
        ];
      },
    },
    {
      id: 'plugins',
      label: 'Plugins',
      noun: 'your plugins',
      source: { kind: 'daemon', method: 'capabilities.run', input: run('plugin.list'), items: plugins },
      follows: { domains: ['plugins', 'workspace'], events: [], lists: ['tools'] },
      empty: 'No plugins yet: put a plugin folder with its manifest.json in ~/.goodvibes/plugins or the project\'s .goodvibes/plugins.',
      row: (item) => {
        const plugin = item as PluginItem;
        return {
          title: plugin.name,
          right: plugin.state === 'quarantined' ? 'quarantined' : plugin.state === 'off' ? 'off' : plugin.tier,
          mark: plugin.state === 'quarantined' ? 'attention' : plugin.state === 'off' ? 'paused' : plugin.startFailure ? 'attention' : 'ok',
        };
      },
      detail: (item) => {
        const plugin = item as PluginItem;
        return [
          ...(plugin.description ? [{ text: plugin.description }, { text: '' }] : []),
          { label: 'State', text: plugin.state === 'quarantined' ? 'quarantined: it does not load' : plugin.state === 'on' ? 'switched on' : 'switched off' },
          { label: 'May do', text: TIER_WORDS[plugin.tier] ?? plugin.tier },
          ...(plugin.tierNotApplied ? [{ label: 'Note', text: plugin.tierNotApplied, tone: 'warning' as const }] : []),
          ...(plugin.startFailure ? [{ label: 'Did not start', text: plugin.startFailure, tone: 'warning' as const }] : []),
          { label: 'Version', text: `${plugin.version}${plugin.author ? `, by ${plugin.author}` : ''}`, tone: 'muted' as const },
        ];
      },
    },
    {
      id: 'plugin-catalog',
      label: 'Published plugins',
      noun: 'the plugins in the local catalog',
      source: { kind: 'daemon', method: 'capabilities.run', input: run('plugin.catalog'), items: catalogPlugins },
      follows: { domains: ['workspace'], events: [], lists: ['tools'] },
      empty: 'No plugin is published to the local catalog.',
      row: (item) => ({ title: (item as CatalogPluginItem).name }),
      detail: (item) => {
        const entry = item as CatalogPluginItem;
        return [{ text: entry.summary || 'It says nothing about what it does.' }, { label: 'From', text: entry.source, tone: 'muted' as const }];
      },
    },
    // Skills, skill bundles, published skills, presets and managed settings (tools-skills-entries.ts): their own item kinds.
    ...(TOOLS_SKILLS_LISTS as unknown as readonly PlaceList<Item>[]),
  ],
  actions: [
    // Skills, skill bundles, published skills, presets and managed settings (tools-skills-entries.ts).
    ...(TOOLS_SKILLS_ACTIONS as unknown as readonly PlaceAction<Item>[]),
    // Hooks: make one, switch one on or off, take one out; the hooks file as a whole.
    { key: 'n', capability: 'hooks.scaffold', label: 'new hook' },
    { key: 'c', capability: 'hooks.chain', label: 'new chain' },
    { key: 'o', list: 'hooks', states: ['off'], capability: 'hooks.enable', label: 'switch on', fill: { hook: 'name' } },
    { key: 'o', list: 'hooks', states: ['on'], capability: 'hooks.disable', label: 'switch off', fill: { hook: 'name' } },
    { key: 'x', list: 'hooks', capability: 'hooks.remove', label: 'remove', fill: { hook: 'name' } },
    { key: 'h', list: 'points', capability: 'hooks.scaffold', id: 'hook-here', label: 'make a hook here', fill: { match: 'pattern' } },
    { key: 't', list: 'points', capability: 'hooks.simulate', label: 'try it', fill: { event: 'pattern' } },
    { key: 'l', list: 'hooks', capability: 'hooks.reload', label: 'read the file again' },
    { key: 'e', list: 'hooks', capability: 'hooks.export', label: 'save to a file' },
    { key: 'i', capability: 'hooks.inspect', label: 'look inside a bundle' },
    { key: 'm', capability: 'hooks.import', label: 'install a bundle' },
    // The tools the model can call here, and the web.
    { key: 'v', list: 'tools', capability: 'tools.contract', label: 'contract', fill: { tool: 'name' } },
    { key: 'k', list: 'tools', capability: 'tools.verify', label: 'check it', fill: { tool: 'name' } },
    { key: 'K', list: 'tools', capability: 'tools.verify-all', label: 'check every tool' },
    { key: 'w', capability: 'tools.web-search', label: 'search the web' },
    // Tool servers (MCP): this program's connections and its session's settings; what the config files keep, through the daemon.
    { key: 'A', capability: 'mcp.add', label: 'add a server' },
    { key: 'F', capability: 'mcp.files', label: 'where servers are configured' },
    { key: 't', list: 'servers', capability: 'mcp.tools', label: 'its tools', fill: { server: 'name' } },
    { key: 'b', list: 'servers', states: ['connected', 'not-connected', 'held-back'], capability: 'mcp.block', label: 'block a tool', fill: { server: 'name' } },
    { key: 'u', list: 'servers', states: ['connected', 'not-connected', 'held-back'], capability: 'mcp.unblock', label: 'stop blocking a tool', fill: { server: 'name' } },
    { key: 'g', list: 'servers', capability: 'mcp.exempt', label: 'let a tool past its limits', fill: { server: 'name' } },
    { key: 'G', list: 'servers', capability: 'mcp.unexempt', label: 'hold a tool to its limits', fill: { server: 'name' } },
    { key: 's', list: 'servers', capability: 'mcp.trust', label: 'set trust', fill: { server: 'name' } },
    { key: 'S', list: 'servers', states: ['connected', 'not-connected', 'held-back'], capability: 'mcp.restore-trust', label: 'saved trust', fill: { server: 'name' } },
    { key: 'y', list: 'servers', capability: 'mcp.role', label: 'set role', fill: { server: 'name' } },
    { key: 'Y', list: 'servers', states: ['connected', 'not-connected', 'held-back'], capability: 'mcp.restore-role', label: 'saved role', fill: { server: 'name' } },
    { key: 'q', list: 'servers', states: ['connected', 'not-connected'], capability: 'mcp.quarantine', label: 'hold back its tools', fill: { server: 'name' } },
    { key: 'a', list: 'servers', states: ['held-back'], capability: 'mcp.accept-tools', label: 'accept its changed tools', fill: { server: 'name' } },
    { key: 'f', list: 'servers', states: ['not-connected', 'held-back'], capability: 'mcp.repair', label: 'how to fix it', fill: { server: 'name' } },
    { key: 'x', list: 'servers', capability: 'mcp.remove', label: 'remove', fill: { server: 'name' } },
    { key: 'R', list: 'servers', capability: 'mcp.reload', label: 'reconnect every server' },
    { key: 'W', list: 'servers', capability: 'mcp.review', label: 'which need a look' },
    { key: 's', list: 'server-files', states: ['kept'], capability: 'mcp.trust', label: 'set trust', fill: { server: 'name' } },
    { key: 'y', list: 'server-files', states: ['kept'], capability: 'mcp.role', label: 'set role', fill: { server: 'name' } },
    { key: 'g', list: 'server-files', states: ['kept'], capability: 'mcp.exempt', label: 'let a tool past its limits', fill: { server: 'name' } },
    { key: 'G', list: 'server-files', states: ['kept'], capability: 'mcp.unexempt', label: 'hold a tool to its limits', fill: { server: 'name' } },
    { key: 'x', list: 'server-files', states: ['kept', 'waits-for-trust'], capability: 'mcp.remove', label: 'remove', fill: { server: 'name', scope: 'scope' } },
    // Plugins: what is kept, through the daemon; loading them again and a quarantine, in this program.
    { key: 'enter', list: 'plugins', capability: 'plugin.inspect', id: 'plugin-see', label: 'see it', fill: { plugin: 'name' } },
    { key: 'o', list: 'plugins', states: ['off'], capability: 'plugin.enable', label: 'switch on', fill: { plugin: 'name' } },
    { key: 'o', list: 'plugins', states: ['on'], capability: 'plugin.disable', label: 'switch off', fill: { plugin: 'name' } },
    { key: 's', list: 'plugins', capability: 'plugin.trust', id: 'plugin-trust', label: 'set what it may do', fill: { plugin: 'name' } },
    { key: 'p', list: 'plugins', capability: 'plugin.capabilities', label: 'what it asks to do', fill: { plugin: 'name' } },
    { key: 'v', list: 'plugins', capability: 'plugin.verify', label: 'check its signature', fill: { plugin: 'name' } },
    { key: 'k', list: 'plugins', capability: 'plugin.trust-key', label: 'save its publisher key', fill: { plugin: 'name' } },
    { key: 'q', list: 'plugins', states: ['on', 'off'], capability: 'plugin.quarantine', id: 'plugin-quarantine', label: 'quarantine', fill: { plugin: 'name' } },
    { key: 'u', list: 'plugins', states: ['quarantined'], capability: 'plugin.lift', label: 'lift the quarantine', fill: { plugin: 'name' } },
    { key: 'R', list: 'plugins', capability: 'plugin.reload', id: 'plugin-reload', label: 'load them again' },
    { key: 'W', list: 'plugins', capability: 'plugin.review', id: 'plugin-review', label: 'how much they may do' },
    { key: 'D', list: 'plugins', capability: 'plugin.dirs', label: 'where they are looked for' },
    { key: 'P', capability: 'plugin.publish-local', label: 'publish a plugin folder' },
    { key: 'x', list: 'plugin-catalog', capability: 'plugin.unpublish', id: 'plugin-unpublish', label: 'take it out', fill: { id: 'id' } },
  ],
  // What is wrong now: a hook that failed in the last day.
  count: (lists) => {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const failed = (lists['runs'] ?? []).filter((item) => item.state === 'failed' && (item as RunItem).at >= since).length;
    return failed > 0 ? { count: failed, words: `${failed} hook run${failed === 1 ? '' : 's'} failed today`, tone: 'wrong' } : undefined;
  },
});
