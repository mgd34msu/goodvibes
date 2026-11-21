import { productVersionFromModule } from '@goodvibes/engine/terminal-shell/cli-help';
import { normalizeHelpTopic as normalizeTopic } from '@goodvibes/engine/terminal-shell/cli-help';
import { renderDetailedCommandHelp, COMMON_COMMAND_HELP, type TerminalCommandHelp } from '@goodvibes/engine/terminal-shell/cli-help';
import { join } from 'node:path';
import { GOODVIBES_CLI_CATALOG } from '@goodvibes/engine/terminal-shell/cli-command-catalog';
import { VERSION } from '../version.ts';

export const getPackageVersion = (): string => productVersionFromModule(import.meta.url, '@goodvibes/tui', VERSION);

export function renderGoodVibesVersion(binary = 'goodvibes'): string {
  return `${binary} ${getPackageVersion()}`;
}

/** Commands served before the shared parser runs, so they are not in its catalog. */
const PRE_PARSER_COMMANDS: readonly { readonly name: string; readonly aliases: readonly string[]; readonly subcommands: readonly string[] }[] = [
  { name: 'acp', aliases: [], subcommands: [] },
  { name: 'host', aliases: [], subcommands: ['pair', 'unpair'] },
];

/** A command offered to a person: its words from the catalog, its line from the help table. */
export interface TuiCommandEntry {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly subcommands: readonly string[];
  readonly line: string;
}

/**
 * Every command `goodvibes` offers, in catalog order with the pre-parser
 * commands before `completion`. `serve` is left out: the catalog keeps it only
 * so the entry point can refuse it by name.
 */
export function listTuiCommands(): readonly TuiCommandEntry[] {
  const catalog = GOODVIBES_CLI_CATALOG.commands.filter((spec) => spec.name !== 'serve');
  const at = catalog.findIndex((spec) => spec.name === 'completion');
  const ordered = [...catalog.slice(0, at), ...PRE_PARSER_COMMANDS, ...catalog.slice(at)];
  return ordered.map((spec) => {
    const help = COMMAND_HELP[normalizeHelpTopic(spec.name)];
    return { name: spec.name, aliases: spec.aliases, subcommands: spec.subcommands, line: help?.line ?? help?.summary ?? spec.name };
  });
}

/** The help's command list: one line per help page, its command words joined (`remote|bridge`). */
function renderCommandList(): string[] {
  const pages = new Map<string, { names: string[]; line: string }>();
  for (const entry of listTuiCommands()) {
    const topic = normalizeHelpTopic(entry.name);
    const page = pages.get(topic);
    if (page) page.names.push(entry.name);
    else pages.set(topic, { names: [entry.name], line: entry.line });
  }
  return [...pages.values()].map(({ names, line }) => {
    const words = names.join('|');
    return words.length < 27 ? `  ${words.padEnd(27)}${line}` : `  ${words}\n${' '.repeat(29)}${line}`;
  });
}

export function renderGoodVibesHelp(binary = 'goodvibes'): string {
  return [
    `Usage: ${binary} [OPTIONS] [PROMPT]`,
    `       ${binary} [OPTIONS] <COMMAND> [ARGS]`,
    '',
    'Commands:',
    ...renderCommandList(),
    '',
    'Options:',
    '  -m, --model <registryKey>       Override model. provider:model infers --provider',
    '      --provider <id>            Override provider',
    '  -C, --cd <dir>                 Set working directory for this launch',
    '      --working-dir <dir>        Alias for --cd',
    '      --daemon-home <dir>        Override daemon home for daemon-backed commands',
    '  -c, --config <key=value>       Override a config value for this launch',
    '      --enable <feature>         Enable a platform feature for this launch',
    '      --disable <feature>        Disable a platform feature for this launch',
    '  -p, --prompt <text>            Run a non-interactive prompt',
    '      --print                    Alias for non-interactive run mode',
    '  -o, --output <format>          text, json, or stream-json',
    '      --output-format <format>   Alias for --output',
    '      --json                     Alias for --output-format json',
    '      --just-vibes               Work without interrupting you; anything that needs you is held for the end',
    '      --yolo                     Run every action without safety denials for this launch',
    '      --no-alt-screen            Keep output in normal terminal scrollback',
    '      --port <port>              Port for server/web commands',
    '      --hostname <host>          Hostname for server/web commands (--host is an alias)',
    '      --open                     Open browser when supported',
    '  -r, --resume [id|latest]       Resume saved session when supported',
    '  -s, --session <id>             run: attach to a specific session',
    '      --continue                 Continue the latest session when supported',
    '      --fork [id]                Fork session (current or specific id) when supported',
    '      --timeout <duration>       run: stop after this long (90, 90s, 5m, 1h); exits 124',
    '      --max-turns <n>            run: stop after n model answers that still ask for tools; exits 1',
    '      --omit-accumulated         run: with stream-json, leave `accumulated` out of STREAM_DELTA',
    '      --answer-permissions       run: with stream-json, read PERMISSION_ANSWER lines on stdin for owner prompts',
    '  -y, --yes                      Auto-confirm prompts (non-interactive)',
    '      --non-interactive          Disable all interactive prompts (implies --yes)',
    '      --strict                   doctor: also fail on advisory findings, for CI',
    '  -h, --help                     Print help',
    '  -v, --version                  Print version',
    '',
    'Examples:',
    `  ${binary}`,
    `  ${binary} --no-alt-screen`,
    `  ${binary} --cd ~/work/project --model openai:gpt-5.2`,
    `  ${binary} setup`,
    `  ${binary} setup status`,
    `  ${binary} status`,
    `  ${binary} models current`,
    `  ${binary} models use openai:gpt-5.2`,
    `  ${binary} providers inspect openai`,
    `  ${binary} surfaces`,
    `  ${binary} surfaces check`,
    `  ${binary} surfaces enable web`,
    `  ${binary} service check`,
    `  ${binary} listener test`,
    `  ${binary} control-plane status`,
    `  ${binary} subscription providers`,
    `  ${binary} subscription login openai start --open`,
    `  goodvibes-daemon --hostname 0.0.0.0 --port 3421`,
  ].join('\n');
}

type CommandHelp = TerminalCommandHelp;

const COMMAND_HELP: Record<string, CommandHelp> = {
  tui: {
    usage: ['tui [path]', '[prompt]'],
    summary: 'Start the interactive terminal UI. A prompt starts the TUI with that prompt seeded.',
    line: 'Start the interactive TUI (default)',
    examples: ['', 'tui ~/work/project', '"review this repo"'],
  },
  run: {
    usage: [
      'run [prompt] [--output text|json|stream-json]',
      'exec [prompt]',
      'run --intake-status|--intake-retry|--intake-resume|--intake-cancel',
      'run [prompt] [--timeout <duration>] [--max-turns <n>] [--omit-accumulated] [--answer-permissions]',
    ],
    summary:
      'Run one prompt non-interactively and print the result; the prompt goes straight to the local model. The --intake-* modes work on a prompt captured through native daemon admission: status is read-only and recovery reuses the saved input. Use -- before literal prompt tokens.',
    line: 'Run non-interactively with text/json/stream-json output',
    examples: ['run "summarize the current project"', 'run --output json "list risks"', 'exec --output stream-json "fix lint"'],
  },
  open: {
    usage: ['open <goodvibes://open/<view>[?target=<id>[:<kind>]]>'],
    summary: 'Start the app and open the view a goodvibes:// link names (selecting its target in a process view). A link that does not parse exits with the usage error.',
    line: 'Start the app on the view a goodvibes://open link names',
    examples: ['open goodvibes://open/security', 'open "goodvibes://open/agents?target=contract-123:contract"'],
  },
  setup: {
    usage: ['setup', 'setup status'],
    summary: 'Open /setup: models, sign-in, keys, access, chat apps and features, one topic at a time; or say whether first run has been done for this user.',
    line: 'Open /setup in the TUI, or say whether first run has been done',
    examples: ['setup', 'setup status'],
  },
  status: {
    usage: ['status', 'status --json'],
    summary: 'Print config, provider, auth, service, surface, and onboarding posture.',
    line: 'Print config, provider, service, and onboarding posture',
    examples: ['status', 'status --json'],
  },
  doctor: {
    usage: ['doctor', 'doctor --json', 'doctor --strict', 'doctor explain <tool|command>', 'doctor routing', 'doctor hooks'],
    summary:
      'Print status plus setup warnings, or explain a platform decision: explain (why a tool/command would be allowed/asked/denied: the gate the app runs, under the mode in force, with the decision model, remembered and never-run rules and the tool\'s path containment; it says when the decision model was not consulted), routing (which model/provider serves which role), hooks (registered hooks, their source, and validation status). Exits 0 when the install is usable (advisory findings render as notes); non-zero only for a must-fix finding. --strict also fails on advisory findings, for CI.',
    line: 'Print status plus setup warnings; explain, routing and hooks explain a decision',
    examples: [
      'doctor',
      'doctor --strict',
      'doctor explain "rm -rf build"',
      'doctor explain write ./src/app.ts',
      'doctor routing',
      'doctor hooks --json',
    ],
  },
  providers: { ...COMMON_COMMAND_HELP['providers'], line: 'List/inspect/use provider config/auth posture' },
  // The terminal app also lists the synthetic models' fallback chains.
  models: {
    ...COMMON_COMMAND_HELP['models'],
    usage: [...COMMON_COMMAND_HELP['models'].usage, 'models chain [filter]'],
    line: 'List/use/pin selectable models, recent model history and fallback chains',
  },
  auth: {
    usage: [
      'auth status',
      'auth users',
      'auth sessions',
      'auth add-user <username> [--password <value>|--password-stdin] [--role <role>]',
      'auth delete-user <username>',
      'auth rotate-password <username> [--password <value>|--password-stdin]',
      'auth revoke-session <session-id-or-token>',
      'auth revoke-sessions <username>',
      'auth clear-bootstrap',
    ],
    summary: 'Inspect and manage local admin users, bootstrap auth, and local sessions. User changes reach a running daemon at its next sign-in or session check; sessions, revoke-session and revoke-sessions act on the running daemon on this machine.',
    line: 'Inspect and manage local users, sessions, and bootstrap auth',
    examples: ['auth', 'auth add-user admin --password-stdin', 'auth rotate-password admin --password-stdin', 'auth clear-bootstrap'],
  },
  host: {
    usage: ['host pair [--url <exact-origin>] [--name <device-name>] [--bootstrap-shared] [--apply]', 'host unpair [--url <exact-origin>]'],
    line: 'Review explicit TUI host pairing (--bootstrap-shared; --apply), or forget it',
    summary: 'Review pairing of this TUI with its host. --apply creates the credential and needs fresh confirmation in an owner terminal; scripted approval (--yes) is not supported. When the host no longer accepts the stored credential, pair --apply offers to forget it. unpair forgets the stored credential (it stays valid on the host until revoked there).',
    examples: ['host pair', 'host pair --bootstrap-shared', 'host pair --apply', 'host unpair'],
  },
  subscription: {
    usage: [
      'subscription list',
      'subscription providers',
      'subscription inspect <provider>',
      'subscription login <provider> start [--open]',
      'subscription login <provider> finish <code-or-url>',
      'subscription refresh <provider>',
      'subscription logout <provider>',
    ],
    summary: 'Manage OAuth/subscription-backed provider sessions such as OpenAI subscription access.',
    line: 'Start/finish/refresh/logout provider subscription sessions',
    examples: ['subscription providers', 'subscription login openai start --open', 'subscription inspect openai'],
  },
  secrets: { ...COMMON_COMMAND_HELP['secrets'], line: 'List, set, link, delete, and test GoodVibes secret refs' },
  sessions: {
    usage: ['sessions list', 'sessions show <id|name>', 'sessions export <id|name> [path]', 'sessions resume <id|name>'],
    summary: 'List, inspect, export, or resume saved TUI sessions.',
    line: 'List, show, export, or resume saved sessions',
    examples: ['sessions list', 'sessions show latest-session', 'sessions export abc123 session.json'],
  },
  tasks: {
    usage: ['tasks list', 'tasks show <taskId>', 'tasks submit <prompt>'],
    summary: 'Inspect runtime tasks or submit a non-interactive task.',
    line: 'List/show in-process tasks or submit a non-interactive task',
    examples: ['tasks list', 'tasks submit "check provider readiness"'],
  },
  surfaces: {
    usage: [
      'surfaces [list]',
      'surfaces check [<web|listener|control-plane|surfaceId>]',
      'surfaces show <web|listener|control-plane|surfaceId>',
      'surfaces enable <web|listener|control-plane|surfaceId>',
      'surfaces disable <web|listener|control-plane|surfaceId>',
    ],
    summary: 'Inspect and configure browser, control-plane, HTTP listener, and external integration surfaces.',
    line: 'Inspect/check/enable/disable browser/listener/external surfaces',
    examples: ['surfaces check', 'surfaces enable web', 'surfaces enable slack'],
  },
  listener: {
    usage: ['listener test'],
    summary: 'Check HTTP listener/webhook readiness, network posture, service posture, auth, and enabled surface requirements.',
    line: 'Test HTTP listener/webhook readiness',
    examples: ['listener test', 'listener test --json'],
  },
  'control-plane': {
    usage: ['control-plane status'],
    summary: 'Inspect daemon control-plane bind posture, reachability, local auth, bootstrap credentials, and operator tokens.',
    line: 'Inspect daemon auth, local admin, tokens, and ports',
    examples: ['control-plane status', 'control-plane status --json'],
  },
  'support-bundle': {
    usage: ['support-bundle export [path]', 'support-bundle inspect <path>', 'support-bundle import <path> [--include-security] [--yes]'],
    summary:
      'Export, inspect, or import a support snapshot (redacted config + diagnostics + posture). Import applies only the config values: it refuses a bundle from another product or format version, imports only values that differ from your settings, holds back permission, sandbox, listener, service and storage settings unless --include-security is given, applies all or nothing, and without --yes lists each change as current -> new and changes nothing (exit 2). Aliases: bundle, bundles. Distinct from `plugin bundles` (capability bundles).',
    line: 'Move a support snapshot (config + diagnostics + posture)',
    examples: ['support-bundle export goodvibes-bundle.json', 'support-bundle inspect goodvibes-bundle.json'],
  },
  acp: {
    usage: ['acp'],
    summary:
      'Run GoodVibes as an Agent Client Protocol agent on stdin/stdout so an ACP editor (Zed and others) can drive it. Stdout carries only protocol frames; messages go to stderr. Ends when the editor closes stdin. Prompt input is text only and session restore (loadSession) is not supported. For an MCP client use `goodvibes-daemon mcp serve`.',
    line: 'Run as an Agent Client Protocol agent over stdio (for editors)',
    examples: ['acp'],
  },
  pair: { ...COMMON_COMMAND_HELP['pair'], line: 'Mint a named device token on the connected host; print its link and QR code' },
  web: {
    usage: ['web [--open]'],
    summary: 'Show the configured browser surface URL, bind address, and enablement state.',
    line: 'Show browser surface bind URL and enablement',
    examples: ['web', 'web --open', 'web --hostname 0.0.0.0 --port 3423'],
  },
  service: {
    usage: ['service status', 'service check', 'service install|start|stop|restart|uninstall'],
    summary: 'Inspect and manage the daemon service lifecycle, autostart, restart policy, PID, logs, and endpoint readiness.',
    line: 'Inspect/manage daemon service lifecycle',
    examples: ['service status', 'service check --json', 'service install'],
  },
  completion: { ...COMMON_COMMAND_HELP['completion'], line: 'Generate shell completion script' },
  serve: {
    usage: ['serve'],
    summary:
      'Not served here: the daemon is its own program. Run `goodvibes-daemon` (or manage the installed service with `goodvibes service`).',
    examples: [],
  },
  remote: {
    usage: ['remote', 'bridge'],
    summary: 'Inspect remote runner/node posture and bridge readiness.',
    line: 'Inspect remote runner/node posture',
    examples: ['remote', 'bridge'],
  },
  hooks: {
    usage: ['hooks validate'],
    summary:
      'Validate the configured hooks.json against the hook loader schema; per-hook pass/fail with plain reasons, nonzero exit if any hook is invalid.',
    line: 'Validate hooks.json against the hook loader schema',
    examples: ['hooks validate', 'hooks validate --json'],
  },
  help: {
    usage: ['help [command]'],
    summary: 'Print the command list and options, or one command\'s help.',
    line: 'Print this help or command-specific help',
    examples: ['help', 'help run'],
  },
  version: {
    usage: ['version'],
    summary: 'Print the version.',
    line: 'Print version',
    examples: ['version'],
  },
  plugin: {
    usage: [
      'plugin init <name> [directory]',
      'plugin validate <path>',
      'plugin bundles browse <index-url-or-file>',
      'plugin bundles install <ref> --sha256 <pin> [--ref <git-ref>] [--yes]',
      'plugin bundles uninstall <id>',
      'plugin bundles list',
      'plugin trust <name> <untrusted|limited|trusted> [note]',
      'plugin verify <name>',
      'plugin capabilities <name>',
    ],
    summary:
      'Scaffold a minimal valid plugin (manifest.json + entry file), validate a plugin directory against the plugin loader checks, browse/install/uninstall/list SHA-256-pinned capability bundles from a governed marketplace index (--ref picks a git ref when the bundle source is a git remote; without --yes, install prints the activation plan and changes nothing), or set and inspect a plugin\'s trust tier (what it may register), which every GoodVibes app on this machine applies the next time it starts the plugin. Bundle installs are never unpinned; a missing or mismatched --sha256 is refused, not overridable. Marking a plugin trusted when its signature does not verify needs --yes.',
    line: 'Scaffold, validate or trust a plugin, or manage SHA-256-pinned capability bundles',
    examples: [
      'plugin init my-plugin',
      'plugin validate .goodvibes/plugins/my-plugin',
      'plugin bundles browse ./marketplace-index.json',
      'plugin bundles install ./bundle.json --sha256 <64-hex> --yes',
      'plugin bundles uninstall my-bundle',
      'plugin trust my-plugin limited',
    ],
  },
};

/** Every catalog spelling names its command's page; `bridge` shares the `remote` page. */
const HELP_ALIASES: Record<string, string> = {
  ...Object.fromEntries(GOODVIBES_CLI_CATALOG.commands.flatMap((spec) => spec.aliases.map((alias) => [alias, spec.name]))),
  bridge: 'remote',
};

const normalizeHelpTopic = (topic: string) => normalizeTopic(topic, HELP_ALIASES);

export function renderGoodVibesCommandHelp(topic: string, binary = 'goodvibes'): string {
  const normalized = normalizeHelpTopic(topic);
  const help = Object.hasOwn(COMMAND_HELP, normalized) ? COMMAND_HELP[normalized] : undefined;
  return renderDetailedCommandHelp(topic, normalized, help, binary, 'GoodVibes', renderGoodVibesHelp);
}
