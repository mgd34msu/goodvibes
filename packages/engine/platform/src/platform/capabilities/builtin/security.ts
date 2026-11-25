/**
 * Security: the paired devices' tokens, the sandbox presets and this
 * folder's trust (the daemon), and the sandbox sessions a terminal program
 * started (the program holding the conversation).
 *
 * Folder trust is one shared register (`~/.goodvibes/shared/workspace-registrations.json`)
 * that every program's gate reads; the daemon writes the asking program's
 * folder there, and that program takes the change in at its next check (the
 * slash action and the place make it read it at once).
 */
import { existsSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { ApiTokenAuditor } from '../../security/token-audit.js';
import type { WorkspaceTrustManager } from '../../runtime/workspace-trust.js';
import { inspectSandboxSessionArtifact, listSandboxPresets, listSandboxProfiles, renderSandboxSessions, type ConfigManagerLike } from '../../runtime/sandbox/manager.js';
import type { SandboxSessionRegistry } from '../../runtime/sandbox/session-registry.js';
import { summarizeError } from '../../utils/native-error-summary.js';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type InputDescription, type ListName } from '../types.js';

type FolderTrust = Pick<WorkspaceTrustManager, 'load' | 'getLevel' | 'isDecided' | 'isTrusted' | 'hasIgnoredLegacyDecision' | 'setLevel' | 'getLoadFault' | 'workspaceRoot'>;

/** What the daemon's security capabilities need. */
export interface SecurityCapabilityServices {
  readonly security: {
    /** The daemon's audit of the paired devices' tokens. */
    readonly tokens: Pick<ApiTokenAuditor, 'auditAll'>;
    /** The trust of one folder, in the shared register every program reads. */
    folder(directory: string): FolderTrust;
    /** Told after a change, so every screen showing it reads it again. */
    changed(): void;
  };
}

/** What the sandbox sessions need from the program that started them. */
export interface SandboxSessionServices {
  readonly sandboxSessions?: {
    readonly registry: SandboxSessionRegistry;
    /** The settings a session's boundary reads. */
    readonly config: ConfigManagerLike;
    /** A path as the program reads it (against its working folder). */
    resolvePath(path: string): string;
    /** True when a model asked: it may write a record only inside the working folder. */
    readonly insideOnly: boolean;
  } | undefined;
}

/** The sandbox sessions a program started (its own list; not the daemon's). */
export const SANDBOX_SESSIONS_LIST = 'security.sandbox-sessions' as ListName;

// ---------------------------------------------------------------------------
// The daemon's
// ---------------------------------------------------------------------------

export const SECURITY_TOKENS: CapabilityDefinition<SecurityCapabilityServices> = {
  capability: { id: 'security.tokens', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'tokens', label: 'See paired-device tokens', word: 'tokens', inputs: [],
  sentence: 'Lists each paired device\'s token with its policy, whether it stays in scope, when it is due for rotation and whether it is blocked.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const audit = services.security.tokens.auditAll(Date.now());
    const tokens = audit.results.map((result) => ({
      id: result.tokenId, label: result.label, policy: result.scope.policyId, scope: result.scope.outcome,
      rotation: result.rotation.outcome, blocked: result.blocked,
    }));
    if (tokens.length === 0) return { text: 'No paired-device tokens: no device is paired with this machine.', data: { tokens } };
    return {
      text: [
        `Paired-device tokens (${tokens.length})`,
        ...tokens.map((token) => `  ${token.label}  policy ${token.policy}  scope ${token.scope}  rotation ${token.rotation}  blocked ${token.blocked ? 'yes' : 'no'}`),
      ].join('\n'),
      data: { tokens },
    };
  },
};

export const SECURITY_SANDBOX_PRESETS: CapabilityDefinition<SecurityCapabilityServices> = {
  capability: { id: 'security.sandbox-presets', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'sandbox-presets', label: 'See the sandbox presets', word: 'sandbox-presets', inputs: [],
  sentence: 'Lists the presets for MCP servers, what each sets and its notes.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run() {
    const presets = listSandboxPresets();
    return {
      text: ['Sandbox presets', ...presets.flatMap((preset) => [
        `  ${preset.label} (${preset.id}): ${preset.summary}`,
        `    MCP servers: ${preset.config.mcpIsolation === 'contained' ? 'inside the sandbox ("Run MCP servers inside the sandbox")' : 'as host processes ("Run MCP servers as host processes")'}`,
        ...preset.notes.map((note) => `    ${note}`),
      ])].join('\n'),
      data: { presets: presets.map((preset) => ({ id: preset.id, label: preset.label, summary: preset.summary, mcpIsolation: preset.config.mcpIsolation, notes: [...preset.notes] })) },
    };
  },
};

/** The folder of the program that asked. */
function folderOf(caller: CapabilityCaller): string {
  if (!caller.workingDirectory) throw new CapabilityRefusal('No folder was given: folder trust is about the folder a program works in.');
  return caller.workingDirectory;
}

/** What a level means in the program that asked: the Agent's own actions pass no folder trust gate. */
function levelMeaning(trusted: boolean, program: CapabilityCaller['program']): string {
  if (program === 'agent') {
    return trusted
      ? 'Its hooks file loads and the MCP servers its files name start.'
      : 'Its hooks file is not loaded and the MCP servers its files name do not start; your own hooks and MCP files are not affected.';
  }
  return trusted
    ? 'Every tool may run here, subject to your permission settings; its hooks file loads and the MCP servers its files name start.'
    : 'Reading only: tools that write, run commands or hand work to agents are refused here, and its hooks file and the MCP servers its files name stay off.';
}

/** A folder's trust, as the place and a script read it. */
export interface FolderTrustFacts {
  readonly folder: string;
  readonly state: 'trusted' | 'restricted' | 'undecided' | 'unreadable';
  readonly meaning: string;
  readonly fault?: string | undefined;
}

async function folderFacts(trust: FolderTrust, program: CapabilityCaller['program']): Promise<FolderTrustFacts> {
  await trust.load();
  const fault = trust.getLoadFault();
  const state: FolderTrustFacts['state'] = fault !== null && !trust.isDecided() ? 'unreadable' : !trust.isDecided() ? 'undecided' : trust.isTrusted() ? 'trusted' : 'restricted';
  return { folder: trust.workspaceRoot, state, meaning: levelMeaning(state === 'trusted', program), ...(fault !== null ? { fault } : {}) };
}

const STATE_WORDS: Readonly<Record<FolderTrustFacts['state'], string>> = {
  trusted: 'trusted', restricted: 'restricted', undecided: 'not decided yet (restricted until you decide)',
  unreadable: 'not known: its trust record could not be read (restricted until you decide again)',
};

export const SECURITY_FOLDER: CapabilityDefinition<SecurityCapabilityServices> = {
  capability: { id: 'security.folder', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'folder', label: 'See whether this folder is trusted', word: 'folder', inputs: [],
  sentence: 'Shows whether this folder is trusted, restricted or not decided, and what each means here.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) {
    const trust = services.security.folder(folderOf(caller));
    const facts = await folderFacts(trust, caller.program);
    return {
      text: [
        `This folder (${basename(facts.folder)}) is ${STATE_WORDS[facts.state]}.`,
        facts.meaning,
        ...(facts.fault ? [`Its trust record could not be read: ${facts.fault}.`] : []),
        ...(trust.hasIgnoredLegacyDecision() ? ['A trust.json inside this folder was found and is not honored: a project cannot decide its own trust. Decisions are kept in your own GoodVibes state.'] : []),
      ].join('\n'),
      data: { ...facts },
    };
  },
};

async function setFolder(services: SecurityCapabilityServices, caller: CapabilityCaller, level: 'trusted' | 'restricted'): Promise<{ text: string; data: Record<string, unknown> }> {
  const trust = services.security.folder(folderOf(caller));
  let saved: Awaited<ReturnType<FolderTrust['setLevel']>>;
  try {
    saved = await trust.setLevel(level);
  } catch (error) {
    throw new CapabilityRefusal(`Nothing was changed: ${summarizeError(error)}`);
  }
  // Saved or not, nothing else reads this process's copy: a decision that could not be written did not happen.
  if (!saved.saved) throw new CapabilityRefusal(`Nothing was changed: ${saved.fault ?? 'the decision could not be saved'}.`);
  services.security.changed();
  return {
    // The folder by its name: a whole path is a long unbroken run a screen's outcome line leaves out.
    text: `This folder (${basename(trust.workspaceRoot)}) is ${level}. ${levelMeaning(level === 'trusted', caller.program)}`,
    data: { folder: trust.workspaceRoot, state: level },
  };
}

export const SECURITY_TRUST_FOLDER: CapabilityDefinition<SecurityCapabilityServices> = {
  capability: { id: 'security.trust-folder', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'trust-folder', label: 'Trust this folder', word: 'trust-folder', inputs: [],
  sentence: 'This folder becomes trusted: its own hooks and MCP servers may run and tools may change it, until you change it.',
  done: '', touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'restrict-folder',
  ownerOnly: { reason: 'it lets this folder\'s own files decide what runs', instead: 'Ask the owner to trust it under Permissions and safety.' },
  example: {},
  async run(_values, services, caller) { return setFolder(services, caller, 'trusted'); },
};

export const SECURITY_RESTRICT_FOLDER: CapabilityDefinition<SecurityCapabilityServices> = {
  capability: { id: 'security.restrict-folder', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'restrict-folder', label: 'Restrict this folder', word: 'restrict-folder', inputs: [],
  sentence: 'This folder becomes restricted: its own hooks and MCP servers stay off, until you change it.',
  done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'trust-folder', example: {},
  async run(_values, services, caller) { return setFolder(services, caller, 'restricted'); },
};

// ---------------------------------------------------------------------------
// The program's: sandbox sessions
// ---------------------------------------------------------------------------

/** Only the program that starts sandbox sessions offers these (the terminal app). */
function keepsSandboxSessions(services: SandboxSessionServices): boolean {
  return services.sandboxSessions !== undefined;
}

function sandboxSessions(services: SandboxSessionServices): NonNullable<SandboxSessionServices['sandboxSessions']> {
  if (!services.sandboxSessions) throw new CapabilityRefusal('This program keeps no sandbox sessions; nothing was done.', 'The terminal app (goodvibes) starts them.');
  return services.sandboxSessions;
}

const SESSION_INPUT: InputDescription = {
  id: 'session', label: 'Sandbox session', help: 'The sandbox sessions started here', kind: 'choice',
  choices: { list: SANDBOX_SESSIONS_LIST, allowOther: { reason: 'a session id' } }, required: true, typed: { position: 1 },
};
const pathInput = (help: string, position: 1 | 2): InputDescription => ({
  id: 'path', label: 'File', help, kind: 'path', freeTextReason: 'a file path', required: true, typed: { position },
});
const REPLACE_INPUT: InputDescription = {
  id: 'replace', label: 'If it exists', help: 'Whether to write over a file that is already there', kind: 'choice',
  choices: [{ value: 'no', label: 'Leave it, write nothing' }, { value: 'yes', label: 'Write over it' }],
  required: { default: 'no', defaultMeans: 'leave an existing file alone' }, typed: { flag: '--replace', switchOn: 'yes' },
};

export const SECURITY_SANDBOX_SESSIONS: CapabilityDefinition<SandboxSessionServices> = {
  capability: { id: 'security.sandbox-sessions', group: 'safety', home: 'session', repeat: 'safe' }, available: keepsSandboxSessions,
  actionId: 'sandbox-sessions', label: 'See the sandbox sessions', word: 'sandbox-sessions', inputs: [],
  sentence: 'Lists the sandbox sessions started here, with their profile, backend and state.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const sessions = sandboxSessions(services).registry.list();
    return {
      text: renderSandboxSessions(sessions),
      data: { sessions: sessions.map((session) => ({ id: session.id, label: session.label, profile: session.profileId, backend: session.backend, state: session.state })) },
    };
  },
};

export const SECURITY_START_SANDBOX: CapabilityDefinition<SandboxSessionServices> = {
  capability: { id: 'security.start-sandbox', group: 'safety', home: 'session', repeat: 'unsafe' }, available: keepsSandboxSessions,
  actionId: 'start-sandbox', label: 'Start a sandbox session', word: 'start-sandbox',
  inputs: [
    { id: 'profile', label: 'Profile', help: 'What the session is for', kind: 'choice', required: true, typed: { position: 1 },
      choices: listSandboxProfiles().map((profile) => ({ value: profile.id, label: profile.label })) },
    { id: 'where', label: 'Boundary', help: 'Inside the sandbox, or on this machine with no boundary', kind: 'choice', typed: { flag: '--host', switchOn: 'host' },
      choices: [
        { value: 'contained', label: 'Inside the sandbox' },
        { value: 'host', label: 'On this machine, with no boundary', help: 'It reaches the host\'s files and network.', risk: 'loosens-a-protection' },
      ],
      required: { default: 'contained', defaultMeans: 'inside the sandbox' } },
    { id: 'label', label: 'Name', help: 'A name to tell it apart', kind: 'text', freeTextReason: 'a name you choose', typed: { tail: true }, required: { default: '', defaultMeans: 'the profile\'s name' } },
  ],
  sentence: 'A {profile} sandbox session starts and stays until you stop it, for this session only.',
  done: '', touches: 'this-machine', lasts: 'session', risk: 'none', undoneBy: 'stop-sandbox', example: { profile: 'command', label: 'build check' },
  async run(values, services) {
    const held = sandboxSessions(services);
    let session: Awaited<ReturnType<SandboxSessionRegistry['start']>>;
    try {
      session = await held.registry.start(values.profile as Parameters<SandboxSessionRegistry['start']>[0], values.label || undefined, held.config, { host: values.where === 'host' });
    } catch (error) {
      throw new CapabilityRefusal(`No sandbox session was started: ${summarizeError(error)}`);
    }
    return {
      text: [
        `Started sandbox session ${session.id} for ${session.profileId} (backend ${session.backend}, ${session.state}, start-up ${session.startupStatus ?? 'not reported'}).`,
        ...(session.startupDetail ? [`  ${session.startupDetail}`] : []),
      ].join('\n'),
      data: { session: session.id, backend: session.backend, state: session.state },
    };
  },
};

export const SECURITY_SANDBOX_SESSION: CapabilityDefinition<SandboxSessionServices> = {
  capability: { id: 'security.sandbox-session', group: 'safety', home: 'session', repeat: 'safe' }, available: keepsSandboxSessions,
  actionId: 'sandbox-session', label: 'See a sandbox session', word: 'sandbox-session', inputs: [SESSION_INPUT],
  sentence: 'Shows sandbox session {session}: its profile, backend, state and the last command it ran.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { session: 'sbx-1a2b' },
  async run(values, services) {
    const session = sandboxSessions(services).registry.get(values.session!);
    if (!session) throw new CapabilityRefusal(`No sandbox session is ${values.session}.`, '"See the sandbox sessions" lists them.');
    return {
      text: [
        `Sandbox session ${session.id}`,
        `  profile: ${session.profileId}`,
        `  kind: ${session.kind}`,
        `  state: ${session.state}`,
        `  backend: ${session.backend}`,
        `  start-up: ${session.startupStatus ?? 'not reported'}`,
        ...(session.startupDetail ? [`  detail: ${session.startupDetail}`] : []),
        ...(session.lastCommandSummary ? [`  last: ${session.lastCommandSummary}`] : []),
      ].join('\n'),
      data: { session: session.id, state: session.state, backend: session.backend },
    };
  },
};

export const SECURITY_STOP_SANDBOX: CapabilityDefinition<SandboxSessionServices> = {
  capability: { id: 'security.stop-sandbox', group: 'safety', home: 'session', repeat: 'safe' }, available: keepsSandboxSessions,
  actionId: 'stop-sandbox', label: 'Stop a sandbox session', word: 'stop-sandbox', inputs: [SESSION_INPUT],
  sentence: 'Sandbox session {session} stops; what runs in it ends.',
  done: '', touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { session: 'sbx-1a2b' },
  async run(values, services) {
    const session = sandboxSessions(services).registry.stop(values.session!);
    if (!session) throw new CapabilityRefusal(`No sandbox session is ${values.session}; nothing was stopped.`, '"See the sandbox sessions" lists them.');
    return { text: `Stopped sandbox session ${session.id}.`, data: { session: session.id } };
  },
};

export const SECURITY_RUN_IN_SANDBOX: CapabilityDefinition<SandboxSessionServices> = {
  capability: { id: 'security.run-in-sandbox', group: 'safety', home: 'session', repeat: 'unsafe' }, available: keepsSandboxSessions,
  actionId: 'run-in-sandbox', label: 'Run a command in a sandbox session', word: 'run-in-sandbox',
  inputs: [
    SESSION_INPUT,
    { id: 'command', label: 'Command', help: 'The program and its arguments', kind: 'text', freeTextReason: 'a command line', required: true, typed: { tail: true } },
  ],
  sentence: 'Runs {command} inside sandbox session {session} (at most 10 seconds) and shows what it printed.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { session: 'sbx-1a2b', command: 'git status' },
  async run(values, services) {
    const [program, ...args] = values.command!.trim().split(/\s+/);
    if (!program) throw new CapabilityRefusal('Name the program to run; nothing was run.');
    try {
      const result = await sandboxSessions(services).registry.execute(values.session!, program, args, { timeoutMs: 10000 });
      const stdout = result.stdout.trim();
      const stderr = result.stderr.trim();
      return {
        text: [`Ran in sandbox session ${values.session}`, `  status: ${result.status ?? 'none'}`, ...(stdout ? [`  stdout: ${stdout}`] : []), ...(stderr ? [`  stderr: ${stderr}`] : [])].join('\n'),
        data: { status: result.status ?? null },
      };
    } catch (error) {
      throw new CapabilityRefusal(`Not run in sandbox session ${values.session}: ${summarizeError(error)}`);
    }
  },
};

export const SECURITY_SAVE_SANDBOX: CapabilityDefinition<SandboxSessionServices> = {
  capability: { id: 'security.save-sandbox', group: 'safety', home: 'session', repeat: 'safe' }, available: keepsSandboxSessions,
  actionId: 'save-sandbox', label: 'Save a sandbox session\'s record to a file', word: 'save-sandbox',
  inputs: [SESSION_INPUT, pathInput('Where to write it', 2), REPLACE_INPUT],
  sentence: 'The record of sandbox session {session} will be written to {path}, until you change it.',
  done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', example: { session: 'sbx-1a2b', path: 'sandbox-session.json' },
  async run(values, services) {
    const held = sandboxSessions(services);
    const target = held.resolvePath(values.path!);
    if (held.insideOnly) {
      const inside = relative(held.resolvePath('.'), target);
      if (inside.startsWith('..') || isAbsolute(inside)) throw new CapabilityRefusal(`Nothing was written: ${target} is outside the working folder, and a model writes only inside it.`);
    }
    if (existsSync(target) && values.replace !== 'yes') throw new CapabilityRefusal(`${target} already exists; nothing was written.`, 'Choose "Write over it" to replace it.');
    try {
      held.registry.exportArtifact(values.session!, resolve(target), held.config);
    } catch (error) {
      throw new CapabilityRefusal(`Nothing was written: ${summarizeError(error)}`);
    }
    return { text: `Saved the record of sandbox session ${values.session} to ${target}.`, data: { path: target } };
  },
};

export const SECURITY_READ_SANDBOX: CapabilityDefinition<SandboxSessionServices> = {
  capability: { id: 'security.read-sandbox', group: 'safety', home: 'session', repeat: 'safe' }, available: keepsSandboxSessions,
  actionId: 'read-sandbox', label: 'Read a saved sandbox session record', word: 'read-sandbox',
  inputs: [pathInput('A sandbox session record saved earlier', 1)],
  sentence: 'Reads the sandbox session record saved in {path} and shows what it recorded.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { path: 'sandbox-session.json' },
  async run(values, services) {
    const held = sandboxSessions(services);
    try {
      return { text: inspectSandboxSessionArtifact(held.registry.inspectArtifact(held.resolvePath(values.path!))) };
    } catch (error) {
      throw new CapabilityRefusal(`Could not read ${values.path}: ${summarizeError(error)}`);
    }
  },
};
