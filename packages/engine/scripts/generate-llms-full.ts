#!/usr/bin/env bun
/**
 * generate-llms-full.ts
 *
 * Writes docs/llms-full.txt, and beside it docs/llms.txt (one line per part and
 * what it covers, then the full file): llms-full.txt is the single file a language model reads to install,
 * configure and operate GoodVibes. It is the hand-written parts in docs/llms/
 * (`NN-slug.md`, concatenated in number order) with every line of the form
 * `<!-- generated: NAME -->` replaced by a reference section built here from
 * the code's own registries: the settings schema, the programs' help builders
 * and command tables, the slash-command registries of both terminal apps, the
 * tool registries, the operator method and event catalog, the error codes, the
 * provider registry, the installer's option parsers and the environment
 * variables the programs read. A part never retypes a list the code holds.
 *
 * The run is isolated: before any registry loads, the environment is cleared to
 * PATH and a throwaway HOME, so nothing on this machine (settings, keys, a
 * daemon) reaches the output, and the output carries no machine path or time.
 *
 *   bun packages/engine/scripts/generate-llms-full.ts           write docs/llms-full.txt and docs/llms.txt
 *   bun packages/engine/scripts/generate-llms-full.ts --check   exit 1, naming what differs, when either is stale
 *
 * A part that names an unknown marker fails both modes.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENV_CATALOG, ENV_SCAN_IGNORED, ENV_SCAN_ROOTS, ENV_SCAN_SHELL_FILES, type EnvEntry } from './generate-llms-full-env.ts';

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(ENGINE_ROOT, '../..');
const PARTS_DIR = join(REPO_ROOT, 'docs/llms');
const OUTPUT = join(REPO_ROOT, 'docs/llms-full.txt');
/** The small index of the parts, beside the full file (partsIndex). */
const INDEX_OUTPUT = join(REPO_ROOT, 'docs/llms.txt');
const CHECK_ONLY = process.argv.includes('--check');
const PLATFORM = join(ENGINE_ROOT, 'platform/src/platform');
const PART_NAME = /^\d\d-[a-z0-9-]+\.md$/;
/** The part that holds every complete list in full. */
const REFERENCE_PART = '90-reference.md';
const MARKER = /^<!-- generated: ([a-z0-9-]+(?::[A-Za-z0-9._-]+)?) -->$/;
/** Written in a part where the release is named; replaced by the suite version, so a part never names a release by hand. */
const RELEASE_TOKEN = '{{release}}';
const RELEASE = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { readonly version: string }).version;

// ---------------------------------------------------------------------------
// Isolation: nothing from this machine may reach the output.
// ---------------------------------------------------------------------------

const SCRATCH = mkdtempSync(join(tmpdir(), 'goodvibes-llms-full-'));
const SCRATCH_HOME = join(SCRATCH, 'home');
const SCRATCH_WORKSPACE = join(SCRATCH, 'workspace');
mkdirSync(SCRATCH_HOME, { recursive: true });
mkdirSync(SCRATCH_WORKSPACE, { recursive: true });
const keptPath = process.env['PATH'] ?? '';
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, { PATH: keptPath, HOME: SCRATCH_HOME, TMPDIR: SCRATCH, TZ: 'UTC', LANG: 'C.UTF-8', NO_COLOR: '1' });

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** One table cell: one line, pipes escaped. */
const cell = (text: string): string => text.replace(/\s*\r?\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
/** Inline code that survives a backtick inside the value. */
const code = (text: string): string => (text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``);
const fence = (text: string, lang = ''): string => ['```' + lang, text.replace(/\s+$/, ''), '```'].join('\n');
/** A value as it is written in a settings file. */
const literal = (value: unknown): string => (value === undefined ? 'none' : JSON.stringify(value));
const sentence = (text: string): string => {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed === '' || /[.!?:)]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Problems found while building: unknown markers, entries a registry left without a description. */
const problems: string[] = [];
const missingDescriptions = new Set<string>();

/** Load a module by a path the type checker does not follow (product sources), typed by the caller. */
async function loadProductModule<T>(relativePath: string): Promise<T> {
  const target = join(REPO_ROOT, relativePath);
  const loaded: unknown = await import(target);
  return loaded as T;
}

// ---------------------------------------------------------------------------
// settings, settings:<prefix>
// ---------------------------------------------------------------------------

interface SettingRow {
  readonly key: string;
  readonly type: string;
  readonly default: unknown;
  readonly description: string;
  readonly deprecated?: boolean | undefined;
  readonly enumValues?: readonly string[] | undefined;
  readonly validationHint?: string | undefined;
  readonly unit?: string | undefined;
  readonly role?: string | undefined;
  /** For a setting one app adds to its own file: which app, and whether a project file may set it. */
  readonly app?: { readonly name: string; readonly projectSettable: boolean } | undefined;
  /** Listed by the terminal app's /settings screen but declared by neither schema. */
  readonly screenOnly?: true | undefined;
}

interface SettingsModalModule { buildSettingGroups(configManager: object): Map<string, readonly { readonly setting?: SettingRow }[]> }
interface HostSettingLike { readonly key: string; readonly type: string; readonly default: unknown; readonly description: string; readonly projectSettable?: boolean; readonly integer?: boolean; readonly min?: number; readonly max?: number }
interface AppConfigModule { readonly [name: string]: unknown }
type AppConfigManager = new (options: Record<string, unknown>) => { getHostSettingsSchema(): readonly HostSettingLike[] };

/** The settings one app registers on top of the shared schema, read from that app's own config manager. */
async function appSettings(path: string, exportName: string, surfaceRoot: string): Promise<readonly HostSettingLike[]> {
  const module = await loadProductModule<AppConfigModule>(path);
  const Manager = module[exportName] as AppConfigManager;
  const workingDir = join(SCRATCH_WORKSPACE, `settings-${surfaceRoot}`);
  mkdirSync(workingDir, { recursive: true });
  return new Manager({ homeDir: SCRATCH_HOME, workingDir, surfaceRoot, readOnly: true }).getHostSettingsSchema();
}

let settingRowsCache: readonly SettingRow[] | undefined;
async function settingRows(): Promise<readonly SettingRow[]> {
  if (settingRowsCache) return settingRowsCache;
  const { CONFIG_SCHEMA, DEFAULT_CONFIG } = await import('../platform/src/platform/config/schema.ts');
  const { readDotPath } = await import('../platform/src/platform/config/shared-config-tier.ts');
  // The schema row and the defaults object must agree: a reader is told the row's default, the program runs the object's.
  for (const setting of CONFIG_SCHEMA) {
    const effective = readDotPath(DEFAULT_CONFIG, setting.key);
    if (effective.present && JSON.stringify(effective.value) !== JSON.stringify(setting.default)) {
      problems.push(`setting ${setting.key}: the schema default ${JSON.stringify(setting.default)} differs from the defaults object's ${JSON.stringify(effective.value)}`);
    }
  }
  const rows: SettingRow[] = [...CONFIG_SCHEMA];
  const tui = await appSettings('products/tui/src/config/host-settings.ts', 'TuiConfigManager', 'tui');
  const agent = await appSettings('products/agent/src/config/host-settings.ts', 'AgentConfigManager', 'agent');
  const agentKeys = new Set(agent.map((setting) => setting.key));
  const tuiKeys = new Set(tui.map((setting) => setting.key));
  for (const setting of [...tui, ...agent.filter((entry) => !tuiKeys.has(entry.key))]) {
    const name = tuiKeys.has(setting.key) && agentKeys.has(setting.key) ? 'terminal app and Agent' : tuiKeys.has(setting.key) ? 'terminal app' : 'Agent';
    const range = setting.type === 'number'
      ? [setting.integer ? 'whole number' : 'number', setting.min !== undefined ? `at least ${setting.min}` : '', setting.max !== undefined ? `at most ${setting.max}` : ''].filter(Boolean).join(', ')
      : undefined;
    rows.push({ key: setting.key, type: setting.type, default: setting.default, description: setting.description, validationHint: range, app: { name, projectSettable: setting.projectSettable === true } });
  }
  // Keys the terminal app's /settings screen shows that neither schema declares (its own entries).
  const { buildSettingGroups } = await loadProductModule<SettingsModalModule>('packages/engine/terminal-shell/src/settings-screen/rows.ts');
  const { TuiConfigManager } = await loadProductModule<{ TuiConfigManager: AppConfigManager & (new (options: Record<string, unknown>) => object) }>('products/tui/src/config/host-settings.ts');
  const known = new Set(rows.map((row) => row.key));
  const screenManager = new TuiConfigManager({ homeDir: SCRATCH_HOME, workingDir: join(SCRATCH_WORKSPACE, 'settings-tui'), surfaceRoot: 'tui', readOnly: true });
  for (const entries of buildSettingGroups(screenManager).values()) {
    for (const entry of entries) {
      const setting = entry.setting;
      if (!setting || known.has(setting.key)) continue;
      known.add(setting.key);
      // A screen entry may name the file it is stored in under this run's throwaway home.
      rows.push({ ...setting, description: setting.description.split(SCRATCH_HOME).join('~'), screenOnly: true });
    }
  }
  settingRowsCache = rows.sort((a, b) => byText(a.key, b.key));
  return settingRowsCache;
}

/**
 * Which file each program reads a key from and which command writes it, from the
 * code that routes it: daemon-owned keys (config-ownership.ts) live in the daemon
 * file; the shared keys (shared-config-tier.ts SHARED_CONFIG_KEYS) in the shared
 * file, over each program's own; every other key in each program's own file,
 * the daemon's being `daemon-host` (products/daemon/src/config/surface.ts).
 */
async function storedIn(key: string, app: SettingRow['app']): Promise<{ readonly where: string; readonly short: string; readonly facts: string[] }> {
  if (app) {
    const short = app.name === 'Agent' ? 'Agent only' : app.name === 'terminal app' ? 'terminal app only' : 'each app';
    const where = app.name === 'Agent' ? 'Agent\'s own file only (`~/.goodvibes/agent/settings.json`); the other programs do not have this setting'
      : app.name === 'terminal app' ? 'the terminal app\'s own file only (`~/.goodvibes/tui/settings.json`); the other programs do not have this setting'
        : 'each app\'s own file (`~/.goodvibes/tui/settings.json`, `~/.goodvibes/agent/settings.json`); the daemon does not have this setting';
    return { where, short, facts: [app.projectSettable ? 'a project file may set it' : 'a project file may not set it'] };
  }
  // The daemon admits a write only to a schema key (its config route and `config set` both check);
  // a key the terminal app's screen shows without one is the terminal app's alone, or stored nowhere.
  const { isValidConfigKey, DEFAULT_CONFIG } = await import('../platform/src/platform/config/schema.ts');
  if (!isValidConfigKey(key)) {
    const { nonSchemaKeyRefusal } = await import('../platform/src/platform/config/write-admission.ts');
    if (nonSchemaKeyRefusal(key, undefined, DEFAULT_CONFIG) !== null) {
      return { where: 'nowhere: it is a row of the terminal app\'s settings screen that opens a command, with no value of its own', short: 'not stored', facts: [] };
    }
    return { where: 'the terminal app\'s own file only (`~/.goodvibes/tui/settings.json`); the daemon refuses it as not a settings key', short: 'terminal app only', facts: [] };
  }
  const { configKeyFacts } = await import('../platform/src/platform/config/config-key-facts.ts');
  const { isDaemonOwnedConfigKey } = await import('../platform/src/platform/config/config-ownership.ts');
  const { isSharedConfigKey } = await import('../platform/src/platform/config/shared-config-tier.ts');
  const facts = configKeyFacts(key);
  const [where, short] = isDaemonOwnedConfigKey(key)
    ? ['the daemon file (one value, which all three programs read)', 'daemon file']
    : isSharedConfigKey(key)
      ? ['the shared file (one value, which wins over each program\'s own file)', 'shared file']
      : ['each program\'s own file (the terminal app, Agent and the daemon each keep their own value)', 'each program'];
  const notes: string[] = [];
  if (!facts.projectSettable) notes.push('a project file may not set it');
  else if (facts.loosens) notes.push('a project file may set it only to a stricter value');
  else notes.push('a project file may set it');
  if (facts.secret) notes.push('a credential: the settings file holds only a `goodvibes://secrets/...` reference to it');
  if (facts.cardMaterial) notes.push('card material: kept only in the daemon\'s card store, never in a settings file');
  if (facts.loosening) notes.push(`a change that would ${facts.loosening} counts as loosening security`);
  return { where, short, facts: notes };
}

/** The schema says `object` for a list-valued key too; a reader is told what the value is written as. */
const typeOf = (row: SettingRow): string => (Array.isArray(row.default) ? 'array' : row.type);

function allowedValues(row: SettingRow): string | undefined {
  if (row.enumValues && row.enumValues.length > 0) return row.enumValues.map(code).join(', ');
  if (row.validationHint) return row.validationHint;
  return undefined;
}

async function renderSetting(row: SettingRow, envBySetting: ReadonlyMap<string, readonly EnvEntry[]>): Promise<string> {
  if (row.description.trim() === '') missingDescriptions.add(`setting ${row.key}`);
  const { where, facts } = await storedIn(row.key, row.app);
  const allowed = allowedValues(row);
  const details = [
    `type ${code(typeOf(row))}`,
    `default ${code(literal(row.default))}`,
    ...(allowed ? [`allowed: ${allowed}`] : []),
    ...(row.unit === 'money' ? ['an amount in `payments.currency`, written as a person says it (`100`, `19.99`)'] : []),
    ...(row.role === 'listen-port' ? ['a port this machine listens on'] : row.role === 'remote-port' ? ['a remote server\'s port'] : []),
  ];
  const env = envBySetting.get(row.key) ?? [];
  const lines = [
    `- ${code(row.key)}: ${sentence(row.description)}${row.deprecated ? ' Deprecated: kept so saved files still load; no settings screen offers it.' : ''}`,
    `  - ${sentence(details.join('; '))}`,
    where.startsWith('nowhere') ? `  - Not stored${where.slice('nowhere'.length)}.` : `  - Stored in ${where}.`,
    `  - ${sentence(facts.join('; ').replace(/^./, (c) => c.toUpperCase()))}`,
    ...(row.screenOnly ? ['  - Only the terminal app\'s `/settings` screen lists it; the shared settings schema does not declare it.'] : []),
    ...(env.length > 0 ? [`  - Environment: ${env.map((entry) => `${code(entry.name)} (${entry.setting?.relation ?? ''})`).join('; ')}.`] : []),
  ];
  return lines.join('\n');
}

async function settingsSection(prefix: string | undefined): Promise<string> {
  const all = await settingRows();
  // A prefix is whole segments (`payments` is `payments.*`); one that ends inside a segment (`telemetry.decisionOtlp`) matches the keys that start with it.
  let rows = all.filter((row) => prefix === undefined || row.key === prefix || row.key.startsWith(`${prefix}.`));
  if (rows.length === 0 && prefix !== undefined) rows = all.filter((row) => row.key.startsWith(prefix));
  if (rows.length === 0) {
    problems.push(`settings:${prefix ?? ''} matches no setting key`);
    return '';
  }
  const envBySetting = new Map<string, EnvEntry[]>();
  for (const entry of ENV_CATALOG) {
    if (!entry.setting) continue;
    const list = envBySetting.get(entry.setting.key) ?? [];
    list.push(entry);
    envBySetting.set(entry.setting.key, list);
  }
  const out: string[] = [];
  if (prefix === undefined) {
    let domain = '';
    for (const row of rows) {
      const next = row.key.split('.')[0]!;
      if (next !== domain) {
        domain = next;
        out.push(`### ${domain}`, '');
      }
      out.push(await renderSetting(row, envBySetting), '');
    }
  } else {
    // In a part, a short table; the full entries are printed once, in the reference.
    const domains = [...new Set(rows.map((row) => row.key.split('.')[0]!))];
    out.push('| Key | Type | Default | Allowed | Stored in | What it does |', '| --- | --- | --- | --- | --- | --- |');
    for (const row of rows) {
      const { short } = await storedIn(row.key, row.app);
      out.push(`| ${code(row.key)} | ${typeOf(row)} | ${code(literal(row.default))} | ${cell(allowedValues(row) ?? '')} | ${short} | ${cell(wholeDescription(row.description))} |`);
    }
    out.push('', `Full entries (files, project rule, environment variable): "Settings" in the part "Reference", under ${domains.map((domain) => `"${domain}"`).join(', ')}.`);
  }
  counts.set(prefix === undefined ? 'settings' : `settings:${prefix}`, rows.length);
  return out.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// cli:goodvibes, cli:goodvibes-agent, cli:goodvibes-daemon
// ---------------------------------------------------------------------------

const NO_DETAILED_HELP = 'No detailed help is available';

interface TuiHelpModule {
  renderGoodVibesHelp(binary?: string): string;
  renderGoodVibesCommandHelp(topic: string, binary?: string): string;
}
interface TuiCompletionModule {
  tuiCompletionTable(binary?: string): { readonly commands: readonly { readonly name: string; readonly aliases: readonly string[]; readonly description: string; readonly subcommands: readonly string[] }[] };
}
interface AgentHelpModule extends TuiHelpModule {
  listGoodVibesHelpTopics(): readonly string[];
}
interface DaemonFlag { readonly tokens: readonly string[]; readonly takesValue?: boolean; readonly summary: string }
interface DaemonCommandsModule {
  readonly DAEMON_COMMANDS: readonly { readonly name: string; readonly aliases: readonly string[]; readonly passthrough?: boolean; readonly passthroughFlags?: readonly DaemonFlag[] }[];
}
interface DaemonHelpModule {
  renderGoodVibesDaemonHelp(binary?: string, platform?: NodeJS.Platform): string;
  renderDaemonCommandHelp(command: string, binary?: string, platform?: NodeJS.Platform): string | null;
  serviceKindForPlatform(platform?: NodeJS.Platform): string;
}

function commandBlock(binary: string, name: string, aliases: readonly string[], help: string): string {
  const alias = aliases.length > 0 ? `\n\nAlso answers to: ${aliases.map((entry) => code(`${binary} ${entry}`)).join(', ')}.` : '';
  return `### \`${binary} ${name}\`${alias}\n\n${fence(help)}`;
}

async function cliTerminal(): Promise<string> {
  const help = await loadProductModule<TuiHelpModule>('products/tui/src/cli/help.ts');
  const COMPLETION_COMMANDS = (await loadProductModule<TuiCompletionModule>('products/tui/src/cli/completions/generate.ts')).tuiCompletionTable('goodvibes').commands;
  const out = [`### \`goodvibes --help\``, '', fence(help.renderGoodVibesHelp('goodvibes'))];
  // Two command words can share one page (`remote` and `bridge`): print it once, under the first.
  const pages = new Map<string, { name: string; aliases: string[] }>();
  for (const command of [...COMPLETION_COMMANDS].sort((a, b) => byText(a.name, b.name))) {
    if (command.name === 'help' || command.name === 'version') continue;
    const page = help.renderGoodVibesCommandHelp(command.name, 'goodvibes');
    const aliases = command.aliases.filter((alias) => alias !== command.name);
    if (page.startsWith(NO_DETAILED_HELP)) {
      missingDescriptions.add(`goodvibes ${command.name}: no help page (help.ts COMMAND_HELP); its completion entry says: ${command.description}`);
      const lines = [sentence(command.description), ...(command.subcommands.length > 0 ? [`Subcommands: ${command.subcommands.map(code).join(', ')}.`] : [])];
      pages.set(`${command.name}\n${lines.join('\n')}`, { name: command.name, aliases });
      continue;
    }
    const seen = pages.get(page);
    // The page's own first line names the command it belongs to (`GoodVibes remote`).
    const owner = /^GoodVibes (\S+)/.exec(page)?.[1];
    if (seen && owner === command.name) {
      seen.aliases.push(seen.name, ...aliases);
      seen.name = command.name;
    } else if (seen) seen.aliases.push(command.name, ...aliases);
    else pages.set(page, { name: command.name, aliases: [...aliases] });
  }
  for (const [page, entry] of pages) {
    const aliases = [...new Set(entry.aliases)].filter((alias) => alias !== entry.name).sort(byText);
    if (page.startsWith(`${entry.name}\n`)) out.push('', `### \`goodvibes ${entry.name}\``, '', page.slice(entry.name.length + 1));
    else out.push('', commandBlock('goodvibes', entry.name, aliases, page));
  }
  counts.set('cli:goodvibes', pages.size);
  return out.join('\n');
}

async function cliAgent(): Promise<string> {
  const help = await loadProductModule<AgentHelpModule>('products/agent/src/cli/help.ts');
  const out = [`### \`goodvibes-agent --help\``, '', fence(help.renderGoodVibesHelp('goodvibes-agent'))];
  const topics = [...help.listGoodVibesHelpTopics()].sort(byText);
  for (const topic of topics) out.push('', commandBlock('goodvibes-agent', topic, [], help.renderGoodVibesCommandHelp(topic, 'goodvibes-agent')));
  counts.set('cli:goodvibes-agent', topics.length);
  return out.join('\n');
}

async function cliDaemon(): Promise<string> {
  const help = await loadProductModule<DaemonHelpModule>('products/daemon/src/cli/help.ts');
  const { DAEMON_COMMANDS } = await loadProductModule<DaemonCommandsModule>('products/daemon/src/cli/command-catalog.ts');
  const out = [
    `The pages below are rendered for Linux, where the service is a ${help.serviceKindForPlatform('linux')}. On macOS the same commands manage a ${help.serviceKindForPlatform('darwin')}.`,
    '',
    `### \`goodvibes-daemon --help\``, '', fence(help.renderGoodVibesDaemonHelp('goodvibes-daemon', 'linux')),
  ];
  const commands = [...DAEMON_COMMANDS].filter((command) => command.name !== 'help' && command.name !== 'version').sort((a, b) => byText(a.name, b.name));
  for (const command of commands) {
    const page = help.renderDaemonCommandHelp(command.name, 'goodvibes-daemon', 'linux');
    if (page === null) {
      problems.push(`goodvibes-daemon ${command.name} has no help page`);
      continue;
    }
    out.push('', commandBlock('goodvibes-daemon', command.name, command.aliases, page));
  }
  counts.set('cli:goodvibes-daemon', commands.length);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// slash:tui, slash:agent
// ---------------------------------------------------------------------------

interface SlashRecord {
  readonly name: string;
  readonly aliases?: readonly string[] | undefined;
  readonly description: string;
  readonly usage?: string | undefined;
  readonly argsHint?: string | undefined;
  readonly firstScreen?: boolean | undefined;
  readonly effect?: string | undefined;
  readonly readVerbs?: readonly string[] | undefined;
  readonly subcommands?: Readonly<Record<string, string>> | undefined;
  readonly confirm?: unknown;
}
interface SlashRegistry { getAll(): SlashRecord[]; register(command: SlashRecord): void }
interface TuiCommandsModule { categorizeBuiltinCommands(): { command: SlashRecord; category: string }[] }
interface CommandRegistryModule { CommandRegistry: new () => SlashRegistry }
interface WorkLedgerHostModule { registerNativeWorkLedgerCommand(registry: SlashRegistry, view: object): void }
interface AgentCommandsModule { registerBuiltinCommands(registry: SlashRegistry): void }

const EFFECT_WORDS: Readonly<Record<string, string>> = {
  'read-only': 'reads only',
  'local-state': 'changes local state',
  'connected-host-state': 'changes state on the connected daemon',
  'external-network': 'reaches an outside service',
  'ui-navigation': 'opens or moves between screens only',
  'session-lifecycle': 'starts, switches or ends a session',
  'delegated-work': 'hands work to an agent or another program',
  mixed: 'depends on the subcommand',
};

function renderSlash(command: SlashRecord, category: string | undefined): string {
  if (command.description.trim() === '') missingDescriptions.add(`slash command /${command.name}`);
  const usage = command.usage ?? command.argsHint;
  const facts: string[] = [];
  if (category) facts.push(`category ${category}`);
  if (command.aliases && command.aliases.length > 0) facts.push(`aliases ${command.aliases.map((alias) => code(`/${alias}`)).join(', ')}`);
  if (command.effect) {
    const reads = command.effect === 'mixed' && command.readVerbs && command.readVerbs.length > 0 ? ` (${command.readVerbs.map(code).join(', ')} only read)` : '';
    facts.push(`${EFFECT_WORDS[command.effect] ?? command.effect}${reads}`);
  }
  if (typeof command.confirm === 'function') facts.push('asks before a line that cannot be undone or changes access; `--yes` answers yes');
  if (command.firstScreen === false) facts.push('not on the first screen of the command list and /help; found as soon as its name is typed');
  const lines = [`- ${code(`/${command.name}`)}${usage ? ` ${code(usage.startsWith('/') ? usage : `/${command.name} ${usage}`.trim())}` : ''}: ${sentence(command.description)}`];
  if (facts.length > 0) lines.push(`  - ${sentence(facts.join('; ').replace(/^./, (c) => c.toUpperCase()))}`);
  for (const [sub, hint] of Object.entries(command.subcommands ?? {}).sort(([a], [b]) => byText(a, b))) {
    lines.push(`  - ${code(`/${command.name} ${sub}`)}${hint ? ` ${code(hint)}` : ''}`);
  }
  return lines.join('\n');
}

async function slashTui(): Promise<string> {
  const { categorizeBuiltinCommands } = await loadProductModule<TuiCommandsModule>('products/tui/src/input/commands.ts');
  const { CommandRegistry } = await loadProductModule<CommandRegistryModule>('products/tui/src/input/command-registry.ts');
  const { registerNativeWorkLedgerCommand } = await loadProductModule<WorkLedgerHostModule>('products/tui/src/runtime/native-work-ledger-host.ts');
  const entries = categorizeBuiltinCommands().map(({ command, category }) => ({ command, category }));
  // Registered beside the built-in groups at start-up (runtime/bootstrap-shell.ts).
  const extra = new CommandRegistry();
  registerNativeWorkLedgerCommand(extra, { selectProject: () => undefined });
  const known = new Set(entries.map((entry) => entry.command.name));
  for (const command of extra.getAll()) if (!known.has(command.name)) entries.push({ command, category: 'Work' });
  entries.sort((a, b) => byText(a.command.name, b.command.name));
  counts.set('slash:tui', entries.length);
  return entries.map((entry) => renderSlash(entry.command, entry.category)).join('\n');
}

async function slashAgent(): Promise<string> {
  const { registerBuiltinCommands } = await loadProductModule<AgentCommandsModule>('products/agent/src/input/commands.ts');
  const { CommandRegistry } = await loadProductModule<CommandRegistryModule>('products/agent/src/input/command-registry.ts');
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);
  const commands = registry.getAll().sort((a, b) => byText(a.name, b.name));
  counts.set('slash:agent', commands.length);
  return commands.map((command) => renderSlash(command, undefined)).join('\n');
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

interface ToolDefinitionLike {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly category?: string | undefined;
  readonly sideEffects?: readonly string[] | undefined;
}
interface ToolRegistryLike { getToolDefinitions(): ToolDefinitionLike[] }

type Schema = Record<string, unknown>;
const isSchema = (value: unknown): value is Schema => typeof value === 'object' && value !== null && !Array.isArray(value);

function schemaType(schema: Schema): string {
  if (Array.isArray(schema['enum'])) return 'one of ' + (schema['enum'] as unknown[]).map((value) => code(JSON.stringify(value))).join(', ');
  if (schema['const'] !== undefined) return `exactly ${code(JSON.stringify(schema['const']))}`;
  const variants = (schema['anyOf'] ?? schema['oneOf']) as unknown;
  if (Array.isArray(variants)) return variants.filter(isSchema).map(schemaType).join(' or ');
  const type = schema['type'];
  const name = Array.isArray(type) ? type.join(' or ') : typeof type === 'string' ? type : 'any';
  if (name === 'array' && isSchema(schema['items'])) return `array of ${schemaType(schema['items'])}`;
  return name;
}

function schemaLimits(schema: Schema): string[] {
  const facts: string[] = [];
  for (const [key, word] of [['minimum', 'at least'], ['maximum', 'at most'], ['minLength', 'length at least'], ['maxLength', 'length at most'], ['minItems', 'at least items:'], ['maxItems', 'at most items:']] as const) {
    if (typeof schema[key] === 'number') facts.push(`${word} ${String(schema[key])}`);
  }
  if (schema['default'] !== undefined) facts.push(`default ${code(JSON.stringify(schema['default']))}`);
  if (typeof schema['pattern'] === 'string') facts.push(`matches ${code(schema['pattern'])}`);
  return facts;
}

function renderProperties(schema: Schema, depth: number, out: string[], undescribed?: string[]): void {
  const properties = isSchema(schema['properties']) ? schema['properties'] : undefined;
  if (!properties) return;
  const required = new Set(Array.isArray(schema['required']) ? (schema['required'] as string[]) : []);
  const indent = '  '.repeat(depth);
  for (const [name, raw] of Object.entries(properties)) {
    if (!isSchema(raw)) continue;
    const facts = [schemaType(raw), required.has(name) ? 'required' : 'optional', ...schemaLimits(raw)];
    const description = typeof raw['description'] === 'string' && raw['description'].trim() !== '' ? sentence(raw['description']) : '';
    if (description === '' && undescribed) undescribed.push(name);
    out.push(`${indent}- ${code(name)} (${facts.join(', ')})${description ? `: ${description}` : '.'}`);
    const nested = raw['type'] === 'array' && isSchema(raw['items']) ? raw['items'] : raw;
    if (depth < 5) renderProperties(nested, depth + 1, out, undescribed);
  }
}

function renderTool(definition: ToolDefinitionLike, category: string | undefined): string {
  if (definition.description.trim() === '') missingDescriptions.add(`tool ${definition.name}`);
  const facts: string[] = [];
  // A tool that declares no category is decided as `delegate` (types/tools.ts).
  facts.push(`permission category ${code(category ?? 'delegate')}`);
  if (definition.sideEffects && definition.sideEffects.length > 0) facts.push(`side effects: ${definition.sideEffects.map(code).join(', ')}`);
  const out = [`### \`${definition.name}\``, '', sentence(definition.description)];
  if (definition.name === 'repl') out.push('', 'This tool is offered only where the command sandbox is available on the machine; elsewhere the model does not see it.');
  if (facts.length > 0) out.push('', sentence(facts.join('; ').replace(/^./, (c) => c.toUpperCase())));
  const inputs: string[] = [];
  const undescribed: string[] = [];
  renderProperties(definition.parameters, 0, inputs, undescribed);
  if (undescribed.length > 0) problems.push(`tool ${definition.name}: input${undescribed.length === 1 ? '' : 's'} with no description: ${undescribed.join(', ')}`);
  out.push('', inputs.length > 0 ? 'Inputs:' : 'Inputs: none.');
  if (inputs.length > 0) out.push('', ...inputs);
  return out.join('\n');
}

async function engineToolDefinitions(): Promise<readonly ToolDefinitionLike[]> {
  const { ConfigManager } = await import('../platform/src/platform/config/manager.ts');
  const { prepareConfiguredProjectContext } = await import('../platform/src/platform/knowledge/project-planning/configured-project.ts');
  const { RuntimeEventBus } = await import('../platform/src/platform/runtime/events/index.ts');
  const { composeRuntimeServices } = await import('../platform/src/platform/runtime/services.ts');
  const { createRuntimeStore } = await import('../platform/src/platform/runtime/store/index.ts');
  const { ToolRegistry } = await import('../platform/src/platform/tools/registry.ts');
  const { registerAllTools } = await import('../platform/src/platform/tools/index.ts');
  const { PersonalCaptureHolder } = await import('../platform/src/platform/personal-capture/index.ts');
  const { REPL_TOOL_SCHEMA } = await import('../platform/src/platform/tools/repl/schema.ts');
  const workingDir = join(SCRATCH_WORKSPACE, 'engine');
  mkdirSync(workingDir, { recursive: true });
  const configManager = new ConfigManager({ homeDir: SCRATCH_HOME, workingDir, surfaceRoot: 'tui' });
  await prepareConfiguredProjectContext(configManager, workingDir, undefined, { activate: true });
  const runtimeBus = new RuntimeEventBus();
  const roots = { configManager, runtimeBus, runtimeStore: createRuntimeStore(), surfaceRoot: 'tui', workingDir, homeDirectory: SCRATCH_HOME };
  const services = composeRuntimeServices({
    surface: 'tui', roots, hostSeams: roots, memoryStore: 'home',
    workspaceTrust: { kind: 'surface', requestTrustDecision: async () => 'trusted' },
    permissionHost: { raiseApproval: () => async () => ({ approved: false }) },
  });
  const registry = new ToolRegistry(services.permissionManager);
  // The optional collaborators each register one more tool; a host that has
  // them (the daemon, a terminal app) passes real ones. Only the definitions
  // are read here, so nothing is ever called on these.
  const unused = {} as never;
  registerAllTools(registry, {
    fileCache: services.fileCache, projectIndex: services.projectIndex, fileUndoManager: services.fileUndoManager,
    modeManager: services.modeManager, processManager: services.processManager, agentManager: services.agentManager,
    agentMessageBus: services.agentMessageBus, workflowServices: services.workflow, archetypeLoader: services.archetypeLoader,
    sessionOrchestration: services.sessionOrchestration, contractRunner: services.contractRunner, configManager,
    providerRegistry: services.providerRegistry, toolLLM: services.toolLLM, featureFlags: services.featureFlags,
    serviceRegistry: services.serviceRegistry, secretsManager: services.secretsManager, overflowHandler: services.overflowHandler,
    webSearchService: services.webSearchService, mcpRegistry: services.mcpRegistry, sandboxSessionRegistry: services.sandboxSessionRegistry,
    hookDispatcher: services.hookDispatcher, runtimeBus, workingDirectory: workingDir, projectRoot: workingDir, surfaceRoot: 'tui',
    resolveSessionId: () => 'llms-full', remoteRunnerRegistry: services.remoteRunnerRegistry, controlSurfaces: {},
    personalCapture: new PersonalCaptureHolder(), workPlan: unused, triggers: unused, ownerQuestions: unused,
  });
  // repl registers only where the command sandbox is available on this host; its definition is the same everywhere.
  const definitions = registry.getToolDefinitions().filter((definition) => definition.name !== 'repl');
  return [...definitions, REPL_TOOL_SCHEMA].sort((a, b) => byText(a.name, b.name));
}

interface AgentServicesModule { createRuntimeServices(options: Record<string, unknown>): Promise<Record<string, unknown> & { permissionManager: unknown; researchReportSourceOwner?: unknown; localReadSourceOwner?: unknown; shellPaths: unknown; providerRegistry: unknown }> }
interface AgentRegistryModule { composeAgentToolRegistry(deps: Record<string, unknown>): { toolRegistry: ToolRegistryLike } }
interface AgentBootstrapToolsModule { registerAgentTools(deps: Record<string, unknown>): void }

async function agentToolDefinitions(): Promise<readonly ToolDefinitionLike[]> {
  const { ConfigManager } = await import('../platform/src/platform/config/manager.ts');
  const { prepareConfiguredProjectContext } = await import('../platform/src/platform/knowledge/project-planning/configured-project.ts');
  const { RuntimeEventBus } = await import('../platform/src/platform/runtime/events/index.ts');
  const { createRuntimeStore } = await import('../platform/src/platform/runtime/store/index.ts');
  const { createRuntimeServices } = await loadProductModule<AgentServicesModule>('products/agent/src/runtime/services.ts');
  const { composeAgentToolRegistry } = await loadProductModule<AgentRegistryModule>('products/agent/src/runtime/agent-tool-registry.ts');
  const { registerAgentTools } = await loadProductModule<AgentBootstrapToolsModule>('products/agent/src/runtime/bootstrap-agent-tools.ts');
  const { CommandRegistry } = await loadProductModule<CommandRegistryModule>('products/agent/src/input/command-registry.ts');
  const workingDir = join(SCRATCH_WORKSPACE, 'agent');
  const configDir = join(SCRATCH_HOME, '.goodvibes', 'agent');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir, homeDir: SCRATCH_HOME, configDir });
  await prepareConfiguredProjectContext(configManager, workingDir, 'knowledge-agent.sqlite', { activate: true });
  const services = await createRuntimeServices({ modelDiscovery: 'skip', runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), configManager, workingDir, homeDirectory: SCRATCH_HOME });
  const { toolRegistry } = composeAgentToolRegistry({
    services, configManager, homeDirectory: SCRATCH_HOME, resolveSessionId: () => 'llms-full',
    researchReportSourceOwner: services.researchReportSourceOwner, researchSourceOwner: services.localReadSourceOwner,
  });
  // The same registration bootstrap.ts makes; the command context is read only for these fields while registering.
  const commandContext = {
    workspace: { shellPaths: services.shellPaths },
    provider: { providerRegistry: services.providerRegistry },
    platform: { config: configManager.getAll(), configManager },
    session: { runtime: { sessionId: 'llms-full' } },
    extensions: {}, ops: {},
  };
  registerAgentTools({ toolRegistry, commandRegistry: new CommandRegistry(), commandContext, configManager, services, getSessionId: () => 'llms-full' });
  // As above: repl is there exactly where the command sandbox is, so it is listed whatever this host has.
  const { REPL_TOOL_SCHEMA } = await import('../platform/src/platform/tools/repl/schema.ts');
  // The Agent shortens its registered definitions for the model (tool-definition-compaction.ts) and keeps
  // the originals; a reader is given the originals, with every input's meaning.
  const { fullToolDefinition } = await loadProductModule<{ fullToolDefinition(registry: unknown, name: string): ToolDefinitionLike | undefined }>('products/agent/src/tools/tool-definition-compaction.ts');
  const definitions = toolRegistry.getToolDefinitions().filter((definition) => definition.name !== 'repl')
    .map((definition) => fullToolDefinition(toolRegistry, definition.name) ?? definition);
  return [...definitions, REPL_TOOL_SCHEMA].sort((a, b) => byText(a.name, b.name));
}

async function toolsSection(): Promise<string> {
  const { toolCategoryOf } = await import('../platform/src/platform/types/tools.ts');
  const renderWithCategory = (definition: ToolDefinitionLike): string => renderTool(definition, toolCategoryOf({ name: definition.name, category: definition.category as Parameters<typeof toolCategoryOf>[0]['category'] }));
  const engine = await engineToolDefinitions();
  const agent = await agentToolDefinitions();
  const engineNames = new Set(engine.map((definition) => definition.name));
  const agentNames = new Set(agent.map((definition) => definition.name));
  const out: string[] = [
    '### Tools of the terminal app, the daemon\'s hosted sessions and helper agents',
    '',
    `These ${engine.length} tools are the platform's own. Each line under a tool names one input: its type, whether it is required, and what it means. Nested inputs are indented under their parent.`,
    `Not in Agent: ${engine.filter((definition) => !agentNames.has(definition.name)).map((definition) => code(definition.name)).join(', ') || 'none'}.`,
  ];
  for (const definition of engine) out.push('', renderWithCategory(definition));
  const agentOnly = agent.filter((definition) => !engineNames.has(definition.name));
  out.push('', '### Tools only Agent has', '', `Agent has the platform tools above (except those listed as not in Agent) and these ${agentOnly.length} more.`);
  for (const definition of agentOnly) out.push('', renderWithCategory(definition));
  counts.set('tools', engine.length + agentOnly.length);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// exit-codes
// ---------------------------------------------------------------------------

async function exitCodesSection(): Promise<string> {
  const source = readFileSync(join(REPO_ROOT, 'docs/exit-codes.md'), 'utf8');
  const lines = source.split('\n');
  const body: string[] = [];
  for (const line of lines) {
    if (line.startsWith('# ')) continue;
    // Links into the repository mean nothing to a reader of this file.
    if (/^Details: \[/.test(line) || /^\[[^\]]+\]\([^)]*\.md[^)]*\)[,.]?$/.test(line)) continue;
    body.push(line.replace(/^## /, '### '));
  }
  let text = body.join('\n').trim();
  text = text.replace(/\n{3,}/g, '\n\n');
  // The numbers the code declares must each appear in the table.
  const { EXIT_OK, EXIT_FAILED, EXIT_AWAITING_OWNER, EXIT_USAGE, EXIT_INTERRUPTED } = await import('../platform/src/platform/contract/cli.ts');
  interface ServiceExitModule { readonly SERVICE_STATUS_EXIT_RUNNING: number; readonly SERVICE_STATUS_EXIT_INSTALLED_NOT_RUNNING: number; readonly SERVICE_STATUS_EXIT_NOT_INSTALLED: number; readonly SERVICE_EXIT_NOT_OURS: number }
  const service = await loadProductModule<ServiceExitModule>('products/daemon/src/daemon/service-commands.ts');
  const declared = [EXIT_OK, EXIT_FAILED, EXIT_AWAITING_OWNER, EXIT_USAGE, EXIT_INTERRUPTED, service.SERVICE_STATUS_EXIT_RUNNING,
    service.SERVICE_STATUS_EXIT_INSTALLED_NOT_RUNNING, service.SERVICE_STATUS_EXIT_NOT_INSTALLED, service.SERVICE_EXIT_NOT_OURS, 124];
  for (const value of declared) if (!text.includes(`| \`${value}\` |`)) problems.push(`docs/exit-codes.md has no row for exit code ${value}, which the code declares`);
  counts.set('exit-codes', (text.match(/^\| `\d+` \|/gm) ?? []).length);
  return text;
}

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

/** Every environment variable name the programs and the installer read, found in their sources. */
function scanEnvironmentReads(): Map<string, Set<string>> {
  const patterns = [
    /process\.env\.([A-Z_][A-Z0-9_]*)/g,
    /process\.env\[\s*['"`]([A-Z_][A-Z0-9_]*)['"`]\s*\]/g,
    /Bun\.env\.([A-Z_][A-Z0-9_]*)/g,
    /(?<!delete )\benv\??\.(?:\[\s*['"`])?([A-Z][A-Z0-9_]{2,})\b/g,
    /\benv\[\s*['"`]([A-Z][A-Z0-9_]{2,})['"`]\s*\]/g,
    /\b(?!\w*[Ee]nvelope)\w*[Ee]nv\w*\(\s*['"`]([A-Z][A-Z0-9_]{2,})['"`]/g,
    /\b\w*(?:_ENV|_ENV_VAR|_ENV_NAME|Env|EnvVar|EnvName)\s*[:=]\s*['"`]([A-Z][A-Z0-9_]{2,})['"`]/g,
    // A credential source tagged as the environment: { kind: 'env', name: 'X' } (either field first).
    /\b(?:kind|type|source)\s*:\s*['"`]env['"`]\s*,\s*(?:name|key|variable)\s*:\s*['"`]([A-Z][A-Z0-9_]{2,})['"`]/g,
    /\b(?:name|key|variable)\s*:\s*['"`]([A-Z][A-Z0-9_]{2,})['"`]\s*,\s*(?:kind|type|source)\s*:\s*['"`]env['"`]/g,
  ];
  const lists = [
    /\b\w*(?:[Ee]nv[A-Z]\w*|[Ee]nvVars|[Ee]nvKeys|ENV_VARS|ENV_KEYS)\s*[:=]\s*\[([^\]]*)\]/g,
    // A list of names handed to an env-reading helper: pickEnv(env, ['A', 'B']).
    /\b(?!\w*[Ee]nvelope)\w*[Ee]nv\w*\([^()[\]]*\[([^\]]*)\]/g,
  ];
  const found = new Map<string, Set<string>>();
  const note = (name: string, where: string): void => {
    let set = found.get(name);
    if (!set) found.set(name, (set = new Set()));
    set.add(where);
  };
  const skip = /(^|\/)(test|tests|e2e|testing|fixtures|test-helpers|generated)\//;
  const scanFile = (path: string, product: string): void => {
    // Comment lines name variables in examples and explanations; only code counts.
    const text = readFileSync(path, 'utf8').split('\n').filter((line) => !/^\s*(?:\*|\/\*|\/\/)/.test(line)).join('\n');
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) note(match[1]!, product);
    for (const list of lists) for (const match of text.matchAll(list)) for (const item of match[1]!.matchAll(/['"`]([A-Z][A-Z0-9_]{2,})['"`]/g)) note(item[1]!, product);
  };
  const walk = (directory: string, product: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relative = path.slice(REPO_ROOT.length + 1);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || skip.test(`${relative}/`)) continue;
        walk(path, product);
        continue;
      }
      const launcher = /(^|\/)bin\/[^/.]+$/.test(relative);
      if ((!launcher && !/\.(ts|tsx|mts)$/.test(entry.name)) || /\.(test|spec)\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
      scanFile(path, product);
    }
  };
  for (const root of ENV_SCAN_ROOTS) {
    const path = join(REPO_ROOT, root.path);
    if (root.path.endsWith('.ts')) scanFile(path, root.product);
    else if (existsSync(path)) walk(path, root.product);
  }
  for (const file of ENV_SCAN_SHELL_FILES) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    const assigned = new Set([...text.matchAll(/(?:^|[\s;(])(?:local\s+|export\s+|readonly\s+)?([A-Z_][A-Z0-9_]*)=/gm)].map((match) => match[1]!));
    for (const match of text.matchAll(/\$\{([A-Z_][A-Z0-9_]*)[:}?-]/g)) if (!assigned.has(match[1]!)) note(match[1]!, 'installer');
    for (const match of text.matchAll(/\$\{([A-Z_][A-Z0-9_]*)[:}?-]/g)) if (assigned.has(match[1]!) && /^GOODVIBES_/.test(match[1]!)) note(match[1]!, 'installer');
  }
  return found;
}

async function envSection(): Promise<string> {
  const { BUILTIN_PROVIDER_ENV_KEYS } = await import('../platform/src/platform/config/provider-credential-catalog.ts');
  const { CREDENTIAL_SCOPE_DECLARATIONS } = await import('../platform/src/platform/config/credential-scope-registry.ts');
  const { CONFIG_KEYS } = await import('../platform/src/platform/config/schema.ts');
  const described = new Map<string, EnvEntry>();
  for (const entry of ENV_CATALOG) {
    if (described.has(entry.name)) problems.push(`environment variable ${entry.name} is described twice in generate-llms-full-env.ts`);
    described.set(entry.name, entry);
    if (entry.setting && !CONFIG_KEYS.has(entry.setting.key)) problems.push(`environment variable ${entry.name} names setting ${entry.setting.key}, which does not exist`);
  }
  // Provider keys: read from the environment first, then the secret store.
  const providerByVar = new Map<string, string[]>();
  for (const [provider, names] of Object.entries(BUILTIN_PROVIDER_ENV_KEYS)) {
    for (const name of names) providerByVar.set(name, [...(providerByVar.get(name) ?? []), provider]);
  }
  // Stored credentials: a variable of the same name is read before the secret store.
  const credentialByVar = new Map<string, string>();
  for (const declaration of CREDENTIAL_SCOPE_DECLARATIONS) {
    if (declaration.match === 'exact' && /^[A-Z][A-Z0-9_]+$/.test(declaration.key)) credentialByVar.set(declaration.key, declaration.why);
  }
  const read = scanEnvironmentReads();
  for (const name of Object.keys(ENV_SCAN_IGNORED)) {
    if (!read.has(name)) problems.push(`ENV_SCAN_IGNORED names ${name}, which the scan no longer finds`);
    read.delete(name);
  }
  const unexplained = [...read.keys()].filter((name) => !described.has(name) && !providerByVar.has(name) && !credentialByVar.has(name)).sort(byText);
  for (const name of unexplained) problems.push(`environment variable ${name} is read (${[...read.get(name)!].sort(byText).join(', ')}) but generate-llms-full-env.ts does not describe it`);
  for (const entry of ENV_CATALOG) {
    if (!entry.internal && !read.has(entry.name) && !providerByVar.has(entry.name) && !credentialByVar.has(entry.name) && !entry.readIndirectly) {
      problems.push(`environment variable ${entry.name} is described in generate-llms-full-env.ts but no source reads it`);
    }
  }
  const names = new Set<string>([...described.keys(), ...providerByVar.keys(), ...credentialByVar.keys()]);
  const rows = [...names].sort(byText).map((name) => {
    const entry = described.get(name);
    const readers = entry?.readBy ?? (read.has(name) ? [...read.get(name)!].sort(byText).join(', ') : 'every program');
    let what: string;
    if (entry) what = entry.does;
    else if (providerByVar.has(name)) {
      const providers = providerByVar.get(name)!;
      what = `A sign-in value (key, token, profile or project) the ${providers.map(code).join(', ')} provider${providers.length > 1 ? 's read' : ' reads'}; read before a secret of the same name in the secret store.`;
    }
    else what = `A credential, read before a stored secret of the same name. ${credentialByVar.get(name)!}`;
    if (entry?.setting) what = `${sentence(what)} Setting: ${code(entry.setting.key)} (${entry.setting.relation}).`;
    if (entry?.internal) what = `${sentence(what)} Set by GoodVibes itself; do not set it by hand.`;
    return `| ${code(name)} | ${cell(readers)} | ${cell(sentence(what))} |`;
  });
  counts.set('env', rows.length);
  return ['| Variable | Read by | What it does |', '| --- | --- | --- |', ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// installer-options
// ---------------------------------------------------------------------------

interface InstallerOption { readonly tokens: readonly string[]; readonly value?: string | undefined; readonly does: string }

/** The `  --flag VALUE   text` lines of a help text, joined with their continuation lines. */
function helpOptions(help: string): Map<string, InstallerOption> {
  const options = new Map<string, InstallerOption>();
  let last: { tokens: string[]; value: string | undefined; does: string } | undefined;
  const flush = (): void => {
    if (!last) return;
    for (const token of last.tokens) options.set(token, { tokens: last.tokens, value: last.value, does: last.does.trim() });
    last = undefined;
  };
  for (const line of help.split('\n')) {
    const match = /^\s{2}((?:-{1,2}[a-z][a-z-]*)(?:\|(?:-{1,2}[a-z][a-z-]*))*)(?: ([A-Z][A-Z_]*))?\s{2,}(\S.*)$/.exec(line);
    if (match) {
      flush();
      last = { tokens: match[1]!.split('|'), value: match[2], does: match[3]! };
      continue;
    }
    const continuation = /^\s{6,}(\S.*)$/.exec(line);
    if (last && continuation) last.does += ` ${continuation[1]}`;
    else flush();
  }
  flush();
  return options;
}

/** The help text between a `--help|-h)` case arm and its `exit 0`. */
function shellHelp(path: string): string {
  const text = readFileSync(join(REPO_ROOT, path), 'utf8');
  const arm = /--help\|-h\)([\s\S]*?)exit 0/.exec(text);
  if (!arm) {
    problems.push(`${path}: no --help case arm`);
    return '';
  }
  const heredoc = /<<'HELP'\n([\s\S]*?)\nHELP/.exec(arm[1]!);
  if (heredoc) return heredoc[1]!;
  // say '...' / echo '...' lines.
  return [...arm[1]!.matchAll(/(?:say|echo) '((?:[^'\\]|\\.)*)'/g)].map((match) => match[1]!).join('\n');
}

function installerTable(path: string, help: string, accepted: readonly string[]): string {
  const described = helpOptions(help);
  const rows: string[] = [];
  const seen = new Set<string>();
  for (const token of accepted) {
    const option = described.get(token);
    if (!option) {
      problems.push(`${path} accepts ${token} but its --help does not describe it`);
      continue;
    }
    const key = option.tokens.join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(`| ${option.tokens.map(code).join(', ')} | ${option.value ? code(option.value) : ''} | ${cell(sentence(option.does))} |`);
  }
  for (const token of described.keys()) if (!accepted.includes(token)) problems.push(`${path} --help describes ${token}, which its parser does not accept`);
  return ['| Option | Value | What it does |', '| --- | --- | --- |', ...rows].join('\n');
}

function shellCaseOptions(path: string, functionOrLoop: RegExp): string[] {
  const text = readFileSync(join(REPO_ROOT, path), 'utf8');
  const body = functionOrLoop.exec(text)?.[1] ?? '';
  const tokens = new Set<string>();
  for (const arm of body.matchAll(/^\s*((?:-{1,2}[a-z][a-z-]*)(?:\|-{1,2}[a-z][a-z-]*)*)\)/gm)) for (const token of arm[1]!.split('|')) tokens.add(token);
  return [...tokens];
}

function installerOptionsSection(): string {
  const releaseAccepted = shellCaseOptions('scripts/install.sh', /parse_options\(\) \{([\s\S]*?)\n\}/);
  const checkoutText = readFileSync(join(REPO_ROOT, 'scripts/install.ts'), 'utf8');
  const valued = /\[((?:'--[a-z-]+',?\s*)+)\]\.includes\(flag\)/.exec(checkoutText)?.[1] ?? '';
  const checkoutAccepted = [
    ...shellCaseOptions('scripts/install-from-checkout.sh', /case "\$\{1:-\}" in([\s\S]*?)\nesac/),
    ...[...checkoutText.matchAll(/flag === '(--[a-z-]+)'/g)].map((match) => match[1]!),
    // The wrapper passes --runtime-dir itself; it is not an option a person gives.
    ...[...valued.matchAll(/'(--[a-z-]+)'/g)].map((match) => match[1]!).filter((token) => token !== '--runtime-dir'),
  ];
  const uninstallAccepted = shellCaseOptions('scripts/uninstall.sh', /while \[ "\$#" -gt 0 \]; do([\s\S]*?)\ndone/);
  const sections = [
    '### `scripts/install.sh` (released programs)', '',
    installerTable('scripts/install.sh', shellHelp('scripts/install.sh'), releaseAccepted), '',
    '### `scripts/install-from-checkout.sh` (build from a clone of the repository)', '',
    installerTable('scripts/install-from-checkout.sh', shellHelp('scripts/install-from-checkout.sh'), [...new Set(checkoutAccepted)]), '',
    '### `scripts/uninstall.sh`', '',
    installerTable('scripts/uninstall.sh', shellHelp('scripts/uninstall.sh'), uninstallAccepted),
  ];
  counts.set('installer-options', new Set([...releaseAccepted, ...checkoutAccepted, ...uninstallAccepted]).size);
  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// operator-methods, events, error-kinds
// ---------------------------------------------------------------------------

async function operatorContract() {
  const { GatewayMethodCatalog } = await import('../platform/src/platform/control-plane/method-catalog.ts');
  const { buildOperatorContract } = await import('../platform/src/platform/control-plane/operator-contract.ts');
  return buildOperatorContract(new GatewayMethodCatalog());
}

/**
 * A description as one table cell. It is never cut to a first sentence: a later sentence often
 * carries the condition or exception that decides what the entry means, and no split on `. `
 * is safe against abbreviations, versions and code.
 */
const wholeDescription = (text: string): string => sentence(text.replace(/\s+/g, ' ').trim());

async function operatorMethodsSection(): Promise<string> {
  const contract = await operatorContract();
  const { GATEWAY_METHOD_INVOKE_PATH } = await import('../daemon-api/src/operator.ts');
  const methods = [...contract.operator.methods].sort((a, b) => byText(a.id, b.id));
  const categories = [...new Set(methods.map((method) => method.category))].sort(byText);
  const out: string[] = [
    `A method with no HTTP route is called with ${code(`POST ${GATEWAY_METHOD_INVOKE_PATH}`)} (the method id in place of ${code('{methodId}')}) or over the WebSocket. The invoke request body is an envelope: ${code('{ "body": <method input>, "query": { ... } }')}, where ${code('body')} is required (${code('{}')} for a method that takes none) and ${code('query')} is optional; the response is the method output itself. Access: ${code('public')} needs no credential; ${code('authenticated')} needs any credential that carries every listed scope; ${code('admin')} needs an admin credential (an admin user's session, the daemon's operator token, or a token with no scope list) as well as the scopes; ${code('remote-peer')} is for a paired node or device. Effect: ${code('read')} changes nothing, ${code('write')} changes the daemon's state, ${code('outward')} sends messages, drives a remote host or browser, or runs metered model work. Retry is what the method declares (its ${code('repeat')}) about sending the same call again after a failure or a lost answer, read from its handler: safe to repeat, safe with a key (the header or body field named, and what a repeat returns; ${code('Idempotency-Key')} is the shared key explained in "Idempotency and safe retries"), or not safe (a repeat acts again).`,
  ];
  const retryCounts = new Map<string, number>();
  for (const category of categories) {
    out.push('', `### ${category}`, '', '| Method | HTTP route | Access | Scopes | Effect | Retry | What it does |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const method of methods.filter((entry) => entry.category === category)) {
      if (method.description.trim() === '') missingDescriptions.add(`operator method ${method.id}`);
      const route = method.http ? code(`${method.http.method} ${method.http.path}`) : 'invoke only';
      const flags = [method.ownerOnly ? 'owner only' : '', method.irreversible ? 'cannot be undone' : '', method.dangerous ? 'dangerous' : ''].filter(Boolean).join(', ');
      // The shared Idempotency-Key is explained once in "Idempotency and safe retries"; its behaviour is not repeated per row.
      const retry = method.replay
        ? method.replay.in === 'header' && method.replay.name === 'Idempotency-Key' && method.id !== 'contracts.start'
          ? `safe with the header ${code('Idempotency-Key')}`
          : `safe with the ${method.replay.in} ${code(method.replay.name)}: ${cell(method.replay.behavior)}`
        : method.repeat === 'safe' ? 'safe to repeat' : method.repeat === 'unsafe' ? 'not safe' : 'not declared';
      retryCounts.set(retry.startsWith('safe with') ? 'safe with a key' : retry, (retryCounts.get(retry.startsWith('safe with') ? 'safe with a key' : retry) ?? 0) + 1);
      out.push(`| ${code(method.id)} | ${route} | ${method.access} | ${method.scopes.map(code).join(', ') || 'none'} | ${method.effect ?? ''}${flags ? ` (${flags})` : ''} | ${retry} | ${cell(wholeDescription(method.description || method.title))} |`);
    }
  }
  for (const [kind, count] of retryCounts) counts.set(`operator-methods retry: ${kind}`, count);
  counts.set('operator-methods', methods.length);
  return out.join('\n');
}

interface EventMember { readonly type: string; readonly doc: string }

/** Every runtime event type by domain, with its doc comment, read from the event unions with the type checker. */
async function runtimeEventsByDomain(): Promise<Map<string, EventMember[]>> {
  const ts = (await import('typescript')).default;
  const platformRoot = join(ENGINE_ROOT, 'platform');
  const domainMap = join(platformRoot, 'src/events/domain-map.ts');
  const parsed = ts.getParsedCommandLineOfConfigFile(join(platformRoot, 'tsconfig.json'), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); },
  });
  if (!parsed) throw new Error('cannot read the platform tsconfig');
  const program = ts.createProgram({ rootNames: [domainMap], options: { ...parsed.options, noEmit: true, composite: false, incremental: false } });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(domainMap);
  const alias = source?.statements.find((statement): statement is import('typescript').TypeAliasDeclaration => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'DomainEventMap');
  if (!alias) throw new Error('DomainEventMap is not declared in domain-map.ts');
  const out = new Map<string, EventMember[]>();
  const mapType = checker.getTypeAtLocation(alias.name);
  for (const property of checker.getPropertiesOfType(mapType)) {
    const union = checker.getTypeOfSymbol(property);
    const members = union.isUnion() ? union.types : [union];
    const events: EventMember[] = [];
    for (const member of members) {
      const typeSymbol = member.getProperty('type');
      if (!typeSymbol) continue;
      const discriminant = checker.getTypeOfSymbol(typeSymbol);
      if (!discriminant.isStringLiteral()) continue;
      let doc = '';
      // Find the union member that declares this `type`: walk up from the property to the node directly under the union.
      const typeDeclaration = typeSymbol.declarations?.[0];
      let memberNode: import('typescript').Node | undefined;
      for (let node: import('typescript').Node | undefined = typeDeclaration; node; node = node.parent) {
        if (node.parent && ts.isUnionTypeNode(node.parent)) { memberNode = node; break; }
      }
      const declaration = memberNode ?? member.getSymbol()?.declarations?.[0];
      if (declaration) {
        // The doc comment of a union member sits before its `|`, outside the member's own node.
        const file = declaration.getSourceFile();
        const text = file.text;
        let at = declaration.getStart(file) - 1;
        while (at >= 0 && /\s/.test(text[at]!)) at -= 1;
        if (text[at] === '|') {
          at -= 1;
          while (at >= 0 && /\s/.test(text[at]!)) at -= 1;
        }
        if (text.slice(at - 1, at + 1) === '*/') {
          const open = text.lastIndexOf('/**', at);
          if (open >= 0) doc = text.slice(open + 3, at - 1).split('\n').map((line) => line.replace(/^\s*\*\s?/, '')).join(' ').replace(/\s+/g, ' ').trim();
        }
      }
      // Some members document their `type` property instead.
      if (doc === '') doc = ts.displayPartsToString(typeSymbol.getDocumentationComment(checker)).replace(/\s+/g, ' ').trim();
      events.push({ type: discriminant.value, doc });
    }
    out.set(property.getName(), events.sort((a, b) => byText(a.type, b.type)));
  }
  return out;
}

async function eventsSection(): Promise<string> {
  const contract = await operatorContract();
  const { EVENT_FIELD_RULES } = await import('../platform/src/events/contracts/event-rules.generated.ts');
  const { gatewayEventAccess } = await import('../platform/src/platform/control-plane/method-catalog-events.ts');
  const out: string[] = [
    '### Event streams a client subscribes to', '',
    'Open the stream with `GET /api/control-plane/events?domains=<comma list>`. "SSE name" is the `event:` name each frame carries on the stream; the catalog name is the id the operator contract lists. Access `authenticated` means any credential holding the scopes; `admin` also needs an admin credential (an admin user\'s session, the daemon\'s operator token, or a token with no scope list). A stream asked for domains the credential may not receive opens with the allowed ones and names the rest in `withheldDomains` on its `ready` frame; when none is allowed the request is refused with `403` and code `EVENT_ACCESS_DENIED`.', '',
    '| Catalog name | SSE name | Domains | Access | Scopes | What it carries |', '| --- | --- | --- | --- | --- | --- |',
  ];
  const domainAccess = new Map<string, string>();
  for (const event of [...contract.operator.events].sort((a, b) => byText(a.id, b.id))) {
    const access = gatewayEventAccess({ id: event.id, category: event.category, domains: event.domains });
    if (event.category === 'runtime-domain') for (const domain of event.domains ?? []) domainAccess.set(domain, access);
    out.push(`| ${code(event.id)} | ${(event.wireEvents ?? []).map(code).join(', ')} | ${(event.domains ?? []).map(code).join(', ')} | ${access} | ${event.scopes.map(code).join(', ') || 'none'} | ${cell(wholeDescription(event.description || event.title))} |`);
  }
  const domains = await runtimeEventsByDomain();
  let total = 0;
  out.push('', '### Runtime events by domain', '', 'Each event is a JSON object whose `type` is the name below. The fields after the name are the rest of the object; a `?` marks an optional field.');
  for (const domain of [...domains.keys()].sort(byText)) {
    const events = domains.get(domain)!;
    out.push('', `Domain ${code(domain)} (access: ${domainAccess.get(domain) ?? 'admin'}):`, '');
    for (const event of events) {
      total += 1;
      const table: Readonly<Record<string, Readonly<Record<string, { readonly kind: string; readonly optional?: true | undefined; readonly values?: readonly string[] | undefined }>>>> = EVENT_FIELD_RULES;
      const rules = table[event.type] ?? {};
      const fields = Object.entries(rules).map(([field, rule]) => `${field}${rule.optional ? '?' : ''}: ${rule.values ? rule.values.map((value) => JSON.stringify(value)).join('|') : rule.kind}`);
      if (event.doc === '') missingDescriptions.add(`runtime event ${event.type} (domain ${domain})`);
      out.push(`- ${code(event.type)}${fields.length > 0 ? ` { ${fields.join(', ')} }` : ''}${event.doc ? `: ${sentence(event.doc)}` : ''}`);
    }
  }
  counts.set('events', contract.operator.events.length + total);
  return out.join('\n');
}

/**
 * What a route code means where the route builds its message at run time (from an error it caught),
 * so the scan finds no text beside it. A code here that the scan stops finding, or that gains a
 * message of its own, is reported so this list does not outlive the code.
 */
const ROUTE_CODE_MEANINGS: Readonly<Record<string, string>> = {
  ALREADY_ANSWERED: 'The item was already answered; the message says by whom and with what, and the first answer stands',
  BATCH_ERROR: 'A batch request failed for a reason other than its input; the message says why',
  BROWSER_ELEMENT_STALE: 'The page changed under the element reference, so nothing was done; take a new snapshot and use a current reference',
  BROWSER_REQUEST_FAILED: 'The browser failed the request; the message is its error',
  CLUSTER_SHARING_OFF: 'A machine-group action was refused because sharing inbound work with the group is switched off on this machine; nothing was changed; send it again with turnOnSharing true (the owner\'s yes), and it is kept and finishes when the daemon restarts',
  CLOUDFLARE_ERROR: 'A Cloudflare operation failed; the message names the step, what was done before it, and that nothing was rolled back',
  COMPANION_CHAT_CLIENT_RATE_LIMIT: 'This client has sent its limit of companion chat messages in the last minute; wait the seconds the message names',
  COMPANION_CHAT_SESSION_RATE_LIMIT: 'This chat session has sent its limit of messages in the last minute; wait the seconds the message names, or start a new session',
  EMAIL_CREDENTIALS_UNREADABLE: 'The secret store on this computer could not be read, so the mail password could not be read; nothing is read from or sent through the mailbox until it can be, and nothing already given is asked for again',
  EMAIL_DELIVERY_UNCONFIRMED:'The mail server did not confirm it took the message, so it may have been sent; the same clientSendId answers this again instead of mailing twice',
  EMAIL_MAILBOX_UNAVAILABLE: 'The mail server reported the mailbox unavailable; nothing was sent',
  EMAIL_NOT_CONFIGURED: 'Email is not configured: set surfaces.email.host (surfaces.email.imap.host for the inbox), surfaces.email.user and the email password secret',
  EMAIL_NOT_ENABLED: 'The email surface is turned off',
  FLEET_CAPACITY: 'The fleet is full, so no agent was started',
  HOSTED_CLIENT_FORBIDDEN: 'The hosted session belongs to another client (clientId), so this client may not act on it',
  HOSTED_SESSION_LIMIT_REACHED: 'hostedSessions.maxSessions live sessions already exist; end one or raise the limit, then create again',
  HOSTED_SESSION_NOT_READY: 'The session exists but is not ready and nothing ran; send the same call again shortly',
  HOSTED_SESSION_TERMINATED: 'The session exists and has ended for good (the message gives the recorded reason); nothing sent to it can run, so start a new session',
  HOSTED_SESSION_UNAVAILABLE: 'The session exists but its loop could not be composed or was shut down mid-delivery; it may still be live, so do not create a second one for the same conversation',
  HOST_REQUEST_HANDLER_FAILED: 'The daemon\'s request handler failed unexpectedly; the message says why',
  INVALID_PATH_ENCODING: 'The request path has a percent-encoding that does not decode',
  KNOWLEDGE_REFINEMENT_TASK_REFUSED: 'The knowledge refinement task is unknown or already decided, so it was not changed',
  MEDIA_OUTPUT_UNAVAILABLE: 'No configured media provider makes the requested output, or the named one does not; nothing was sent',
  NOT_A_SESSION_ANSWER: 'The item has no answer to deliver, or its answer goes to an agent, which records taking it',
  APPROVAL_WRITE_IN_APPROVED_CHANGE: 'An approved change\'s handler tried to raise, answer or change an approval while its own approval was being applied; that write was refused and nothing was written; the message names the handler and the approval',
  CARD_ENTRY_TRANSPORT: 'Card details are not taken over this connection, because it reaches the daemon unencrypted over the network; nothing was sent or stored; enter the card on the daemon\'s own machine, over https (controlPlane.tls), or over the machine\'s Tailscale address',
  HANDLER_FAILED: 'The method\'s handler failed for a reason other than a refusal; the message is its error',
  OWNER_APPROVAL_REQUIRED: 'The act needs the owner\'s approval first and nothing was done: a purchase begun with payments.confirmEveryPurchase on and no matching owner approval (the message says whether the approval is missing, expired or for a different purchase), or a settings change that would loosen a security, permission, judgment or payment setting (send it through config.set or config.setMany, which puts it to the owner)',
  APPROVED_NOT_APPLIED: 'The owner approved the change, but applying it failed; the approval stays recorded and the message says why; fix the cause and make the change again',
  REMEMBER_NOT_SAVED: 'The answer asked to be remembered, but its rule could not be saved; nothing was decided and the ask is still waiting; answer it again, or without remembering',
  NOT_APPLIED: 'An approval answer relayed from another machine of the group could not be applied; the message says why; read the approval again',
  REROOT_FAILED: 'The new working directory could not be saved to the daemon settings; nothing changed',
  SET_MODEL_FAILED: 'The model could not be made current; the message is the provider registry\'s reason',
  UNTRUSTED_CONTENT_BLOCKED_EFFECT: 'This turn read content from a web page, so a browser action with an outward effect is refused',
  UNTRUSTED_CONTENT_DERIVED: 'The message would send content derived from untrusted text, which needs the owner',
  WORKSPACE_BUSY: 'The daemon is already moving to another working directory; retry after the Retry-After seconds',
};

/** Modules outside the route folders whose refusals a route answers as they are, with the status it answers them with. */
const ROUTE_REFUSAL_SOURCES: Readonly<Record<string, number>> = {
  'packages/engine/platform/src/platform/pairing/pairing-token-store.ts': 401,
};

/**
 * Codes whose first message in the sources is not the one a client receives: another layer answers
 * first. Each names that layer.
 */
const ROUTE_CODE_ANSWERED_ELSEWHERE: Readonly<Record<string, string>> = {
  // The gateway gate (daemon/http/gateway-binding-gate.ts) refuses an owner-only method called with the Agent's credential before any route runs.
  OWNER_ONLY: '<method> is the owner\'s own act; a call the Agent makes for him is refused. The owner does it from his own app. A settings change the Agent makes that would loosen security is refused with this code too, naming the setting',
};

/** Where the status alone would mislead about retrying: what has to change first. */
const ROUTE_CODE_RETRY: Readonly<Record<string, string>> = {
  HOSTED_SESSION_LIMIT_REACHED: 'only after a session ends or hostedSessions.maxSessions is raised; waiting alone does not help',
  PAIRING_TOKEN_ROTATION_DUE: 'only with a new token: pair the device again',
  HOSTED_SESSION_TERMINATED: 'never for this session: create a new one',
};

/** Codes the scan finds that never reach a client: an internal error a route catches and answers with another code. */
const ROUTE_CODES_NOT_ANSWERED: Readonly<Record<string, string>> = {
  OTLP_PROTOBUF_DECODE_ERROR: 'the OTLP route answers INVALID_PAYLOAD instead',
};

/** The object literal around `at` (its text without the braces) and the source right after it, or undefined. */
function enclosingObject(text: string, at: number): { readonly body: string; readonly tail: string; readonly lead: string } | undefined {
  let depth = 0;
  let open = -1;
  for (let index = at; index >= 0 && at - index < 4000; index--) {
    const char = text[index];
    if (char === '}') depth += 1;
    else if (char === '{') {
      if (depth === 0) { open = index; break; }
      depth -= 1;
    }
  }
  if (open < 0) return undefined;
  depth = 0;
  for (let index = open; index < text.length && index - open < 6000; index++) {
    const char = text[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, index), tail: text.slice(index + 1, index + 80), lead: text.slice(Math.max(0, open - 600), open) };
    }
  }
  return undefined;
}

/**
 * Every error code a daemon route or gateway method can answer with, read from the code that
 * raises it: a `GatewayVerbError(message, CODE, status)`, or an object with `code: 'CODE'` in a
 * route module, with the status, category, `recoverable` and message written beside it.
 */
function scanRouteErrorCodes(): Map<string, { statuses: number[]; categories: string[]; recoverable?: boolean; meaning: string; carried: boolean }> {
  const found = new Map<string, { statuses: number[]; categories: string[]; recoverable?: boolean; meaning: string; carried: boolean }>();
  const routeDirectories = ['packages/engine/daemon-api/src', 'packages/engine/platform/src/platform/daemon', 'packages/engine/platform/src/platform/control-plane', 'packages/engine/platform/src/platform/companion'];
  // An answer that was not applied carries its refusal in a successful body; these modules answer that way.
  const carriedIn = /\/(owner-inbox|routes\/rewind)\.ts$/;
  const skip = /(^|\/)(test|tests|testing|fixtures|generated)\//;
  const literalText = (raw: string | undefined): string | undefined => {
    if (raw === undefined) return undefined;
    const body = raw.slice(1, -1);
    return body.replace(/\$\{\s*([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\s*\}/g, (_, path: string) => `<${path.split(/\??\./).pop()}>`)
      .replace(/\$\{[^}]*\}/g, '<value>').replace(/\\'/g, "'").replace(/\s+/g, ' ').trim();
  };
  const STRING = String.raw`('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\`(?:[^\`\\]|\\.)*\`)`;
  const note = (name: string, status: number | undefined, category: string | undefined, recoverable: boolean | undefined, meaning: string | undefined, carried: boolean): void => {
    const entry = found.get(name) ?? { statuses: [], categories: [], meaning: '', carried };
    if (status !== undefined) entry.statuses.push(status);
    if (category) entry.categories.push(category.toLowerCase());
    if (recoverable !== undefined && entry.recoverable === undefined) entry.recoverable = recoverable;
    if (!entry.meaning && meaning) entry.meaning = meaning;
    if (!carried) entry.carried = false;
    found.set(name, entry);
  };
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relative = path.slice(REPO_ROOT.length + 1);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && !skip.test(`${relative}/`)) walk(path); continue; }
      if (/\.ts$/.test(entry.name) && !/\.(test|spec|d)\.ts$/.test(entry.name)) files.push(relative);
    }
  };
  walk(join(REPO_ROOT, 'packages/engine/platform/src'));
  walk(join(REPO_ROOT, 'packages/engine/daemon-api/src'));
  const sources = new Map(files.sort(byText).map((relative) => [relative,
    readFileSync(join(REPO_ROOT, relative), 'utf8').split('\n').filter((line) => !/^\s*(?:\*|\/\*|\/\/)/.test(line)).join('\n')]));
  // An error class that names its own code (`readonly code = 'X'`), for a route that answers with `error.code`.
  const classCodes = new Map<string, string>();
  for (const text of sources.values()) {
    for (const match of text.matchAll(/class (\w+)[^{]*\{(?:(?!class )[^]){0,600}?readonly code = '([A-Z][A-Z0-9_]{2,})'/g)) {
      classCodes.set(match[1]!, match[2]!);
    }
  }
  for (const [relative, text] of sources) {
    for (const match of text.matchAll(/instanceof (\w+)\)\s*\{([^}]{0,300}?)GatewayVerbError\([^;]*?\b\w+\.code,\s*(\d{3})/g)) {
      const name = classCodes.get(match[1]!);
      if (name) note(name, Number(match[3]), undefined, undefined, undefined, false);
    }
    // A gateway method's refusal, wherever its handler lives.
    for (const match of text.matchAll(new RegExp(String.raw`GatewayVerbError\(\s*(?:${STRING}[^;]{0,300}?|[^;]{0,300}?),\s*'([A-Z][A-Z0-9_]{2,})'\s*,\s*(\d{3})`, 'g'))) {
      note(match[2]!, Number(match[3]), undefined, undefined, literalText(match[1]), false);
    }
    // A module whose refusals a route answers with a status it sets itself: the pairing store's go out on the 401 path (daemon/http/router.ts).
    const answeredWith = ROUTE_REFUSAL_SOURCES[relative];
    if (!answeredWith && !routeDirectories.some((directory) => relative.startsWith(`${directory}/`))) continue;
    const carried = carriedIn.test(relative);
    for (const match of text.matchAll(/\bcode:\s*'([A-Z][A-Z0-9_]{2,})'(?!\s*[|;])/g)) {
      const object = enclosingObject(text, match.index!);
      if (!object) continue;
      const { body, tail, lead } = object;
      // The message an error carries when the object only adds fields to it: new Error('...'), { code } or fail('...', { code }).
      const leadMessage = literalText(new RegExp(String.raw`(?:new \w*Error|\w+)\(\s*${STRING}\s*\)?\s*,\s*$`).exec(lead)?.[1]);
      const status = /(?:^|[,{]\s*)status:\s*(\d{3})/.exec(body)?.[1] ?? /^\s*,\s*\{\s*status:\s*(\d{3})/.exec(tail)?.[1]
        ?? /^\s*\)\s*,\s*(\d{3})\s*\)/.exec(tail)?.[1] ?? /^\s*,\s*(\d{3})\s*\)/.exec(tail)?.[1];
      const category = /\bcategory:\s*(?:'([a-z_]+)'|DaemonErrorCategory\.([A-Z_]+))/.exec(body);
      const recoverable = /\brecoverable:\s*(true|false)/.exec(body)?.[1];
      const read = (field: string): string | undefined => literalText(new RegExp(String.raw`\b${field}:\s*${STRING}`).exec(body)?.[1]);
      const error = read('error');
      // A bare code word as the message says nothing; the state, reason or hint does.
      const meaning = [error && !/^[A-Z_]+$|^[a-z]+(?:-[a-z]+)+$/.test(error) ? error : undefined, read('reason'), read('message'), leadMessage, read('state'), read('hint'), read('guidance')]
        .filter((part): part is string => part !== undefined && part !== '' && !part.includes('${'))[0];
      const answeredStatus = status === undefined ? answeredWith : Number(status);
      note(match[1]!, answeredStatus, category?.[1] ?? category?.[2], recoverable === undefined ? undefined : recoverable === 'true', meaning, carried && answeredStatus === undefined);
    }
    // A code passed through from a result (`code: result.code`), named where the route picks its status.
    for (const match of text.matchAll(/\bcode === '([A-Z][A-Z0-9_]{2,})'\s*\?\s*(\d{3})/g)) note(match[1]!, Number(match[2]), undefined, undefined, undefined, false);
    for (const match of text.matchAll(/\bif \(\w+\.code === '([A-Z][A-Z0-9_]{2,})'\)\s*\{([^]{0,400}?)\bstatus:\s*(\d{3})/g)) note(match[1]!, Number(match[3]), undefined, undefined, undefined, false);
  }
  return found;
}

async function errorKindsSection(): Promise<string> {
  const errors = await import('../errors/src/index.ts');
  const { DaemonErrorCategory } = await import('../errors/src/daemon-error-contract.ts');
  const { EngineErrorCodes } = await import('../errors/src/error-codes.ts');
  const { REST_LAYER_CODES, errorBodySchema, knownErrorCodes } = await import('./openapi-shared.ts');
  const contract = await operatorContract();
  const categories = Object.values(DaemonErrorCategory).sort(byText);
  const kindOf = (category: string): string => new errors.GoodVibesError('probe', { category: category as typeof categories[number] }).kind;
  const out: string[] = [
    '### Error body', '',
    'Every failed daemon request answers with a JSON body of this shape; only `error` is always present.', '',
  ];
  const body = errorBodySchema(knownErrorCodes(contract.operator.methods));
  const undescribed: string[] = [];
  renderProperties(body as Schema, 0, out, undescribed);
  for (const field of undescribed) missingDescriptions.add(`error body field ${field} (scripts/openapi-shared.ts errorBodySchema)`);
  out.push('', '### Categories and kinds', '', 'A failure has a `category` and a `kind`. The categories marked "on the wire" are the values the `category` field of an error body can hold. The `kind` is never sent: a client computes it from the category. The category `contract` is a client\'s own (a reply that broke the operator contract) and is never sent either.', '', '| Category | Kind | Category on the wire |', '| --- | --- | --- |');
  for (const category of categories) out.push(`| ${code(category)} | ${code(kindOf(category))} | yes |`);
  out.push(`| ${code('contract')} | ${code(new errors.GoodVibesError('probe', { category: 'contract' }).kind)} | no (client only) |`);
  out.push('', '### Engine error codes', '', `The shared codes any GoodVibes error may carry in \`code\`: ${Object.values(EngineErrorCodes).sort(byText).map(code).join(', ')}.`);
  const { categoryForStatus } = await import('../errors/src/failure-reading.ts');
  const { TRANSIENT_STATUS_CODES } = await import('../errors/src/failure-transience.ts');
  const retryFor = (statuses: readonly number[], recoverable?: boolean): string => {
    if (recoverable === true) return 'yes, after a wait';
    if (recoverable === false) return 'no';
    if (statuses.length === 0) return 'as the answer says';
    if (statuses.every((status) => TRANSIENT_STATUS_CODES.includes(status))) return 'yes, after a wait';
    if (statuses.every((status) => status === 409 || status === 412 || status === 423)) return 'after the state changes';
    if (statuses.some((status) => TRANSIENT_STATUS_CODES.includes(status))) return 'depends on the status';
    return 'no: change the request';
  };
  const categoryFor = (statuses: readonly number[], explicit: readonly string[]): string => {
    const named = explicit.length > 0 ? explicit : statuses.map((status) => categoryForStatus(status) ?? '').filter(Boolean);
    return [...new Set(named)].sort(byText).map(code).join(', ') || 'none';
  };
  const declared = new Map<string, { status: number; meaning: string; methods: string[] }>();
  for (const method of contract.operator.methods) {
    for (const entry of method.errorCodes ?? []) {
      const known = declared.get(entry.code);
      if (known) known.methods.push(method.id);
      else declared.set(entry.code, { status: entry.status, meaning: entry.meaning, methods: [method.id] });
    }
  }
  const scanned = scanRouteErrorCodes();
  const shared = new Map<string, { statuses: number[]; categories: string[]; recoverable?: boolean; meaning: string; carried: boolean }>();
  for (const entry of REST_LAYER_CODES) shared.set(entry.code, { statuses: [entry.status], categories: [], meaning: entry.meaning, carried: false });
  for (const [name, found] of scanned) {
    if (ROUTE_CODES_NOT_ANSWERED[name] !== undefined) continue;
    if (declared.has(name) || shared.has(name) || (Object.values(EngineErrorCodes) as string[]).includes(name)) continue;
    const elsewhere = ROUTE_CODE_ANSWERED_ELSEWHERE[name];
    if (elsewhere !== undefined) { shared.set(name, { ...found, meaning: elsewhere }); continue; }
    const written = ROUTE_CODE_MEANINGS[name];
    if (written !== undefined && found.meaning) problems.push(`error-kinds: ${name} now has a message at its source; drop it from ROUTE_CODE_MEANINGS`);
    const meaning = found.meaning || written;
    if (!meaning) problems.push(`error-kinds: route code ${name} has no message the scan can read; add its meaning to ROUTE_CODE_MEANINGS`);
    shared.set(name, { ...found, meaning: meaning ?? '' });
  }
  for (const name of [...Object.keys(ROUTE_CODE_MEANINGS), ...Object.keys(ROUTE_CODES_NOT_ANSWERED), ...Object.keys(ROUTE_CODE_ANSWERED_ELSEWHERE)]) {
    if (!scanned.has(name)) problems.push(`error-kinds: ${name} is listed in the generator but no route raises it any more`);
  }
  out.push('', '### Codes any route may answer', '',
    'Codes the shared request layer and the daemon\'s routes put in `code` beyond those a method declares (next table), found in the routes themselves. The meaning is the route\'s own message; `<name>` stands for a value filled in. Category is the `category` the body carries, or, where the body carries none, the one a client reads from the status. A code marked "in an answer" is not an error status: it comes in the `refusal` of a successful answer that was not applied.', '',
    '| Code | HTTP status | Category | Meaning | Retry |', '| --- | --- | --- | --- | --- |');
  for (const [name, entry] of [...shared].sort(([a], [b]) => byText(a, b))) {
    const statuses = [...new Set(entry.statuses)].sort((a, b) => a - b);
    out.push(`| ${code(name)} | ${entry.carried ? 'in an answer' : statuses.join(', ') || 'set where it is relayed'} | ${categoryFor(statuses, entry.categories)} | ${cell(sentence(entry.meaning))} | ${ROUTE_CODE_RETRY[name] ?? retryFor(statuses, entry.recoverable)} |`);
  }
  out.push('', '### Codes a method declares', '', '| Code | HTTP status | Category | Meaning | Retry | Methods |', '| --- | --- | --- | --- | --- | --- |');
  for (const [name, entry] of [...declared].sort(([a], [b]) => byText(a, b))) {
    out.push(`| ${code(name)} | ${entry.status} | ${categoryFor([entry.status], [])} | ${cell(sentence(entry.meaning))} | ${retryFor([entry.status])} | ${entry.methods.sort(byText).map(code).join(', ')} |`);
  }
  const listedCodes = new Set([...shared.keys(), ...declared.keys()]);
  counts.set('error-kinds', categories.length + 1 + Object.keys(EngineErrorCodes).length + listedCodes.size);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// providers
// ---------------------------------------------------------------------------

async function providersSection(): Promise<string> {
  const { registerBuiltinProviders } = await import('../platform/src/platform/providers/builtin-registry.ts');
  const { BUILTIN_COMPAT_PROVIDERS } = await import('../platform/src/platform/providers/builtin-catalog.ts');
  const { BUILTIN_PROVIDER_ENV_KEYS } = await import('../platform/src/platform/config/provider-credential-catalog.ts');
  const { listBuiltinSubscriptionProviders } = await import('../platform/src/platform/config/subscription-providers.ts');
  const { WELL_KNOWN_LOCAL_ENDPOINTS } = await import('../platform/src/platform/providers/well-known-endpoints.ts');
  const { providerDisplayLabel } = await import('../platform/src/platform/providers/provider-labels.ts');
  interface Registered { readonly name: string; readonly models?: readonly string[]; readonly aliases?: readonly string[]; readonly baseURL?: string; readonly defaultModel?: string }
  const registered = new Map<string, Registered>();
  const unused = {} as never;
  registerBuiltinProviders({ register: (provider: Registered) => { registered.set(provider.name, provider); } } as never, () => false, () => '', {
    resolveProvider: () => unused,
    getCatalogModels: () => [],
    getBenchmarks: () => undefined,
    githubCopilotTokenCachePath: join(SCRATCH, 'copilot-token.json'),
    subscriptionManager: unused,
    persistenceRoot: join(SCRATCH, 'providers'),
  });
  const compat = new Map(BUILTIN_COMPAT_PROVIDERS.map((definition) => [definition.id, definition]));
  const subscriptions = new Map(listBuiltinSubscriptionProviders().map((entry) => [entry.providerId, entry]));
  const rows: string[] = [];
  for (const name of [...registered.keys()].sort(byText)) {
    const provider = registered.get(name)!;
    const definition = compat.get(name);
    const keys = BUILTIN_PROVIDER_ENV_KEYS[name] ?? definition?.envVars ?? [];
    const aliases = provider.aliases ?? definition?.aliases ?? [];
    const signIns = [keys.length > 0 ? 'API key' : '', subscriptions.has(name) ? `subscription (${subscriptions.get(name)!.displayName})` : '', definition?.allowAnonymous ? 'no key needed' : ''].filter(Boolean);
    const base = definition?.baseURL ?? provider.baseURL ?? '';
    const model = definition?.defaultModel ?? provider.defaultModel ?? '';
    rows.push(`| ${code(name)} | ${cell(providerDisplayLabel(name))} | ${aliases.map(code).join(', ')} | ${keys.map(code).join(', ')} | ${signIns.join(', ')} | ${base ? code(base) : 'the provider\'s own'} | ${model ? code(model) : 'from its model list'} |`);
  }
  const out = [
    '| Provider id | Name | Aliases | Credential variables | Sign-ins | Base URL | Default model |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    'The usual addresses of local model servers, which GoodVibes looks for when no address is configured:',
    '',
    ...Object.entries(WELL_KNOWN_LOCAL_ENDPOINTS).sort(([a], [b]) => byText(a, b)).map(([server, url]) => `- ${code(server)}: ${code(url)}`),
  ];
  counts.set('providers', rows.length);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// installer-errors
// ---------------------------------------------------------------------------

/** Every `fail INSTALL_E### "<message>"` in install.sh, and every refusal of the checkout installer. */
function installerErrorsSection(): string {
  const release = readFileSync(join(REPO_ROOT, 'scripts/install.sh'), 'utf8');
  const byId = new Map<string, string[]>();
  const failCall = /\bfail (INSTALL_E\d{3}) (?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/g;
  for (const match of release.matchAll(failCall)) {
    const message = (match[2] ?? match[3] ?? match[4] ?? '').replace(/\\(["$`\\])/g, '$1').replace(/\s*\n\s*/g, ' ').trim();
    const list = byId.get(match[1]!) ?? [];
    if (!list.includes(message)) list.push(message);
    byId.set(match[1]!, list);
  }
  const out = [
    '### Release installer (`scripts/install.sh`)', '',
    'Every refusal prints `install.sh: <message> (<id>)` on standard error and exits `1`. `$name` in a message is filled in with the value at the time (the operating system, a file, a version). An id with two messages is raised at two places.', '',
    '| Id | Message |', '| --- | --- |',
  ];
  for (const id of [...byId.keys()].sort(byText)) for (const message of byId.get(id)!) out.push(`| ${code(id)} | ${cell(message)} |`);
  // The checkout installer has no ids: its refusals are the messages its shell wrapper and its TypeScript print.
  const checkoutMessages: string[] = [];
  const wrapper = readFileSync(join(REPO_ROOT, 'scripts/install-from-checkout.sh'), 'utf8');
  for (const match of wrapper.matchAll(/echo (?:'([^']*)'|"((?:[^"\\]|\\.)*)") >&2/g)) checkoutMessages.push((match[1] ?? match[2] ?? '').trim());
  for (const file of ['scripts/install.ts', 'scripts/installation.ts']) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const match of text.matchAll(/new (?:Error|CommandError)\((?:'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g)) checkoutMessages.push((match[1] ?? match[2] ?? '').replace(/\$\{([^}]*)\}/g, '<$1>').trim());
  }
  const uniqueMessages = [...new Set(checkoutMessages.filter((message) => message !== ''))];
  out.push('', '### Checkout installer (`scripts/install-from-checkout.sh`)', '',
    'It prints the message on standard error and exits `1`. `<name>` stands for a value filled in at the time.', '',
    ...uniqueMessages.map((message) => `- ${code(message)}`));
  counts.set('installer-errors', [...byId.values()].reduce((sum, list) => sum + list.length, 0) + uniqueMessages.length);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// owner-only, permission-modes, surface-authority, remember-tiers
// ---------------------------------------------------------------------------

async function ownerOnlySection(): Promise<string> {
  const { OWNER_ONLY_KINDS, ownerOnlyReason } = await import('../platform/src/platform/gate/classify.ts');
  const rows = [...OWNER_ONLY_KINDS].map((kind) => `| ${code(kind)} | ${cell(ownerOnlyReason(kind))} |`);
  counts.set('owner-only', rows.length);
  return ['| Kind | Reason shown to the owner |', '| --- | --- |', ...rows].join('\n');
}

async function permissionModesSection(): Promise<string> {
  const presets = await import('../platform/src/platform/gate/presets.ts');
  // The presets' per-stakes rows are not what decides a call (the permission manager does, by mode), so they are not printed.
  const out = ['| Mode (`permissions.mode`) | Label | What it does | Read-only |', '| --- | --- | --- | --- |'];
  for (const name of presets.SESSION_GATE_PRESET_NAMES) {
    const preset = presets.GATE_PRESETS[name];
    out.push(`| ${code(preset.mode)} | ${cell(preset.label)} | ${cell(preset.summary)} | ${preset.readOnly ? 'yes' : 'no'} |`);
  }
  // The values a saved file may still hold: every case of parsePermissionMode, read back through it.
  const source = readFileSync(join(PLATFORM, 'gate/presets.ts'), 'utf8');
  const body = /export function parsePermissionMode[\s\S]*?\n\}/.exec(source)?.[0] ?? '';
  const saved = [...body.matchAll(/case '([a-z-]+)'/g)].map((match) => match[1]!).filter((value) => !presets.isGatePresetName(value));
  out.push('', 'Older saved values are still read and run as a current mode:', '', '| Saved value | Runs as | Note |', '| --- | --- | --- |');
  for (const value of saved) out.push(`| ${code(value)} | ${code(presets.parsePermissionMode(value) ?? '')} | ${cell(presets.retiredPermissionModeNotice(value) ?? '')} |`);
  out.push('', `Any other value runs as ${code(presets.normalizePermissionMode('unknown'))}. In every mode but \`yolo\` and \`plan\`, the permission rules settle some calls before the mode is consulted: a declared read inside the allowed directories and a recoverable change inside them run, a per-tool or remembered rule applies, and an owner-only decision goes to the owner.`);
  if (saved.length === 0) problems.push('permission-modes: no saved values found in parsePermissionMode');
  counts.set('permission-modes', presets.SESSION_GATE_PRESET_NAMES.length + saved.length);
  return out.join('\n');
}

async function surfaceAuthoritySection(): Promise<string> {
  const authority = await import('../platform/src/platform/gate/surface-authority.ts');
  const { ROUTE_SURFACE_KINDS } = await import('../platform/src/events/routes.ts');
  const surfaces = [...new Set([...authority.listDeclaredSurfaces(), ...ROUTE_SURFACE_KINDS])].sort(byText);
  const { isChannelSurfaceKind } = await import('../platform/src/events/surfaces.ts');
  const rows = surfaces.map((surface) => {
    const command = authority.surfaceCarriesCommandAuthority(surface);
    // Only a third-party channel's surface is put on a turn (daemon/facade.ts); a first-party surface's
    // rule is never consulted, so its work runs as the owner's own request.
    const effect = !command && (ROUTE_SURFACE_KINDS as readonly string[]).includes(surface) && !isChannelSurfaceKind(surface)
      ? 'never applied in practice: a turn started from the web UI, the API or a hosted session carries no channel surface, so it is decided as the owner\'s own request'
      : command
      ? 'decided like a request typed in the terminal app'
      : authority.surfaceRequestsReachOwner(surface)
        ? 'becomes the owner-only item `channel-request`: the owner is asked every time'
        : 'refused; no approval is raised';
    return `| ${code(surface)} | ${code(authority.surfaceAuthority(surface))} | ${effect} |`;
  });
  counts.set('surface-authority', rows.length);
  return [
    `A message on a \`command\` surface can start, approve and confirm work. A message on an \`input-only\` surface is input: a change it asks for is handled as the last column says. A surface not listed is \`${authority.DEFAULT_SURFACE_COMMAND_AUTHORITY}\`.`, '',
    '| Surface | Authority | A change asked for there |', '| --- | --- | --- |', ...rows,
  ].join('\n');
}

async function rememberTiersSection(): Promise<string> {
  const { buildRememberOptions } = await import('../platform/src/platform/permissions/approval-rules.ts');
  // One call of each kind the tiers distinguish; the labels below are what these calls would show.
  const samples: readonly { readonly tool: string; readonly args: Record<string, unknown> }[] = [
    { tool: 'exec', args: { commands: [{ cmd: 'git status' }] } },
    { tool: 'edit', args: { edits: [{ path: 'src/app.ts', find: 'a', replace: 'b' }] } },
    { tool: 'write', args: { files: [{ path: 'src/app.ts', content: '' }] } },
    { tool: 'read', args: { files: [{ path: 'src/app.ts' }] } },
  ];
  const tiers = new Map<string, { tools: string[]; label: string; detail: string }>();
  // The order offered, merged across the samples: a tier one sample lists before another stays before it.
  const order: string[] = [];
  for (const sample of samples) {
    const offered = buildRememberOptions(sample.tool, sample.args);
    for (const [index, option] of offered.entries()) {
      const entry = tiers.get(option.tier) ?? { tools: [], label: option.label, detail: option.detail };
      entry.tools.push(sample.tool);
      tiers.set(option.tier, entry);
      if (order.includes(option.tier)) continue;
      const next = offered.slice(index + 1).map((later) => order.indexOf(later.tier)).find((position) => position >= 0);
      order.splice(next ?? order.length, 0, option.tier);
    }
  }
  // How many remembered exact answers for one command class put the class tier first, found by asking.
  type RememberedRule = Parameters<typeof buildRememberOptions>[2] extends readonly (infer R)[] | undefined ? R : never;
  const exactRule = (command: string): RememberedRule => ({ type: 'prefix', toolPattern: 'exec', exactCommands: [command] }) as unknown as RememberedRule;
  const promotedAfter = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((count) => buildRememberOptions('exec', { commands: [{ cmd: 'git status' }] },
    Array.from({ length: count }, (_, index) => exactRule(`git log -${index + 1}`)))[0]?.tier === 'command-class');
  if (promotedAfter === undefined) problems.push('remember-tiers: the command-class tier was never offered first; the promotion rule changed');
  const rows = order.map((tier) => [tier, tiers.get(tier)!] as const).map(([tier, entry]) => `| ${code(tier)} | ${entry.tools.length === samples.length ? 'every tool' : entry.tools.map(code).join(', ')} | ${cell(entry.label)} | ${cell(entry.detail)} |`);
  counts.set('remember-tiers', rows.length);
  return [
    `The tiers are offered in the order of this table, each only for the calls it applies to, except that once ${promotedAfter ?? '?'} exact answers for commands of one class are remembered in the project, \`command-class\` is offered first. The labels and matches shown are for the example calls \`exec\` with \`git status\`, and \`edit\`, \`write\` or \`read\` of \`src/app.ts\`.`, '',
    '| Tier | Offered for | Label shown | What the remembered rule matches |', '| --- | --- | --- | --- |', ...rows,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// channel-setup, webhook-paths, secret-providers
// ---------------------------------------------------------------------------

async function channelSetupSection(): Promise<string> {
  const { getBuiltinSetupSchema } = await import('../platform/src/platform/channels/builtin/setup-schema.ts');
  const { ROUTE_SURFACE_KINDS } = await import('../platform/src/events/routes.ts');
  const out: string[] = [];
  let count = 0;
  // A field with no default of its own takes the setting's.
  const settingDefaults = new Map((await settingRows()).map((row) => [row.key, row.default]));
  for (const surface of [...ROUTE_SURFACE_KINDS].sort(byText)) {
    let schema: Awaited<ReturnType<typeof getBuiltinSetupSchema>>;
    try {
      schema = getBuiltinSetupSchema(surface as Parameters<typeof getBuiltinSetupSchema>[0]);
    } catch {
      continue;
    }
    if (!schema) continue;
    count += 1;
    out.push(`### ${schema.label} (\`${schema.surface}\`)`, '', `${sentence(schema.description)} Set up by: ${code(schema.setupMode)}.`);
    if (schema.fields.length > 0) {
      out.push('', '| Field | Setting | Kind | Required | Default | Notes |', '| --- | --- | --- | --- | --- | --- |');
      for (const field of schema.fields) {
        const notes = [field.detail ? sentence(field.detail) : '', field.placeholder ? `Example: ${code(field.placeholder)}.` : '', field.options?.length ? `Values: ${field.options.map((option) => code(option.value)).join(', ')}.` : ''].filter(Boolean).join(' ');
        const fieldDefault = field.defaultValue ?? (field.configKey ? settingDefaults.get(field.configKey) : undefined);
        out.push(`| ${cell(field.label)} | ${field.configKey ? code(field.configKey) : ''} | ${field.kind} | ${field.required ? 'yes' : 'no'} | ${fieldDefault === undefined ? '' : code(JSON.stringify(fieldDefault))} | ${cell(notes)} |`);
      }
    }
    if (schema.secretTargets.length > 0) {
      out.push('', 'Credentials:', '');
      for (const target of schema.secretTargets) {
        const where = [target.envKeys?.length ? `environment ${target.envKeys.map(code).join(', ')}` : '', target.configKeys?.length ? `setting ${target.configKeys.map(code).join(', ')}` : '', target.serviceName ? `service entry ${code(target.serviceName)}${target.serviceField ? ` field ${code(target.serviceField)}` : ''}` : ''].filter(Boolean).join('; ');
        out.push(`- ${target.label}${target.required ? ' (required)' : ''}: ${target.detail ? sentence(target.detail) : ''} Read from: ${where || 'the secret store'}.`);
      }
    }
    if (schema.externalSteps.length > 0) {
      out.push('', 'Steps outside GoodVibes:', '', ...schema.externalSteps.map((step, index) => `${index + 1}. ${sentence(step)}`));
    }
    out.push('');
  }
  counts.set('channel-setup', count);
  return out.join('\n').trimEnd();
}

async function webhookPathsSection(): Promise<string> {
  const { registerBuiltinChannelPlugins } = await import('../platform/src/platform/channels/builtin/plugins.ts');
  const registered: { surface: string; displayName: string; webhookPath?: string }[] = [];
  // Only the registrations are read: every other collaborator answers nothing, and no plugin handler runs.
  const inert: object = new Proxy(() => undefined, { get: (_target, key) => (key === 'then' ? undefined : inert), apply: () => ({}) });
  const deps = new Proxy({}, { get: (_target, key) => (key === 'channelPlugins' ? { register: (plugin: { surface: string; displayName: string; webhookPath?: string }) => { registered.push(plugin); } } : inert) });
  const context = new Proxy({}, { get: (_target, key) => (key === 'deps' ? deps : () => ({})) });
  registerBuiltinChannelPlugins(context as Parameters<typeof registerBuiltinChannelPlugins>[0]);
  const rows = registered.filter((plugin) => plugin.webhookPath).sort((a, b) => byText(a.webhookPath!, b.webhookPath!))
    .map((plugin) => `| ${code(`POST ${plugin.webhookPath!}`)} | ${cell(plugin.displayName)} (\`${plugin.surface}\`) |`);
  counts.set('webhook-paths', rows.length);
  return ['| Path on the control-plane listener | Surface |', '| --- | --- |', ...rows].join('\n');
}

async function secretProvidersSection(): Promise<string> {
  const { BUILTIN_SECRET_PROVIDER_SOURCES } = await import('../platform/src/platform/config/secret-refs.ts');
  const { isCommandBackedSecretSource } = await import('../platform/src/platform/config/secrets.ts');
  const rows = BUILTIN_SECRET_PROVIDER_SOURCES.map((source) => `| ${code(source)} | ${isCommandBackedSecretSource(source) ? 'yes' : 'no'} |`);
  const settings = (await settingRows()).filter((row) => row.key.startsWith('storage.secretProviders.')).map((row) => code(row.key));
  counts.set('secret-providers', rows.length);
  return [
    '| Source | Runs a program to read the secret |', '| --- | --- |', ...rows, '',
    `A reference names its source: \`goodvibes://secrets/<source>/...\`. The settings that tell GoodVibes how to run each password manager are ${settings.join(', ')}.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// scopes
// ---------------------------------------------------------------------------

async function scopesSection(): Promise<string> {
  const contract = await operatorContract();
  const { GatewayMethodCatalog, grantedGatewayScopes } = await import('../platform/src/platform/control-plane/method-catalog.ts');
  const catalog = new GatewayMethodCatalog();
  // Every scope a credential can be granted, as the daemon computes it, and those a read-only grant gets.
  const grantable = grantedGatewayScopes(catalog, true);
  const readOnly = new Set(grantedGatewayScopes(catalog, false));
  const byScope = new Map<string, { methods: number; categories: Set<string>; events: number }>();
  for (const scope of grantable) byScope.set(scope, { methods: 0, categories: new Set(), events: 0 });
  for (const method of contract.operator.methods) for (const scope of method.scopes) {
    const entry = byScope.get(scope);
    if (!entry) { problems.push(`scopes: method ${method.id} needs ${scope}, which no credential can be granted`); continue; }
    entry.methods += 1; entry.categories.add(method.category);
  }
  for (const event of contract.operator.events) for (const scope of event.scopes) {
    const entry = byScope.get(scope);
    if (!entry) { problems.push(`scopes: event ${event.id} needs ${scope}, which no credential can be granted`); continue; }
    entry.events += 1;
  }
  const resourceOf = (scope: string): string => (scope.includes(':') ? scope.slice(scope.indexOf(':') + 1) : scope);
  const resources = [...new Set(grantable.map(resourceOf))].sort(byText);
  const out = [
    'A token or user carries scopes; a method or event stream needs every scope it lists (see "Operator API methods" for each method\'s scopes and access). `read:` scopes read and `write:` scopes change. "Read-only grant" says whether a token minted for reading gets the scope. A scope with no methods or streams is checked by an HTTP route directly (the telemetry routes check `read:telemetry`, and `read:telemetry-sensitive` for the raw view).', '',
    '| Covers | Scope | Read-only grant | Methods that need it | Event streams | Method categories |', '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const resource of resources) {
    for (const scope of grantable.filter((key) => resourceOf(key) === resource).sort(byText)) {
      const entry = byScope.get(scope)!;
      out.push(`| ${resource} | ${code(scope)} | ${readOnly.has(scope) ? 'yes' : 'no'} | ${entry.methods} | ${entry.events} | ${[...entry.categories].sort(byText).join(', ')} |`);
    }
  }
  // Scopes an HTTP route checks that the catalog's grantable list does not hold, read from the route source.
  const telemetryRoutes = readFileSync(join(ENGINE_ROOT, 'daemon-api/src/telemetry-routes.ts'), 'utf8');
  const ingest = /const OTLP_INGEST_SCOPES = \[([^\]]*)\]/.exec(telemetryRoutes)?.[1];
  const ingestScopes = ingest ? [...ingest.matchAll(/'([a-z]+:[a-z-]+)'/g)].map((match) => match[1]!) : [];
  if (ingestScopes.length === 0) problems.push('scopes: OTLP_INGEST_SCOPES not found in daemon-api/src/telemetry-routes.ts');
  for (const scope of ingestScopes.filter((entry) => !byScope.has(entry))) {
    out.push(`| ${resourceOf(scope)} | ${code(scope)} | no | 0 | 0 | OTLP telemetry ingest routes (either ${ingestScopes.map(code).join(' or ')} is enough); a token gets it only when an admin names it at minting |`);
  }
  counts.set('scopes', grantable.length + ingestScopes.filter((entry) => !byScope.has(entry)).length);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// keybindings:tui, keybindings:agent
// ---------------------------------------------------------------------------

interface KeybindingsModule { KeybindingsManager: new (options: Record<string, unknown>) => { getAll(): { action: string; combos: object[]; description: string }[]; formatCombo(combo: object): string; getConfigPath(): string } }

async function keybindingsSection(product: 'tui' | 'agent'): Promise<string> {
  const { KeybindingsManager } = await loadProductModule<KeybindingsModule>(`products/${product}/src/input/keybindings.ts`);
  const manager = new KeybindingsManager({ homeDirectory: SCRATCH_HOME });
  const rows = manager.getAll().map((entry) => `| ${code(entry.action)} | ${entry.combos.map((combo) => code(manager.formatCombo(combo))).join(', ') || 'unbound'} | ${cell(sentence(entry.description))} |`);
  const file = manager.getConfigPath().split(SCRATCH_HOME).join('~');
  counts.set(`keybindings:${product}`, rows.length);
  return [
    `These actions can be rebound in ${code(file)}: a JSON object from action name to a key combination or a list of them, each \`{ "key": "k", "ctrl": true, "shift": false, "alt": false }\`.`, '',
    '| Action | Default keys | What it does |', '| --- | --- | --- |', ...rows,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------

async function hooksSection(): Promise<string> {
  const { listHookPointContracts } = await import('../platform/src/platform/hooks/contracts.ts');
  const ts = (await import('typescript')).default;
  const typesFile = join(PLATFORM, 'hooks/types.ts');
  const program = ts.createProgram({ rootNames: [typesFile], options: { noEmit: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler } });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(typesFile)!;
  const literals = (name: string): string[] => {
    const alias = source.statements.find((statement): statement is import('typescript').TypeAliasDeclaration => ts.isTypeAliasDeclaration(statement) && statement.name.text === name);
    if (!alias) { problems.push(`hooks: ${name} is not declared in hooks/types.ts`); return []; }
    const type = checker.getTypeAtLocation(alias.name);
    return (type.isUnion() ? type.types : [type]).filter((member) => member.isStringLiteral()).map((member) => (member as import('typescript').StringLiteralType).value);
  };
  const fields = (name: string): string[] => {
    const declaration = source.statements.find((statement): statement is import('typescript').InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text === name);
    if (!declaration) { problems.push(`hooks: ${name} is not declared in hooks/types.ts`); return []; }
    return checker.getPropertiesOfType(checker.getTypeAtLocation(declaration.name)).map((property) => {
      const decl = property.valueDeclaration ?? property.declarations?.[0];
      const type = decl ? checker.typeToString(checker.getTypeOfSymbolAtLocation(property, decl)).replace(/ \| undefined/g, '') : 'unknown';
      const doc = ts.displayPartsToString(property.getDocumentationComment(checker)).replace(/\s+/g, ' ').trim();
      if (doc === '') missingDescriptions.add(`hook field ${name}.${property.getName()} (hooks/types.ts)`);
      const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
      return `- ${code(property.getName())} (${type}, ${optional ? 'optional' : 'required'})${doc ? `: ${sentence(doc)}` : '.'}`;
    });
  };
  const contracts = listHookPointContracts();
  const out = [
    `A hook fires on an event path \`Phase:Category:Specific\`; a pattern may use \`*\` for any part. Phases: ${literals('HookPhase').map(code).join(', ')}. Categories: ${literals('HookCategory').map(code).join(', ')}. Hook types: ${literals('HookType').map(code).join(', ')}.`,
    '', '### Hook points', '',
    '| Pattern | What a hook there can do | Runs | Can deny | Can change input | Can add context | If the hook fails |', '| --- | --- | --- | --- | --- | --- | --- |',
    ...contracts.map((contract) => `| ${code(contract.pattern)} | ${cell(sentence(contract.description))} | ${contract.executionMode} | ${contract.canDeny ? 'yes' : 'no'} | ${contract.canMutateInput ? 'yes' : 'no'} | ${contract.canInjectContext ? 'yes' : 'no'} | ${contract.failurePolicy} |`),
    '', 'Each hook runs under its own `timeout` (default 30 s, 60 s for an agent hook), whatever its point.',
    '', '### Fields of a hook in hooks.json', '', ...fields('HookDefinition'),
    '', '### Fields of a chain step', '', ...fields('ChainStep'),
    '', '### Fields of a chain', '', ...fields('HookChain'),
    '', '### What a hook returns', '', ...fields('HookResult'),
  ];
  counts.set('hooks', contracts.length);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// cluster-sync, ports
// ---------------------------------------------------------------------------

async function clusterSyncSection(): Promise<string> {
  const { listDaemonConfigClassifications } = await import('../platform/src/platform/cluster/config-replication-policy.ts');
  const { isValidConfigKey } = await import('../platform/src/platform/config/schema.ts');
  // Only settings a person can set; internal daemon paths (the group's own key material) are not settings.
  const classifications = listDaemonConfigClassifications().filter((entry) => isValidConfigKey(entry.path));
  const domainOf = (path: string): string => path.split('.')[0]!;
  const byDomain = new Map<string, typeof classifications[number][]>();
  for (const entry of classifications) byDomain.set(domainOf(entry.path), [...(byDomain.get(domainOf(entry.path)) ?? []), entry]);
  const out = [
    'Only daemon settings can be shared across a cluster. Each one either replicates (every node takes the group\'s value) or is node-local (each machine keeps its own). A replicated setting is sent with `goodvibes-daemon cluster publish <setting>` and taken with `goodvibes-daemon cluster accept <setting>`; `goodvibes-daemon cluster status` lists those that differ. A setting that names a credential carries that credential with it when it replicates. A port this machine listens on never replicates, wherever it lives.', '',
    'Each row is one settings domain: how its keys are classed, and every key that is classed the other way, with the reason.', '',
    '| Domain | Keys | Classed | Reason | Keys classed the other way |', '| --- | --- | --- | --- | --- |',
  ];
  for (const domain of [...byDomain.keys()].sort(byText)) {
    const entries = byDomain.get(domain)!;
    // The domain's class is the one most of its keys have; the reason column gives that class's reasons.
    const byClass = new Map<string, number>();
    for (const entry of entries) byClass.set(entry.replication, (byClass.get(entry.replication) ?? 0) + 1);
    const mainClass = [...byClass].sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))[0]![0];
    const mainReason = [...new Set(entries.filter((entry) => entry.replication === mainClass).map((entry) => entry.reason))].sort(byText).join('; ');
    const exceptions = entries.filter((entry) => entry.replication !== mainClass).sort((a, b) => byText(a.path, b.path))
      .map((entry) => `${code(entry.path)} ${entry.replication} (${entry.reason})`);
    out.push(`| ${code(`${domain}.*`)} | ${entries.length} | ${mainClass} | ${cell(mainReason)} | ${cell(exceptions.join('; ')) || 'none'} |`);
  }
  counts.set('cluster-sync', classifications.length);
  return out.join('\n');
}

async function portsSection(): Promise<string> {
  const rows: string[] = [];
  for (const row of await settingRows()) {
    if (row.role !== 'listen-port' && row.role !== 'remote-port') continue;
    rows.push(`| ${code(String(row.default))} | ${row.role === 'listen-port' ? 'this machine listens' : 'a remote server'} | setting ${code(row.key)} | ${cell(sentence(row.description))} |`);
  }
  const { listBuiltinSubscriptionProviders } = await import('../platform/src/platform/config/subscription-providers.ts');
  for (const provider of listBuiltinSubscriptionProviders()) {
    const callback = provider.oauth.localCallback;
    if (callback) rows.push(`| ${code(String(callback.port))} | this machine listens, only during sign-in | ${provider.displayName} sign-in | The sign-in page returns to \`http://${callback.host}:${callback.port}${callback.path}\`. |`);
  }
  const { WELL_KNOWN_LOCAL_PORTS } = await import('../platform/src/platform/providers/well-known-endpoints.ts');
  for (const [server, port] of Object.entries(WELL_KNOWN_LOCAL_PORTS).sort(([a], [b]) => byText(a, b))) {
    rows.push(`| ${code(String(port))} | a local model server | ${code(server)} | The port GoodVibes recognises this server by when it scans this machine for local model servers. |`);
  }
  counts.set('ports', rows.length);
  return ['| Port | Who listens | Set by | Notes |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const counts = new Map<string, number>();

const BUILDERS: Readonly<Record<string, () => Promise<string> | string>> = {
  settings: () => settingsSection(undefined),
  'cli:goodvibes': cliTerminal,
  'cli:goodvibes-agent': cliAgent,
  'cli:goodvibes-daemon': cliDaemon,
  'slash:tui': slashTui,
  'slash:agent': slashAgent,
  tools: toolsSection,
  'exit-codes': exitCodesSection,
  env: envSection,
  'installer-options': installerOptionsSection,
  'operator-methods': operatorMethodsSection,
  events: eventsSection,
  'error-kinds': errorKindsSection,
  providers: providersSection,
  'installer-errors': installerErrorsSection,
  'owner-only': ownerOnlySection,
  'permission-modes': permissionModesSection,
  'surface-authority': surfaceAuthoritySection,
  'remember-tiers': rememberTiersSection,
  'channel-setup': channelSetupSection,
  'webhook-paths': webhookPathsSection,
  'secret-providers': secretProvidersSection,
  scopes: scopesSection,
  'keybindings:tui': () => keybindingsSection('tui'),
  'keybindings:agent': () => keybindingsSection('agent'),
  hooks: hooksSection,
  'cluster-sync': clusterSyncSection,
  ports: portsSection,
};

/**
 * Lists printed in full only in the reference: inside another part their marker
 * renders these columns of the same tables, each long cell cut to its first
 * sentence, and names the reference heading that holds the full list.
 */
const COMPACT_IN_PARTS: Readonly<Record<string, { readonly heading: string; readonly columns: readonly number[] }>> = {
  'installer-options': { heading: 'Installer options', columns: [0, 1, 2] },
  'permission-modes': { heading: 'Permission modes', columns: [0, 1, 2] },
  'remember-tiers': { heading: 'Remember tiers', columns: [0, 1, 2] },
  'webhook-paths': { heading: 'Webhook paths', columns: [0] },
};

/** The tables of a rendered section with only `columns` kept; `### X` lines become `X:`; other prose is left out. */
function compactTables(text: string, columns: readonly number[]): string {
  const out: string[] = [];
  const inline: string[] = [];
  const flush = (): void => {
    if (inline.length > 0) out.push(`${inline.join(', ')}.`, '');
    inline.length = 0;
  };
  let header = true;
  for (const line of text.split('\n')) {
    const heading = /^### (.+)$/.exec(line);
    if (heading) {
      flush();
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      out.push(`${heading[1]}:`, '');
      header = true;
      continue;
    }
    if (!line.startsWith('|')) {
      flush();
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      // Prose around a table says how to read it (an order, an exception), so it stays.
      if (line.trim() !== '') out.push(line, '');
      header = true;
      continue;
    }
    const cells = line.slice(1, -1).split(/(?<!\\)\|/).map((value) => value.trim());
    if (cells.every((value) => /^-+$/.test(value))) {
      if (columns.length > 1) out.push(`| ${columns.map(() => '---').join(' | ')} |`);
      continue;
    }
    const isHeader = header;
    header = false;
    // Cells are kept as they are: a compact table drops columns, never words.
    const kept = columns.map((index) => cells[index] ?? '');
    if (columns.length === 1) {
      if (!isHeader) inline.push(kept[0]!);
      continue;
    }
    out.push(`| ${kept.join(' | ')} |`);
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const built = new Map<string, string>();
async function section(name: string, inReference: boolean): Promise<string | undefined> {
  const compact = !inReference ? COMPACT_IN_PARTS[name] : undefined;
  const cacheKey = compact ? `compact:${name}` : name;
  const cached = built.get(cacheKey);
  if (cached !== undefined) return cached;
  let text: string | undefined;
  if (name.startsWith('settings:')) text = await settingsSection(name.slice('settings:'.length));
  else if (Object.hasOwn(BUILDERS, name)) {
    const full = built.get(name) ?? await BUILDERS[name]!();
    built.set(name, full);
    text = compact ? `${compactTables(full, compact.columns)}\n\nFull list: "${compact.heading}" in the part "Reference".` : full;
  } else return undefined;
  built.set(cacheKey, text);
  return text;
}

async function assemble(): Promise<string> {
  const parts = existsSync(PARTS_DIR) ? readdirSync(PARTS_DIR).filter((name) => PART_NAME.test(name)).sort(byText) : [];
  if (parts.length === 0) problems.push('docs/llms has no NN-slug.md part');
  // Each part's lines as rendered: a hand-written line keeps its source line number, a marker's text has none.
  const renderedParts: { readonly part: string; readonly lines: { readonly text: string; readonly source?: number }[] }[] = [];
  for (const part of parts) {
    const lines = readFileSync(join(PARTS_DIR, part), 'utf8').replace(/\r\n/g, '\n').split('\n');
    const rendered: { text: string; source?: number }[] = [];
    for (const [index, line] of lines.entries()) {
      const marker = MARKER.exec(line.trim());
      if (!marker) {
        if (line.includes('<!-- generated:')) problems.push(`docs/llms/${part}:${index + 1}: a malformed marker: ${line.trim()}`);
        rendered.push({ text: line.replaceAll(RELEASE_TOKEN, RELEASE), source: index + 1 });
        continue;
      }
      if (marker[1] === 'toc') {
        rendered.push({ text: TOC_PLACEHOLDER });
        continue;
      }
      const text = await section(marker[1]!, part === REFERENCE_PART);
      if (text === undefined) {
        problems.push(`docs/llms/${part}:${index + 1}: unknown marker "${marker[1]}" (known: ${[...Object.keys(BUILDERS), 'settings:<prefix>', 'toc'].join(', ')})`);
        continue;
      }
      rendered.push({ text });
    }
    renderedParts.push({ part, lines: rendered });
  }
  const targets = headingTargets(renderedParts.map(({ part, lines }) => ({ part, text: lines.map((line) => line.text).join('\n') })));
  const out = renderedParts.map(({ part, lines }) => {
    let fenced = false;
    return lines.map(({ text, source }) => {
      if (source === undefined) return text;
      if (/^\s*(```|~~~)/.test(text)) fenced = !fenced;
      if (fenced) return text;
      const resolved = resolveLinks(text, part, source, targets);
      checkQuotedReferences(resolved, part, source, targets);
      return resolved;
    }).join('\n').trim();
  });
  const text = `${out.join('\n\n')}\n`;
  return text.includes(TOC_PLACEHOLDER) ? text.split(TOC_PLACEHOLDER).join(tableOfContents(text)) : text;
}

interface HeadingTarget { readonly heading: string; readonly part: string; readonly partTitle: string }

/**
 * Every heading's anchor, as a Markdown renderer makes it (lower case, punctuation dropped,
 * spaces to hyphens, a repeat numbered `-1`, `-2` within its part), mapped to the heading.
 */
function headingTargets(parts: readonly { readonly part: string; readonly text: string }[]): Map<string, HeadingTarget[]> {
  const targets = new Map<string, HeadingTarget[]>();
  for (const { part, text } of parts) {
    const seen = new Map<string, number>();
    let fenced = false;
    let partTitle = part;
    for (const line of text.split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) continue;
      const heading = /^(#{1,6}) (.+?)\s*#*\s*$/.exec(line);
      if (!heading) continue;
      const name = heading[2]!.trim();
      if (heading[1] === '#' && partTitle === part) partTitle = name;
      const base = name.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
      const repeat = seen.get(base) ?? 0;
      seen.set(base, repeat + 1);
      const anchor = repeat === 0 ? base : `${base}-${repeat}`;
      targets.set(anchor, [...(targets.get(anchor) ?? []), { heading: name, part, partTitle }]);
    }
  }
  return targets;
}

/**
 * A heading named in quotes (`see "X"`, `under "X"`, `"X" in the part "Y"`, `the part "Y"`) must be a
 * heading that exists, written exactly as it is (backticks included), since the file has no links to follow.
 */
function checkQuotedReferences(line: string, part: string, source: number, targets: ReadonlyMap<string, HeadingTarget[]>): void {
  // Compared exactly: a reference that drops a heading's backticks names a heading that is not there.
  const plain = (text: string): string => text.trim();
  const all = [...targets.values()].flat();
  const parts = new Set(all.map((target) => plain(target.partTitle)));
  const headingsIn = (title: string | undefined): Set<string> => new Set(all.filter((target) => title === undefined || plain(target.partTitle) === title).map((target) => plain(target.heading)));
  const everyHeading = headingsIn(undefined);
  const seen = new Set<number>();
  for (const match of line.matchAll(/"([^"\n]{2,120})" in the part "([^"\n]{2,80})"/g)) {
    seen.add(match.index!);
    const [name, title] = [plain(match[1]!), plain(match[2]!)];
    if (!parts.has(title)) problems.push(`docs/llms/${part}:${source}: the part "${match[2]}" does not exist`);
    else if (!headingsIn(title).has(name)) problems.push(`docs/llms/${part}:${source}: the part "${match[2]}" has no heading "${match[1]}"`);
  }
  for (const match of line.matchAll(/\bthe part "([^"\n]{2,80})"/g)) {
    if (!parts.has(plain(match[1]!))) problems.push(`docs/llms/${part}:${source}: the part "${match[1]}" does not exist`);
  }
  for (const match of line.matchAll(/\b(?:[Ss]ee|under) "([^"\n]{2,120})"/g)) {
    const after = line.slice(match.index! + match[0].length);
    if (after.startsWith(' in the part "')) continue;
    if (!everyHeading.has(plain(match[1]!))) problems.push(`docs/llms/${part}:${source}: "${match[1]}" is not a heading`);
  }
}

/**
 * `[text](#anchor)` becomes the quoted heading it points at, since the assembled file has no
 * anchors; a heading in another part also names that part. An anchor no heading has is a problem.
 */
function resolveLinks(line: string, part: string, source: number, targets: ReadonlyMap<string, HeadingTarget[]>): string {
  return line.replace(/\[((?:[^\]\\]|\\.)+)\]\(#([^)\s]+)\)/g, (whole, _label: string, anchor: string) => {
    const found = targets.get(anchor);
    if (!found) {
      problems.push(`docs/llms/${part}:${source}: the link ${whole} points at no heading`);
      return whole;
    }
    const target = found.find((entry) => entry.part === part) ?? found[0]!;
    const name = `"${target.heading}"`;
    return target.part === part ? name : `${name} in the part "${target.partTitle}"`;
  });
}

const TOC_PLACEHOLDER = '\u0000toc\u0000';

/** Every part (`# `) and section (`## `) heading of the assembled file, outside code blocks. */
function tableOfContents(text: string): string {
  const lines: string[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = /^(#{1,2}) (.+)$/.exec(line);
    if (!heading) continue;
    lines.push(`${heading[1] === '#' ? '' : '  '}- ${heading[2]!.trim()}`);
  }
  counts.set('toc', lines.length);
  return lines.join('\n');
}

/** The first line where two texts differ, for the --check message. */
function firstDifference(current: string, next: string): string {
  const a = current.split('\n');
  const b = next.split('\n');
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if (a[index] !== b[index]) {
      const left = a[index] ?? '', right = b[index] ?? '';
      let column = 0;
      while (column < left.length && left[column] === right[column]) column += 1;
      const window = (line: string | undefined): string => (line === undefined ? '<end of file>' : line.slice(Math.max(0, column - 60), column + 100));
      return `line ${index + 1}, column ${column + 1}: committed ${JSON.stringify(window(a[index]))}, generated ${JSON.stringify(window(b[index]))}`;
    }
  }
  return 'the files differ only in their ends';
}

/**
 * docs/llms.txt, the small index beside the full file: one line per part, its
 * title and the first sentence of its opening paragraph (what the part says it
 * covers), then the full file with its size. An opening sentence about "this
 * file" describes the whole full file, not the part, so that part is listed by
 * its title alone.
 */
function partsIndex(fullBytes: number): string {
  const parts = existsSync(PARTS_DIR) ? readdirSync(PARTS_DIR).filter((name) => PART_NAME.test(name)).sort(byText) : [];
  const entries: string[] = [];
  for (const part of parts) {
    const lines = readFileSync(join(PARTS_DIR, part), 'utf8').replace(/\r\n/g, '\n').split('\n');
    const titleAt = lines.findIndex((line) => /^# \S/.test(line));
    if (titleAt < 0) {
      problems.push(`docs/llms/${part}: no "# " title line for docs/llms.txt`);
      continue;
    }
    const title = lines[titleAt]!.slice(2).trim();
    const opening: string[] = [];
    for (const line of lines.slice(titleAt + 1)) {
      if (line.trim() === '') { if (opening.length > 0) break; continue; }
      if (/^(#{1,6} |<!--|```|~~~|[|>*-] )/.test(line)) break;
      opening.push(line.trim());
    }
    const sentence = /^(.+?[.!?])(?:\s|$)/.exec(opening.join(' '))?.[1];
    const covers = sentence === undefined || /^This file\b/.test(sentence) ? '' : `: ${sentence}`;
    entries.push(`- [${title}](llms/${part})${covers}`);
  }
  return [
    '# GoodVibes',
    '',
    '> How to install, configure and operate GoodVibes, written for a language model that operates it for a person. Each part below is one file in `llms/`; `llms-full.txt` is all of them in order, with every `<!-- generated: ... -->` line of a part replaced by the complete list the code holds (settings, commands, slash commands, tools, operator API methods, events, errors, environment variables).',
    '',
    '## Parts',
    '',
    ...entries,
    '',
    '## Everything in one file',
    '',
    `- [GoodVibes, complete](llms-full.txt): every part above in one file, with the generated lists filled in (${fullBytes} bytes).`,
    '',
  ].join('\n');
}

let exitCode = 0;
try {
  const output = await assemble();
  if (output.includes(SCRATCH) || output.includes(REPO_ROOT)) problems.push('the output contains a path on this machine');
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : null;
  const index = partsIndex(Buffer.byteLength(output, 'utf8'));
  const currentIndex = existsSync(INDEX_OUTPUT) ? readFileSync(INDEX_OUTPUT, 'utf8') : null;
  for (const problem of problems) console.error(`[llms-full] ${problem}`);
  if (problems.length > 0) exitCode = 1;
  if (CHECK_ONLY) {
    if (current === null) {
      console.error('[llms-full] docs/llms-full.txt does not exist; run `bun run llms:generate`');
      exitCode = 1;
    } else if (current !== output) {
      console.error(`[llms-full] docs/llms-full.txt is out of step with docs/llms and the registries (${firstDifference(current, output)}); run \`bun run llms:generate\` and commit docs/llms-full.txt`);
      exitCode = 1;
    }
    if (currentIndex === null) {
      console.error('[llms-full] docs/llms.txt does not exist; run `bun run llms:generate`');
      exitCode = 1;
    } else if (currentIndex !== index) {
      console.error(`[llms-full] docs/llms.txt is out of step with docs/llms (${firstDifference(currentIndex, index)}); run \`bun run llms:generate\` and commit docs/llms.txt`);
      exitCode = 1;
    }
    if (exitCode === 0) console.log('[llms-full] docs/llms-full.txt and docs/llms.txt are up to date');
  } else {
    if (current !== output) writeFileSync(OUTPUT, output, 'utf8');
    if (currentIndex !== index) writeFileSync(INDEX_OUTPUT, index, 'utf8');
    console.log(`[llms-full] ${current === output ? 'unchanged' : 'wrote'} docs/llms-full.txt (${Buffer.byteLength(output, 'utf8')} bytes, ${output.split('\n').length} lines)`);
    console.log(`[llms-full] ${currentIndex === index ? 'unchanged' : 'wrote'} docs/llms.txt (${index.split('\n').length} lines)`);
    for (const [name, count] of [...counts].sort(([a], [b]) => byText(a, b))) console.log(`[llms-full]   ${name}: ${count}`);
    if (missingDescriptions.size > 0) {
      console.log(`[llms-full] entries a registry leaves without a description (${missingDescriptions.size}):`);
      for (const entry of [...missingDescriptions].sort(byText)) console.log(`[llms-full]   ${entry}`);
    }
  }
} catch (error) {
  console.error(`[llms-full] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  exitCode = 1;
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}
// Registries started for the tool lists hold timers and watchers; the answer is written.
process.exit(exitCode);
