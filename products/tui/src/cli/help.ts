import { productVersionFromModule } from '@goodvibes-jev/engine/terminal-shell/cli-help';
import { normalizeHelpTopic as normalizeTopic } from '@goodvibes-jev/engine/terminal-shell/cli-help';
import { renderDetailedCommandHelp, COMMON_COMMAND_HELP, type TerminalCommandHelp } from '@goodvibes-jev/engine/terminal-shell/cli-help';
import 'node:fs';
import { join } from 'node:path';
import 'node:url';
import { VERSION } from '../version.ts';

export const getPackageVersion = (): string => productVersionFromModule(import.meta.url, '@goodvibes-jev/tui', VERSION);

export function renderGoodVibesVersion(binary = 'goodvibes'): string {
  return `${binary} ${getPackageVersion()}`;
}

export function renderGoodVibesHelp(binary = 'goodvibes'): string {
  return [
    `Usage: ${binary} [OPTIONS] [PROMPT]`,
    `       ${binary} [OPTIONS] <COMMAND> [ARGS]`,
    '',
    'Commands:',
    '  tui [path]                 Start the interactive TUI (default)',
    '  run|exec [prompt]          Run non-interactively with text/json/stream-json output',
    '  web                        Show browser surface bind URL and enablement',
    '  service                    Inspect/manage daemon service lifecycle',
    '  status                     Print config, provider, service, and onboarding posture',
    '  doctor                     Print status plus setup warnings',
    '  doctor explain <target>    Explain why a tool/command would be allowed/asked/denied',
    '  doctor routing             Print which model/provider serves which role',
    '  doctor hooks               List registered hooks, their source, and validation status',
    '  onboarding [status]        Open onboarding in the TUI, or print onboarding status',
    '  models [provider]          List/use/pin selectable models and recent model history',
    '  providers                  List/inspect/use provider config/auth posture',
    '  auth                       Inspect and manage local users, sessions, and bootstrap auth',
    '  subscription               Start/finish/logout provider subscription sessions',
    '  secrets                    List, set, link, delete, and test GoodVibes secret refs',
    '  sessions                   List, show, export, or resume saved sessions',
    '  tasks                      List/show in-process tasks or submit a non-interactive task',
    '  acp                        Run as an Agent Client Protocol agent over stdio (for editors)',
    '  host pair|unpair          Review explicit TUI host pairing (--bootstrap-shared; --apply), or forget it',
    '  pair|qrcode                Mint a named device token on the connected host; print its link and QR code',
    '  surfaces                   Inspect/check/enable/disable browser/listener/external surfaces',
    '  listener test              Test HTTP listener/webhook readiness',
    '  control-plane status       Inspect daemon auth, local admin, tokens, and ports',
    '  support-bundle export|inspect|import',
    '                             Move a support snapshot (config + diagnostics + posture)',
    '  remote|bridge              Inspect remote runner/node posture',
    '  hooks validate             Validate hooks.json against the hook loader schema',
    '  plugin init|validate|trust Scaffold, validate, or set what a plugin may do',
    '  plugin bundles ...         Browse/install/uninstall/list SHA-256-pinned capability bundles',
    '  completion <shell>         Generate shell completion script',
    '  help [command]             Print this help or command-specific help',
    '  version                    Print version',
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
    `  ${binary} onboarding`,
    `  ${binary} onboarding status`,
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
    examples: ['run "summarize the current project"', 'run --output json "list risks"', 'exec --output stream-json "fix lint"'],
  },
  open: {
    usage: ['open <goodvibes://open/<view>[?target=<id>[:<kind>]]>'],
    summary: 'Start the app and open the view a goodvibes:// link names (selecting its target in a process view). A link that does not parse exits with the usage error.',
    examples: ['open goodvibes://open/security', 'open "goodvibes://open/agents?target=contract-123:contract"'],
  },
  onboarding: {
    usage: ['onboarding', 'setup', 'onboarding status'],
    summary: 'Open the setup wizard, or inspect whether onboarding has already been shown for this user.',
    examples: ['onboarding', 'onboarding status'],
  },
  status: {
    usage: ['status', 'status --json'],
    summary: 'Print config, provider, auth, service, surface, and onboarding posture.',
    examples: ['status', 'status --json'],
  },
  doctor: {
    usage: ['doctor', 'doctor --json', 'doctor --strict', 'doctor explain <tool|command>', 'doctor routing', 'doctor hooks'],
    summary:
      'Print status plus setup warnings, or explain a platform decision: explain (why a tool/command would be allowed/asked/denied under the current mode), routing (which model/provider serves which role), hooks (registered hooks, their source, and validation status). Exits 0 when the install is usable (advisory findings render as notes); non-zero only for a must-fix finding. --strict also fails on advisory findings, for CI.',
    examples: [
      'doctor',
      'doctor --strict',
      'doctor explain "rm -rf build"',
      'doctor explain write ./src/app.ts',
      'doctor routing',
      'doctor hooks --json',
    ],
  },
  providers: COMMON_COMMAND_HELP['providers'],
  models: COMMON_COMMAND_HELP['models'],
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
    summary: 'Inspect and manage local admin users, bootstrap auth, and local sessions. Changes are written to the user store; a running host picks them up when it restarts, and its in-memory sessions are not reachable from this command.',
    examples: ['auth', 'auth add-user admin --password-stdin', 'auth rotate-password admin --password-stdin', 'auth clear-bootstrap'],
  },
  host: {
    usage: ['host pair [--url <exact-origin>] [--name <device-name>] [--bootstrap-shared] [--apply]', 'host unpair [--url <exact-origin>]'],
    summary: 'Review pairing of this TUI with its host. --apply creates the credential and needs fresh confirmation in an owner terminal; scripted approval (--yes) is not supported. When the host no longer accepts the stored credential, pair --apply offers to forget it. unpair forgets the stored credential (it stays valid on the host until revoked there).',
    examples: ['host pair', 'host pair --bootstrap-shared', 'host pair --apply', 'host unpair'],
  },
  subscription: {
    usage: [
      'subscription list',
      'subscription providers',
      'subscription inspect <provider>',
      'subscription login <provider> start|finish',
      'subscription logout <provider>',
    ],
    summary: 'Manage OAuth/subscription-backed provider sessions such as OpenAI subscription access.',
    examples: ['subscription providers', 'subscription login openai start --open', 'subscription inspect openai'],
  },
  secrets: COMMON_COMMAND_HELP['secrets'],
  sessions: {
    usage: ['sessions list', 'sessions show <id|name>', 'sessions export <id|name> [path]', 'sessions resume <id|name>'],
    summary: 'List, inspect, export, or resume saved TUI sessions.',
    examples: ['sessions list', 'sessions show latest-session', 'sessions export abc123 session.json'],
  },
  tasks: {
    usage: ['tasks list', 'tasks show <taskId>', 'tasks submit <prompt>'],
    summary: 'Inspect runtime tasks or submit a non-interactive task.',
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
    examples: ['surfaces check', 'surfaces enable web', 'surfaces enable slack'],
  },
  listener: {
    usage: ['listener test'],
    summary: 'Check HTTP listener/webhook readiness, network posture, service posture, auth, and enabled surface requirements.',
    examples: ['listener test', 'listener test --json'],
  },
  'control-plane': {
    usage: ['control-plane status'],
    summary: 'Inspect daemon control-plane bind posture, reachability, local auth, bootstrap credentials, and operator tokens.',
    examples: ['control-plane status', 'control-plane status --json'],
  },
  'support-bundle': {
    usage: ['support-bundle export [path]', 'support-bundle inspect <path>', 'support-bundle import <path> [--include-security] [--yes]'],
    summary:
      'Export, inspect, or import a support snapshot (redacted config + diagnostics + posture). Import applies only the config values: it refuses a bundle from another product or format version, imports only values that differ from your settings, holds back permission, sandbox, listener, service and storage settings unless --include-security is given, applies all or nothing, and without --yes lists each change as current -> new and changes nothing (exit 2). Aliases: bundle, bundles. Distinct from `plugin bundles` (capability bundles).',
    examples: ['support-bundle export goodvibes-bundle.json', 'support-bundle inspect goodvibes-bundle.json'],
  },
  acp: {
    usage: ['acp'],
    summary:
      'Run GoodVibes as an Agent Client Protocol agent on stdin/stdout so an ACP editor (Zed and others) can drive it. Stdout carries only protocol frames; messages go to stderr. Ends when the editor closes stdin. Prompt input is text only and session restore (loadSession) is not supported. For an MCP client use `goodvibes-daemon mcp serve`.',
    examples: ['acp'],
  },
  pair: COMMON_COMMAND_HELP['pair'],
  web: {
    usage: ['web [--open]'],
    summary: 'Show the configured browser surface URL, bind address, and enablement state.',
    examples: ['web', 'web --open', 'web --hostname 0.0.0.0 --port 3423'],
  },
  service: {
    usage: ['service status', 'service check', 'service install|start|stop|restart|uninstall'],
    summary: 'Inspect and manage the daemon service lifecycle, autostart, restart policy, PID, logs, and endpoint readiness.',
    examples: ['service status', 'service check --json', 'service install'],
  },
  completion: COMMON_COMMAND_HELP['completion'],
  serve: {
    usage: ['serve'],
    summary:
      'Not served here: the daemon is its own program. Run `goodvibes-daemon` (or manage the installed service with `goodvibes service`).',
    examples: [],
  },
  remote: {
    usage: ['remote', 'bridge'],
    summary: 'Inspect remote runner/node posture and bridge readiness.',
    examples: ['remote', 'bridge'],
  },
  hooks: {
    usage: ['hooks validate'],
    summary:
      'Validate the configured hooks.json against the hook loader schema; per-hook pass/fail with plain reasons, nonzero exit if any hook is invalid.',
    examples: ['hooks validate', 'hooks validate --json'],
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

const HELP_ALIASES: Record<string, string> = {
  app: 'tui',
  exec: 'run',
  setup: 'onboarding',
  provider: 'providers',
  model: 'models',
  subscriptions: 'subscription',
  secret: 'secrets',
  session: 'sessions',
  task: 'tasks',
  surface: 'surfaces',
  webhook: 'listener',
  controlplane: 'control-plane',
  cp: 'control-plane',
  bundle: 'support-bundle',
  bundles: 'support-bundle',
  qrcode: 'pair',
  qr: 'pair',
  daemon: 'serve',
  server: 'serve',
  services: 'service',
  bridge: 'remote',
  hook: 'hooks',
  plugins: 'plugin',
};

const normalizeHelpTopic = (topic: string) => normalizeTopic(topic, HELP_ALIASES);

export function renderGoodVibesCommandHelp(topic: string, binary = 'goodvibes'): string {
  const normalized = normalizeHelpTopic(topic);
  const help = Object.hasOwn(COMMAND_HELP, normalized) ? COMMAND_HELP[normalized] : undefined;
  return renderDetailedCommandHelp(topic, normalized, help, binary, 'GoodVibes', renderGoodVibesHelp);
}
