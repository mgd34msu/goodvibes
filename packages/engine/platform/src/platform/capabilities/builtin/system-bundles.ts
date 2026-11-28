/**
 * System, support and transfer (home `daemon`): a program's settings and setup as a redacted support bundle (saved,
 * previewed, checked, loaded back), a support folder for a support thread, and the setup carried to another computer.
 * The daemon writes and reads them for every door: the System place's "Support and transfer" tab, a model's
 * `capability_run`, an outside agent and `goodvibes do`. Which program: the settings, secrets and project files are one
 * program's own, so each capability takes the program as an input from context (the program asking fills it; a caller
 * with none names it). Nothing secret is written: settings through the one config redaction, the secret store by key
 * names only, file entries masked (platform/support/).
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ConfigManager } from '../../config/manager.js';
import type { ConfigKey } from '../../config/schema-types.js';
import { CONFIG_SCHEMA } from '../../config/schema.js';
import { isDaemonOwnedConfigKey } from '../../config/config-ownership.js';
import { resolveGoodVibesDaemonHome } from '../../config/goodvibes-home.js';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';
import type { ProviderRegistry } from '../../providers/registry.js';
import { classifyProviderSetup } from '../../providers/provider-setup.js';
import { createShellPathService } from '../../runtime/shell-paths.js';
import { renderSandboxProfiles, renderSandboxRecommendation, renderSandboxReview } from '../../runtime/sandbox/manager.js';
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import { VERSION } from '../../version.js';
import { createSupportBundle, type SupportBundleSource } from '../../support/support-bundle.js';
import { buildCliServicePosture } from '../../support/service-manager-posture.js';
import {
  SUPPORT_FOLDER_MARK, buildSetupTransferBundle, describeHeldBackSettings, describeSetupTransferChanges, inspectSetupTransferBundle, inspectSupportFolder,
  planSetupTransferImport, setupTransferWrites, writeSetupTransferBundle, writeSupportFolder, type SetupReview, type SetupTransferBundle,
  type SetupTransferFiles,
} from '../../support/setup-transfer.js';
import { CapabilityRefusal, REPLACED_DONE, type ActionValues, type CapabilityCaller, type CapabilityDefinition, type InputDescription } from '../types.js';
import { fileWorkRefusal, readCallerJson, unreadableFile } from '../path-inputs.js';
import { heldPath } from '../held-paths.js';
import type { ProgramSettingsCapabilityServices } from './program-settings.js';
import { REMOTE_LIST, type RemoteCapabilityServices } from './remote.js';
import { PROGRAM_INPUT, lockedFileSettingsRefusal } from './system-settings.js';
import { incomingSecurityInput } from './incoming-settings.js';

/** The file that marks a support folder: a program doing the file work on its own disk checks for it (terminal-shell bundle-file-work.ts). */
export { SUPPORT_FOLDER_MARK };

type Program = 'tui' | 'agent';
const PROGRAM_WORDS: Readonly<Record<Program, string>> = { tui: 'the terminal app', agent: 'the Agent' };

/** What these capabilities need from the daemon, beside the asking program's settings and the daemon's remote runners. */
export interface SystemBundleCapabilityServices extends ProgramSettingsCapabilityServices, RemoteCapabilityServices {
  readonly supportBundles: {
    /** The daemon's providers, whose readiness a bundle names; undefined where the daemon was composed without them. */
    providerRegistry(): ProviderRegistry | undefined;
    /** The program's secret store as that program reads it: what is stored and where, never a value. */
    secrets(caller: CapabilityCaller, program: Program, config: ConfigManager): { inspect(): Promise<unknown>; listDetailed(): Promise<readonly { readonly key: string; readonly source: string; readonly overriddenByEnv?: boolean | undefined }[]> };
    /** The program's setup as the daemon reads it (models, services, skills, plugins, tool servers, hooks, sandbox), without the runners. */
    review(caller: CapabilityCaller, program: Program, config: ConfigManager): Promise<Omit<SetupReview, 'remoteRunnerCount' | 'remoteRunners' | 'remoteRunnersUnreadable' | 'checks' | 'issues'> & { readonly checks: SetupReview['checks'] }>;
    /** The presets kept for the program (their count goes into the platform facts). */
    presetCount(caller: CapabilityCaller, program: Program): number;
    /** The home folder `~/.goodvibes` is under. */
    home(): string;
    /** The caller's project folder, else the daemon's. */
    project(caller: CapabilityCaller): string;
    /** The hooks file the program's turns in the caller's project read; null when the caller named no project. */
    hooksFile(caller: CapabilityCaller, config: ConfigManager): string | null;
  };
}

type Def = CapabilityDefinition<SystemBundleCapabilityServices>;

function programOf(values: ActionValues, caller: CapabilityCaller): Program {
  const named = values.program;
  if (named === 'tui' || named === 'agent') return named;
  if (named) throw new CapabilityRefusal(`${named} is not a program: the terminal app (tui) or the Agent (agent).`);
  if (caller.program) return caller.program;
  throw new CapabilityRefusal('Whose setup: name the program, the terminal app (tui) or the Agent (agent); nothing was read or written.', undefined, 'USAGE');
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');

// ---------------------------------------------------------------------------
// Where the file is. A program whose daemon runs on another machine keeps its files on its own disk: it sends a file's
// content to be read (`content`) and writes what comes back (`data.file`, `data.files`), with `filesAt: program`
// (terminal-shell bundle-file-work.ts). The daemon then builds and reads in a scratch folder of its own and keeps
// nothing. Both inputs are filled by the program asking and never asked of a person.
// ---------------------------------------------------------------------------

export const FILES_AT: InputDescription = {
  id: 'filesAt', label: 'Where the file is', help: 'On the daemon\'s machine, or on the machine of the program asking (which sends and writes the file itself)',
  kind: 'choice', choices: [{ value: 'daemon', label: 'On the daemon\'s machine' }, { value: 'program', label: 'On the machine of the program asking' }],
  required: { default: 'daemon', defaultMeans: 'on the daemon\'s machine' }, typed: { flag: '--files-at' }, showWhen: { suppliedBy: 'the program asking' },
};
export const CONTENT_INPUT: InputDescription = {
  id: 'content', label: 'What the file holds', help: 'The file\'s text (a folder\'s: its files as JSON, name to text), sent by the program asking when the file is on its machine',
  kind: 'long-text', freeTextReason: 'filled by the program asking', required: { default: '', defaultMeans: 'read from the path' },
  typed: { flag: '--content' }, showWhen: { suppliedBy: 'the program asking' },
};

const filesAtProgram = (values: ActionValues): boolean => values.filesAt === 'program';

/** Work on a scratch folder of the daemon's own, removed afterwards whatever happens. */
async function inScratch<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'goodvibes-files-'));
  try { return await work(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The name a file is shown by when the program asking holds it: as it typed it. */
const shownName = (values: ActionValues, key: string, fallback: string): string => values[key] || fallback;

/** A file the program asking sent, as a path the daemon reads (in `dir`). */
function sentFile(dir: string, values: ActionValues, key: string): string {
  const path = join(dir, basename(values[key] || 'file.json'));
  writeFileSync(path, values.content ?? '');
  return path;
}

/** The files of a folder the program asking sent (`content`: JSON, name to text), written into `dir`. */
function sentFolder(dir: string, values: ActionValues): string {
  let files: unknown;
  try { files = JSON.parse(values.content || '{}'); } catch { throw new CapabilityRefusal('The folder\'s files were not JSON (name to text); nothing was read.', undefined, 'USAGE'); }
  for (const [name, text] of Object.entries(files !== null && typeof files === 'object' ? files as Record<string, unknown> : {})) {
    if (typeof text === 'string' && name === basename(name)) writeFileSync(join(dir, name), text);
  }
  return dir;
}

/** Every file of a folder the daemon wrote, to hand to the program asking. */
function folderFiles(dir: string): readonly { readonly name: string; readonly content: string }[] {
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => ({ name: entry.name, content: readFileSync(join(dir, entry.name), 'utf-8') }));
}

// ---------------------------------------------------------------------------
// The support bundle (one file): bundle.preview, bundle.export, bundle.inspect, bundle.import
// ---------------------------------------------------------------------------

const BUNDLE_POLICY = {
  tui: { site: 'terminal-shell.support-bundle.export', providerSite: 'tui.support-bundle.setup', packageName: 'goodvibes', bundleType: 'goodvibes.support',
    title: 'GoodVibes support bundle', defaultFilename: 'goodvibes-bundle.json', detachConfig: false, issuesKey: 'serviceIssues' },
  agent: { site: 'agent.cli.bundle-export', providerSite: 'agent.support-bundle.setup', packageName: 'goodvibes-agent', bundleType: 'goodvibes-agent.support',
    title: 'GoodVibes Agent support bundle', defaultFilename: 'goodvibes-agent-bundle.json', detachConfig: true, issuesKey: 'hostIntegrationIssues' },
} as const;

interface BundleRun {
  readonly program: Program;
  readonly runtime: SupportBundleSource & { readonly configManager: ConfigManager };
  readonly builder: ReturnType<typeof createSupportBundle<SupportBundleSource & { readonly configManager: ConfigManager }, ProviderRegistry, Awaited<ReturnType<typeof buildCliServicePosture>>>>;
}

/** The one builder (platform/support/support-bundle.ts) bound to the daemon's providers and the program's settings. */
function bundleFor(values: ActionValues, services: SystemBundleCapabilityServices, caller: CapabilityCaller): BundleRun {
  const program = programOf(values, caller);
  const config = services.programSettings.config({ ...caller, program });
  const home = services.supportBundles.home();
  const runtime = { workingDirectory: services.supportBundles.project(caller), homeDirectory: home, configManager: config };
  const policy = BUNDLE_POLICY[program];
  const builder = createSupportBundle<typeof runtime, ProviderRegistry, Awaited<ReturnType<typeof buildCliServicePosture>>>({
    schema: CONFIG_SCHEMA,
    createSecrets: () => services.supportBundles.secrets(caller, program, config),
    withServices: (_runtime, body) => {
      const registry = services.supportBundles.providerRegistry();
      if (!registry) throw new CapabilityRefusal('This daemon was started without its providers, so no bundle was written.', undefined, 'UNAVAILABLE');
      return body(registry);
    },
    providerRegistry: (registry) => registry,
    classifyProvider: (snapshot, options) => classifyProviderSetup(snapshot, options),
    // The daemon service as this machine's service manager reports it: the one reading `goodvibes service status` makes.
    servicePosture: (bound, options) => buildCliServicePosture(bound, options),
    authPosture: (bound) => {
      const paths = createShellPathService({ workingDirectory: bound.workingDirectory, homeDirectory: bound.homeDirectory });
      const userStorePath = paths.resolveUserPath(program, 'auth-users.json');
      const bootstrapCredentialPath = paths.resolveUserPath(program, 'auth-bootstrap.txt');
      const operatorTokenPath = join(resolveGoodVibesDaemonHome(bound.homeDirectory), 'operator-tokens.json');
      return {
        userStorePath, userStorePresent: existsSync(userStorePath),
        bootstrapCredentialPath, bootstrapCredentialPresent: existsSync(bootstrapCredentialPath),
        operatorTokenPath, operatorTokenPresent: existsSync(operatorTokenPath),
      };
    },
    packageVersion: () => VERSION,
    onboardingMarkerPath: (paths, scope) => (scope === 'project' ? paths.resolveProjectPath(program, 'onboarding-checked.json') : paths.resolveUserPath(program, 'onboarding-checked.json')),
    // The daemon's own settings go through its method, as the same caller: one update it admits whole.
    routeDaemonSettings: async (_bound, entries) => {
      if (!caller.method) throw new Error('no daemon took the request here');
      const answer = await caller.method('config.setMany', { entries: entries.map(({ key, value }) => ({ key, value })) }) as Record<string, unknown> | undefined;
      if (answer?.code === 'OWNER_APPROVAL_PENDING') throw new Error('changing them loosens a protection, so they were put to the owner; load the bundle again once the owner approves');
      return { appliedBy: 'daemon' };
    },
  }, {
    ...policy,
    time: (timestamp) => new Date(timestamp).toISOString(),
    invalidJsonSeparator: ': ',
  });
  return { program, runtime, builder };
}

const BUNDLE_FILE: InputDescription = {
  id: 'path', label: 'File', help: 'A support bundle file, such as goodvibes-bundle.json, in this project folder unless it is a full path', kind: 'path',
  freeTextReason: 'a file path on this computer', required: true, typed: { position: 1 },
};

/** What loading a bundle would change, in lines: the security settings first, then the rest, then what it holds back. */
function planLines(run: BundleRun, path: string, includeSecurity: boolean): { readonly lines: string[]; readonly changes: number } {
  const planned = run.builder.plan(run.runtime, path, includeSecurity);
  if (!planned.ok) return { lines: [planned.problem], changes: 0 };
  if (planned.invalid.length > 0) {
    return { lines: [`Loading it would be refused: ${planned.invalid.length} value(s) cannot be applied.`, ...planned.invalid.map((entry) => `  ${entry.key}: ${entry.message}`)], changes: 0 };
  }
  const words = run.builder.describe(planned);
  return {
    changes: planned.pending.length,
    lines: [
      planned.pending.length === 0 ? `Loading it would change nothing.${words.note}` : `Loading it would change ${planned.pending.length} setting(s) (current -> new).${words.note}`,
      ...(words.security.length ? ['Security settings:', ...words.security] : []),
      ...(words.ordinary.length ? ['Other settings:', ...words.ordinary] : []),
      ...(words.heldBack.length ? ['Left as they are unless security settings are loaded too:', ...words.heldBack] : []),
    ],
  };
}

export const BUNDLE_PREVIEW: Def = {
  capability: { id: 'bundle.preview', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'preview', label: 'See what a support bundle would hold', word: 'preview', inputs: [PROGRAM_INPUT],
  sentence: 'Builds a support bundle of a program\'s settings and setup in a temporary place, shows what it holds (every secret taken out), and deletes it; nothing is kept.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(values, services, caller) {
    const run = bundleFor(values, services, caller);
    const scratch = mkdtempSync(join(tmpdir(), 'goodvibes-bundle-'));
    try {
      const path = join(scratch, BUNDLE_POLICY[run.program].defaultFilename);
      const written = await run.builder.write(run.runtime, path);
      const read = run.builder.inspectFile(path);
      if (!read.ok) throw new CapabilityRefusal(read.problem);
      return {
        text: [`A support bundle of ${PROGRAM_WORDS[run.program]} would hold ${read.summary.configKeys} setting(s), ${read.summary.redactedConfigPaths.length} of them taken out as secret; nothing was kept ("Save a support bundle" keeps one).`, '',
          run.builder.summaryText(read.summary).replace(/\n {2}path: .*$/m, ''), `  service issues: ${written.issues.length}`].join('\n'),
        data: { program: run.program, configKeys: read.summary.configKeys, redactedConfigKeys: read.summary.redactedConfigPaths.length, issues: written.issues.length },
      };
    } catch (error) {
      if (error instanceof CapabilityRefusal) throw error;
      throw new CapabilityRefusal(`The support bundle could not be built: ${errorText(error)}.`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
};

export const BUNDLE_SAVE: Def = {
  capability: { id: 'bundle.export', group: 'system', home: 'daemon', repeat: 'unsafe' },
  actionId: 'save', label: 'Save a support bundle', word: 'export',
  inputs: [
    { ...BUNDLE_FILE, file: 'written', help: 'Where to write it, in this project folder unless it is a full path', required: { default: '', defaultMeans: 'goodvibes-bundle.json (the Agent\'s: goodvibes-agent-bundle.json) in this folder' } },
    { id: 'existing', label: 'If the file exists', help: 'Stop, or write over what it holds', kind: 'choice', choices: [
      { value: 'stop', label: 'Stop and say so' },
      { value: 'replace', label: 'Replace it', help: 'What it holds now cannot be recovered.', risk: 'cannot-be-undone', riskDone: REPLACED_DONE },
    ], required: { default: 'stop', defaultMeans: 'stop and say so' }, typed: { flag: '--replace', switchOn: 'replace' } },
    PROGRAM_INPUT,
    FILES_AT,
  ],
  sentence: 'A program\'s settings and setup, with every secret taken out, are written to {path}, for someone helping you.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { path: 'support.json' },
  async run(values, services, caller) {
    const run = bundleFor(values, services, caller);
    if (filesAtProgram(values)) {
      // The program asking writes the file on its own machine (and checked what is there): built here, handed back.
      const name = shownName(values, 'path', BUNDLE_POLICY[run.program].defaultFilename);
      return inScratch(async (dir) => {
        let written;
        try { written = await run.builder.write(run.runtime, join(dir, basename(name))); } catch (error) {
          throw new CapabilityRefusal(`The support bundle could not be built: ${errorText(error)}.`);
        }
        return {
          text: `Support bundle of ${PROGRAM_WORDS[run.program]} saved to ${name}: ${written.redactedConfigPaths.length} setting(s) taken out as secret, ${written.issues.length} service issue(s) named.`,
          data: { program: run.program, path: name, redactedConfigKeys: written.redactedConfigPaths.length, issues: written.issues.length,
            file: { name, content: readFileSync(written.path, 'utf-8') } },
        };
      });
    }
    const path = services.programSettings.resolvePath(caller, values.path || BUNDLE_POLICY[run.program].defaultFilename);
    if (values.existing !== 'replace' && existsSync(path)) {
      throw new CapabilityRefusal(`${path} already exists; nothing was written.`, 'Choose another file, or choose to replace it.');
    }
    let written;
    try { written = await run.builder.write(run.runtime, path); } catch (error) {
      throw new CapabilityRefusal(`The support bundle could not be written: ${errorText(error)}.`);
    }
    return {
      text: `Support bundle of ${PROGRAM_WORDS[run.program]} saved to ${written.path}: ${written.redactedConfigPaths.length} setting(s) taken out as secret, ${written.issues.length} service issue(s) named.`,
      data: { program: run.program, path: written.path, redactedConfigKeys: written.redactedConfigPaths.length, issues: written.issues.length },
    };
  },
};

export const BUNDLE_CHECK: Def = {
  capability: { id: 'bundle.inspect', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'check', label: 'Check a support bundle', word: 'inspect', inputs: [BUNDLE_FILE, PROGRAM_INPUT, FILES_AT, CONTENT_INPUT],
  sentence: 'Shows what the support bundle {path} holds and which of a program\'s settings loading it would change, without changing anything.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { path: 'support.json' },
  async run(values, services, caller) {
    if (filesAtProgram(values)) return inScratch((dir) => checkBundle(values, services, caller, sentFile(dir, values, 'path'), values.path!));
    return checkBundle(values, services, caller, services.programSettings.resolvePath(caller, values.path!));
  },
};

async function checkBundle(values: ActionValues, services: SystemBundleCapabilityServices, caller: CapabilityCaller, path: string, shown: string = path): Promise<{ text: string; data: Record<string, unknown> }> {
  const run = bundleFor(values, services, caller);
  const read = run.builder.inspectFile(path);
  // The reader's words can quote the file (a parser's message): only the person, or the program that sent it, reads them.
  if (!read.ok) throw caller.personAsked === true || filesAtProgram(values) ? new CapabilityRefusal(read.problem.split(path).join(shown)) : unreadableFile(shown, 'a support bundle', caller, undefined, 'Nothing was read from it.');
  const plan = planLines(run, path, false);
  return {
    text: [`${shown} holds ${read.summary.configKeys} setting(s); loading it would change ${plan.changes} of ${PROGRAM_WORDS[run.program]}'s. Nothing was changed.`, '',
      run.builder.summaryText(read.summary).split(path).join(shown), '', ...plan.lines].join('\n'),
    data: { program: run.program, path: shown, changes: plan.changes },
  };
}

export const BUNDLE_LOAD: Def = {
  capability: { id: 'bundle.import', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'load', label: 'Load settings from a support bundle', word: 'import',
  inputs: [
    BUNDLE_FILE,
    incomingSecurityInput('Load them too'),
    PROGRAM_INPUT,
    FILES_AT,
    CONTENT_INPUT,
  ],
  sentence: 'Each setting in {path} that differs from the program\'s replaces it, until you change it; secrets are never in a bundle, so yours stay.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { path: 'support.json' },
  async run(values, services, caller) {
    if (filesAtProgram(values)) return inScratch((dir) => loadBundle(values, services, caller, sentFile(dir, values, 'path'), values.path!));
    return loadBundle(values, services, caller, services.programSettings.resolvePath(caller, values.path!));
  },
};

async function loadBundle(values: ActionValues, services: SystemBundleCapabilityServices, caller: CapabilityCaller, path: string, shown: string = path): Promise<{ text: string; data: Record<string, unknown> }> {
  const run = bundleFor(values, services, caller);
  const includeSecurity = values.security === 'yes';
  const loaded = await run.builder.load(run.runtime, path, includeSecurity);
  if (!loaded.ok) {
    // The reader's words can quote the file (a parser's message): only the person, or the program that sent it, reads them.
    throw caller.personAsked === true || filesAtProgram(values) ? new CapabilityRefusal([loaded.problem, ...(loaded.lines ?? [])].join('\n').split(path).join(shown))
      : unreadableFile(shown, 'a support bundle', caller, undefined, 'Nothing was loaded.');
  }
  const words = run.builder.describe(loaded.plan);
  const applied = loaded.applied.length;
  return {
    text: [
      applied === 0 ? `Nothing was loaded: no setting in ${shown} differs from ${PROGRAM_WORDS[run.program]}'s.` : `Loaded ${applied} setting(s) into ${PROGRAM_WORDS[run.program]}${loaded.daemonApplied ? ` (${loaded.daemonApplied} of them the daemon's own)` : ''}:`,
      ...loaded.applied.map((entry) => `  ${entry.key}`),
      ...(loaded.plan.heldBack.length ? ['Left as they are (security settings; load them too to change them):', ...words.heldBack] : []),
      ...(loaded.plan.skippedRedacted ? [`Left as they are: ${loaded.plan.skippedRedacted} value(s) the bundle holds as secret.`] : []),
      ...(loaded.plan.unchanged ? [`Already the same: ${loaded.plan.unchanged}.`] : []),
    ].join('\n'),
    data: { program: run.program, applied: loaded.applied.map((entry) => entry.key), heldBack: loaded.plan.heldBack.map((entry) => entry.key), skippedRedacted: loaded.plan.skippedRedacted, unchanged: loaded.plan.unchanged },
  };
}

// ---------------------------------------------------------------------------
// The support folder and the setup moved to another computer: startup.*
// ---------------------------------------------------------------------------

const PLACE_INPUT = (id: string, label: string, help: string): InputDescription => ({
  id, label, help, kind: 'path', freeTextReason: 'a file or folder on this computer, typed as a path', required: true, typed: { position: 1 },
});
const OVERWRITE: InputDescription = {
  id: 'overwrite', label: 'If it is already there', help: 'What happens when something is already at that place', kind: 'choice',
  choices: [{ value: 'keep', label: 'Leave it and stop' }, { value: 'replace', label: 'Replace it', risk: 'cannot-be-undone', riskDone: REPLACED_DONE }],
  required: { default: 'keep', defaultMeans: 'leave it and stop' }, typed: { flag: '--overwrite', switchOn: 'replace' },
};

/** The program's setup as the daemon reads it, with the daemon's remote runners and every check. */
async function reviewOf(services: SystemBundleCapabilityServices, caller: CapabilityCaller, program: Program, config: ConfigManager): Promise<{ readonly review: SetupReview; readonly remote: Record<string, unknown> }> {
  const base = await services.supportBundles.review(caller, program, config);
  let remote: Record<string, unknown>;
  try {
    remote = ((await REMOTE_LIST.run({}, services, caller)).data ?? {}) as Record<string, unknown>;
  } catch (error) {
    remote = { unreadable: errorText(error) };
  }
  const contracts = Array.isArray(remote['contracts']) ? remote['contracts'] as Record<string, unknown>[] : [];
  const unreadable = typeof remote['unreadable'] === 'string' ? remote['unreadable'] : undefined;
  const runners = contracts.map((contract) => ({ runnerId: contract['runnerId'], label: contract['label'] ?? contract['runnerId'], trustClass: contract['trustClass'] }));
  const checks = [
    ...base.checks,
    unreadable
      ? { severity: 'warn' as const, area: 'remote', message: `the remote runners could not be read: ${unreadable}` }
      : { severity: runners.length > 0 ? 'pass' as const : 'info' as const, area: 'remote', message: runners.length > 0 ? `${runners.length} remote runner contract(s) in the daemon` : 'no remote runners: none has been started' },
  ];
  const review: SetupReview = {
    ...base, remoteRunnerCount: runners.length, remoteRunners: runners, ...(unreadable ? { remoteRunnersUnreadable: unreadable } : {}),
    checks, issues: checks.filter((check) => check.severity === 'warn' || check.severity === 'fail'),
  };
  const artifacts = Array.isArray(remote['artifacts']) ? remote['artifacts'] as Record<string, unknown>[] : [];
  return {
    review,
    remote: {
      ...(unreadable ? { unreadable } : {}),
      runners: contracts,
      artifacts: artifacts.map((artifact) => ({ id: artifact['id'], runnerId: artifact['runnerId'], status: artifact['status'], createdAt: artifact['createdAt'] })),
    },
  };
}

function transferFiles(services: SystemBundleCapabilityServices, caller: CapabilityCaller, program: Program): SetupTransferFiles {
  const paths = createShellPathService({ workingDirectory: services.supportBundles.project(caller), homeDirectory: services.supportBundles.home() });
  return {
    services: paths.resolveUserPath(program, 'services.json'),
    plugins: paths.resolveProjectPath(program, 'ecosystem', 'plugins.json'),
    skills: paths.resolveProjectPath(program, 'ecosystem', 'skills.json'),
  };
}

/**
 * What only the program asking knows, filled by it and never asked of a person (the System place's Support folder
 * row, the terminal app's typed line): the interfaces its integration helpers serve, and the links to its views.
 */
const HELPERS_INPUT: InputDescription = {
  id: 'helpers', label: 'Integration helpers', help: 'The interface families and routes the program\'s integration helpers serve, as JSON',
  kind: 'long-text', freeTextReason: 'filled by the program asking', required: { default: '', defaultMeans: 'not recorded: the caller named none' },
  typed: { flag: '--helpers' }, showWhen: { suppliedBy: 'the program asking' },
};
const LINKS_INPUT: InputDescription = {
  id: 'links', label: 'Links to views', help: 'The goodvibes://open link of each of the program\'s views, one per line',
  kind: 'list', freeTextReason: 'filled by the program asking', required: { default: '', defaultMeans: 'not recorded: the caller named none' },
  typed: { flag: '--links' }, showWhen: { suppliedBy: 'the program asking' },
};

/** The integration helpers' interfaces as the program gave them, else why they are not in the folder. */
function helpersOf(value: string | undefined): Record<string, unknown> | string {
  if (!value) return 'not recorded: the program asking did not name them';
  try {
    const parsed = JSON.parse(value) as { apiFamilies?: unknown; routes?: unknown };
    const list = (entry: unknown): string[] => (Array.isArray(entry) ? entry.filter((item): item is string => typeof item === 'string') : []);
    return { apiFamilies: list(parsed.apiFamilies), routes: list(parsed.routes) };
  } catch {
    throw new CapabilityRefusal('The integration helpers were not JSON with apiFamilies and routes; nothing was written.', undefined, 'USAGE');
  }
}

export const STARTUP_SUPPORT_BUNDLE: Def = {
  capability: { id: 'startup.support-bundle', group: 'system', home: 'daemon', repeat: 'unsafe' },
  actionId: 'support-bundle', label: 'Save a support folder about this setup', word: 'support-bundle',
  inputs: [{ ...PLACE_INPUT('dir', 'Folder', 'The folder the support files are written to'), file: 'written', workFolder: false }, OVERWRITE, PROGRAM_INPUT, HELPERS_INPUT, LINKS_INPUT, FILES_AT],
  sentence: 'The setup review, the platform facts, the services and hooks files and the remote runners are written to the folder {dir} for a support thread; credentials in them are masked.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { dir: 'support' },
  async run(values, services, caller) {
    // The program asking writes the folder on its own machine (and checked what is there): written here, handed back.
    if (filesAtProgram(values)) {
      return inScratch(async (dir) => {
        const made = await writeSupportFolderFor(values, services, caller, dir, values.dir!);
        return { ...made, data: { ...made.data, files: folderFiles(dir) } };
      });
    }
    return writeSupportFolderFor(values, services, caller, services.programSettings.resolvePath(caller, values.dir!));
  },
};

async function writeSupportFolderFor(values: ActionValues, services: SystemBundleCapabilityServices, caller: CapabilityCaller, targetDir: string, shown: string = targetDir): Promise<{ text: string; data: Record<string, unknown> }> {
  {
    const program = programOf(values, caller);
    const config = services.programSettings.config({ ...caller, program });
    if (shown === targetDir && existsSync(heldPath(join(targetDir, SUPPORT_FOLDER_MARK))) && values.overwrite !== 'replace') {
      throw new CapabilityRefusal(`${targetDir} already holds a support folder; nothing was written.`, 'Choose another folder, or choose to replace it.');
    }
    const { review, remote } = await reviewOf(services, caller, program, config);
    const records = await services.supportBundles.secrets(caller, program, config).listDetailed();
    const stored = records.filter((record) => record.source !== 'env');
    const platformReview = {
      install: { appVersion: VERSION, program, workingDirectory: services.supportBundles.project(caller), homeDirectory: services.supportBundles.home(), profileCount: services.supportBundles.presetCount(caller, program) },
      storage: {
        storedKeys: [...new Set(stored.map((record) => record.key))],
        overriddenByEnv: [...new Set(stored.filter((record) => record.overriddenByEnv).map((record) => record.key))],
      },
      integrationHelpers: helpersOf(values.helpers),
      sandbox: { review: renderSandboxReview(config), recommendation: renderSandboxRecommendation(config), profiles: renderSandboxProfiles(config) },
      deepLinks: values.links ? values.links.split('\n').map((link) => link.trim()).filter(Boolean) : 'none named: the program asking named no views with links (the Agent has none)',
    };
    const paths = createShellPathService({ workingDirectory: services.supportBundles.project(caller), homeDirectory: services.supportBundles.home() });
    const hooksFile = services.supportBundles.hooksFile(caller, config);
    const { masked } = writeSupportFolder(targetDir, {
      review, platformReview, remoteSummary: remote,
      copies: [[paths.resolveUserPath(program, 'services.json'), 'services.json'], ...(hooksFile !== null ? [[hooksFile, 'hooks.json'] as [string, string]] : [])],
    // Each file beneath a folder the caller named, through its held handle (capabilities/held-paths.ts).
    }, heldPath);
    return {
      text: `Support folder for ${PROGRAM_WORDS[program]} written to ${shown}${masked > 0 ? ` (${masked} credential value(s) masked)` : ''}.`,
      data: { program, dir: shown, masked, issues: review.issues.length },
    };
  }
}

export const STARTUP_SUPPORT_BUNDLE_INSPECT: Def = {
  capability: { id: 'startup.support-bundle-inspect', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'support-bundle-inspect', label: 'Read a support folder', word: 'support-bundle-inspect',
  inputs: [{ ...PLACE_INPUT('dir', 'Folder', 'The folder that holds the support files'), workFolder: false }, FILES_AT, CONTENT_INPUT],
  sentence: 'Shows what the support folder {dir} says about its setup.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { dir: 'support' },
  async run(values, services, caller) {
    if (filesAtProgram(values)) {
      return inScratch(async (dir) => {
        try {
          return { text: `The support folder ${values.dir} was read; nothing was changed.\n\n${inspectSupportFolder(sentFolder(dir, values)).split(dir).join(values.dir ?? '')}`, data: { dir: values.dir } };
        } catch (error) {
          if (error instanceof CapabilityRefusal) throw error;
          throw new CapabilityRefusal(`Could not read the support folder in ${values.dir}: ${errorText(error).split(dir).join(values.dir ?? '')}.`, 'Save one first: "Save a support folder about this setup".');
        }
      });
    }
    const targetDir = services.programSettings.resolvePath(caller, values.dir!);
    try {
      return { text: `The support folder ${targetDir} was read; nothing was changed.\n\n${inspectSupportFolder(targetDir, heldPath)}`, data: { dir: targetDir } };
    } catch (error) {
      // Never the system's or the parser's words to anyone but the person (path-inputs.ts).
      throw fileWorkRefusal(targetDir, 'a support folder', caller, error, 'Nothing was read from it.');
    }
  },
};

export const STARTUP_TRANSFER_EXPORT: Def = {
  capability: { id: 'startup.transfer-export', group: 'system', home: 'daemon', repeat: 'unsafe' },
  actionId: 'transfer-export', label: 'Save this setup to move it to another computer', word: 'transfer-export',
  inputs: [{ ...PLACE_INPUT('path', 'File', 'The file the setup is written to'), file: 'written' }, OVERWRITE, PROGRAM_INPUT, FILES_AT],
  sentence: 'Settings, services, plugins and skills are written to {path} for another computer; literal credentials are left out.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { path: 'setup-transfer.json' },
  async run(values, services, caller) {
    const program = programOf(values, caller);
    const config = services.programSettings.config({ ...caller, program });
    // The program asking writes the file on its own machine (and checked what is there): built here, handed back.
    const here = filesAtProgram(values);
    const target = here ? values.path! : services.programSettings.resolvePath(caller, values.path!);
    if (!here && existsSync(target) && values.overwrite !== 'replace') {
      throw new CapabilityRefusal(`${target} already exists; nothing was written.`, 'Choose another file, or choose to replace it.');
    }
    const { review } = await reviewOf(services, caller, program, config);
    const bundle = buildSetupTransferBundle(config, transferFiles(services, caller, program), review);
    const file = here
      ? await inScratch(async (dir) => { const scratch = join(dir, basename(target)); writeSetupTransferBundle(scratch, bundle); return { name: target, content: readFileSync(scratch, 'utf-8') }; })
      : (writeSetupTransferBundle(target, bundle), undefined);
    const redacted = bundle.redacted ?? [];
    return {
      text: [
        `The setup of ${PROGRAM_WORDS[program]} is saved to ${target}: ${Object.keys(bundle.config).length} setting(s), ${bundle.services ? 'the services file' : 'no services file'}, ${bundle.ecosystem?.plugins ? 'the plugin catalog' : 'no plugin catalog'}, ${bundle.ecosystem?.skills ? 'the skill catalog' : 'no skill catalog'}.`,
        ...(redacted.length > 0 ? [`${redacted.length} literal credential(s) were left out or masked (${redacted.slice(0, 8).join(', ')}${redacted.length > 8 ? ', ...' : ''}); secret-store references travel, so point a credential at a password manager (Permissions and safety, Secrets) to carry it.`] : []),
      ].join('\n'),
      data: { program, path: target, settings: Object.keys(bundle.config).length, redacted: redacted.length, ...(file ? { file } : {}) },
    };
  },
};

/** The setup file a call names: read here, or (the program asking holds it) the content it sent. */
function transferOf(values: ActionValues, services: SystemBundleCapabilityServices, caller: CapabilityCaller): { readonly path: string; readonly parsed: unknown } {
  if (!filesAtProgram(values)) {
    const path = services.programSettings.resolvePath(caller, values.path!);
    // Never the system's or the parser's words (capabilities/path-inputs.ts).
    return { path, parsed: readCallerJson(path, 'a setup file', caller, 'Nothing was read.') };
  }
  const path = values.path!;
  try { return { path, parsed: JSON.parse(values.content ?? '') }; } catch (error) { throw new CapabilityRefusal(`${path} is not a setup file: ${errorText(error)}.`); }
}

export const STARTUP_TRANSFER_INSPECT: Def = {
  capability: { id: 'startup.transfer-inspect', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'transfer-inspect', label: 'Read a moved setup, and what bringing it in would change', word: 'transfer-inspect',
  inputs: [PLACE_INPUT('path', 'File', 'The setup file to read'), PROGRAM_INPUT, FILES_AT, CONTENT_INPUT],
  sentence: 'Shows what the setup file {path} holds and what bringing it in would change and replace, without changing anything.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { path: 'setup-transfer.json' },
  async run(values, services, caller) {
    const program = programOf(values, caller);
    const config = services.programSettings.config({ ...caller, program });
    const { path, parsed } = transferOf(values, services, caller);
    const plan = planSetupTransferImport(config, parsed);
    if (!plan.ok) return { text: `${path}: ${plan.reason}`, data: { path, importable: false } };
    const writes = setupTransferWrites(plan.bundle, transferFiles(services, caller, program));
    return {
      text: [
        `Bringing in ${path} would change ${plan.changes.length} setting(s) of ${PROGRAM_WORDS[program]} and replace ${writes.length} file(s)${plan.heldBack.length > 0 ? `; ${plan.heldBack.length} security setting(s) stay as they are unless you bring those in too` : ''}. Nothing was changed.`, '',
        inspectSetupTransferBundle(parsed as SetupTransferBundle), `  path: ${path}`, '',
        `Bringing it into ${PROGRAM_WORDS[program]}:`,
        ...describeSetupTransferChanges(plan.changes),
        ...(plan.heldBack.length > 0 ? ['Security settings, held back unless you bring them in too:', ...describeHeldBackSettings(plan.heldBack)] : []),
        `Files replaced: ${writes.length > 0 ? writes.map((write) => write.name).join(', ') : 'none'}.`,
        ...(plan.skippedParts.length > 0 ? [`Kept as they are here (the file masked credentials in them): ${plan.skippedParts.join(', ')}.`] : []),
        ...(plan.ignoredKeys.length > 0 ? [`Unknown settings skipped: ${plan.ignoredKeys.join(', ')}.`] : []),
      ].join('\n'),
      data: { program, path, importable: true, changes: plan.changes.length, heldBack: plan.heldBack.map((change) => change.key), replaces: writes.map((write) => write.name) },
    };
  },
};

export const STARTUP_TRANSFER_IMPORT: Def = {
  capability: { id: 'startup.transfer-import', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'transfer-import', label: 'Bring in a setup moved from another computer', word: 'transfer-import',
  inputs: [
    PLACE_INPUT('path', 'File', 'The setup file to bring in'),
    incomingSecurityInput(),
    PROGRAM_INPUT,
    FILES_AT,
    CONTENT_INPUT,
  ],
  sentence: 'The settings and files in {path} replace the ones here, security settings only if you choose to bring them in too; the files they replace are not kept. Reading the file first shows what changes.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', riskDone: 'The files it replaced are not kept.', example: { path: 'setup-transfer.json' },
  question: 'Bring in the setup in {path}?',
  // Read once before anything is asked: a setting in it locked as managed refuses it now, and what runs is the content read.
  readsFileBefore(values, services, caller) {
    const { path, parsed } = transferOf(values, services, caller);
    const config = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { config?: unknown }).config : undefined;
    const entries = config !== null && typeof config === 'object' && !Array.isArray(config) ? Object.entries(config).map(([key, value]) => ({ key, value })) : [];
    return lockedFileSettingsRefusal(path, entries) ?? (filesAtProgram(values) ? undefined : { ...values, filesAt: 'program', path, content: JSON.stringify(parsed) });
  },
  async run(values, services, caller) {
    const program = programOf(values, caller);
    const config = services.programSettings.config({ ...caller, program });
    const { path, parsed } = transferOf(values, services, caller);
    const plan = planSetupTransferImport(config, parsed, values.security === 'yes');
    if (!plan.ok) throw new CapabilityRefusal(`Nothing was brought in: ${plan.reason}`);
    const writes = setupTransferWrites(plan.bundle, transferFiles(services, caller, program));
    // The daemon's own settings first, as one update it admits whole; then the program's, as one; then the files.
    const daemonOwned = plan.changes.filter((change) => isDaemonOwnedConfigKey(change.key));
    const own = plan.changes.filter((change) => !isDaemonOwnedConfigKey(change.key));
    const putDaemonBack = async (): Promise<boolean> => {
      if (daemonOwned.length === 0 || !caller.method) return true;
      try {
        const answer = await caller.method('config.setMany', { entries: daemonOwned.map((change) => ({ key: change.key, value: change.previous })) }) as Record<string, unknown> | undefined;
        return answer?.code !== 'OWNER_APPROVAL_PENDING';
      } catch { return false; }
    };
    if (daemonOwned.length > 0) {
      if (!caller.method) throw new CapabilityRefusal('This runs in the daemon, and no daemon took the request here; nothing was brought in.', undefined, 'UNAVAILABLE');
      try {
        const answer = await caller.method('config.setMany', { entries: daemonOwned.map((change) => ({ key: change.key, value: change.next })) }) as Record<string, unknown> | undefined;
        if (answer?.code === 'OWNER_APPROVAL_PENDING') throw new Error('they loosen a protection and were put to the owner; bring the setup in again once the owner approves');
      } catch (error) {
        throw new CapabilityRefusal(`Nothing was brought in: the daemon did not take its ${daemonOwned.length} setting(s) (${errorText(error)}).`);
      }
    }
    if (own.length > 0) {
      const result = config.setMany(own.map((change) => ({ key: change.key as ConfigKey, value: change.next })), localOwnerActor());
      if (!result.ok) {
        const back = await putDaemonBack();
        throw new CapabilityRefusal(`Nothing was brought in: ${result.refusal.reason}${daemonOwned.length > 0 ? (back ? ' The daemon\'s settings were put back.' : ' The daemon\'s settings could not be put back and hold the new values.') : ''}`, result.refusal.next[0]);
      }
    }
    const replaced: { readonly path: string; readonly previous: string | null }[] = [];
    try {
      for (const write of writes) {
        const previous = existsSync(write.path) ? readFileSync(write.path, 'utf-8') : null;
        atomicWriteFileSync(write.path, JSON.stringify(write.body, null, 2) + '\n', { mkdirp: true });
        replaced.push({ path: write.path, previous });
      }
    } catch (error) {
      // Put every replaced file and every setting back, so a failure leaves nothing half brought in.
      const notRestored: string[] = [];
      for (const entry of [...replaced].reverse()) {
        try {
          if (entry.previous === null) rmSync(entry.path, { force: true });
          else atomicWriteFileSync(entry.path, entry.previous, { mkdirp: true });
        } catch { notRestored.push(entry.path); }
      }
      const ownBack = own.length === 0 || config.setMany(own.map((change) => ({ key: change.key as ConfigKey, value: change.previous })), localOwnerActor()).ok;
      const back = await putDaemonBack();
      const settingsSummary = ownBack && back ? 'The settings were put back'
        : ownBack && !back ? 'The program\'s settings were put back, except the daemon\'s'
          : !ownBack && back ? 'The daemon\'s settings were put back, except this program\'s'
            : 'Neither the program\'s nor the daemon\'s settings could be put back';
      throw new CapabilityRefusal(`Nothing was brought in: a file could not be written (${errorText(error)}). ${settingsSummary}${notRestored.length > 0 ? `; these files still hold the new contents: ${notRestored.join(', ')}` : ' and every file already replaced was put back'}.`);
    }
    return {
      text: [
        `Brought in the setup from ${path} for ${PROGRAM_WORDS[program]}: ${plan.changes.length} setting(s) changed${daemonOwned.length > 0 ? ` (${daemonOwned.length} of them the daemon's own)` : ''}, ${writes.length} file(s) replaced${writes.length > 0 ? ` (${writes.map((write) => write.name).join(', ')})` : ''}.`,
        ...(plan.changes.length > 0 ? describeSetupTransferChanges(plan.changes).slice(1) : []),
        ...(plan.heldBack.length > 0 ? [`Held back: ${plan.heldBack.length} security setting(s), left as they are (bring the setup in again with security settings to change them):`, ...describeHeldBackSettings(plan.heldBack)] : []),
        ...(plan.skippedParts.length > 0 ? [`Left as they are here: ${plan.skippedParts.join(' and ')} (the file masked credentials in them; point those credentials at a password manager on the other computer and save the setup again).`] : []),
        ...(plan.ignoredKeys.length > 0 ? [`Left out: ${plan.ignoredKeys.length} setting(s) this version does not know (${plan.ignoredKeys.join(', ')}).`] : []),
      ].join('\n'),
      data: { program, path, changed: plan.changes.map((change) => change.key), heldBack: plan.heldBack.map((change) => change.key), replaced: writes.map((write) => write.name), left: [...plan.skippedParts, ...plan.ignoredKeys] },
      ...(writes.length === 0 ? { riskDone: '' } : {}),
    };
  },
};

/** Every capability of this file, with the command it came from. */
export const SYSTEM_BUNDLE_CAPABILITIES: readonly { readonly definition: Def; readonly command: { readonly name: string; readonly title: string } }[] = [
  ...[BUNDLE_PREVIEW, BUNDLE_SAVE, BUNDLE_CHECK, BUNDLE_LOAD].map((definition) => ({ definition, command: { name: 'bundle', title: 'Support bundle' } })),
  ...[STARTUP_SUPPORT_BUNDLE, STARTUP_SUPPORT_BUNDLE_INSPECT, STARTUP_TRANSFER_EXPORT, STARTUP_TRANSFER_INSPECT, STARTUP_TRANSFER_IMPORT]
    .map((definition) => ({ definition, command: { name: 'startup', title: 'Check, export or move your setup' } })),
];
