/**
 * System, in the program a person is sitting at (home `session`), second part:
 * whether this program is working (`health.*`), release readiness of this
 * project from this session (`release.*`), this program's own start
 * (`startup.*` reviews and links), the links to its views, its help, stopping
 * what it speaks, and the wake word on its microphone. Each reads or acts on
 * the program's own live state, so it runs there with the program's services
 * (system-session.ts `SystemSessionServices`); nothing here reaches a screen.
 */
import { CapabilityRefusal, REPLACED_DONE, type CapabilityDefinition, type FixedChoice, type InputDescription, type ListName } from '../types.js';
import type { SystemHealthServices, SystemSessionServices } from './system-session.js';

type System = NonNullable<SystemSessionServices['systemSession']>;
type Def = CapabilityDefinition<SystemSessionServices>;

function systemOf(services: SystemSessionServices): System {
  if (!services.systemSession) throw new CapabilityRefusal('This program has nothing of its own to show or change here.', undefined, 'UNAVAILABLE');
  return services.systemSession;
}

const session = (id: string, repeat: 'safe' | 'unsafe' = 'safe') => ({ id, group: 'system' as const, home: 'session' as const, repeat });

const read = (fields: Pick<Def, 'capability' | 'actionId' | 'label' | 'word' | 'sentence' | 'run'> & Partial<Pick<Def, 'inputs' | 'example' | 'available'>>): Def => ({
  inputs: [], example: {}, ...fields, done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none',
});

const REPLACE: InputDescription = {
  id: 'replace', label: 'If the file exists', help: 'Keep it, or write over it', kind: 'choice', typed: { flag: '--replace', switchOn: 'yes' },
  choices: [{ value: 'no', label: 'Keep it and stop' }, { value: 'yes', label: 'Write over it', help: 'What the file holds now is lost.', risk: 'cannot-be-undone', riskDone: REPLACED_DONE }],
  required: { default: 'no', defaultMeans: 'keep it and stop' },
};

const pathInput = (help: string): InputDescription => ({
  id: 'path', label: 'File', help, kind: 'path', freeTextReason: 'a file path', required: true, typed: { position: 1 },
});

// ---------------------------------------------------------------------------
// Whether this program is working: health.*
// ---------------------------------------------------------------------------

/** The areas "Check one area" offers, the same list in both programs. */
export const HEALTH_AREAS = [
  { value: 'setup', label: 'Setup', help: 'Models, services, plugins and MCP servers found at start' },
  { value: 'services', label: 'Services', help: 'Whether each configured service is ready' },
  { value: 'provider', label: 'Model providers', help: 'The model in use and provider account problems' },
  { value: 'accounts', label: 'Provider accounts', help: 'Sign-ins and keys of each provider' },
  { value: 'auth', label: 'Local sign-in', help: 'Users and sessions of this machine\'s sign-in' },
  { value: 'settings', label: 'Settings', help: 'Managed locks, conflicts and failed writes' },
  { value: 'intelligence', label: 'Code intelligence', help: 'Language servers, symbols and diagnostics' },
  { value: 'remote', label: 'Remote runners', help: 'Remote sessions and their connections' },
  { value: 'mcp', label: 'MCP servers', help: 'Which servers are connected and which failed' },
  { value: 'memory', label: 'Memory use', help: 'This program\'s memory budget, caches and paused work' },
  { value: 'metrics', label: 'Runtime counters and quota', help: 'The daemon\'s counters and the provider\'s remaining quota' },
  { value: 'continuity', label: 'Picking up where you left off', help: 'The last session and the recovery file' },
  { value: 'worktrees', label: 'Worktrees', help: 'Worktrees kept, active or paused' },
  { value: 'maintenance', label: 'Conversation size', help: 'How full the context window is and whether to compact' },
  { value: 'sandbox', label: 'Sandbox', help: 'Whether commands and MCP servers run inside a boundary' },
  { value: 'terminal', label: 'This terminal', help: 'Colours, synchronized output and intercepted writes' },
  { value: 'approvals', label: 'Approvals waiting', help: 'The asks waiting for you on the host and here' },
] as const satisfies readonly FixedChoice[];

export type HealthArea = typeof HEALTH_AREAS[number]['value'];
export type FailureReportView = 'summary' | 'json' | 'bundle';

/** The failure reports of this session, newest first (the list stays registered in terminal-shell's health-command.ts). */
export const FAILURE_REPORTS_LIST = 'health.failure-reports' as ListName;

function healthOf(services: SystemSessionServices): SystemHealthServices {
  const health = systemOf(services).health;
  if (!health) throw new CapabilityRefusal('This program does not check its own health.', undefined, 'UNAVAILABLE');
  return health;
}

function failuresOf(services: SystemSessionServices): NonNullable<SystemHealthServices['failures']> {
  const health = healthOf(services);
  if (!health.failures) throw new CapabilityRefusal(`Failure reports are not kept in this program; nothing was done. They are in ${health.elsewhere}.`, undefined, 'UNAVAILABLE');
  return health.failures;
}

const REPORT_INPUT: InputDescription = {
  id: 'report', label: 'Failure report', help: 'This session\'s failure reports, newest first', kind: 'choice',
  choices: { list: FAILURE_REPORTS_LIST, allowOther: { reason: 'a report id, or latest' } },
  required: { default: 'latest', defaultMeans: 'the latest one' }, typed: { position: 1 },
};

export const HEALTH_REPORT: Def = read({
  capability: session('health.report'), actionId: 'report', label: 'See what needs attention', word: 'report',
  sentence: 'Checks whether everything is working (setup, providers, accounts, settings, services, MCP servers, sign-in and the conversation\'s size) and names each thing that is not, with how to fix it.',
  async run(_values, services) { return { text: await healthOf(services).report() }; },
});

export const HEALTH_CHECK: Def = read({
  capability: session('health.check'), actionId: 'check', label: 'Check one area', word: 'check',
  inputs: [
    { id: 'area', label: 'Area', help: 'What to look at in detail', kind: 'choice', choices: HEALTH_AREAS, required: true, typed: { position: 1 } },
    { id: 'provider', label: 'Provider', help: 'Whose remaining quota to read', kind: 'text', freeTextReason: 'a provider\'s id', required: { default: '', defaultMeans: 'the provider in use' }, typed: { flag: '--provider' }, showWhen: { input: 'area', is: 'metrics' } },
  ],
  sentence: 'Shows {area} in detail: what is set up, what is working and what is not.', example: { area: 'mcp' },
  async run(values, services) { return { text: await healthOf(services).check(values.area!, values.provider ?? '') }; },
});

export const HEALTH_DIAGNOSE: Def = read({
  capability: session('health.diagnose'), actionId: 'diagnose', label: 'Describe a problem', word: 'diagnose',
  inputs: [{ id: 'symptom', label: 'What is wrong', help: 'In your own words, such as "stuck turn"', kind: 'text', freeTextReason: 'your own words', required: true, typed: { tail: true } }],
  sentence: 'Finds the checks for {symptom} and runs them against this program\'s live state; no model is asked.', example: { symptom: 'stuck turn' },
  async run(values, services) { return { text: await healthOf(services).diagnose(values.symptom!) }; },
});

export const HEALTH_FAILURE: Def = read({
  capability: session('health.failure'), actionId: 'failure', label: 'See a failure report', word: 'failure',
  inputs: [REPORT_INPUT, {
    id: 'view', label: 'As', help: 'How much to show', kind: 'choice', typed: { flag: '--as' },
    choices: [
      { value: 'summary', label: 'A summary', help: 'What failed, why, and the evidence counts' },
      { value: 'json', label: 'The report as JSON' },
      { value: 'bundle', label: 'The whole bundle as JSON', help: 'With the replay snapshot, for a support thread' },
    ],
    required: { default: 'summary', defaultMeans: 'a summary' },
  }],
  sentence: 'Shows a failure report of this session: what failed, its cause and the evidence.', example: { report: 'latest', view: 'json' },
  async run(values, services) {
    return { text: failuresOf(services).show(values.report || 'latest', (values.view || 'summary') as FailureReportView) };
  },
});

export const HEALTH_SAVE_FAILURE: Def = {
  capability: session('health.save-failure'), actionId: 'save-failure', label: 'Save a failure report as a file', word: 'save-failure',
  inputs: [
    pathInput('Where to write it'),
    { ...REPORT_INPUT, typed: { flag: '--report' } },
    {
      id: 'replay', label: 'Replay snapshot', help: 'The recorded turn, to replay it elsewhere', kind: 'choice', typed: { flag: '--with-replay', switchOn: 'yes' },
      choices: [{ value: 'no', label: 'Leave it out' }, { value: 'yes', label: 'Put it in' }], required: { default: 'no', defaultMeans: 'leave it out' },
    },
    REPLACE,
  ],
  sentence: 'The failure report\'s bundle will be written to {path} on this machine, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { path: 'incident.json', report: 'latest' },
  async run(values, services) {
    return { text: failuresOf(services).save({ report: values.report || 'latest', path: values.path!, replay: values.replay === 'yes', replace: values.replace === 'yes' }) };
  },
};

export const HEALTH_KEEP_FAILURE: Def = {
  capability: session('health.keep-failure'), actionId: 'keep-failure', label: 'Keep a failure of this session as an incident', word: 'keep-failure',
  inputs: [REPORT_INPUT],
  sentence: 'A failure report of this session (what failed, why, the evidence) is kept as an incident record that later sessions remember, once, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { report: 'latest' },
  async run(values, services) { return { text: await failuresOf(services).keep(values.report || 'latest') }; },
};

export const HEALTH_STATE: Def = read({
  capability: session('health.state'), actionId: 'state', label: 'See the runtime store', word: 'state',
  inputs: [{ id: 'domains', label: 'Parts', help: 'Only these parts, such as session agents tasks', kind: 'text', freeTextReason: 'part names as the store lists them', required: { default: '', defaultMeans: 'every part' }, typed: { tail: true } }],
  sentence: 'Shows what this program\'s runtime store holds now, part by part, with credentials masked; for debugging.', example: { domains: 'session' },
  async run(values, services) {
    return { text: healthOf(services).state((values.domains ?? '').split(/[\s,]+/).filter((name) => name.length > 0)) };
  },
});

export const HEALTH_COMPAT: Def = read({
  capability: session('health.compat'), actionId: 'compat', label: 'Check the connected host\'s compatibility', word: 'compat',
  inputs: [{
    id: 'format', label: 'As', help: 'Text, or JSON for programs', kind: 'choice', typed: { flag: '--json', switchOn: 'json' },
    choices: [{ value: 'text', label: 'Text' }, { value: 'json', label: 'JSON' }], required: { default: 'text', defaultMeans: 'text' },
  }],
  sentence: 'Asks the connected host which routes it serves and whether the Agent\'s knowledge routes are ready.', example: { format: 'json' },
  available: (services) => Boolean(services.systemSession?.health?.compat),
  async run(values, services) {
    const health = healthOf(services);
    if (!health.compat) throw new CapabilityRefusal(`The connected-host compatibility check is not in this program. It is in ${health.elsewhere}.`, undefined, 'UNAVAILABLE');
    return { text: await health.compat(values.format === 'json') };
  },
});

// ---------------------------------------------------------------------------
// Release readiness: release.*
// ---------------------------------------------------------------------------

function releaseOf(services: SystemSessionServices): NonNullable<System['release']> {
  const release = systemOf(services).release;
  if (!release) throw new CapabilityRefusal('Release readiness is read from the terminal app\'s own session; this program has none.', undefined, 'UNAVAILABLE');
  return release;
}
const hasRelease = (services: SystemSessionServices): boolean => Boolean(services.systemSession?.release);

export const RELEASE_REVIEW: Def = read({
  capability: session('release.review'), actionId: 'review', label: 'See release readiness', word: 'review',
  sentence: 'Shows whether this project is ready to release: the model in use, the project\'s eval tasks, this session\'s failure reports, remote work and the plugins and skills installed.',
  available: hasRelease,
  async run(_values, services) { return { text: releaseOf(services).review() }; },
});

export const RELEASE_CHECKLIST: Def = read({
  capability: session('release.checklist'), actionId: 'checklist', label: 'See the release checklist', word: 'checklist',
  sentence: 'Lists the checks to run before a release, and where each one is.',
  async run() {
    return {
      text: [
        'Release checklist',
        '  1. System, Setup and Health: everything is set up and working.',
        '  2. Permissions and safety: nothing needs attention, and you know what is trusted.',
        '  3. Permissions and safety, the policy: it is what you mean to enforce.',
        '  4. Work and agents, the eval gate over the project\'s eval tasks.',
        '  5. System, Health (failure reports) and Work and agents (remote runners): nothing is left unexplained.',
        '  6. Save the release evidence to a file (System, This session).',
      ].join('\n'),
    };
  },
});

export const RELEASE_SAVE: Def = {
  capability: session('release.save'), actionId: 'save', label: 'Save the release evidence to a file', word: 'save',
  inputs: [pathInput('Where to write it'), REPLACE],
  sentence: 'The release evidence (what "See release readiness" shows) will be written to {path}, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { path: 'release-evidence.json' }, available: hasRelease,
  async run(values, services) { return { text: releaseOf(services).save(values.path!, values.replace === 'yes') }; },
};

export const RELEASE_READ: Def = read({
  capability: session('release.read'), actionId: 'read', label: 'Read saved release evidence', word: 'read',
  inputs: [pathInput('Release evidence saved earlier')],
  sentence: 'Reads the release evidence saved in {path} and shows what it recorded.', example: { path: 'release-evidence.json' },
  available: hasRelease,
  async run(values, services) { return { text: releaseOf(services).read(values.path!) }; },
});

// ---------------------------------------------------------------------------
// This program's own start: startup.* reviews and links
// ---------------------------------------------------------------------------

function startupOf(services: SystemSessionServices): NonNullable<System['startup']> {
  const startup = systemOf(services).startup;
  if (!startup) throw new CapabilityRefusal('This program does not review its own start.', undefined, 'UNAVAILABLE');
  return startup;
}
const hasStartup = (services: SystemSessionServices): boolean => Boolean(services.systemSession?.startup);

export const STARTUP_REVIEW: Def = read({
  capability: session('startup.review'), actionId: 'review', label: 'See what this setup has', word: 'review',
  sentence: 'Shows the providers, services, plugins, hooks and servers this program started with.', available: hasStartup,
  async run(_values, services) { return { text: await startupOf(services).review() }; },
});

export const STARTUP_DOCTOR: Def = read({
  capability: session('startup.doctor'), actionId: 'doctor', label: 'Check this setup for problems', word: 'doctor',
  sentence: 'Checks the setup this program started with and lists what is not working.', available: hasStartup,
  async run(_values, services) { return { text: await startupOf(services).doctor() }; },
});

export const STARTUP_SERVICES: Def = read({
  capability: session('startup.services'), actionId: 'services', label: 'See the services and sign-ins', word: 'services',
  sentence: 'Shows the configured services, provider sign-ins and their problems.', available: hasStartup,
  async run(_values, services) { return { text: await startupOf(services).services() }; },
});

export const STARTUP_EXPORT: Def = {
  capability: session('startup.export'), actionId: 'export', label: 'Save the setup review to a file', word: 'export',
  inputs: [pathInput('The file the setup review is written to'), REPLACE],
  sentence: 'The setup review is written as JSON to {path}.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { path: 'setup-review.json' }, available: hasStartup,
  async run(values, services) { return { text: await startupOf(services).save(values.path!, values.replace === 'yes') }; },
};

export const STARTUP_LINK: Def = read({
  capability: session('startup.link'), actionId: 'link', label: 'Make a link to a view', word: 'link',
  inputs: [
    { id: 'surface', label: 'View', help: 'The view the link opens', kind: 'choice', choices: { list: 'deeplink.views' as ListName, allowOther: { reason: 'a view name' } }, required: true, typed: { position: 1 } },
    { id: 'target', label: 'Item', help: 'One item in that view, by its id', kind: 'text', freeTextReason: 'an id inside the view, typed as it is shown there', required: { default: '', defaultMeans: 'the view itself' }, typed: { position: 2 } },
  ],
  sentence: 'Shows a goodvibes:// link that opens {surface}.', example: { surface: 'tasks' }, available: hasStartup,
  async run(values, services) { return { text: startupOf(services).link(values.surface!, values.target ?? '') }; },
});

export const STARTUP_OPEN_LINK: Def = {
  capability: session('startup.open-link'), actionId: 'open-link', label: 'Open a goodvibes:// link', word: 'open-link',
  inputs: [{ id: 'uri', label: 'Link', help: 'A goodvibes://open/… link', kind: 'text', freeTextReason: 'a link someone gave you, pasted as it is', required: true, typed: { position: 1 } }],
  sentence: 'Opens the view the link {uri} names.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { uri: 'goodvibes://open/tasks' }, available: hasStartup,
  async run(values, services) { return { text: startupOf(services).openLink(values.uri!) }; },
};

// ---------------------------------------------------------------------------
// Links to views, help, speaking and the wake word
// ---------------------------------------------------------------------------

export const DEEPLINK_REVIEW: Def = read({
  capability: session('deeplink.review'), actionId: 'review', label: 'See the links to each view', word: 'review',
  sentence: 'Lists the goodvibes://open link of each view of this program.',
  available: (services) => Boolean(services.systemSession?.viewLinks),
  async run(_values, services) {
    const links = systemOf(services).viewLinks;
    if (!links) throw new CapabilityRefusal('Links open views of the terminal app; this program has none.', undefined, 'UNAVAILABLE');
    return { text: ['Links to views:', ...links().map((link) => `  ${link}`)].join('\n'), data: { links: links() } };
  },
});

export const SYSTEM_HELP: Def = read({
  capability: session('system.help'), actionId: 'help', label: 'See every command and every key', word: '',
  inputs: [{
    id: 'about', label: 'About', help: 'A command\'s name to see its actions and lines, or keys for every key', kind: 'text',
    freeTextReason: 'a command name as you type it, without the slash; or keys', required: { default: '', defaultMeans: 'every command and every key' }, typed: { position: 1 },
  }],
  sentence: 'Shows every command and every key, or one command\'s actions and lines.', example: { about: 'keys' },
  async run(values, services) {
    const help = systemOf(services).help;
    if (!help) throw new CapabilityRefusal('This program has no help of its own to show.', undefined, 'UNAVAILABLE');
    return { text: await help((values.about ?? '').replace(/^\//, '').trim()) };
  },
});

function speechOf(services: SystemSessionServices): NonNullable<System['speech']> {
  const speech = systemOf(services).speech;
  if (!speech) throw new CapabilityRefusal('Speaking and listening are not available in this program.', undefined, 'UNAVAILABLE');
  return speech;
}

export const VOICE_STOP: Def = {
  capability: session('voice.stop'), actionId: 'stop', label: 'Stop what is being spoken', word: 'stop', inputs: [],
  sentence: 'Whatever is being played aloud now stops.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const speech = speechOf(services);
    if (!speech.stop) throw new CapabilityRefusal('Speech output is not available in this session.', undefined, 'UNAVAILABLE');
    return { text: speech.stop() ? 'Stopped speaking.' : 'Nothing is playing.' };
  },
};

function wakeOf(services: SystemSessionServices): NonNullable<NonNullable<System['speech']>['wake']> {
  const wake = speechOf(services).wake;
  if (!wake) throw new CapabilityRefusal('Wake-word detection is not available in this session.', undefined, 'UNAVAILABLE');
  return wake;
}

export const VOICE_WAKE_STATUS: Def = read({
  capability: session('voice.wake-status'), actionId: 'wake-status', label: 'See wake-word detection', word: 'wake-status',
  sentence: 'Shows whether the wake-word models are here and how listening for the wake word is set.',
  async run(_values, services) { return { text: await wakeOf(services).status() }; },
});

export const VOICE_WAKE_SETUP: Def = {
  capability: session('voice.wake-setup', 'safe'), actionId: 'wake-setup', label: 'Set up the wake word', word: 'wake-setup',
  inputs: [{
    id: 'stt', label: 'Speech-to-text', help: 'What makes a wake word useful', kind: 'choice', typed: { flag: '--with-speech-to-text', switchOn: 'yes' },
    choices: [{ value: 'no', label: 'Only say whether it is needed' }, { value: 'yes', label: 'Install it too' }],
    required: { default: 'no', defaultMeans: 'only say whether it is needed' },
  }],
  sentence: 'The wake-word models are downloaded and checked, and speech-to-text is installed too when chosen.', done: '',
  touches: 'another-machine', lasts: 'not-a-change', risk: 'none', example: { stt: 'yes' },
  async run(values, services) { return { text: await wakeOf(services).setup(values.stt === 'yes') }; },
};

/** Every capability of this file, with the command it came from. */
export const SYSTEM_PROGRAM_CAPABILITIES: readonly { readonly definition: Def; readonly command: { readonly name: string; readonly title: string } }[] = [
  ...[HEALTH_REPORT, HEALTH_CHECK, HEALTH_DIAGNOSE, HEALTH_FAILURE, HEALTH_SAVE_FAILURE, HEALTH_KEEP_FAILURE, HEALTH_STATE, HEALTH_COMPAT]
    .map((definition) => ({ definition, command: { name: 'health', title: 'Health' } })),
  ...[RELEASE_REVIEW, RELEASE_CHECKLIST, RELEASE_SAVE, RELEASE_READ].map((definition) => ({ definition, command: { name: 'release', title: 'Release readiness' } })),
  ...[STARTUP_REVIEW, STARTUP_DOCTOR, STARTUP_SERVICES, STARTUP_EXPORT, STARTUP_LINK, STARTUP_OPEN_LINK]
    .map((definition) => ({ definition, command: { name: 'startup', title: 'This program\'s start' } })),
  { definition: DEEPLINK_REVIEW, command: { name: 'deeplink', title: 'Links to views' } },
  { definition: SYSTEM_HELP, command: { name: 'help', title: 'Help' } },
  ...[VOICE_STOP, VOICE_WAKE_STATUS, VOICE_WAKE_SETUP].map((definition) => ({ definition, command: { name: 'voice', title: 'Voice' } })),
];
